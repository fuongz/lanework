// Permission rules (FE-165): what a conversation may do without asking, kept
// per project, and the audit list of what it did on a rule's say-so.
//
// Contracts, constants and pure checks only: no I/O, no Node or Electron.

/** What a rule does when it matches: run the tool, or stop and ask. */
export const PERMISSION_EFFECTS = ["allow", "ask"] as const;
export type PermissionEffect = (typeof PERMISSION_EFFECTS)[number];

export type PermissionRule = {
  id: string;
  effect: PermissionEffect;
  /**
   * `Bash`, `Edit`, `Write`, `Read`, an MCP tool `mcp__server__tool`, or a
   * whole server `mcp__server__*`.
   */
  tool: string;
  /**
   * A command prefix with a trailing `*` for Bash, or a path glob for a file
   * tool. Literal text or glob only, never a regular expression.
   */
  pattern?: string;
  /** The conductor the rule is limited to; every conversation when absent. */
  conductor?: string;
  /** Shipped with the app (SEEDED_ASK_RULES), not written by the user. */
  seeded?: boolean;
  /** ISO 8601. */
  createdAt: string;
};

export type PermissionRulesFile = {
  version: 1;
  rules: PermissionRule[];
};

/** One automatic allow, for the audit list. */
export type AutoAllowEntry = {
  /** ISO 8601. */
  at: string;
  tool: string;
  /** What ran, short and one line. */
  summary: string;
  /** The rule that allowed it. */
  ruleId: string;
  /** The conversation that ran it. */
  conversation: string;
  conductor?: string;
};

export const PERMISSION_RULES_VERSION = 1;
/** The most entries the audit list keeps per project; the oldest go first. */
export const AUTO_ALLOW_MAX = 200;
export const PERMISSION_RULES_MAX = 500;
export const PERMISSION_PATTERN_MAX = 500;
export const PERMISSION_TOOL_MAX = 200;
export const PERMISSION_ID_MAX = 100;
export const PERMISSION_SUMMARY_MAX = 500;
/** The built-in file tools a rule may name. */
export const PERMISSION_BUILTIN_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
] as const;

/** A refused rule, file or entry. The message is meant to be shown. */
export class PermissionInputError extends Error {
  override name = "PermissionInputError";
}

function fail(message: string): never {
  throw new PermissionInputError(message);
}

const MCP_TOOL_PATTERN = /^mcp__[A-Za-z0-9_-]+__(?:[A-Za-z0-9_-]+|\*)$/;
// A pattern is literal text or a glob (`*`, `**`, `?`). These belong to
// regular expressions (or shell expansion) only, so they are refused.
const REGEX_SYNTAX = /[()[\]{}^$+\\]/;

/** Whether `tool` names a built-in tool, an MCP tool or a whole MCP server. */
export function isPermissionTool(tool: string): boolean {
  return (
    (PERMISSION_BUILTIN_TOOLS as readonly string[]).includes(tool) ||
    MCP_TOOL_PATTERN.test(tool)
  );
}

function object(value: unknown, allowed: readonly string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be a JSON object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length)
    fail(
      `${label} has unknown field${unknown.length > 1 ? "s" : ""} ${unknown
        .map((key) => JSON.stringify(key))
        .join(", ")}`,
    );
  return value as Record<string, unknown>;
}

function str(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim())
    fail(`${label} must be a non-empty string`);
  if (value.length > max) fail(`${label} is longer than ${max} characters`);
  return value;
}

function optionalStr(
  value: unknown,
  label: string,
  max: number,
): string | undefined {
  return value == null ? undefined : str(value, label, max);
}

function timestamp(value: unknown, label: string): string {
  const at = str(value, label, 40);
  if (Number.isNaN(Date.parse(at))) fail(`${label} must be an ISO 8601 date`);
  return at;
}

/**
 * A rule's pattern: literal or glob, at most {@link PERMISSION_PATTERN_MAX}
 * characters, on one line.
 *
 * @throws {PermissionInputError} On regular-expression syntax or a long one.
 */
export function parsePermissionPattern(
  value: unknown,
  label = "pattern",
): string {
  const pattern = str(value, label, PERMISSION_PATTERN_MAX);
  if (/[\r\n\0]/.test(pattern)) fail(`${label} must be one line`);
  if (REGEX_SYNTAX.test(pattern))
    fail(
      `${label} must be literal text or a glob (* and ?), not a regular expression`,
    );
  return pattern;
}

/**
 * Check one rule, from the page, the file or the store.
 *
 * @throws {PermissionInputError} On a missing or unknown field, or a bad value.
 */
export function parsePermissionRule(
  value: unknown,
  label = "The rule",
): PermissionRule {
  const input = object(
    value,
    ["id", "effect", "tool", "pattern", "conductor", "seeded", "createdAt"],
    label,
  );
  const effect = input.effect;
  if (!(PERMISSION_EFFECTS as readonly unknown[]).includes(effect))
    fail(`${label}'s effect must be "allow" or "ask"`);
  const tool = str(input.tool, `${label}'s tool`, PERMISSION_TOOL_MAX);
  if (!isPermissionTool(tool))
    fail(
      `${label}'s tool must be Bash, Edit, Write, Read, mcp__server__tool or mcp__server__*`,
    );
  if (input.seeded != null && typeof input.seeded !== "boolean")
    fail(`${label}'s seeded must be true or false`);
  const pattern =
    input.pattern == null
      ? undefined
      : parsePermissionPattern(input.pattern, `${label}'s pattern`);
  const conductor = optionalStr(
    input.conductor,
    `${label}'s conductor`,
    PERMISSION_ID_MAX,
  );
  return {
    id: str(input.id, `${label}'s id`, PERMISSION_ID_MAX),
    effect: effect as PermissionEffect,
    tool,
    ...(pattern !== undefined ? { pattern } : {}),
    ...(conductor !== undefined ? { conductor } : {}),
    ...(input.seeded ? { seeded: true } : {}),
    createdAt: timestamp(input.createdAt, `${label}'s createdAt`),
  };
}

/**
 * Check a rules file: version 1, at most {@link PERMISSION_RULES_MAX} rules,
 * each id used once.
 *
 * @throws {PermissionInputError} On the first problem found.
 */
export function parsePermissionRulesFile(value: unknown): PermissionRulesFile {
  const input = object(value, ["version", "rules"], "The rules file");
  if (input.version !== PERMISSION_RULES_VERSION)
    fail(`The rules file's version must be ${PERMISSION_RULES_VERSION}`);
  if (!Array.isArray(input.rules) || input.rules.length > PERMISSION_RULES_MAX)
    fail(`rules must list at most ${PERMISSION_RULES_MAX} rules`);
  const ids = new Set<string>();
  const rules = input.rules.map((entry, index) => {
    const rule = parsePermissionRule(entry, `Rule ${index + 1}`);
    if (ids.has(rule.id)) fail(`Rule ${index + 1} repeats the id ${rule.id}`);
    ids.add(rule.id);
    return rule;
  });
  return { version: PERMISSION_RULES_VERSION, rules };
}

/**
 * Check one audit entry.
 *
 * @throws {PermissionInputError} On a missing or unknown field, or a bad value.
 */
export function parseAutoAllowEntry(
  value: unknown,
  label = "The entry",
): AutoAllowEntry {
  const input = object(
    value,
    ["at", "tool", "summary", "ruleId", "conversation", "conductor"],
    label,
  );
  const conductor = optionalStr(
    input.conductor,
    `${label}'s conductor`,
    PERMISSION_ID_MAX,
  );
  return {
    at: timestamp(input.at, `${label}'s at`),
    tool: str(input.tool, `${label}'s tool`, PERMISSION_TOOL_MAX),
    summary: str(input.summary, `${label}'s summary`, PERMISSION_SUMMARY_MAX),
    ruleId: str(input.ruleId, `${label}'s ruleId`, PERMISSION_ID_MAX),
    conversation: str(
      input.conversation,
      `${label}'s conversation`,
      PERMISSION_ID_MAX,
    ),
    ...(conductor !== undefined ? { conductor } : {}),
  };
}

/**
 * Check an audit list; it keeps the newest {@link AUTO_ALLOW_MAX} entries as
 * given (oldest first), so an over-long file is cut, not refused.
 *
 * @throws {PermissionInputError} When it is not a list, or an entry is bad.
 */
export function parseAutoAllowList(value: unknown): AutoAllowEntry[] {
  if (!Array.isArray(value)) fail("The audit list must be an array");
  return value
    .slice(-AUTO_ALLOW_MAX)
    .map((entry, index) => parseAutoAllowEntry(entry, `Entry ${index + 1}`));
}

/**
 * The pattern a file-tool rule uses for "any path outside the checkout".
 * Not a glob the file system matches: the evaluator resolves the path and
 * tests it against the conversation's checkout.
 */
export const OUTSIDE_CHECKOUT_PATTERN = "!<checkout>/**";

const SEED_AT = "2026-01-01T00:00:00.000Z";

const seed = (id: string, tool: string, pattern?: string): PermissionRule => ({
  id: `seed:${id}`,
  effect: "ask",
  tool,
  ...(pattern !== undefined ? { pattern } : {}),
  seeded: true,
  createdAt: SEED_AT,
});

/**
 * Rules that always ask, whatever an allow rule says: they ship with the app
 * and the user may not delete them, only the allow rules around them.
 */
export const SEEDED_ASK_RULES: readonly PermissionRule[] = [
  seed("git-push", "Bash", "git push*"),
  seed("rm-rf", "Bash", "rm -rf*"),
  // A download piped into a shell, either command into either shell.
  seed("curl-sh", "Bash", "curl*| sh*"),
  seed("curl-bash", "Bash", "curl*| bash*"),
  seed("wget-sh", "Bash", "wget*| sh*"),
  seed("wget-bash", "Bash", "wget*| bash*"),
  seed("write-outside", "Write", OUTSIDE_CHECKOUT_PATTERN),
  seed("edit-outside", "Edit", OUTSIDE_CHECKOUT_PATTERN),
  seed("sessions-answer", "mcp__lanework_control__sessions_answer"),
];

// ─── IPC ────────────────────────────────────────────────────────────────────

export const permissionsChannels = {
  /** The project's rules, seeded ones included. */
  list: "permissions:list",
  /** Add or replace one rule, by id. */
  save: "permissions:save",
  remove: "permissions:remove",
  /** The project's audit list, newest last. */
  audit: "permissions:audit",
  /** The Allow rule a pending card would save, not saved. */
  suggest: "permissions:suggest",
  /** "Always allow": save the suggested rule for the card's own project. */
  allowCard: "permissions:allow-card",
  /** Main → renderer: a project's rules or audit list changed. */
  changed: "permissions:changed",
} as const;

/** What `permissions.onChange` hears. */
export interface PermissionsEvent {
  project: string;
}

/** The slice of `window.desktop` that reaches permission rules. */
export interface DesktopPermissionsApi {
  list: (project: string) => Promise<PermissionRule[]>;
  save: (project: string, rule: PermissionRule) => Promise<PermissionRule[]>;
  remove: (project: string, id: string) => Promise<PermissionRule[]>;
  audit: (project: string) => Promise<AutoAllowEntry[]>;
  /** The Allow rule card `requestId` would save, not saved; null: none. */
  suggest: (
    project: string,
    conversation: string,
    requestId: string,
  ) => Promise<PermissionRule | null>;
  /**
   * "Always allow": save that rule for the card's own project. Null when no
   * rule fits it (or the card is gone). The card itself is still answered
   * through `conversation.answerPermission`.
   */
  allowCard: (
    project: string,
    conversation: string,
    requestId: string,
  ) => Promise<PermissionRule[] | null>;
  /** Returns the function that stops listening. */
  onChange: (listener: (event: PermissionsEvent) => void) => () => void;
}
