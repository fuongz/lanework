// Archive an agent conversation the CLI's own way, and bring it back (FE-72).
//
// Codex has an archive: `codex archive <id>` moves the rollout into
// `~/.codex/archived_sessions/`, and `codex resume` no longer offers it — so
// Codex's own command does it. Claude Code has none for a local conversation,
// so Lanework does what Codex does: the transcript and its folder move out of
// `~/.claude/projects/` into `~/.claude/archived_sessions/`, where
// `claude --resume` never looks, and back.
//
// NOTE: Every path is built here from ids main has already checked against
// this folder's listing (or its archived one); a page never names a file.
//
// Nothing here imports Electron: main passes the home and the Codex runner.
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createZstdDecompress } from "node:zlib";
import {
  type ArchivedAgentSession,
  isAgentSessionId,
  type TerminalAgent,
} from "../../../shared/terminal";
import { dropCodexIndex } from "./agent-delete";
import {
  claudeProjectDir,
  claudeSession,
  codexNames,
  codexPrompt,
  codexRole,
  type Line,
  lines,
  META_CHUNK,
  readRange,
  tidy,
} from "./agent-sessions";

/** Runs `codex <args>`; throws what Codex said when it fails. */
export type CodexRunner = (args: string[]) => Promise<void>;

/** Claude's folder of `folder`'s live conversations. */
const claudeLive = (home: string, folder: string) =>
  join(home, ".claude", "projects", claudeProjectDir(folder));
/** Where Lanework moves `folder`'s archived Claude conversations. */
const claudeArchive = (home: string, folder: string) =>
  join(home, ".claude", "archived_sessions", claudeProjectDir(folder));
/** Codex's own archive, one flat folder for every project. */
const codexArchive = (home: string) =>
  join(home, ".codex", "archived_sessions");

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Move `<id>.jsonl` and its `<id>/` folder from one Claude folder to another.
 *
 * Refused when the other side already has the transcript: two copies of one
 * conversation would leave nobody sure which is the real one.
 *
 * @throws when `from` has no transcript, or `to` already has one.
 */
async function moveClaude(from: string, to: string, id: string) {
  const file = join(from, `${id}.jsonl`);
  if (!(await exists(file)))
    throw new Error("That conversation has no file here.");
  if (await exists(join(to, `${id}.jsonl`)))
    throw new Error("That conversation is already there.");
  await mkdir(to, { recursive: true });
  // The folder first: once the transcript moves the rail stops listing it,
  // and a sub-agent folder left behind would be an orphan nobody sees.
  if (await exists(join(from, id))) await rename(join(from, id), join(to, id));
  await rename(file, join(to, `${id}.jsonl`));
}

/**
 * Archive a conversation main has checked is one of `folder`'s.
 *
 * @throws when `id` is not a session id, or the move or `codex archive`
 *   fails.
 */
export async function archiveAgentTranscript(
  home: string,
  folder: string,
  agent: TerminalAgent,
  id: string,
  codex: CodexRunner,
): Promise<void> {
  if (!isAgentSessionId(id))
    throw new Error("A valid conversation is required");
  if (agent === "claude")
    return moveClaude(
      claudeLive(home, folder),
      claudeArchive(home, folder),
      id,
    );
  // NOTE: Named, never "the other one": OpenCode keeps no archive (FE-104/D11).
  if (agent !== "codex") throw new Error("This agent has no archive.");
  await codex(["archive", id]);
}

/**
 * Bring back a conversation main has checked is in `folder`'s archive.
 *
 * @throws when `id` is not a session id, or the move or `codex unarchive`
 *   fails.
 */
export async function unarchiveAgentTranscript(
  home: string,
  folder: string,
  agent: TerminalAgent,
  id: string,
  codex: CodexRunner,
): Promise<void> {
  if (!isAgentSessionId(id))
    throw new Error("A valid conversation is required");
  if (agent === "claude")
    return moveClaude(
      claudeArchive(home, folder),
      claudeLive(home, folder),
      id,
    );
  // NOTE: Named, never "the other one": OpenCode keeps no archive (FE-104/D11).
  if (agent !== "codex") throw new Error("This agent has no archive.");
  await codex(["unarchive", id]);
}

/**
 * The first {@link META_CHUNK} bytes of a rollout as text.
 *
 * Codex compresses the ones it has archived a while (`.jsonl.zst`): those
 * are inflated only that far.
 */
async function rolloutHead(file: string): Promise<string> {
  if (!file.endsWith(".zst")) return readRange(file, 0, META_CHUNK);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const source = createReadStream(file);
    const inflate = createZstdDecompress();
    const done = () => {
      source.destroy();
      inflate.destroy();
      resolve(Buffer.concat(chunks).subarray(0, META_CHUNK).toString("utf8"));
    };
    inflate.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= META_CHUNK) done();
    });
    inflate.once("end", done);
    inflate.once("error", reject);
    source.once("error", reject);
    source.pipe(inflate);
  });
}

/** One rollout in Codex's archive that belongs to the folder. */
interface CodexArchived {
  file: string;
  id: string;
  /** The conversation that spawned it, for a spawned thread. */
  parent: string | null;
  head: Line[];
}

/** The rollouts in Codex's archive that are `folder`'s, helpers left out. */
async function codexArchived(
  home: string,
  folder: string,
): Promise<CodexArchived[]> {
  const dir = codexArchive(home);
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: CodexArchived[] = [];
  for (const name of names) {
    if (
      !name.startsWith("rollout-") ||
      !(name.endsWith(".jsonl") || name.endsWith(".jsonl.zst"))
    )
      continue;
    const file = join(dir, name);
    try {
      const head = lines(await rolloutHead(file), { head: true });
      const meta = head.find((line) => line.type === "session_meta")?.payload as
        | Record<string, unknown>
        | undefined;
      if (!meta || meta.cwd !== folder || !isAgentSessionId(meta.id)) continue;
      const role = codexRole(meta);
      if (role.kind === "helper") continue;
      out.push({
        file,
        id: meta.id,
        parent: role.kind === "spawned" ? role.root : null,
        head,
      });
    } catch {
      // Being written, gone, or not a rollout: the next one.
    }
  }
  return out;
}

/** `folder`'s archived conversations, Claude's and Codex's, newest first. */
export async function listArchivedAgentSessions(
  home: string,
  folder: string,
): Promise<ArchivedAgentSession[]> {
  const claude = async (): Promise<ArchivedAgentSession[]> => {
    const dir = claudeArchive(home, folder);
    const names = await readdir(dir).catch(() => [] as string[]);
    const read = await Promise.all(
      names
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => name.slice(0, -6))
        .filter(isAgentSessionId)
        .map((id) =>
          claudeSession(join(dir, `${id}.jsonl`), id, folder).catch(() => null),
        ),
    );
    return read.flatMap((session) =>
      session
        ? [
            {
              id: session.id,
              agent: "claude" as const,
              title: session.title,
              updatedAt: session.updatedAt,
            },
          ]
        : [],
    );
  };
  const codex = async (): Promise<ArchivedAgentSession[]> => {
    const titles = await codexNames(home);
    const out: ArchivedAgentSession[] = [];
    for (const entry of await codexArchived(home, folder)) {
      if (entry.parent) continue;
      const named = titles.get(entry.id);
      const title = named
        ? tidy(named)
        : entry.head.map(codexPrompt).find(Boolean);
      if (!title) continue;
      const info = await stat(entry.file).catch(() => null);
      if (!info) continue;
      out.push({
        id: entry.id,
        agent: "codex",
        title,
        updatedAt: info.mtime.toISOString(),
      });
    }
    return out;
  };
  const [a, b] = await Promise.all([
    claude().catch(() => []),
    codex().catch(() => []),
  ]);
  return [...a, ...b].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
}

/**
 * Delete an archived conversation for good.
 *
 * It removes the same files as deleting a live conversation, from the
 * archive instead. A Codex conversation takes its spawned threads with it.
 *
 * @throws when `id` is not a session id, or the archive has no file for it.
 */
export async function deleteArchivedTranscript(
  home: string,
  folder: string,
  agent: TerminalAgent,
  id: string,
): Promise<void> {
  if (!isAgentSessionId(id))
    throw new Error("A valid conversation is required");
  if (agent === "claude") {
    const dir = claudeArchive(home, folder);
    await rm(join(dir, `${id}.jsonl`));
    await rm(join(dir, id), { recursive: true, force: true });
    return;
  }
  const doomed = (await codexArchived(home, folder)).filter(
    (entry) => entry.id === id || entry.parent === id,
  );
  if (doomed.length === 0)
    throw new Error("That conversation has no file here.");
  for (const entry of doomed) await rm(entry.file, { force: true });
  await dropCodexIndex(join(home, ".codex"), id);
}
