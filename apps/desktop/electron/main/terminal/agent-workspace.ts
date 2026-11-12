// Where an agent conversation works and what it committed, read from its
// transcript and from git (the agent view's workspace line).
//
// NOTE: Commits are only those the conversation's OWN shell calls made: a
// `git commit` whose result printed `[branch shortsha] subject`. One made in a
// terminal, or by a tool that hides its output, is in no transcript, and the
// UI must not read "not listed" as "not committed".
//
// Read-only, and nothing here imports Electron: main calls it, and a spec can
// drive it under plain Node against a fake home folder.
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  AgentCommit,
  AgentWorkspace,
  TerminalAgent,
} from "../../../shared/terminal";
import { gitRead } from "../git/runner";
import { readsAllowed } from "../git/trust-gate";
import {
  AGENT_FILES_READ_MAX,
  claudeSources,
  codexMeta,
  codexSources,
  type Source,
} from "./agent-files";
import { type Line, readRange } from "./agent-sessions";
import { opencodeShellCalls } from "./opencode-details";
import { opencodeDataDirOf } from "./opencode-sessions";

/** The most commits one answer lists. */
export const AGENT_COMMITS_MAX = 20;

/** Candidates resolved, so commits git no longer knows do not empty the list. */
const CANDIDATES_MAX = AGENT_COMMITS_MAX * 2;

/** How long one git read may run: these are local, tiny reads. */
const GIT_TIMEOUT = 5_000;

/** A shell command that commits. `git -C dir commit` and `git -c k=v commit` too. */
const COMMIT_COMMAND = /\bgit\b(?:\s+-[cC]\s+\S+)*\s+commit\b/;

/** The line git prints after a commit: `[branch (root-commit) sha] subject`. */
const COMMIT_RESULT = /^\[[^\]\n]* ([0-9a-f]{7,40})\]/gm;

/** A non-empty string, or null. */
const str = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

/** What one transcript says: its newest cwd and branch, its commits' shas. */
interface Said {
  cwd: string | null;
  branch: string | null;
  /** Abbreviated or full shas, oldest first. */
  shas: string[];
}

/** The text of a Claude `tool_result`'s content. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Record<string, unknown>[])
    .map((part) => str(part?.text) ?? "")
    .join("\n");
}

/** The shas a result's text printed. */
function printed(text: string): string[] {
  return [...text.matchAll(COMMIT_RESULT)].map((match) => match[1] as string);
}

/**
 * The last `AGENT_FILES_READ_MAX` bytes of `file`, whole lines only.
 *
 * NOTE: The tail, as agent-files does: the newest cwd and the newest commits
 * are the ones that matter.
 */
async function tail(file: string): Promise<string[]> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return [];
  const from = Math.max(0, info.size - AGENT_FILES_READ_MAX);
  const text = await readRange(file, from, info.size - from).catch(() => "");
  const all = text.split("\n");
  // A read that began mid-line: its first piece is not a line.
  return from > 0 ? all.slice(1) : all;
}

/** Parse `raw` when it is a JSON object; null otherwise. */
function parse(raw: string): Line | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Line) : null;
  } catch {
    return null;
  }
}

/** One Claude or Codex transcript, read for its cwd, branch and commits. */
async function scanFile(file: string, agent: TerminalAgent): Promise<Said> {
  const said: Said = { cwd: null, branch: null, shas: [] };
  const commitCalls = new Set<string>();
  const rows = await tail(file);
  // Newest first for the cwd; the loop below keeps the first one it meets.
  for (let i = rows.length - 1; i >= 0 && !(said.cwd && said.branch); i--) {
    const row = rows[i] as string;
    if (!row.includes('"cwd"') && !row.includes('"gitBranch"')) continue;
    const line = parse(row);
    if (!line) continue;
    const payload = line.payload as Record<string, unknown> | undefined;
    said.cwd ??= str(line.cwd) ?? str(payload?.cwd);
    said.branch ??= str(line.gitBranch);
  }
  for (const row of rows) {
    if (agent === "claude") {
      if (!row.includes("git") || !row.includes("commit")) continue;
      const line = parse(row);
      const content = (line?.message as { content?: unknown } | undefined)
        ?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content as Record<string, unknown>[]) {
        if (part?.type === "tool_use" && part.name === "Bash") {
          const command = str((part.input as { command?: unknown })?.command);
          if (command && COMMIT_COMMAND.test(command) && part.id)
            commitCalls.add(String(part.id));
        } else if (
          part?.type === "tool_result" &&
          commitCalls.has(String(part.tool_use_id)) &&
          part.is_error !== true
        )
          said.shas.push(...printed(resultText(part.content)));
      }
    } else {
      if (!row.includes("commit")) continue;
      const line = parse(row);
      const payload = line?.payload as Record<string, unknown> | undefined;
      if (line?.type !== "response_item" || !payload) continue;
      if (payload.type === "function_call") {
        if (
          typeof payload.arguments === "string" &&
          COMMIT_COMMAND.test(payload.arguments) &&
          payload.call_id
        )
          commitCalls.add(String(payload.call_id));
      } else if (
        payload.type === "function_call_output" &&
        commitCalls.has(String(payload.call_id))
      ) {
        const output = payload.output;
        // Older CLIs wrap the output as `{"output": "…"}` in a string.
        const text =
          typeof output === "string"
            ? output
            : resultText((output as { content?: unknown })?.content);
        said.shas.push(...printed(text), ...printed(unwrap(text)));
      }
    }
  }
  return said;
}

/** `{"output":"…"}` unwrapped; the text itself otherwise. */
function unwrap(text: string): string {
  const parsed = text.startsWith("{") ? parse(text) : null;
  return str(parsed?.output) ?? text;
}

/** What every source of the conversation says, merged: newest cwd wins. */
async function transcriptSaid(
  home: string,
  folder: string,
  agent: Exclude<TerminalAgent, "opencode">,
  id: string,
): Promise<Said> {
  const sources: Source[] =
    agent === "claude"
      ? await claudeSources(home, folder, id)
      : await codexSources(home, folder, id);
  // The conversation's own transcript is first; its sub-agents follow.
  const reads = await Promise.all(
    sources.map((source) => scanFile(source.file, agent).catch(() => null)),
  );
  const own = reads[0];
  const said: Said = {
    cwd: own?.cwd ?? null,
    branch: own?.branch ?? null,
    shas: reads.flatMap((read) => read?.shas ?? []),
  };
  if (!said.cwd && agent === "codex") {
    const own = sources[0];
    const meta = own ? await codexMeta(own.file).catch(() => null) : null;
    said.cwd = str(meta?.cwd);
  }
  return said;
}

/** Git's answer in `cwd`, or null when it cannot give one. */
async function git(
  cwd: string,
  args: string[],
  ok?: number[],
): Promise<{ out: string; code: number } | null> {
  try {
    const { stdout, code } = await gitRead(cwd, args, {
      timeout: GIT_TIMEOUT,
      ok,
      // NOTE: Never a prompt: no terminal, no askpass, no pager.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
    });
    return { out: stdout.trim(), code };
  } catch {
    return null;
  }
}

/** The branch, worktree and commits git reports for `shas` in `cwd`. */
async function fromGit(
  cwd: string,
  shas: string[],
): Promise<Pick<AgentWorkspace, "branch" | "worktree" | "commits"> | null> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top?.out) return null;
  const [head, dir, common] = await Promise.all([
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]),
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ]);
  const branch = head?.out && head.out !== "HEAD" ? head.out : null;
  const linked = !!dir?.out && !!common?.out && dir.out !== common.out;
  const commits: AgentCommit[] = [];
  const seen = new Set<string>();
  // Newest first; a sha is resolved once however often it was printed.
  for (const sha of [...shas].reverse()) {
    if (commits.length >= AGENT_COMMITS_MAX) break;
    const found = await git(cwd, [
      "log",
      "-1",
      "--format=%H%x00%h%x00%cI%x00%s",
      `${sha}^{commit}`,
    ]);
    const [full, short, at, ...subject] = found?.out.split("\0") ?? [];
    if (!full || !short || seen.has(full)) continue;
    seen.add(full);
    const ancestor = await git(
      cwd,
      ["merge-base", "--is-ancestor", full, "HEAD"],
      [1],
    );
    commits.push({
      sha: full,
      shortSha: short,
      subject: subject.join("\0"),
      at: at || null,
      onBranch: ancestor?.code === 0,
    });
  }
  return {
    branch,
    worktree: { path: top.out, linked },
    commits,
  };
}

/**
 * Where conversation `id` of `agent` works, and what it committed.
 *
 * - `cwd`: the newest working directory its transcript names (OpenCode: the
 *   session's own directory).
 * - `branch`, `worktree`: read live from git in `cwd` while it exists, the
 *   transcript's `gitBranch` when git cannot answer.
 * - `commits`: see the file's NOTE; each resolved in `cwd`, a commit git no
 *   longer knows skipped.
 *
 * NOTE: Git runs only where {@link readsAllowed} says an automatic read may,
 * as every other unprompted read of a linked folder does; otherwise only the
 * transcript's facts are answered.
 *
 * Never throws: a missing transcript or folder is nulls and no commits.
 */
export async function readAgentWorkspace(
  home: string,
  folder: string,
  { agent, id }: { agent: TerminalAgent; id: string },
): Promise<AgentWorkspace> {
  let said: Said = { cwd: null, branch: null, shas: [] };
  try {
    if (agent === "opencode") {
      const found = await opencodeShellCalls(
        opencodeDataDirOf(home),
        folder,
        id,
      );
      said = {
        cwd: folder,
        branch: null,
        shas: found.flatMap((output) => printed(output)),
      };
    } else said = await transcriptSaid(home, folder, agent, id);
  } catch {
    // Not one of this project's, or unreadable: nothing to say.
  }
  const shas = [...new Set(said.shas)].slice(-CANDIDATES_MAX);
  const cwd = said.cwd
    ? isAbsolute(said.cwd)
      ? said.cwd
      : resolve(folder, said.cwd)
    : null;
  const here = cwd && (await stat(cwd).catch(() => null))?.isDirectory();
  const live =
    cwd && here && (await readsAllowed(cwd).catch(() => false))
      ? await fromGit(cwd, shas).catch(() => null)
      : null;
  return {
    cwd,
    branch: live ? live.branch : said.branch,
    worktree: live?.worktree ?? null,
    commits: live?.commits ?? [],
  };
}
