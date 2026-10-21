// A link's favicon and title, for the chat's link chips (FE-62/D4).
//
// ⚠️ No third-party service: main fetches the page itself — http(s) only,
// never a loopback, private or link-local address (checked on the address
// actually connected to, after DNS), a few redirects, small bodies, a short
// timeout — and keeps what it found on disk per domain.
//
// Nothing here imports Electron, so a Node test drives it with a fake fetcher.
import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import { isPreviewUrl, type LinkPreview } from "../../../shared/conversation";

const PAGE_MAX = 512 * 1024;
const ICON_MAX = 100 * 1024;
const TIMEOUT_MS = 5_000;
const REDIRECTS = 3;
const TTL_MS = 7 * 24 * 60 * 60_000;
/** A failed fetch is tried again after this, and never written to disk. */
const FAILED_TTL_MS = 10 * 60_000;
/** Titles kept per domain. */
const TITLES_MAX = 64;

export interface Fetched {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: Buffer;
  /** Where the body came from, after redirects. */
  url: string;
}

/** Fetch `url` with at most `max` bytes of body; rejects on anything unsafe. */
export type Fetcher = (url: string, max: number) => Promise<Fetched>;

// ─── Addresses ──────────────────────────────────────────────────────────────

function v4Private(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Loopback, private, link-local, CGNAT, multicast or unspecified. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return v4Private(address);
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (mapped) return v4Private(mapped);
  return (
    lower === "::" ||
    lower === "::1" ||
    /^f[cd]/.test(lower) ||
    /^fe[89ab]/.test(lower) ||
    lower.startsWith("ff") ||
    lower.startsWith("::ffff:")
  );
}

function refusedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return true;
  return isIP(host) !== 0 && isPrivateAddress(host);
}

/**
 * `dns.lookup`, refusing an answer that is a private address.
 *
 * ⚠️ Used as the socket's own lookup, so the check is on the address the
 * request really connects to — a name that resolves to a public address for
 * a check and to 127.0.0.1 a moment later cannot slip through.
 */
function safeLookup(
  hostname: string,
  options: object,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "");
    const list = addresses as LookupAddress[];
    const bad = list.find((entry) => isPrivateAddress(entry.address));
    if (bad || list.length === 0)
      return callback(
        Object.assign(new Error("That address is not reachable from here."), {
          code: "EREFUSED",
        }),
        "",
      );
    if ((options as { all?: boolean }).all) return callback(null, list);
    const first = list[0] as LookupAddress;
    callback(null, first.address, first.family);
  });
}

function once(url: URL, max: number): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const get = url.protocol === "https:" ? https.get : http.get;
    const request = get(
      url,
      {
        lookup: safeLookup as never,
        timeout: TIMEOUT_MS,
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh) Lanework link preview",
          accept: "text/html,image/*;q=0.9,*/*;q=0.5",
          "accept-encoding": "identity",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) {
            // Enough to read a <head>: keep what fits and stop.
            chunks.push(chunk.subarray(0, chunk.length - (size - max)));
            response.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers))
            if (typeof value === "string") headers[key.toLowerCase()] = value;
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks),
            url: url.toString(),
          });
        };
        response.on("end", finish);
        response.on("error", (error) => {
          if (!done) reject(error);
        });
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error("Timed out")),
      TIMEOUT_MS,
    );
    request.on("timeout", () => request.destroy(new Error("Timed out")));
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** The real fetcher: redirects followed by hand, each hop checked again. */
export const netFetcher: Fetcher = async (start, max) => {
  let url = new URL(start);
  for (let hop = 0; hop <= REDIRECTS; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("Only http and https links are fetched.");
    if (url.username || url.password) throw new Error("No credentials.");
    if (refusedHost(url.hostname))
      throw new Error("That address is not reachable from here.");
    const response = await once(url, max);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    return response;
  }
  throw new Error("Too many redirects.");
};

// ─── Parsing ────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  middot: "·",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, name: string) => {
      if (name[0] === "#") {
        const code =
          name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    },
  );
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(
    /([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
  ))
    out[(match[1] as string).toLowerCase()] = decodeEntities(
      match[3] ?? match[4] ?? match[5] ?? "",
    );
  return out;
}

/** A page's `<title>` (or its `og:title`), and its best icon link. */
export function parseHead(
  html: string,
  base: string,
): { title: string | null; icon: string } {
  const head = html.slice(0, PAGE_MAX);
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  let title = raw ? decodeEntities(raw).replace(/\s+/g, " ").trim() : "";
  if (!title)
    for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
      const attrs = attributes(tag);
      if (attrs.property === "og:title" && attrs.content?.trim()) {
        title = attrs.content.replace(/\s+/g, " ").trim();
        break;
      }
    }
  const icons: { href: string; score: number }[] = [];
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(tag);
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    if (!attrs.href) continue;
    let score: number;
    if (rel.includes("icon")) {
      const sizes = attrs.sizes ?? "";
      const size = Number(/(\d+)x\d+/i.exec(sizes)?.[1] ?? 0);
      // A small icon is what a chip draws; an SVG draws at any size.
      score =
        attrs.type === "image/svg+xml" || attrs.href.endsWith(".svg")
          ? 90
          : size >= 16 && size <= 64
            ? 100 - Math.abs(size - 32)
            : size > 64
              ? 60
              : 70;
    } else if (rel.includes("apple-touch-icon")) score = 40;
    else continue;
    icons.push({ href: attrs.href, score });
  }
  icons.sort((a, b) => b.score - a.score);
  let icon: string;
  try {
    icon = new URL(icons[0]?.href ?? "/favicon.ico", base).toString();
  } catch {
    icon = new URL("/favicon.ico", base).toString();
  }
  return { title: title ? title.slice(0, 300) : null, icon };
}

/** What an icon's bytes are, by their header or their first bytes. */
function iconType(body: Buffer, header: string | undefined): string | null {
  const type = header?.split(";")[0]?.trim().toLowerCase();
  if (type?.startsWith("image/")) return type;
  if (body.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])))
    return "image/x-icon";
  if (body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return "image/jpeg";
  if (body.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (/^\s*(<\?xml[^>]*>\s*)?<svg\b/i.test(body.subarray(0, 256).toString()))
    return "image/svg+xml";
  return null;
}

// ─── The cache ──────────────────────────────────────────────────────────────

interface DomainEntry {
  /** When the icon was fetched. */
  at: number;
  icon: string | null;
  /** Page titles by URL, newest last. */
  titles: Record<string, { title: string | null; at: number }>;
}

interface LinkPreviewOptions {
  /** `userData/link-previews`. */
  dir: string;
  fetcher?: Fetcher;
  now?: () => number;
}

/**
 * Link previews with an on-disk cache per domain (7 days) and one in memory;
 * concurrent asks for one URL share one fetch.
 */
export function createLinkPreviews(options: LinkPreviewOptions) {
  const fetcher = options.fetcher ?? netFetcher;
  const now = options.now ?? Date.now;
  const memory = new Map<string, DomainEntry>();
  const failed = new Map<string, number>();
  const inflight = new Map<string, Promise<LinkPreview>>();

  const fileOf = (domain: string) =>
    join(
      options.dir,
      `${createHash("sha256").update(domain).digest("hex").slice(0, 32)}.json`,
    );

  async function load(domain: string): Promise<DomainEntry | null> {
    const cached = memory.get(domain);
    if (cached) return cached;
    try {
      const value = JSON.parse(
        await readFile(fileOf(domain), "utf8"),
      ) as DomainEntry;
      if (typeof value?.at !== "number" || typeof value.titles !== "object")
        return null;
      memory.set(domain, value);
      return value;
    } catch {
      return null;
    }
  }

  async function save(domain: string, entry: DomainEntry): Promise<void> {
    memory.set(domain, entry);
    try {
      await mkdir(options.dir, { recursive: true });
      const file = fileOf(domain);
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(entry));
      await rename(temp, file);
    } catch {
      // The memory copy still answers this run.
    }
  }

  async function fetchIcon(url: string): Promise<string | null> {
    try {
      const response = await fetcher(url, ICON_MAX + 1);
      if (response.status < 200 || response.status >= 300) return null;
      if (response.body.length === 0 || response.body.length > ICON_MAX)
        return null;
      const type = iconType(response.body, response.headers["content-type"]);
      return type
        ? `data:${type};base64,${response.body.toString("base64")}`
        : null;
    } catch {
      return null;
    }
  }

  async function fresh(url: string, domain: string): Promise<LinkPreview> {
    const entry = await load(domain);
    const time = now();
    const iconFresh = entry !== null && time - entry.at < TTL_MS;
    const known = entry?.titles[url];
    if (iconFresh && known && time - known.at < TTL_MS)
      return { url, title: known.title, icon: entry.icon };
    const failedAt = failed.get(url);
    if (failedAt !== undefined && time - failedAt < FAILED_TTL_MS)
      return { url, title: null, icon: iconFresh ? entry.icon : null };

    let title: string | null = null;
    let iconUrl = new URL("/favicon.ico", url).toString();
    let ok = false;
    try {
      const page = await fetcher(url, PAGE_MAX);
      const type = page.headers["content-type"] ?? "";
      if (page.status >= 200 && page.status < 300) {
        ok = true;
        if (/html|xml/i.test(type) || !type) {
          const head = parseHead(page.body.toString("utf8"), page.url);
          title = head.title;
          iconUrl = head.icon;
        }
      }
    } catch {
      // The icon may still be had from /favicon.ico.
    }
    const icon = iconFresh ? entry.icon : await fetchIcon(iconUrl);
    if (!ok) {
      failed.set(url, time);
      if (!iconFresh && icon)
        await save(domain, { at: time, icon, titles: entry?.titles ?? {} });
      return { url, title: null, icon };
    }
    const titles = { ...(entry?.titles ?? {}), [url]: { title, at: time } };
    const keys = Object.keys(titles);
    for (const key of keys.slice(0, Math.max(0, keys.length - TITLES_MAX)))
      delete titles[key];
    await save(domain, {
      at: iconFresh ? entry.at : time,
      icon,
      titles,
    });
    return { url, title, icon };
  }

  return function linkPreview(value: unknown): Promise<LinkPreview> {
    if (!isPreviewUrl(value)) throw new Error("Only http and https links.");
    const url = new URL(value);
    url.hash = "";
    const key = url.toString();
    const domain = url.hostname.toLowerCase();
    let task = inflight.get(key);
    if (!task) {
      task = fresh(key, domain).finally(() => inflight.delete(key));
      inflight.set(key, task);
    }
    // Answered for the link as the page wrote it, fragment and all.
    return task.then((preview) => ({ ...preview, url: value }));
  };
}
