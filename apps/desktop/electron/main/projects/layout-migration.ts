// The one-time move from the flat `<home>/projects/` of older builds to one
// folder per project (FE-108). Electron-free and synchronous: main runs it at
// startup, right after `moveLegacyProjectsDir()`, before anything reads the
// folder, and the unit tests run it against a temp home.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { MachineRecord } from "../auth/store";
import { projectsDir } from "../paths";
import { accountKey, isSlug, LOCAL_API } from "./store";

const HEX = "[0-9a-f]{64}";
const ACTIVE = new RegExp(`^(${HEX})\\.json$`);
const FOLDERS = new RegExp(`^folders-(${HEX})\\.json$`);
const BOARD = new RegExp(`^board-(${HEX})\\.json$`);
const MIGRATION = new RegExp(`^migration-(${HEX})\\.json$`);

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * The flat key local mode's files were filed under (`LOCAL_RECORD`).
 *
 * Computed only when there is something to move: `accountKey` logs once that
 * `lanework-local:` is not a control-plane URL.
 */
const localKey = () =>
  accountKey({
    machineId: "local",
    secret: "",
    apiUrl: LOCAL_API,
    name: "local",
    userId: null,
    owner: null,
  } as MachineRecord);

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Move `from` to `to`, unless `to` is already there: then `from` goes. */
function place(from: string, to: string): void {
  mkdirSync(join(to, ".."), { recursive: true, mode: 0o700 });
  if (existsSync(to)) rmSync(from, { force: true });
  else renameSync(from, to);
}

/**
 * Move every flat file into its account's and project's folder, once.
 *
 * - `<key>.json` → `<account>/active.json`; its id and slug seed the
 *   account's id → slug index.
 * - `folders-<key>.json` → one `<account>/<slug>/folders.json` per project.
 * - `board-*` / `migration-*` name their project's id inside. The account is
 *   the one whose key hashes with that id to the file name. With a known slug
 *   the file goes to `<account>/<slug>/`, else to `.pending/` until the next
 *   list read names it (`indexProjects`). A file no account claims is a stale
 *   cache and is deleted, as are leftover `*.tmp` files (FE-108/D3).
 *
 * A launch with no flat files left does nothing.
 *
 * @returns How many flat files it handled; 0 when there was nothing to do.
 */
export function migrateProjectsLayout(dir = projectsDir()): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const flat = names.filter(
    (name) =>
      name.endsWith(".tmp") ||
      ACTIVE.test(name) ||
      FOLDERS.test(name) ||
      BOARD.test(name) ||
      MIGRATION.test(name),
  );
  if (!flat.length) return 0;

  const local = localKey();
  const accountName = (key: string) => (key === local ? "local" : key);
  const keys = new Set<string>([local]);
  for (const name of flat) {
    const key = ACTIVE.exec(name)?.[1] ?? FOLDERS.exec(name)?.[1];
    if (key) keys.add(key);
  }
  /** id → slug per account key, from the active files. */
  const slugs = new Map<string, Record<string, string>>();

  for (const name of flat) {
    const file = join(dir, name);
    try {
      if (name.endsWith(".tmp")) {
        rmSync(file, { force: true });
        continue;
      }
      const active = ACTIVE.exec(name);
      if (active) {
        const key = active[1] as string;
        const data = readJson(file) as {
          activeId?: unknown;
          activeSlug?: unknown;
        } | null;
        if (
          typeof data?.activeId === "string" &&
          typeof data.activeSlug === "string" &&
          isSlug(data.activeSlug)
        )
          slugs.set(key, {
            ...slugs.get(key),
            [data.activeId]: data.activeSlug,
          });
        place(file, join(dir, accountName(key), "active.json"));
        continue;
      }
      const folders = FOLDERS.exec(name);
      if (folders) {
        const key = folders[1] as string;
        const data = readJson(file) as {
          v?: unknown;
          folders?: unknown;
        } | null;
        if (
          (data?.v === 1 || data?.v === 2) &&
          data.folders &&
          typeof data.folders === "object"
        )
          for (const [slug, entry] of Object.entries(
            data.folders as Record<string, unknown>,
          )) {
            // `v1`: one path per slug. `v2`: the list, primary first.
            const paths = (Array.isArray(entry) ? entry : [entry]).filter(
              (path): path is string =>
                typeof path === "string" && path.length > 0,
            );
            if (!paths.length || !isSlug(slug)) continue;
            const target = join(dir, accountName(key), slug, "folders.json");
            if (existsSync(target)) continue;
            mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
            writeFileSync(target, JSON.stringify({ v: 1, paths }), {
              mode: 0o600,
            });
          }
        rmSync(file, { force: true });
      }
    } catch (error) {
      console.warn(`Could not move ${name} into its project folder`, error);
    }
  }

  // After the active files, so their slugs are known.
  for (const name of flat) {
    const board = BOARD.exec(name);
    const migration = MIGRATION.exec(name);
    if (!board && !migration) continue;
    const file = join(dir, name);
    try {
      const data = readJson(file) as {
        view?: { workspaceId?: unknown };
        run?: { workspaceId?: unknown };
      } | null;
      const id = (board ? data?.view : data?.run)?.workspaceId;
      const hash = (board ?? migration)?.[1];
      const key =
        typeof id === "string"
          ? [...keys].find(
              (candidate) =>
                sha(
                  board ? `${candidate}:${id}` : `${candidate}:${id}:migration`,
                ) === hash,
            )
          : undefined;
      if (!key || typeof id !== "string") {
        rmSync(file, { force: true });
        continue;
      }
      const slug = slugs.get(key)?.[id];
      const folder = slug
        ? join(dir, accountName(key), slug)
        : join(dir, accountName(key), ".pending", sha(id));
      place(file, join(folder, board ? "board.json" : "migration.json"));
    } catch (error) {
      console.warn(`Could not move ${name} into its project folder`, error);
    }
  }

  for (const [key, known] of slugs)
    try {
      const index = join(dir, accountName(key), "projects.json");
      if (!existsSync(index))
        writeFileSync(index, JSON.stringify({ v: 1, slugs: known }), {
          mode: 0o600,
        });
    } catch {
      // The next list read writes it.
    }
  return flat.length;
}
