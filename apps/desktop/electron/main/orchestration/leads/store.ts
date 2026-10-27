// Team leads in main (FE-88): the three sources, merged.
//
// - `builtin`: {@link BUILTIN_LEADS}, shipped with the app.
// - `personal`: the user's own, in `<dir>/personal.json` with the default id.
// - `repo`: `.lanework/leads/<id>.md` in the workspace's folder, frontmatter
//   then the instructions as markdown.
//
// A personal lead may override a built-in one of its id. A repo lead is
// `repo:<id>` (FE-89/D3), so a file a project checks in never stands in for
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
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type LeadsEvent,
  type LeadsList,
  type LeadsMainHandlers,
  leadId,
  leadRef,
  parseTeamLead,
  REPO_LEAD_PREFIX,
  type TeamLead,
} from "../../../../shared/orchestration";
import { BUILTIN_LEADS } from "./builtin";
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

export interface LeadStore extends LeadsMainHandlers {
  /**
   * The lead a run starts under, as `list(workspace)` would show it.
   *
   * @throws {Error} When no source holds `id`, or its repo file is broken.
   */
  resolve: (workspace: string, id: string) => Promise<TeamLead>;
}

interface PersonalFile {
  version: 1;
  leads: TeamLead[];
  defaultId: string | null;
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
      ...frontmatter,
      id: stem,
      checks: frontmatter.checks ?? [],
      jev: frontmatter.jev ?? null,
      instructions: body,
    },
    "repo",
  );
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
    const empty: PersonalFile = { version: 1, leads: [], defaultId: null };
    if (raw === null) return empty;
    try {
      const parsed = JSON.parse(raw) as Partial<PersonalFile>;
      const leads: TeamLead[] = [];
      for (const entry of Array.isArray(parsed.leads) ? parsed.leads : []) {
        try {
          const lead = parseTeamLead(entry, "personal");
          if (!leads.some((other) => other.id === lead.id)) leads.push(lead);
        } catch {
          // One unreadable entry does not cost the others.
        }
      }
      let defaultId: string | null = null;
      try {
        defaultId = parsed.defaultId == null ? null : leadRef(parsed.defaultId);
      } catch {
        defaultId = null;
      }
      return { version: 1, leads, defaultId };
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
    const [personal, repo] = await Promise.all([
      readPersonal(),
      readRepo(workspace),
    ]);
    // A Map keeps the first place an id took, and the last value set there.
    const merged = new Map<string, TeamLead>();
    for (const lead of BUILTIN_LEADS) merged.set(lead.id, lead);
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

  const changed = () => deps.broadcast({ workspace: null });

  return {
    list,

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

    savePersonal: (input) =>
      serial(async () => {
        const lead = parseTeamLead(input, "personal");
        const file = await readPersonal();
        const at = file.leads.findIndex((entry) => entry.id === lead.id);
        if (at === -1 && file.leads.length >= PERSONAL_LEADS_MAX)
          throw new Error(
            `You can keep at most ${PERSONAL_LEADS_MAX} team leads of your own. Remove one first.`,
          );
        if (at === -1) file.leads.push(lead);
        else file.leads[at] = lead;
        await writePersonal(file);
        changed();
      }).then(() => list(null)),

    removePersonal: (id) =>
      serial(async () => {
        leadId(id);
        const file = await readPersonal();
        if (!file.leads.some((entry) => entry.id === id))
          throw new Error(
            BUILTIN_LEADS.some((entry) => entry.id === id)
              ? `"${id}" ships with the app and cannot be removed.`
              : `"${id}" is not one of your team leads.`,
          );
        file.leads = file.leads.filter((entry) => entry.id !== id);
        const stillKnown =
          BUILTIN_LEADS.some((entry) => entry.id === id) ||
          [...repoIds.values()].some((ids) => ids.has(id));
        if (file.defaultId === id && !stillKnown) file.defaultId = null;
        await writePersonal(file);
        changed();
      }).then(() => list(null)),

    setDefault: (id) =>
      serial(async () => {
        const file = await readPersonal();
        if (id !== null) {
          leadRef(id);
          const known =
            BUILTIN_LEADS.some((entry) => entry.id === id) ||
            file.leads.some((entry) => entry.id === id) ||
            [...repoIds.values()].some((ids) => ids.has(id));
          if (!known) throw new Error(`No team lead "${id}" to start on.`);
        }
        file.defaultId = id;
        await writePersonal(file);
        changed();
      }).then(() => list(null)),
  };
}
