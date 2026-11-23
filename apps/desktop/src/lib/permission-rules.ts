// Permission rules as the renderer reads them (FE-165): the rule a request
// suggests, whether a built-in Ask rule already covers it, and how a rule is
// named in a list.
//
// NOTE: Main owns the evaluator. What is matched here only decides what the
// card and the settings page SAY (a suggestion, an unavailable action); a
// rule is always enforced by main, and an Ask rule wins there whatever this
// says.

import {
  isPermissionTool,
  OUTSIDE_CHECKOUT_PATTERN,
  PERMISSION_PATTERN_MAX,
  type PermissionRule,
  parsePermissionPattern,
  SEEDED_ASK_RULES,
} from "#/../shared/permissions";

/** A rule's tool and pattern, as the editor holds them. */
export interface RuleDraft {
  tool: string;
  /** "" for none: the whole tool. */
  pattern: string;
}

const FILE_TOOLS: readonly string[] = ["Edit", "Write", "Read"];

/** One string field of a tool's input JSON, even when the JSON was cut short. */
function inputField(input: string, key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>)[key];
      return typeof value === "string" ? value : null;
    }
  } catch {
    // Cut at TOOL_TEXT_MAX: read the field out of the text as far as it goes.
  }
  const found = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(
    input,
  );
  if (!found?.[1]) return null;
  try {
    const decoded: unknown = JSON.parse(`"${found[1]}"`);
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
}

/** What a tool acts on: a Bash command or a file's path; null for any other. */
export function toolTarget(tool: string, input: string): string | null {
  if (tool === "Bash") return inputField(input, "command");
  if (FILE_TOOLS.includes(tool))
    return inputField(input, "file_path") ?? inputField(input, "path");
  return null;
}

/** Whether a rule may name `tool`: Bash, a file tool, or an MCP tool. */
export const canBeRule = (tool: string): boolean => isPermissionTool(tool);

const usable = (pattern: string): boolean => {
  try {
    parsePermissionPattern(pattern);
    return true;
  } catch {
    return false;
  }
};

/**
 * The rule a request suggests: a Bash command's first words with a trailing
 * `*`, a file's folder with `/**`, an MCP tool as it is.
 */
export function suggestRule(tool: string, input: string): RuleDraft {
  const target = toolTarget(tool, input);
  if (!target) return { tool, pattern: "" };
  if (tool === "Bash") {
    const words = target.trim().split(/\s+/);
    const head = words[0] ?? "";
    const second = words[1];
    const prefix =
      second && /^[A-Za-z0-9._:@/-]+$/.test(second) && !second.startsWith("-")
        ? `${head} ${second}`
        : head;
    for (const candidate of [prefix, head]) {
      const pattern = `${candidate}*`;
      if (candidate && usable(pattern)) return { tool, pattern };
    }
    return { tool, pattern: "" };
  }
  const slash = target.lastIndexOf("/");
  const folder = slash > 0 ? target.slice(0, slash) : "";
  const pattern = folder ? `${folder}/**` : target;
  return {
    tool,
    pattern:
      usable(pattern) && pattern.length <= PERMISSION_PATTERN_MAX
        ? pattern
        : "",
  };
}

/** Why a draft cannot be saved, or null when it can. */
export function draftProblem(draft: RuleDraft): string | null {
  if (!draft.tool.trim()) return "Name a tool.";
  if (!canBeRule(draft.tool.trim()))
    return "A rule names Bash, Edit, Write, Read, an MCP tool (mcp__server__tool) or a whole server (mcp__server__*).";
  if (draft.pattern.trim()) {
    try {
      parsePermissionPattern(draft.pattern.trim());
    } catch (failure) {
      return failure instanceof Error ? failure.message : "Check the pattern.";
    }
  }
  return null;
}

// ─── Matching (what the card says, never what runs) ─────────────────────────

const escapeGlob = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** A glob as a regular expression: `bash` lets `*` cross `/`, a path's does not. */
function globRegExp(pattern: string, path: boolean): RegExp {
  let source = "";
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at] ?? "";
    if (char === "*") {
      if (path && pattern[at + 1] !== "*") source += "[^/]*";
      else {
        source += ".*";
        if (pattern[at + 1] === "*") at++;
      }
    } else if (char === "?") source += path ? "[^/]" : ".";
    else source += escapeGlob(char);
  }
  return new RegExp(`^${source}$`, "s");
}

/** The command, and each command of a chain, so `a && git push` is seen. */
function commandParts(command: string): string[] {
  const whole = command.trim();
  return [
    whole,
    ...whole
      .split(/&&|\|\||;|\n/)
      .map((part) => part.trim())
      .filter(Boolean),
  ];
}

/** `path` made absolute against `root` and cleaned of `.` and `..`. */
function resolvePath(path: string, root: string): string {
  const absolute = path.startsWith("/") ? path : `${root}/${path}`;
  const out: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

function toolMatches(ruleTool: string, tool: string): boolean {
  if (ruleTool === tool) return true;
  return ruleTool.endsWith("__*") && tool.startsWith(ruleTool.slice(0, -1));
}

/**
 * Whether `rule` covers a request. `checkout` is the conversation's folder,
 * for the rule about paths outside it; unknown, that rule is not claimed.
 */
export function ruleCovers(
  rule: PermissionRule,
  tool: string,
  input: string,
  checkout: string | null,
): boolean {
  if (!toolMatches(rule.tool, tool)) return false;
  if (!rule.pattern) return true;
  const target = toolTarget(tool, input);
  if (target === null) return false;
  if (rule.pattern === OUTSIDE_CHECKOUT_PATTERN) {
    if (!checkout) return false;
    const root = resolvePath(checkout, "/");
    const path = resolvePath(target, root);
    return path !== root && !path.startsWith(`${root}/`);
  }
  if (tool === "Bash") {
    const pattern = globRegExp(rule.pattern, false);
    return commandParts(target).some((part) => pattern.test(part));
  }
  return globRegExp(rule.pattern, true).test(target);
}

/** The built-in Ask rule that covers a request, if one does. */
export function seededAskFor(
  tool: string,
  input: string,
  checkout: string | null,
): PermissionRule | null {
  return (
    SEEDED_ASK_RULES.find((rule) => ruleCovers(rule, tool, input, checkout)) ??
    null
  );
}

// ─── Words ──────────────────────────────────────────────────────────────────

/** A rule in a list: its tool, then its pattern when it has one. */
export function ruleLabel(rule: Pick<PermissionRule, "tool" | "pattern">) {
  if (!rule.pattern) return rule.tool;
  return rule.pattern === OUTSIDE_CHECKOUT_PATTERN
    ? `${rule.tool} outside the checkout`
    : `${rule.tool} ${rule.pattern}`;
}

/** Why a built-in rule stops "Always allow", as a sentence. */
export function seededReason(rule: PermissionRule): string {
  return `Lanework always asks first for ${ruleLabel(rule)}, whatever an allow rule says.`;
}
