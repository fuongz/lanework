// The readiness rules (FE-30), with no Electron and no filesystem: what the
// gathered facts about a folder mean, and what each fix would write. Pure on
// purpose — tests/readiness.spec.ts calls these directly.
import { AGENT_NOTES, MCP_HOST, MCP_URL } from "../../../shared/agent-notes";
import type {
  ReadinessCheck,
  ReadinessFix,
  ReadinessReport,
} from "../../../shared/readiness";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

function parseObject(text: string | null): Json | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Whether a notes file tells an agent about the board.
 *
 * ⚠️ Loose on purpose. People reword the snippet, and a check that wanted it
 * verbatim would nag every repo that wrote its own. Naming the server's host
 * or the tool an agent starts with is enough to say somebody wrote it down.
 */
export function hasLaneworkNotes(text: string | null): boolean {
  if (!text) return false;
  return (
    text.includes(MCP_HOST) ||
    text.includes("list_boards") ||
    /^#{1,6}[ \t]+lanework\b/im.test(text)
  );
}

/** `@AGENTS.md` on a line of its own — Claude Code's import. */
export function importsAgentsMd(text: string | null): boolean {
  return !!text && /^[ \t]*@(\.\/)?AGENTS\.md[ \t]*$/m.test(text);
}

/** One `mcpServers` map holds an entry that is ours: by name, or by URL. */
function hasLaneworkServer(servers: unknown): boolean {
  if (!isObject(servers)) return false;
  return Object.entries(servers).some(
    ([name, entry]) =>
      name === "lanework" ||
      (isObject(entry) &&
        typeof entry.url === "string" &&
        entry.url.includes(MCP_HOST)),
  );
}

/**
 * Whether Claude Code, started in `folder`, has the lanework MCP server.
 *
 * Its three scopes: `.mcp.json` in the folder (project), and in
 * `~/.claude.json` the top-level `mcpServers` (user) and
 * `projects[<folder>].mcpServers` (local).
 */
export function claudeHasLanework(input: {
  folder: string;
  mcpJson: string | null;
  claudeJson: string | null;
}): boolean {
  if (hasLaneworkServer(parseObject(input.mcpJson)?.mcpServers)) return true;
  const user = parseObject(input.claudeJson);
  if (!user) return false;
  if (hasLaneworkServer(user.mcpServers)) return true;
  const projects = user.projects;
  return (
    isObject(projects) &&
    isObject(projects[input.folder]) &&
    hasLaneworkServer((projects[input.folder] as Json).mcpServers)
  );
}

/**
 * Whether Codex's `config.toml` has the lanework MCP server: a
 * `[mcp_servers.lanework]` table, or any `[mcp_servers.*]` pointing at us.
 *
 * ⚠️ The same deliberately tiny reading as `handoff/codex.ts`: table headers
 * and the lines under them. Anything it cannot read counts as "not there",
 * which only ever shows an instruction that was not needed.
 */
export function codexHasLanework(toml: string | null): boolean {
  if (!toml) return false;
  let table = "";
  for (const raw of toml.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header?.[1]) {
      table = header[1].trim();
      if (/^mcp_servers\.("lanework"|lanework)$/.test(table)) return true;
      continue;
    }
    if (table.startsWith("mcp_servers.") && line.includes(MCP_HOST))
      return true;
  }
  return false;
}

/** Everything main gathers about one project before judging it. */
export interface ReadinessFacts {
  slug: string;
  folder:
    | { kind: "none" }
    | { kind: "missing"; path: string }
    | {
        kind: "linked";
        path: string;
        agentsMd: string | null;
        claudeMd: string | null;
        claudeMcp: boolean;
        legacyReviews: boolean;
      };
  /** Claude Code has been run on this machine (`~/.claude` exists). */
  claude: { used: boolean; hook: boolean };
  codex: { used: boolean; hook: boolean; mcp: boolean };
  checkedAt: string;
}

const CLAUDE_ADD = `claude mcp add --transport http --scope user lanework ${MCP_URL}`;
const CODEX_ADD = `codex mcp add lanework --url ${MCP_URL}`;

function check(
  base: Omit<ReadinessCheck, "detail" | "fix" | "action"> &
    Partial<Pick<ReadinessCheck, "fix" | "action">>,
  detail: string,
): ReadinessCheck {
  return {
    fix: null,
    action: null,
    ...base,
    detail: base.ok ? "" : detail,
  };
}

export function buildReport(facts: ReadinessFacts): ReadinessReport {
  const checks: ReadinessCheck[] = [];
  const { folder } = facts;

  checks.push(
    check(
      {
        id: "folder",
        level: "blocker",
        ok: folder.kind === "linked",
        title: "Folder on this machine",
        action: "project-settings",
      },
      folder.kind === "missing"
        ? `The linked folder is gone: ${folder.path}. Link it again in Settings › Project › General.`
        : "No folder is linked to this project on this machine. Link one in Settings › Project › General.",
    ),
  );

  if (folder.kind === "linked") {
    checks.push(
      check(
        {
          id: "agents-md",
          level: "warning",
          ok: hasLaneworkNotes(folder.agentsMd),
          title: "AGENTS.md",
          fix: "agents-md",
        },
        folder.agentsMd === null
          ? "This folder has no AGENTS.md. It is how an agent learns where this repo's cards go."
          : "AGENTS.md says nothing about the Lanework board. Add the board notes so an agent knows where cards go.",
      ),
    );
    // ⚠️ Information, not a warning. The docs say Claude Code reads only
    // CLAUDE.md, but newer versions also read AGENTS.md — a repo without the
    // import may be perfectly fine, and the app cannot tell which version runs.
    if (facts.claude.used)
      checks.push(
        check(
          {
            id: "claude-md",
            level: "info",
            ok:
              importsAgentsMd(folder.claudeMd) ||
              hasLaneworkNotes(folder.claudeMd),
            title: "CLAUDE.md",
            fix: "claude-md",
          },
          folder.claudeMd === null
            ? "No CLAUDE.md. Versions of Claude Code that read only CLAUDE.md will not see the board notes; one line, @AGENTS.md, fixes that."
            : "CLAUDE.md neither imports AGENTS.md nor mentions the board. Add @AGENTS.md so Claude Code reads the same notes.",
        ),
      );
    if (facts.claude.used)
      checks.push(
        check(
          {
            id: "claude-mcp",
            level: "blocker",
            ok: folder.claudeMcp,
            title: "Lanework MCP for Claude Code",
            fix: "mcp-json",
          },
          `Claude Code has no lanework MCP server in this folder, so it cannot reach the board. Add .mcp.json here, or once for every repo: ${CLAUDE_ADD}`,
        ),
      );
  }

  if (facts.codex.used)
    checks.push(
      check(
        {
          id: "codex-mcp",
          level: "blocker",
          ok: facts.codex.mcp,
          title: "Lanework MCP for Codex",
        },
        `Codex has no lanework MCP server, so it cannot reach the board. Run: ${CODEX_ADD}`,
      ),
    );

  const unhooked = [
    facts.claude.used && !facts.claude.hook ? "Claude Code" : null,
    facts.codex.used && !facts.codex.hook ? "Codex" : null,
  ].filter(Boolean);
  if (facts.claude.used || facts.codex.used)
    checks.push(
      check(
        {
          id: "hook",
          level: "info",
          ok: unhooked.length === 0,
          title: "Checkpoints between agents",
          action: "agent-settings",
        },
        `${unhooked.join(" and ")} does not leave a checkpoint on the card after each turn, so another agent cannot pick the work up. Turn it on in Settings › Agents › Harness.`,
      ),
    );

  if (folder.kind === "linked" && folder.legacyReviews)
    checks.push(
      check(
        {
          id: "legacy-reviews",
          level: "info",
          ok: false,
          title: "Old .agents/reviews cards",
          action: "project-settings",
        },
        "This folder still has cards in .agents/reviews from before they moved to the board. Import them from Settings › Project › General.",
      ),
    );

  return {
    slug: facts.slug,
    folder: folder.kind === "none" ? null : folder.path,
    checkedAt: facts.checkedAt,
    checks,
  };
}

/** The file each fix writes, inside the project's folder. */
export const FIX_FILES: Record<ReadinessFix, string> = {
  "agents-md": "AGENTS.md",
  "claude-md": "CLAUDE.md",
  "mcp-json": ".mcp.json",
};

/**
 * What a fix turns `before` into.
 *
 * ⚠️ Every fix APPENDS or ADDS one key; none rewrites what somebody wrote. A
 * `.mcp.json` that is not a JSON object is refused rather than replaced.
 */
export function applyFix(fix: ReadinessFix, before: string | null): string {
  switch (fix) {
    case "agents-md":
      return before === null || !before.trim()
        ? `# Instructions for AI agents\n\n${AGENT_NOTES}\n`
        : `${before.trimEnd()}\n\n${AGENT_NOTES}\n`;
    case "claude-md":
      return before === null || !before.trim()
        ? "@AGENTS.md\n"
        : `${before.trimEnd()}\n\n@AGENTS.md\n`;
    case "mcp-json": {
      const current =
        before === null || !before.trim() ? {} : parseObject(before);
      if (!current)
        throw new Error(
          ".mcp.json in this folder is not a JSON object, so it was left alone. Add the lanework server by hand.",
        );
      const servers = isObject(current.mcpServers) ? current.mcpServers : {};
      return `${JSON.stringify(
        {
          ...current,
          mcpServers: { ...servers, lanework: { type: "http", url: MCP_URL } },
        },
        null,
        2,
      )}\n`;
    }
  }
}
