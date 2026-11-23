// The permission matcher (FE-165): whether a project's rules answer a tool
// request on their own, or the card is shown.
//
// Pure and cheap: no I/O, no clock, no state. Every check is linear in the
// text it reads, times the rule's pattern; nothing here builds a regular
// expression from a rule, so no pattern can backtrack.
//
// The order is fixed:
// 1. An Ask rule that matches asks, seeded ones always included. A Bash Ask
//    rule is tried at every word of the whole command, so wrapping a command
//    (`sudo`, `env`, a subshell, a `find -exec`) does not hide it.
// 2. A write outside the checkout asks.
// 3. Otherwise every part must match an Allow rule: each command of a Bash
//    line split at `&&`, `||`, `;`, `|`, `&`, newlines, `$(...)` and
//    backticks, each path of a file tool. One part without one asks.

import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  OUTSIDE_CHECKOUT_PATTERN,
  type PermissionRule,
  parsePermissionPattern,
  SEEDED_ASK_RULES,
} from "../../../shared/permissions";

/** The built-in file tools a rule names. */
export type FileTool = "Edit" | "Write" | "Read";

/** A tool request, in the shape the rules read. */
export type PermissionSubject =
  | { kind: "bash"; command: string }
  | { kind: "file"; tool: FileTool; paths: string[] }
  | { kind: "mcp"; tool: string };

export interface MatchContext {
  /** The folder the conversation runs in: a worker's is its worktree. */
  checkout: string;
  /** Other folders a write may land in without asking (a worker's scratch). */
  roots?: readonly string[];
  /** For `~/` in a path or pattern. */
  home?: string;
  /** The conductor whose conversation this is, if any. */
  conductor?: string | null;
}

export type Verdict =
  | { effect: "allow"; rule: PermissionRule }
  | {
      effect: "ask";
      /** The Ask rule that matched; null when no Allow rule did. */
      rule: PermissionRule | null;
      /**
       * Nothing may answer it but a person: an Ask rule matched, a write
       * left the checkout, or the request was too large to read. Jev and a
       * worker's own scope check must not allow it either.
       */
      strict: boolean;
    };

/** Longer commands are not read: they ask, strictly. */
export const COMMAND_MAX = 10_000;
/** More commands in one line than this ask. */
const PARTS_MAX = 64;
/** More paths in one request than this ask, strictly. */
const PATHS_MAX = 64;
const PATH_MAX = 4_096;

const ask = (rule: PermissionRule | null, strict = rule !== null): Verdict => ({
  effect: "ask",
  rule,
  strict,
});

// ─── Globs ──────────────────────────────────────────────────────────────────

type Token =
  | { kind: "literal"; text: string }
  | { kind: "one" }
  | { kind: "star" }
  | { kind: "globstar" }
  /** `**\/`: no folder, or any number of whole folders. */
  | { kind: "folders" };

function tokens(pattern: string, paths: boolean): Token[] {
  const out: Token[] = [];
  let literal = "";
  const flush = () => {
    if (literal) out.push({ kind: "literal", text: literal });
    literal = "";
  };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "?") {
      flush();
      out.push({ kind: "one" });
    } else if (c === "*") {
      flush();
      let j = i;
      while (pattern[j + 1] === "*") j++;
      const double = j > i;
      i = j;
      if (!paths) {
        if (out.at(-1)?.kind !== "star") out.push({ kind: "star" });
      } else if (double && pattern[i + 1] === "/") {
        i++;
        out.push({ kind: "folders" });
      } else out.push({ kind: double ? "globstar" : "star" });
    } else literal += c;
  }
  flush();
  return out;
}

/** Characters a word may follow, for a Bash Ask rule tried at every word. */
const WORD_BREAK = new Set([
  " ",
  "\t",
  "\n",
  "'",
  '"',
  ";",
  "&",
  "|",
  "(",
  ")",
  "`",
  "{",
  "}",
]);

/**
 * Whether `pattern` matches all of `text`.
 *
 * A set of positions stepped token by token: linear in the text per token,
 * whatever the pattern, so no input backtracks.
 *
 * @param paths `*` and `?` stop at `/`; `**` crosses it. Off: both match
 *   any character.
 * @param anywhere Try every word start of `text`, not just its first
 *   character.
 */
export function globMatch(
  pattern: string,
  text: string,
  paths: boolean,
  anywhere = false,
): boolean {
  const n = text.length;
  let at = new Uint8Array(n + 1);
  at[0] = 1;
  if (anywhere)
    for (let q = 1; q <= n; q++)
      if (WORD_BREAK.has(text[q - 1] as string)) at[q] = 1;
  for (const token of tokens(pattern, paths)) {
    const next = new Uint8Array(n + 1);
    let any = false;
    switch (token.kind) {
      case "literal":
        for (let p = 0; p + token.text.length <= n; p++)
          if (at[p] && text.startsWith(token.text, p)) {
            next[p + token.text.length] = 1;
            any = true;
          }
        break;
      case "one":
        for (let p = 0; p < n; p++)
          if (at[p] && !(paths && text[p] === "/")) {
            next[p + 1] = 1;
            any = true;
          }
        break;
      case "star":
        // Each reached position runs to the next `/` (paths) or the end.
        for (let p = 0, open = false; p <= n; p++) {
          if (at[p]) open = true;
          if (open) {
            next[p] = 1;
            any = true;
          }
          if (paths && text[p] === "/") open = false;
        }
        break;
      case "globstar":
        for (let p = 0, open = false; p <= n; p++) {
          if (at[p]) open = true;
          if (open) {
            next[p] = 1;
            any = true;
          }
        }
        break;
      case "folders":
        for (let p = 0, open = false; p <= n; p++) {
          if (at[p]) {
            next[p] = 1;
            any = true;
            open = true;
          } else if (open && text[p - 1] === "/") {
            next[p] = 1;
            any = true;
          }
        }
        break;
    }
    if (!any) return false;
    at = next;
  }
  return at[n] === 1;
}

// ─── Bash ───────────────────────────────────────────────────────────────────

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** A command line as Bash Ask rules read it: one space, pipes spaced. */
function wholeCommand(command: string): string {
  return squash(command.replace(/\\\n/g, " ")).replace(
    /\s*(\|\|?)\s*/g,
    " $1 ",
  );
}

const isTargetEnd = (c: string | undefined) =>
  c === undefined || /[\s;&|()<>`]/.test(c);

export interface SplitCommand {
  /** Each simple command, trimmed, one space between words. */
  parts: string[];
  /**
   * Every part is all that runs: no quote left open, no command
   * substitution inside double quotes, no output redirected anywhere but
   * `/dev/null` or another descriptor.
   */
  safe: boolean;
}

/**
 * Split a Bash line into the commands it runs.
 *
 * Splits at `&&`, `||`, `;`, `|`, `|&`, a lone `&`, newlines, parentheses
 * (so `$(...)`, `<(...)` and subshells) and backticks, outside quotes. A
 * `$(...)` or backtick inside double quotes, an open quote or a redirect to a
 * file makes it unsafe: an Allow rule then never answers it.
 */
export function splitCommand(command: string): SplitCommand {
  const parts: string[] = [];
  let safe = true;
  let current = "";
  let quote: "'" | '"' | null = null;
  const push = () => {
    const part = squash(current);
    if (part) parts.push(part);
    current = "";
  };
  const n = command.length;
  for (let i = 0; i < n; i++) {
    const c = command[i] as string;
    const next = command[i + 1];
    if (quote === "'") {
      current += c;
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === "\\" && next !== undefined) {
        current += c + next;
        i++;
        continue;
      }
      if (c === '"') quote = null;
      else if (c === "`" || (c === "$" && next === "(")) safe = false;
      current += c;
      continue;
    }
    switch (c) {
      case "\\":
        if (next === "\n") i++;
        else if (next !== undefined) {
          current += c + next;
          i++;
        } else current += c;
        break;
      case "'":
      case '"':
        quote = c;
        current += c;
        break;
      case "\n":
      case ";":
      case "(":
      case ")":
      case "`":
        push();
        break;
      case "|":
        if (next === "|" || next === "&") i++;
        push();
        break;
      case "&": {
        const before = current.at(-1);
        if (next === "&") {
          i++;
          push();
        } else if (next === ">") {
          // `&>file`: the redirect is read at the `>`.
          current += c;
        } else if (before === ">" || before === "<") {
          // `2>&1`, `<&3`: a descriptor, not a background job.
          current += c;
        } else push();
        break;
      }
      case ">": {
        let j = i + 1;
        if (command[j] === ">" || command[j] === "|") j++;
        if (command[j] === "&") {
          // `>&2`, `>&-`: to a descriptor.
          j++;
          const start = j;
          while (j < n && /[0-9-]/.test(command[j] as string)) j++;
          if (j === start || !isTargetEnd(command[j])) safe = false;
        } else {
          while (command[j] === " " || command[j] === "\t") j++;
          const start = j;
          while (!isTargetEnd(command[j])) j++;
          if (command.slice(start, j) !== "/dev/null") safe = false;
        }
        current += c;
        break;
      }
      case "#":
        // A comment runs to the end of the line, at the start of a word.
        if (!current || /\s$/.test(current)) {
          while (i + 1 < n && command[i + 1] !== "\n") i++;
        } else current += c;
        break;
      default:
        current += c;
    }
  }
  if (quote) safe = false;
  push();
  return { parts, safe };
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const slashes = (path: string) =>
  sep === "/" ? path : path.split(sep).join("/");

function expandHome(path: string, home: string | undefined): string {
  if (!home) return path;
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

/** `path` made absolute against the checkout, `..` folded. */
function resolvedPath(path: string, context: MatchContext): string {
  const expanded = expandHome(path, context.home);
  return isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(context.checkout, expanded);
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** Whether absolute `path` is `folder` or under it. */
export function isInside(folder: string, path: string): boolean {
  return isAbsolute(path) && inside(folder, resolve(path));
}

function insideCheckout(path: string, context: MatchContext): boolean {
  return [context.checkout, ...(context.roots ?? [])].some((root) =>
    inside(root, path),
  );
}

/** Whether a file rule's pattern matches resolved `path`. */
function pathMatches(
  pattern: string | undefined,
  path: string,
  context: MatchContext,
): boolean {
  if (pattern === undefined) return true;
  if (pattern === OUTSIDE_CHECKOUT_PATTERN)
    return !insideCheckout(path, context);
  let full = expandHome(pattern, context.home);
  if (full.endsWith("/")) full += "**";
  // NOTE: `resolve` folds `.` and `..` and keeps `*` and `?` as they are.
  full = isAbsolute(full) ? resolve(full) : resolve(context.checkout, full);
  return globMatch(slashes(full), slashes(path), true);
}

// ─── Rules ──────────────────────────────────────────────────────────────────

/** Whether a rule names the subject's tool. */
function namesTool(rule: PermissionRule, subject: PermissionSubject): boolean {
  switch (subject.kind) {
    case "bash":
      return rule.tool === "Bash";
    case "file":
      return rule.tool === subject.tool;
    case "mcp": {
      if (rule.tool === subject.tool) return true;
      if (!rule.tool.endsWith("__*")) return false;
      const prefix = rule.tool.slice(0, -1);
      return (
        subject.tool.length > prefix.length && subject.tool.startsWith(prefix)
      );
    }
  }
}

function applies(rule: PermissionRule, context: MatchContext): boolean {
  return !rule.conductor || rule.conductor === (context.conductor ?? null);
}

/**
 * What the rules say of one request.
 *
 * The seeded Ask rules always count, whether `rules` lists them or not; a
 * rule in `rules` marked seeded counts only as one of them.
 */
export function evaluate(
  rules: readonly PermissionRule[],
  subject: PermissionSubject,
  context: MatchContext,
): Verdict {
  const own = rules.filter(
    (rule) =>
      !rule.seeded && applies(rule, context) && namesTool(rule, subject),
  );
  const asks = [
    ...SEEDED_ASK_RULES.filter((rule) => namesTool(rule, subject)),
    ...own.filter((rule) => rule.effect === "ask"),
  ];
  const allows = own.filter((rule) => rule.effect === "allow");
  switch (subject.kind) {
    case "bash": {
      const { command } = subject;
      if (command.length > COMMAND_MAX) return ask(null, true);
      const whole = wholeCommand(command);
      const { parts, safe } = splitCommand(command);
      // NOTE: The whole line and each part: a rule with no trailing `*`
      // matches a part to its end, which the line's end may not be.
      for (const rule of asks)
        if (
          rule.pattern === undefined ||
          globMatch(rule.pattern, whole, false, true) ||
          parts.some((part) =>
            globMatch(rule.pattern as string, part, false, true),
          )
        )
          return ask(rule);
      if (!allows.length) return ask(null);
      if (!safe || !parts.length || parts.length > PARTS_MAX) return ask(null);
      let first: PermissionRule | null = null;
      for (const part of parts) {
        const rule = allows.find(
          (entry) =>
            entry.pattern === undefined ||
            globMatch(entry.pattern, part, false),
        );
        if (!rule) return ask(null);
        first ??= rule;
      }
      return first ? { effect: "allow", rule: first } : ask(null);
    }
    case "file": {
      const { paths, tool } = subject;
      if (
        !paths.length ||
        paths.length > PATHS_MAX ||
        paths.some(
          (path) => !path || path.length > PATH_MAX || path.includes("\0"),
        )
      )
        return ask(null, true);
      const resolved = paths.map((path) => resolvedPath(path, context));
      for (const rule of asks)
        if (resolved.some((path) => pathMatches(rule.pattern, path, context)))
          return ask(rule);
      if (
        tool !== "Read" &&
        resolved.some((path) => !insideCheckout(path, context))
      )
        return ask(null, true);
      let first: PermissionRule | null = null;
      for (const path of resolved) {
        const rule = allows.find((entry) =>
          pathMatches(entry.pattern, path, context),
        );
        if (!rule) return ask(null);
        first ??= rule;
      }
      return first ? { effect: "allow", rule: first } : ask(null);
    }
    case "mcp": {
      const asked = asks[0];
      if (asked) return ask(asked);
      const rule = allows[0];
      return rule ? { effect: "allow", rule } : ask(null);
    }
  }
}

// ─── Requests ───────────────────────────────────────────────────────────────

const MCP_NAME = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;

const field = (input: unknown, key: string): string | null => {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
};

/** A Claude `can_use_tool` request as a subject; null for a tool rules skip. */
export function claudeSubject(
  tool: string,
  input: unknown,
): PermissionSubject | null {
  switch (tool) {
    case "Bash": {
      const command = field(input, "command");
      return command === null ? null : { kind: "bash", command };
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "Write":
    case "Read": {
      const path = field(input, "file_path") ?? field(input, "notebook_path");
      if (path === null) return null;
      return {
        kind: "file",
        tool: tool === "Write" ? "Write" : tool === "Read" ? "Read" : "Edit",
        paths: [path],
      };
    }
    default:
      return MCP_NAME.test(tool) ? { kind: "mcp", tool } : null;
  }
}

/**
 * The text an audit entry shows for a subject: one line, short.
 */
export function subjectSummary(subject: PermissionSubject): string {
  const text =
    subject.kind === "bash"
      ? squash(subject.command)
      : subject.kind === "file"
        ? `${subject.tool} ${subject.paths.join(", ")}`
        : subject.tool;
  return text.slice(0, 300);
}

/** The tool name an audit entry and a rule use for a subject. */
export function subjectTool(subject: PermissionSubject): string {
  return subject.kind === "bash" ? "Bash" : subject.tool;
}

// ─── Suggestions ────────────────────────────────────────────────────────────

/** Commands whose second word is what they do: `git log`, `npm run`. */
const TWO_WORD = new Set([
  "bun",
  "bunx",
  "cargo",
  "docker",
  "gh",
  "git",
  "go",
  "kubectl",
  "mise",
  "npm",
  "npx",
  "pnpm",
  "uv",
  "yarn",
]);

/** The rule an "Always allow" would save, without its id or date. */
export interface SuggestedRule {
  tool: string;
  pattern?: string;
}

function pattern(value: string): string | null {
  try {
    return parsePermissionPattern(value);
  } catch {
    return null;
  }
}

/**
 * The narrowest useful Allow rule for a request: `git log --oneline -5`
 * gives Bash `git log*`, a file its path from the checkout, an MCP tool its
 * own name.
 *
 * @returns null when no rule would ever answer it (a compound command, a
 *   write outside the checkout, something an Ask rule catches).
 */
export function suggestRule(
  subject: PermissionSubject,
  context: MatchContext,
): SuggestedRule | null {
  const asked = evaluate([], subject, context);
  if (asked.effect === "ask" && asked.strict) return null;
  switch (subject.kind) {
    case "bash": {
      const { parts, safe } = splitCommand(subject.command);
      const part = parts[0];
      if (!safe || parts.length !== 1 || !part) return null;
      const words = part.split(" ");
      const head = words[0] as string;
      if (!head || head.includes("=")) return null;
      const second = words[1];
      const prefix =
        TWO_WORD.has(head) && second && /^[A-Za-z][\w:.-]*$/.test(second)
          ? `${head} ${second}`
          : head;
      const found = pattern(`${prefix}*`);
      return found ? { tool: "Bash", pattern: found } : null;
    }
    case "file": {
      if (subject.paths.length !== 1) return null;
      const path = resolvedPath(subject.paths[0] as string, context);
      const rel = relative(resolve(context.checkout), path);
      const within = inside(context.checkout, path);
      if (!within && subject.tool !== "Read") return null;
      const found = pattern(within ? slashes(rel) : slashes(path));
      return found ? { tool: subject.tool, pattern: found } : null;
    }
    case "mcp":
      return { tool: subject.tool };
  }
}

/**
 * A command Codex reports as `bash -lc '<line>'` (or `zsh`, `sh`), as the
 * line it runs. Only a body without a single quote is taken out: anything
 * else stays whole, and asks.
 */
export function unwrapShell(command: string): string {
  const found = /^(?:\/\S*\/)?(?:ba|z)?sh -l?c '([^']*)'$/.exec(command.trim());
  return found ? (found[1] as string) : command;
}
