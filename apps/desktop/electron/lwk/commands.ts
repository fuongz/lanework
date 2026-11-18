// `lwk find|grep|sg|ls|sessions` (FE-152) without the app: the flags, the
// call (`standalone.ts`, in the working folder) and the output.
//
// The native lwk (`apps/desktop/lwk/src/kit.rs`) is the same command with
// the app up, through its socket; it hands the same argv here when the app
// is not there to answer. Both print the same bytes: a change to the flags
// or the output is made in both.
//
// - Flags mirror the tools' inputs (`KIT_TOOLS`, lanework-dev/contracts); the
//   kit checks them, so a bad value fails with the kit's own words.
// - `--json` prints the tool's answer as the MCP server does
//   (`KitToolOutputs`). Otherwise one line per hit: `path:line: text` for
//   grep and sg, a path for find and ls, a heading and its snippets per
//   session.
// - Paths are relative to the folder searched, and prefixed with FOLDER as
//   it was typed when there is one, as grep and rg print them.
// - Exit code: 0 found, 1 nothing found (ls: 0 always), 2 an error. A cut
//   answer says so on stderr.
import { join } from "node:path";
import type {
  FileHit,
  FileMatch,
  KitToolName,
  SessionMatch,
} from "@lanework/contracts";
import { KitError } from "../kit";
import { runHere } from "./standalone";

type Command = "find" | "grep" | "sg" | "ls" | "sessions";

const TOOL: Record<Command, KitToolName> = {
  find: "find_files",
  grep: "search_text",
  sg: "search_structural",
  ls: "list_files",
  sessions: "search_sessions",
};

/** The flags each command takes: name → the input it sets. */
const FLAGS: Record<Command, Record<string, string>> = {
  find: {},
  grep: {
    "-E": "regex",
    "--regex": "regex",
    "-F": "fixed",
    "--fixed-strings": "fixed",
    "-i": "ignore_case",
    "--ignore-case": "ignore_case",
    "-s": "case_sensitive",
    "--case-sensitive": "case_sensitive",
    "-g": "globs",
    "--glob": "globs",
  },
  sg: { "--lang": "lang" },
  ls: {},
  sessions: {},
};

/** Flags that take a value. */
const VALUED = new Set(["-g", "--glob", "--lang", "--limit"]);

interface Parsed {
  params: Record<string, unknown>;
  /** FOLDER as typed, to prefix the paths printed. */
  folder?: string;
  json: boolean;
}

/** `lwk COMMAND ARGS` as the tool's params. @throws {KitError} `invalid`. */
function parse(command: Command, args: string[]): Parsed {
  const positional: string[] = [];
  const params: Record<string, unknown> = {};
  let json = false;
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    let arg = args[i] as string;
    if (literal || arg === "-" || !arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    let value: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    const known = arg === "--limit" || Object.hasOwn(FLAGS[command], arg);
    if (!known)
      throw new KitError("invalid", `unknown option ${arg}. See lwk help.`);
    if (VALUED.has(arg)) {
      if (value === undefined) {
        value = args[i + 1];
        i++;
      }
      if (value === undefined)
        throw new KitError("invalid", `${arg} needs a value.`);
    } else if (value !== undefined) {
      throw new KitError("invalid", `${arg} takes no value.`);
    }
    const name = arg === "--limit" ? "limit" : FLAGS[command][arg];
    switch (name) {
      case "limit": {
        const limit = Number(value);
        // A bad number goes to the kit as it is, to be refused in its words.
        params.limit = Number.isFinite(limit) ? limit : value;
        break;
      }
      case "globs":
        params.globs = [...((params.globs as string[]) ?? []), value];
        break;
      case "lang":
        params.lang = value;
        break;
      case "regex":
        params.regex = true;
        break;
      case "fixed":
        params.regex = false;
        break;
      case "ignore_case":
        params.case_sensitive = false;
        break;
      case "case_sensitive":
        params.case_sensitive = true;
        break;
    }
  }
  const wantsQuery = command !== "ls";
  const max = wantsQuery ? 2 : 1;
  if (positional.length > max || (wantsQuery && positional.length === 0))
    throw new KitError(
      "invalid",
      `Usage: lwk ${command} ${wantsQuery ? `${command === "sg" ? "PATTERN" : "QUERY"} ` : ""}[FOLDER]`,
    );
  const [first, second] = positional;
  const folder = wantsQuery ? second : first;
  if (wantsQuery) params[command === "sg" ? "pattern" : "query"] = first;
  if (folder !== undefined) params.folder = folder;
  return { params, folder, json };
}

/** `path` as printed: under FOLDER as typed, when one was. */
function shown(path: string, folder: string | undefined): string {
  return folder === undefined ? path : join(folder, path);
}

function out(text: string) {
  process.stdout.write(text);
}

/** Print matches as `path:line: text`. @returns How many files. */
function printMatches(matches: FileMatch[], folder?: string): number {
  const lines: string[] = [];
  for (const file of matches)
    for (const line of file.lines)
      lines.push(`${shown(file.path, folder)}:${line.line}: ${line.text}`);
  if (lines.length) out(`${lines.join("\n")}\n`);
  return matches.length;
}

function printSessions(sessions: SessionMatch[]): void {
  const blocks = sessions.map((session) =>
    [
      `${session.harness} ${session.sessionId} ${session.at} ${session.title}`,
      ...session.lines.map((line) => `  ${line.line}: ${line.text}`),
    ].join("\n"),
  );
  if (blocks.length) out(`${blocks.join("\n\n")}\n`);
}

/** Say on stderr that the answer was cut, and how to see more. */
function noteCut(what: string) {
  process.stderr.write(
    `lwk: stopped at the ${what} limit; pass --limit N for more, or narrow the folder.\n`,
  );
}

/**
 * Run `lwk COMMAND ARGS`.
 *
 * @returns The exit code.
 */
export async function runKitCommand(
  command: string,
  args: string[],
): Promise<number> {
  const name = command as Command;
  try {
    const { params, folder, json } = parse(name, args);
    const tool = TOOL[name];
    const result = await runHere(tool, params, process.cwd());
    switch (tool) {
      case "find_files": {
        const files = result as FileHit[];
        if (json) out(`${JSON.stringify({ files })}\n`);
        else if (files.length)
          out(`${files.map((hit) => shown(hit.path, folder)).join("\n")}\n`);
        return files.length ? 0 : 1;
      }
      case "search_text":
      case "search_structural": {
        const matches = result as FileMatch[];
        if (json) out(`${JSON.stringify({ matches })}\n`);
        else printMatches(matches, folder);
        if (matches.at(-1)?.truncated && !json) noteCut("file");
        return matches.length ? 0 : 1;
      }
      case "list_files": {
        const listing = result as { files: string[]; truncated: boolean };
        if (json) out(`${JSON.stringify(listing)}\n`);
        else if (listing.files.length)
          out(
            `${listing.files.map((path) => shown(path, folder)).join("\n")}\n`,
          );
        if (listing.truncated && !json) noteCut("path");
        return 0;
      }
      case "search_sessions": {
        const sessions = result as SessionMatch[];
        if (json) out(`${JSON.stringify({ sessions })}\n`);
        else printSessions(sessions);
        return sessions.length ? 0 : 1;
      }
    }
  } catch (error) {
    const message =
      error instanceof KitError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    process.stderr.write(`lwk ${command}: ${message}\n`);
    return 2;
  }
}
