// Connectors (FE-166): turn a conductor's disabled list into what one agent
// process is started with. Pure: no I/O, no Electron, nothing at module
// level that changes, so engines and unit tests call it directly.
//
// NOTE: Checked on 2026-11-23 against the CLIs installed on the dev machine,
// read-only (no conversation started, no config written):
//
// - Claude Code 2.1.330. `--disallowedTools, --disallowed-tools <tools...>`
//   takes "comma or space-separated" names. A rule `mcp__<server>__*` denies
//   every tool of that server; the server itself still starts, its tools are
//   just refused. The CLI has no per-process "skip this one server" flag:
//   `--strict-mcp-config` drops every configured server at once, so it does not
//   fit a denylist. The flag is variadic (Commander), so a second
//   `--disallowedTools` would also work, but a variadic flag swallows the
//   words after it. One merged flag is safer: {@link withDisallowedTools}.
//   Server names are normalised as the 2.1.330 bundle does (`xn()`):
//   `[^a-zA-Z0-9_-]` → `_`, and for a `claude.ai ` name runs of `_` collapse
//   and the edges are trimmed, so `claude.ai Gmail` → `claude_ai_Gmail`. A
//   plugin's server is `plugin:<plugin>:<server>` (→ `plugin_<plugin>_<server>`).
// - Codex CLI 0.170.0. `-c, --config <key=value>` overrides config.toml for
//   one process, with a dotted path and a TOML value. `mcp_servers.<name>.enabled`
//   is a field of its MCP server config. Verified with
//   `codex -c mcp_servers.lanework-kit.enabled=false mcp list`, which then
//   lists that server as `disabled`. A dotted path cannot quote a name, so a
//   name outside `[A-Za-z0-9_-]` gets no override (Codex's own names fit it).
// - OpenCode 2.3.2. It has no CLI flag for MCP servers. It reads
//   `OPENCODE_CONFIG_CONTENT` (inline JSON) as its last config source. Its v2
//   schema drops a server's `enabled` key: an inline `enabled: false` is
//   stripped, and an entry without `type` is dropped. What works is a policy,
//   `{ action: "mcp.use", resource: "<server>", effect: "deny" }`. The bundle
//   removes every server whose `mcp.use` evaluates to deny from its MCP list.
//   `opencode debug config --standalone` shows the inline policy kept. CAVEAT:
//   an env var only reaches an OpenCode the app starts with it. The chat talks
//   to the user's shared background service (`opencode-service.ts`), which
//   never sees a per-conversation env. The override applies only to a
//   process started with `--standalone`, or to a server the app spawns itself.

/** Lanework's own servers, by Claude-normalised, lower-cased name. */
const LANEWORK_NAMES = new Set([
  "lanework",
  "lanework_control",
  "lanework_kit",
]);

/**
 * `name` as Claude Code names it in a tool id (`mcp__<this>__<tool>`).
 *
 * Idempotent: a name that is already normalised comes back as it was.
 */
export function claudeServerName(name: string): string {
  let out = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (name.startsWith("claude.ai "))
    out = out.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return out;
}

/**
 * Whether `name` is one of Lanework's own servers, which can never be
 * disabled: `lanework`, `lanework_control`, `lanework-kit`, any claude.ai
 * Lanework connector, and a plugin's server of one of those names.
 */
export function isLaneworkConnector(name: string): boolean {
  const server = name.startsWith("plugin:")
    ? (name.split(":").at(-1) ?? "")
    : name;
  const key = claudeServerName(server)
    .toLowerCase()
    .replace(/[-_]+/g, "_")
    .replace(/^_|_$/g, "");
  return LANEWORK_NAMES.has(key) || key.startsWith("claude_ai_lanework");
}

/** The names that may be turned off: non-empty, unique, never Lanework's. */
function disablable(disabled: readonly string[]): string[] {
  return [
    ...new Set(
      disabled
        .map((name) => name.trim())
        .filter((name) => name && !isLaneworkConnector(name)),
    ),
  ];
}

const DISALLOWED_FLAGS = new Set(["--disallowedTools", "--disallowed-tools"]);

/** Claude Code's deny rules for the disabled servers' tools. */
export function claudeDisallowedTools(disabled: readonly string[]): string[] {
  return [
    ...new Set(
      disablable(disabled)
        .map(claudeServerName)
        .filter((name) => name && !isLaneworkConnector(name))
        .map((name) => `mcp__${name}__*`),
    ),
  ];
}

/**
 * `args` with `tools` added to its `--disallowedTools`.
 *
 * Merges into the first `--disallowedTools` / `--disallowed-tools` (its next
 * argument, comma-separated) instead of adding a second flag. Appends a new
 * flag only when there is none. Returns a new array; `args` is not changed.
 */
export function withDisallowedTools(
  args: readonly string[],
  tools: readonly string[],
): string[] {
  const out = [...args];
  if (!tools.length) return out;
  const at = out.findIndex((arg) => DISALLOWED_FLAGS.has(arg));
  if (at >= 0 && at + 1 < out.length) {
    const have = (out[at + 1] ?? "").split(/[,\s]+/).filter(Boolean);
    out[at + 1] = [...new Set([...have, ...tools])].join(",");
    return out;
  }
  const inline = out.findIndex((arg) =>
    [...DISALLOWED_FLAGS].some((flag) => arg.startsWith(`${flag}=`)),
  );
  if (inline >= 0) {
    const arg = out[inline] ?? "";
    const eq = arg.indexOf("=");
    const have = arg
      .slice(eq + 1)
      .split(/[,\s]+/)
      .filter(Boolean);
    out[inline] =
      `${arg.slice(0, eq)}=${[...new Set([...have, ...tools])].join(",")}`;
    return out;
  }
  out.push("--disallowedTools", tools.join(","));
  return out;
}

/**
 * Claude Code's args for the disabled list: one `--disallowedTools` with
 * `mcp__<server>__*` per server; none when nothing is disabled.
 *
 * Beside an existing `--disallowedTools` (a guarded lead's), use
 * {@link withDisallowedTools} with {@link claudeDisallowedTools} instead.
 */
export function claudeConnectorArgs(disabled: readonly string[]): string[] {
  return withDisallowedTools([], claudeDisallowedTools(disabled));
}

/** A name a Codex `-c` dotted path can hold unquoted. */
const CODEX_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Codex's args: `-c mcp_servers.<name>.enabled=false` per server. */
export function codexConnectorArgs(disabled: readonly string[]): string[] {
  return disablable(disabled)
    .filter((name) => CODEX_NAME.test(name))
    .flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
}

/** OpenCode's inline-config variable (see the NOTE above). */
export const OPENCODE_CONFIG_CONTENT = "OPENCODE_CONFIG_CONTENT";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * OpenCode's per-process override: the env to add, or null when nothing is
 * disabled.
 *
 * @param existing The process's current `OPENCODE_CONFIG_CONTENT`, if any.
 *   Its keys are kept and its `policies` come first, so ours win; text that
 *   is not a JSON object is replaced.
 */
export function opencodeConnectorConfig(
  disabled: readonly string[],
  existing?: string,
): Record<string, string> | null {
  const names = disablable(disabled);
  if (!names.length) return null;
  let base: Json = {};
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (isObject(parsed)) base = parsed;
    } catch {
      // Not JSON: ours replaces it.
    }
  }
  const policies = [
    ...(Array.isArray(base.policies) ? base.policies : []),
    ...names.map((resource) => ({
      action: "mcp.use",
      resource,
      effect: "deny",
    })),
  ];
  return {
    [OPENCODE_CONFIG_CONTENT]: JSON.stringify({ ...base, policies }),
  };
}
