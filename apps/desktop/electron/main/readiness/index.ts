// Is this project's folder ready for an agent to work its board? (FE-30)
//
// Gathered here, in main, because every answer is on the disk or behind the
// machine: the folder link, origin remote, AGENTS.md, CLAUDE.md, `.mcp.json`,
// `~/.claude.json`, Codex's `config.toml` and the checkpoint hooks.
// Cloud boards also look up which board the folder's origin belongs to.
// Judging the facts is `checks.ts`, which is pure.
//
// NOTE: The renderer names a project by SLUG and a fix by NAME. Every path is
// resolved here from the folder links this process wrote down, so no renderer
// can point a read, or the one kind of write, at a file of its choosing.
//
// NOTE: This is the ONLY writer of a user's folder in this app, and only
// after the diff was shown and confirmed (FE-30/D5): AGENTS.md, CLAUDE.md or
// `.mcp.json`, one appended block or one added key. Nothing is committed, and
// nothing outside the folder (`~/.claude.json`, `config.toml`) is written.
import { randomUUID } from "node:crypto";
import { readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isReadinessFix,
  type ReadinessFix,
  type ReadinessLinkResult,
  type ReadinessPreview,
  type ReadinessReport,
  readinessChannels,
} from "../../../shared/readiness";
import { claudeDir, claudeJsonPath, readText } from "../agent-home";
import { opencodeConfigDir, opencodeConfigPath } from "../agent-setup/opencode";
import { gitReadOut } from "../git/runner";
import {
  claudeSettingsPath,
  findHook,
  readSettings,
} from "../handoff/claude-settings";
import { codexConfigPath, codexHome, codexHooksPath } from "../handoff/codex";
import { opencodePluginPath, readOpencodePlugin } from "../handoff/opencode";
import { handle } from "../ipc";
import { fetchBoardsForRepo, linkRepoToBoard } from "../projects/client";
import { folderExists } from "../projects/local-folder";
import {
  assertSameSession,
  knownProject,
  LOCAL_RECORD,
} from "../projects/session";
import { readFolders } from "../projects/store";
import { opencodeDataDir } from "../terminal/opencode-sessions";
import { agentHomeDir } from "../test-seams";
import {
  applyFix,
  type BoardLink,
  boardLinkOf,
  buildReport,
  claudeHasLanework,
  codexHasLanework,
  FIX_FILES,
  opencodeHasLanework,
  type ReadinessFacts,
} from "./checks";

/** Whether anything is at `path`. */
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Whether the settings file at `path` carries the checkpoint hook. */
async function hookInstalled(path: string): Promise<boolean> {
  const read = await readSettings(path);
  return read.ok && findHook(read.settings) !== null;
}

/** Whether `folder` still has card files under `.agents/reviews/`. */
async function hasLegacyReviews(folder: string): Promise<boolean> {
  const entries = await readdir(join(folder, ".agents", "reviews")).catch(
    () => [] as string[],
  );
  return entries.some((name) => !name.startsWith("."));
}

/**
 * The project and its primary folder on this machine.
 *
 * @returns `path: null` when the project has no folder here.
 */
async function resolve(slug: string) {
  const { record, project } = await knownProject(slug);
  const [path] = (await readFolders(record))[project.slug] ?? [];
  return { record, project, path: path ?? null };
}

/**
 * Read every fact the readiness report judges.
 *
 * Claude's and Codex's files are read only when that CLI is used on this
 * machine.
 */
/**
 * OpenCode on this machine (FE-104): used, hooked, and whether its user
 * config, or the folder's own, has the lanework MCP server.
 */
async function opencodeFacts(folder: string | null) {
  const home = agentHomeDir();
  const realHome = home === homedir();
  const configDir = opencodeConfigDir(home);
  const used = (
    await Promise.all([
      exists(configDir),
      exists(opencodeDataDir(home, process.env, realHome)),
    ])
  ).some(Boolean);
  if (!used) return { used, hook: false, mcp: false };
  const plugin = await readOpencodePlugin(opencodePluginPath(configDir));
  const configs = [
    opencodeConfigPath(home),
    ...(folder
      ? ["opencode.json", "opencode.jsonc"].map((name) => join(folder, name))
      : []),
  ];
  const texts = await Promise.all(configs.map((path) => readText(path)));
  return {
    used,
    hook: plugin.kind === "ours",
    mcp: texts.some(opencodeHasLanework),
  };
}

async function gather(slug: string): Promise<ReadinessFacts> {
  const { record, project, path } = await resolve(slug);
  const [claudeUsed, codexUsed] = await Promise.all([
    Promise.all([exists(claudeDir()), exists(claudeJsonPath())]).then((found) =>
      found.some(Boolean),
    ),
    exists(codexHome()),
  ]);
  const [claudeHook, codexHook, codexToml, claudeJson] = await Promise.all([
    claudeUsed ? hookInstalled(claudeSettingsPath()) : false,
    codexUsed ? hookInstalled(codexHooksPath()) : false,
    codexUsed ? readText(codexConfigPath()) : null,
    claudeUsed ? readText(claudeJsonPath()) : null,
  ]);

  let folder: ReadinessFacts["folder"];
  if (!path) folder = { kind: "none" };
  else if (!(await folderExists(path))) folder = { kind: "missing", path };
  else {
    const [agentsMd, claudeMd, mcpJson, legacyReviews] = await Promise.all([
      readText(join(path, "AGENTS.md")),
      readText(join(path, "CLAUDE.md")),
      readText(join(path, ".mcp.json")),
      hasLegacyReviews(path),
    ]);
    let repo: { remote: string | null; board: BoardLink } | undefined;
    if (record !== LOCAL_RECORD && project.id) {
      const remote = await originUrl(path);
      const board = remote
        ? await fetchBoardsForRepo(record, remote)
            .then((boards) => boardLinkOf(boards, project.id as string))
            .catch(() => ({ kind: "unknown" }) as const)
        : ({ kind: "unknown" } as const);
      repo = { remote, board };
    }
    folder = {
      kind: "linked",
      repo,
      path,
      agentsMd,
      claudeMd,
      claudeMcp: claudeHasLanework({ folder: path, mcpJson, claudeJson }),
      legacyReviews,
    };
  }

  return {
    slug: project.slug,
    folder,
    claude: { used: claudeUsed, hook: claudeHook },
    codex: {
      used: codexUsed,
      hook: codexHook,
      mcp: codexHasLanework(codexToml),
    },
    opencode: await opencodeFacts(path),
    checkedAt: new Date().toISOString(),
  };
}

/** Read only the linked folder's origin, through the safe git runner. */
async function originUrl(folder: string): Promise<string | null> {
  return gitReadOut(folder, ["remote", "get-url", "origin"], {
    timeout: 5_000,
    maxBuffer: 16_384,
  }).then(
    (value) => value.trim() || null,
    () => null,
  );
}

/**
 * Make this project's board THE board for its folder's repo (BE-20): the
 * remote is read here from the folder this process linked, never sent by the
 * renderer — like every path in this file.
 */
async function linkBoard(
  slug: string,
  replace: boolean,
): Promise<ReadinessLinkResult> {
  const { record, project, path } = await resolve(slug);
  if (record === LOCAL_RECORD)
    throw new Error("Local boards do not have a cloud repo link.");
  await assertSameSession(record);
  if (!project.id)
    throw new Error("This project has no board on the service to link to.");
  if (!path || !(await folderExists(path)))
    throw new Error("This project has no folder on this machine.");
  const remote = await originUrl(path);
  if (!remote)
    throw new Error("This folder has no origin remote to link to the board.");
  const moved = await linkRepoToBoard(record, project.id, remote, replace);
  if (!moved.ok) return { done: false, linked: moved.linked };
  return {
    done: true,
    report: await readinessOf(slug),
    unlinked: moved.unlinked.map((board) => board.name),
  };
}

async function readinessOf(slug: string): Promise<ReadinessReport> {
  return buildReport(await gather(slug));
}

/**
 * The absolute path of the file `fix` writes in the project's folder.
 *
 * @throws when the project has no folder on this machine.
 */
async function fixTarget(slug: string, fix: ReadinessFix): Promise<string> {
  const { path } = await resolve(slug);
  if (!path || !(await folderExists(path)))
    throw new Error("This project has no folder on this machine to fix.");
  return join(path, FIX_FILES[fix]);
}

/** The file `fix` writes, before and after the fix. */
async function preview(
  slug: string,
  fix: ReadinessFix,
): Promise<ReadinessPreview> {
  const file = await fixTarget(slug, fix);
  const before = await readText(file);
  return { fix, file: FIX_FILES[fix], before, after: applyFix(fix, before) };
}

/**
 * Write `fix` into the project's folder, atomically.
 *
 * @param expected The file as the preview showed it.
 * @throws when the file changed since the preview, or cannot be written.
 */
async function apply(
  slug: string,
  fix: ReadinessFix,
  expected: string | null,
): Promise<ReadinessReport> {
  const file = await fixTarget(slug, fix);
  const before = await readText(file);
  // NOTE: The file as the PREVIEW showed it, or nothing is written. An editor
  // that saved in between would otherwise lose what it saved.
  if (before !== expected)
    throw new Error(
      `${FIX_FILES[fix]} changed since the preview. Look at it again before applying.`,
    );
  const after = applyFix(fix, before);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, after, { mode: 0o644 });
    await rename(temporary, file);
  } catch {
    throw new Error(`Could not write ${FIX_FILES[fix]} in this folder.`);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return readinessOf(slug);
}

/**
 * The project slug the renderer sent.
 *
 * @throws when `value` is not a slug.
 */
function slugArg(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("A project is required");
  return value;
}

/**
 * The fix the renderer named.
 *
 * @throws when `value` is not a known fix.
 */
function fixArg(value: unknown): ReadinessFix {
  if (!isReadinessFix(value)) throw new Error("Unknown fix");
  return value;
}

/** Register the readiness IPC handlers: check, preview and apply. */
export function registerReadiness(devUrl?: string): void {
  handle(readinessChannels.check, devUrl, (args) => {
    if (args.length !== 1) throw new Error("check takes one project");
    return readinessOf(slugArg(args[0]));
  });
  handle(readinessChannels.linkBoard, devUrl, (args) => {
    if (args.length !== 2 || typeof args[1] !== "boolean")
      throw new Error("linkBoard takes a project and whether to replace");
    return linkBoard(slugArg(args[0]), args[1]);
  });
  handle(readinessChannels.preview, devUrl, (args) => {
    if (args.length !== 2) throw new Error("preview takes a project and a fix");
    return preview(slugArg(args[0]), fixArg(args[1]));
  });
  handle(readinessChannels.apply, devUrl, (args) => {
    if (args.length !== 3 || !(args[2] === null || typeof args[2] === "string"))
      throw new Error("apply takes a project, a fix and the previewed file");
    return apply(slugArg(args[0]), fixArg(args[1]), args[2]);
  });
}
