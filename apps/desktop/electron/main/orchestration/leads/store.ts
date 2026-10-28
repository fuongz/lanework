// Conductors (team leads) in main (FE-88, FE-95): the two sources, merged.
// None ships with the app any more (FE-95): the user makes their own.
//
// - `personal`: the user's own, in `<dir>/personal.json`, one set per
//   project with its default (FE-95): a conductor follows its project, and
//   another project starts without it. A version-1 file (one set for every
//   project) is handed to ONE project, the first one listed after the
//   upgrade, and is gone from then on: never shown in two.
// - `repo`: `.lanework/leads/<id>.md` in the workspace's folder, frontmatter
//   then the instructions as markdown. Its context files (FE-96) are the
//   `context:` list in the frontmatter.
//
// A repo lead is `repo:<id>` (FE-89/D3), so a file a project checks in never stands in for
// a lead the user trusts, and it may not carry `jev` (D1). A repo file that
// fails to read or parse is left out and reported with its repo-relative
// path; the others still load.
//
// NOTE: A workspace is resolved to its folder here, through `folderOf`, never
// from a path the page sent. Repo files are read only when they are plain
// files directly in `.lanework/leads/`: a symlink could point anywhere.
//
// Nothing here imports Electron: `index.ts` hands in the folder, the
// resolver and the broadcast.

import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  type ContextEntry,
  type ContextPick,
  contextPath,
  LEAD_CONTEXT_FILES_MAX,
  type LeadsEvent,
  type LeadsList,
  type LeadsMainHandlers,
  leadId,
  leadRef,
  parseTeamLead,
  REPO_LEAD_PREFIX,
  type TeamLead,
} from "../../../../shared/orchestration";
import { splitFrontmatter } from "./frontmatter";

/** Where a project keeps its leads, relative to its folder. */
export const REPO_LEADS_DIR = ".lanework/leads";
/** The most repo files read per workspace; the rest are reported. */
export const REPO_LEADS_MAX = 50;
/** The largest repo file read. */
export const REPO_LEAD_BYTES = 64 * 1024;
/** The most personal leads kept. */
export const PERSONAL_LEADS_MAX = 50;

export interface LeadStoreDeps {
  /** Where `personal.json` lives; created on the first write. */
  dir: string;
  /** The folder main wrote down for a workspace; null when it has none here. */
  folderOf: (workspace: string) => Promise<string | null>;
  broadcast: (event: LeadsEvent) => void;
}

/** Every handler but the chooser, which needs Electron (`index.ts`). */
export interface LeadStore extends Omit<LeadsMainHandlers, "pickContext"> {
  /**
   * The lead a run starts under, as `list(workspace)` would show it.
   *
   * @throws {Error} When no source holds `id`, or its repo file is broken.
   */
  resolve: (workspace: string, id: string) => Promise<TeamLead>;
}

/** One project's own conductors, and its default. */
interface Bucket {
  leads: TeamLead[];
  defaultId: string | null;
}

interface PersonalFile {
  version: 2;
  /** By workspace key. */
  workspaces: Record<string, Bucket>;
  /**
   * Version 1's set, until the first project listed takes it. Ignored once
   * any project has a set of its own.
   */
  legacy: Bucket | null;
}

const emptyBucket = (): Bucket => ({ leads: [], defaultId: null });

/** One stored set, every entry checked; an unreadable one is left out. */
function parseBucket(value: unknown): Bucket {
  const raw = (value ?? {}) as { leads?: unknown; defaultId?: unknown };
  const leads: TeamLead[] = [];
  for (const entry of Array.isArray(raw.leads) ? raw.leads : []) {
    try {
      const lead = parseTeamLead(entry, "personal");
      if (!leads.some((other) => other.id === lead.id)) leads.push(lead);
    } catch {
      // One unreadable entry does not cost the others.
    }
  }
  let defaultId: string | null = null;
  try {
    defaultId = raw.defaultId == null ? null : leadRef(raw.defaultId);
  } catch {
    defaultId = null;
  }
  return { leads, defaultId };
}

/** `workspace`'s own set, or none. */
function bucketOf(file: PersonalFile, workspace: string | null): Bucket {
  if (!workspace) return emptyBucket();
  return file.workspaces[workspace] ?? emptyBucket();
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Read one repo file; throws with a message meant for the person who wrote it. */
async function readRepoLead(path: string, stem: string): Promise<TeamLead> {
  const info = await lstat(path);
  if (!info.isFile())
    throw new Error("Not a plain file (symlinks are not read)");
  if (info.size > REPO_LEAD_BYTES)
    throw new Error(`Larger than ${REPO_LEAD_BYTES / 1024} KB`);
  try {
    leadId(stem);
  } catch {
    throw new Error(
      "The file name must be the lead's id: 1-48 lowercase letters, digits or -, then .md",
    );
  }
  const { frontmatter, body } = splitFrontmatter(await readFile(path, "utf8"));
  if ("instructions" in frontmatter)
    throw new Error(
      "instructions go in the markdown below the frontmatter, not in it",
    );
  if ("source" in frontmatter)
    throw new Error("source is not a frontmatter key");
  if ("contextFiles" in frontmatter)
    throw new Error("context files go in a context: list, not contextFiles");
  const { context, ...rest } = frontmatter;
  if (
    frontmatter.id != null &&
    frontmatter.id !== stem &&
    frontmatter.id !== `${REPO_LEAD_PREFIX}${stem}`
  )
    throw new Error(
      `id "${String(frontmatter.id)}" does not match the file name "${stem}.md"`,
    );
  return parseTeamLead(
    {
      ...rest,
      id: stem,
      contextFiles: context ?? [],
      checks: frontmatter.checks ?? [],
      jev: frontmatter.jev ?? null,
      permission: frontmatter.permission ?? null,
      instructions: body,
    },
    "repo",
  );
}

/** Whether `path` is `root` or under it; both already real paths. */
function inside(root: string, path: string): boolean {
  return (
    path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}

/**
 * Each path as it stands under `folder` now. A path that resolves outside
 * it (a symlink out of the project) reads as missing: never followed.
 */
export async function inspectContextIn(
  folder: string | null,
  paths: readonly string[],
): Promise<ContextEntry[]> {
  const root = folder ? await realpath(folder).catch(() => null) : null;
  return Promise.all(
    paths.slice(0, LEAD_CONTEXT_FILES_MAX).map(async (path) => {
      const missing: ContextEntry = { path, kind: "missing" };
      if (!root) return missing;
      try {
        const real = await realpath(join(root, contextPath(path)));
        if (!inside(root, real) || real === root) return missing;
        const info = await stat(real);
        if (info.isDirectory()) return { path, kind: "folder" as const };
        return info.isFile() ? { path, kind: "file" as const } : missing;
      } catch {
        return missing;
      }
    }),
  );
}

/**
 * Absolute paths the user chose, as context files of `folder`: relative,
 * `/`-separated, the project's own folder and anything outside it left out.
 */
export async function contextPickIn(
  folder: string,
  chosen: readonly string[],
): Promise<ContextPick> {
  const root = await realpath(folder);
  const paths: string[] = [];
  let outside = 0;
  for (const path of chosen) {
    const real = await realpath(path).catch(() => null);
    if (!real || !inside(root, real) || real === root) {
      outside++;
      continue;
    }
    paths.push(contextPath(relative(root, real).split(sep).join("/")));
  }
  return { paths: [...new Set(paths)], outside };
}

export function createLeadStore(deps: LeadStoreDeps): LeadStore {
  const personalPath = join(deps.dir, "personal.json");
  /** Ids each workspace's repo held when last listed, for `setDefault`. */
  const repoIds = new Map<string, Set<string>>();
  let writes: Promise<unknown> = Promise.resolve();

  /** Run `job` after every earlier write, so two saves never interleave. */
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const next = writes.then(job, job);
    writes = next.catch(() => {});
    return next;
  }

  async function readPersonal(): Promise<PersonalFile> {
    const raw = await readFile(personalPath, "utf8").catch(() => null);
    const empty: PersonalFile = { version: 2, workspaces: {}, legacy: null };
    if (raw === null) return empty;
    try {
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        workspaces?: unknown;
        legacy?: unknown;
      };
      if (parsed.version !== 2) {
        // Version 1: one set for every project, kept as the legacy one.
        const legacy = parseBucket(parsed);
        return {
          version: 2,
          workspaces: {},
          legacy: legacy.leads.length ? legacy : null,
        };
      }
      const workspaces: Record<string, Bucket> = {};
      if (parsed.workspaces && typeof parsed.workspaces === "object")
        for (const [key, value] of Object.entries(parsed.workspaces))
          workspaces[key] = parseBucket(value);
      return {
        version: 2,
        workspaces,
        legacy: parsed.legacy ? parseBucket(parsed.legacy) : null,
      };
    } catch {
      return empty;
    }
  }

  async function writePersonal(file: PersonalFile): Promise<void> {
    await mkdir(deps.dir, { recursive: true, mode: 0o700 });
    const temp = `${personalPath}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temp, 0o600).catch(() => {});
    await rename(temp, personalPath);
  }

  async function readRepo(
    workspace: string | null,
  ): Promise<{ leads: TeamLead[]; errors: LeadsList["errors"] }> {
    if (!workspace) return { leads: [], errors: [] };
    const folder = await deps.folderOf(workspace).catch(() => null);
    if (!folder) {
      repoIds.delete(workspace);
      return { leads: [], errors: [] };
    }
    const dir = join(folder, REPO_LEADS_DIR);
    const names = (await readdir(dir).catch(() => [] as string[]))
      .filter((name) => name.endsWith(".md"))
      .sort();
    const leads: TeamLead[] = [];
    const errors: LeadsList["errors"] = [];
    for (const [index, name] of names.entries()) {
      const file = `${REPO_LEADS_DIR}/${name}`;
      if (index >= REPO_LEADS_MAX) {
        errors.push({
          file,
          error: `Not read: a project may keep at most ${REPO_LEADS_MAX} leads`,
        });
        continue;
      }
      try {
        leads.push(await readRepoLead(join(dir, name), name.slice(0, -3)));
      } catch (error) {
        errors.push({ file, error: messageOf(error) });
      }
    }
    repoIds.set(workspace, new Set(leads.map((lead) => lead.id)));
    return { leads, errors };
  }

  async function list(workspace: string | null): Promise<LeadsList> {
    const [file, repo] = await Promise.all([
      readPersonal(),
      readRepo(workspace),
    ]);
    // Version 1's set goes to the first project listed, and to no other.
    if (workspace && file.legacy) {
      if (!Object.keys(file.workspaces).length)
        await serial(() => adoptLegacy(workspace));
      else await serial(dropLegacy);
      return list(workspace);
    }
    const personal = bucketOf(file, workspace);
    // A Map keeps the first place an id took, and the last value set there.
    const merged = new Map<string, TeamLead>();
    for (const lead of personal.leads) merged.set(lead.id, lead);
    for (const lead of repo.leads) merged.set(lead.id, lead);
    const defaultId =
      personal.defaultId && merged.has(personal.defaultId)
        ? personal.defaultId
        : null;
    return {
      leads: [...merged.values()].map((lead) => structuredClone(lead)),
      defaultId,
      errors: repo.errors,
    };
  }

  const changed = (workspace: string) => deps.broadcast({ workspace });

  /** Give version 1's set to `workspace`, unless a project has one. */
  async function adoptLegacy(workspace: string): Promise<void> {
    const file = await readPersonal();
    if (!file.legacy) return;
    if (!Object.keys(file.workspaces).length)
      file.workspaces[workspace] = file.legacy;
    file.legacy = null;
    await writePersonal(file);
  }

  async function dropLegacy(): Promise<void> {
    const file = await readPersonal();
    if (!file.legacy) return;
    file.legacy = null;
    await writePersonal(file);
  }

  /** Change `workspace`'s own set, written as its own from then on. */
  async function updateBucket(
    workspace: string,
    change: (bucket: Bucket) => void,
  ): Promise<void> {
    const file = await readPersonal();
    const bucket = bucketOf(file, workspace);
    change(bucket);
    file.workspaces[workspace] = bucket;
    // A project has a set of its own now: version 1's is no one else's.
    file.legacy = null;
    await writePersonal(file);
    changed(workspace);
  }

  return {
    list,

    inspectContext: async (workspace, paths) =>
      inspectContextIn(await deps.folderOf(workspace).catch(() => null), paths),

    async resolve(workspace, id) {
      const { leads, errors } = await list(workspace);
      const broken = id.startsWith(REPO_LEAD_PREFIX)
        ? errors.find(
            (entry) =>
              entry.file ===
              `${REPO_LEADS_DIR}/${id.slice(REPO_LEAD_PREFIX.length)}.md`,
          )
        : undefined;
      if (broken)
        throw new Error(
          `Team lead "${id}" in ${broken.file} does not parse: ${broken.error}`,
        );
      const lead = leads.find((entry) => entry.id === id);
      if (!lead)
        throw new Error(
          `Team lead "${id}" is not in this project any more. Pick another one, or none.`,
        );
      return lead;
    },

    savePersonal: (workspace, input) =>
      serial(() =>
        updateBucket(workspace, (bucket) => {
          const lead = parseTeamLead(input, "personal");
          const at = bucket.leads.findIndex((entry) => entry.id === lead.id);
          if (at === -1 && bucket.leads.length >= PERSONAL_LEADS_MAX)
            throw new Error(
              `A project keeps at most ${PERSONAL_LEADS_MAX} conductors of your own. Remove one first.`,
            );
          if (at === -1) bucket.leads.push(lead);
          else bucket.leads[at] = lead;
        }),
      ).then(() => list(workspace)),

    removePersonal: (workspace, id) =>
      serial(() =>
        updateBucket(workspace, (bucket) => {
          leadId(id);
          if (!bucket.leads.some((entry) => entry.id === id))
            throw new Error(`"${id}" is not one of this project's conductors.`);
          bucket.leads = bucket.leads.filter((entry) => entry.id !== id);
          const stillKnown = repoIds.get(workspace)?.has(id) ?? false;
          if (bucket.defaultId === id && !stillKnown) bucket.defaultId = null;
        }),
      ).then(() => list(workspace)),

    setDefault: (workspace, id) =>
      serial(() =>
        updateBucket(workspace, (bucket) => {
          if (id !== null) {
            leadRef(id);
            const known =
              bucket.leads.some((entry) => entry.id === id) ||
              (repoIds.get(workspace)?.has(id) ?? false);
            if (!known) throw new Error(`No conductor "${id}" to start on.`);
          }
          bucket.defaultId = id;
        }),
      ).then(() => list(workspace)),
  };
}
