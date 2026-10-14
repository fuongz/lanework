// Is this project's folder ready for an agent to work its board? (FE-30)
//
// Gathered here, in main, because every answer is on the disk or behind the
// machine: the folder link, AGENTS.md, CLAUDE.md, `.mcp.json`,
// `~/.claude.json`, Codex's config.toml and the checkpoint hooks. Nothing
// about git: the folder's remote and the repo's board are not checked here.
// Judging the facts is `checks.ts`, which is pure.
//
// ⚠️ The renderer names a project by SLUG and a fix by NAME. Every path is
// resolved here from the folder links this process wrote down, so no renderer
// can point a read — let alone the one kind of write — at a file of its
// choosing.
//
// ⚠️ The ONLY writer of a user's folder in this app, and only after the diff
// was shown and confirmed (FE-30/D5): AGENTS.md, CLAUDE.md or .mcp.json, one
// appended block or one added key. Nothing is committed, and nothing outside
// the folder — `~/.claude.json`, `config.toml` — is ever written.
import { randomUUID } from "node:crypto";
import { readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isReadinessFix,
  type ReadinessFix,
  type ReadinessPreview,
  type ReadinessReport,
  readinessChannels,
} from "../../../shared/readiness";
import { claudeDir, claudeJsonPath, readText } from "../agent-home";
import {
  claudeSettingsPath,
  findHook,
  readSettings,
} from "../handoff/claude-settings";
import { codexConfigPath, codexHome, codexHooksPath } from "../handoff/codex";
import { handle } from "../ipc";
import { knownWorkspace } from "../workspaces";
import { folderExists } from "../workspaces/local-folder";
import { readFolders } from "../workspaces/store";
import {
  applyFix,
  buildReport,
  claudeHasLanework,
  codexHasLanework,
  FIX_FILES,
  type ReadinessFacts,
} from "./checks";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function hookInstalled(path: string): Promise<boolean> {
  const read = await readSettings(path);
  return read.ok && findHook(read.settings) !== null;
}

async function hasLegacyReviews(folder: string): Promise<boolean> {
  const entries = await readdir(join(folder, ".agents", "reviews")).catch(
    () => [] as string[],
  );
  return entries.some((name) => !name.startsWith("."));
}

/** The workspace and its primary folder on this machine, or why there is none. */
async function resolve(slug: string) {
  const { record, workspace } = await knownWorkspace(slug);
  const [path] = (await readFolders(record))[workspace.slug] ?? [];
  return { workspace, path: path ?? null };
}

async function gather(slug: string): Promise<ReadinessFacts> {
  const { workspace, path } = await resolve(slug);
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
    folder = {
      kind: "linked",
      path,
      agentsMd,
      claudeMd,
      claudeMcp: claudeHasLanework({ folder: path, mcpJson, claudeJson }),
      legacyReviews,
    };
  }

  return {
    slug: workspace.slug,
    folder,
    claude: { used: claudeUsed, hook: claudeHook },
    codex: {
      used: codexUsed,
      hook: codexHook,
      mcp: codexHasLanework(codexToml),
    },
    checkedAt: new Date().toISOString(),
  };
}

export async function readinessOf(slug: string): Promise<ReadinessReport> {
  return buildReport(await gather(slug));
}

async function fixTarget(slug: string, fix: ReadinessFix): Promise<string> {
  const { path } = await resolve(slug);
  if (!path || !(await folderExists(path)))
    throw new Error("This project has no folder on this machine to fix.");
  return join(path, FIX_FILES[fix]);
}

async function preview(
  slug: string,
  fix: ReadinessFix,
): Promise<ReadinessPreview> {
  const file = await fixTarget(slug, fix);
  const before = await readText(file);
  return { fix, file: FIX_FILES[fix], before, after: applyFix(fix, before) };
}

async function apply(
  slug: string,
  fix: ReadinessFix,
  expected: string | null,
): Promise<ReadinessReport> {
  const file = await fixTarget(slug, fix);
  const before = await readText(file);
  // ⚠️ The file as the PREVIEW showed it, or nothing is written. An editor
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

function slugArg(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("A project is required");
  return value;
}

function fixArg(value: unknown): ReadinessFix {
  if (!isReadinessFix(value)) throw new Error("Unknown fix");
  return value;
}

export function registerReadiness(devUrl?: string): void {
  handle(readinessChannels.check, devUrl, (args) => {
    if (args.length !== 1) throw new Error("check takes one project");
    return readinessOf(slugArg(args[0]));
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
