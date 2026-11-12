import type { ToolCall, Turn } from "#/../shared/conversation";

/** One page a conversation found or read on the web. */
export interface WebSource {
  url: string;
  /** As the search result named it; null when only the URL is known. */
  title: string | null;
  /** The URL's host, without a leading `www.`. */
  host: string;
  /** The agent read the page itself (WebFetch), not only listed it. */
  fetched: boolean;
}

/** One web search and what it found; `query: null` for pages read directly. */
export interface WebSearch {
  query: string | null;
  /** When it ran, as an ISO timestamp; "" when unknown. */
  at: string;
  sources: WebSource[];
}

/** The most searches and sources one panel shows. */
const SEARCHES_MAX = 100;
const SOURCES_MAX = 500;

const SEARCH_TOOLS = new Set(["WebSearch", "web_search", "websearch"]);
const FETCH_TOOLS = new Set(["WebFetch", "webfetch", "fetch"]);

/**
 * `raw` as a web page's address: http or https only, without credentials or
 * a fragment. null for anything else, so no other scheme reaches a click.
 */
export function webUrl(raw: string): { url: string; host: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return { url: parsed.href, host: parsed.hostname.replace(/^www\./, "") };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A tool call's input as an object; `{}` when it is not JSON. */
function inputOf(call: ToolCall): Record<string, unknown> {
  try {
    return record(JSON.parse(call.input));
  } catch {
    return {};
  }
}

/**
 * The JSON array after `Links:` in a Claude WebSearch result, read by
 * matching brackets: the result goes on in prose after it.
 */
function linksArray(output: string): unknown[] | null {
  const start = output.indexOf("Links: [");
  if (start < 0) return null;
  const open = start + "Links: ".length;
  let depth = 0;
  let quoted = false;
  for (let at = open; at < output.length; at++) {
    const char = output[at];
    if (quoted) {
      if (char === "\\") at++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(output.slice(open, at + 1));
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>()[\]{}`]+/g;

/** The pages a search result lists: its links, else every URL in it. */
function foundIn(output: string): { url: string; title: string | null }[] {
  const links = linksArray(output);
  if (links)
    return links.flatMap((entry) => {
      const { url, title } = record(entry);
      return typeof url === "string"
        ? [
            {
              url,
              title:
                typeof title === "string" && title.trim() ? title.trim() : null,
            },
          ]
        : [];
    });
  return [...output.matchAll(URL_IN_TEXT)].map((match) => ({
    url: match[0].replace(/[.,;:!?]+$/, ""),
    title: null,
  }));
}

/** Every tool call of `turns`, with when its turn started, in order. */
function* callsOf(turns: Turn[]): Generator<{ call: ToolCall; at: string }> {
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const block of turn.blocks)
      if (block.type === "tools")
        for (const call of block.calls) yield { call, at: turn.at };
  }
}

/**
 * The web searches a conversation ran and the pages it read, from its own
 * tool calls (a sub-agent's are in its own transcript, not here), newest
 * first. A page read that no search listed goes under `query: null`.
 *
 * @returns At most {@link SEARCHES_MAX} searches and {@link SOURCES_MAX}
 *   sources, and whether some were left out.
 */
export function webSources(turns: Turn[]): {
  searches: WebSearch[];
  partial: boolean;
} {
  const searches: WebSearch[] = [];
  const direct: WebSearch = { query: null, at: "", sources: [] };
  /** Each URL's sources, so a later read marks every listing of it. */
  const byUrl = new Map<string, WebSource[]>();
  let count = 0;
  let partial = false;

  const add = (search: WebSearch, raw: string, title: string | null) => {
    const web = webUrl(raw);
    if (!web || search.sources.some((s) => s.url === web.url)) return null;
    if (count >= SOURCES_MAX) {
      partial = true;
      return null;
    }
    const source: WebSource = { ...web, title, fetched: false };
    search.sources.push(source);
    byUrl.set(web.url, [...(byUrl.get(web.url) ?? []), source]);
    count++;
    return source;
  };

  for (const { call, at } of callsOf(turns)) {
    if (SEARCH_TOOLS.has(call.tool)) {
      const input = inputOf(call);
      const query =
        typeof input.query === "string" ? input.query : call.input.trim();
      const search: WebSearch = { query: query || null, at, sources: [] };
      for (const found of foundIn(call.output ?? ""))
        add(search, found.url, found.title);
      searches.push(search);
    } else if (FETCH_TOOLS.has(call.tool) && call.kind === "fetch") {
      const url = inputOf(call).url;
      const web = typeof url === "string" ? webUrl(url) : null;
      if (!web) continue;
      const listed = byUrl.get(web.url);
      if (listed) for (const source of listed) source.fetched = true;
      else {
        const source = add(direct, web.url, null);
        if (source) source.fetched = true;
        direct.at = at;
      }
    }
  }

  const all = [...searches, ...(direct.sources.length ? [direct] : [])]
    .filter((search) => search.query !== null || search.sources.length > 0)
    .reverse();
  if (all.length > SEARCHES_MAX) partial = true;
  return { searches: all.slice(0, SEARCHES_MAX), partial };
}

/**
 * Searches from several conversations as one list, newest first: the same
 * query run twice stays two searches, a page listed twice in one stays one.
 */
export function mergeWebSearches(lists: WebSearch[][]): WebSearch[] {
  return lists.flat().sort((a, b) => (b.at || "").localeCompare(a.at || ""));
}

/** A markdown link `[text](url)` or a bare URL, in an answer's text. */
const LINK_IN_TEXT =
  /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s"'<>()[\]{}`]+/g;

/**
 * Every web page one answer stands on: what its own searches found and its
 * fetches read, then the links its text gives, each page once. A title
 * comes from the search result, else from the link's own words.
 */
export function answerSources(turn: Turn, text: string): WebSource[] {
  const byUrl = new Map<string, WebSource>();
  for (const search of webSources([turn]).searches)
    for (const source of search.sources) {
      const known = byUrl.get(source.url);
      if (!known) byUrl.set(source.url, { ...source });
      else {
        known.fetched ||= source.fetched;
        known.title ??= source.title;
      }
    }
  for (const match of text.matchAll(LINK_IN_TEXT)) {
    const raw = (match[2] ?? match[0]).replace(/[.,;:!?]+$/, "");
    const web = webUrl(raw);
    if (!web) continue;
    const named = match[1]?.trim() || null;
    const known = byUrl.get(web.url);
    if (known) known.title ??= named;
    else byUrl.set(web.url, { ...web, title: named, fetched: false });
  }
  return [...byUrl.values()].slice(0, SOURCES_MAX);
}
