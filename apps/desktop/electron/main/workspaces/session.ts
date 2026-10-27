// Who may act on the workspaces, and which projects this process knows of:
// the session gate, local mode's stand-in "account", and the list the last
// `load` read. Split out of `index.ts` (FE-82/D1); every feature that resolves
// a project to its folder goes through here.
import { can } from "../../../shared/policy";
import type { Workspace, WorkspaceSnapshot } from "../../../shared/workspaces";
import { currentSession } from "../auth";
import { resolveApi } from "../auth/client";
import { readLocalMode } from "../auth/local-mode";
import { type MachineRecord, readRecord } from "../auth/store";
import { fetchWorkspaces } from "./client";
import {
  findLocalWorkspace,
  type LocalBoard,
  listLocalWorkspaces,
  localBoard,
  toWorkspace as localToWorkspace,
} from "./local-backend";
import { folderExists } from "./local-folder";
import { readActive, readFolders, writeActive } from "./store";

/**
 * The credential this window is allowed to act with, or a refusal.
 *
 * NOTE: Exported for `../git`, which needs the same gate: its handlers file
 * state per Lanework account, so they have to agree with this file on which
 * account is asking. A second copy of this check is a second place for the
 * answer to drift.
 *
 * @throws When the window is signed out, or the session changed under it.
 */
export async function authorizedRecord(): Promise<MachineRecord> {
  const session = await currentSession();
  // FE-78/D7: the policy's own answer, so main enforces the rule the renderer
  // reads. The `kind` test only narrows the type for the reads below; with
  // `cloud:use` true for a `machine` alone, it never refuses on its own.
  if (
    !can(session.principal, "cloud:use") ||
    session.principal.kind !== "machine"
  )
    throw new Error("Sign in to load your workspaces.");
  const record = await readRecord();
  if (
    !record ||
    record.machineId !== session.principal.machineId ||
    record.userId !== session.principal.userId ||
    resolveApi(record.apiUrl) !== session.apiUrl
  )
    throw new Error("Your session changed. Try again.");
  return record;
}

export async function assertSameSession(record: MachineRecord): Promise<void> {
  const current = await authorizedRecord();
  if (
    current.secret !== record.secret ||
    current.machineId !== record.machineId ||
    current.userId !== record.userId ||
    current.apiUrl !== record.apiUrl
  )
    throw new Error("Your session changed. Try again.");
}

// ── Local boards ────────────────────────────────────────────────────────────

/**
 * The "account" local boards file their per-account state under — the saved
 * selection and the folder links — through the same `store.ts` functions the
 * cloud account uses.
 *
 * NOTE: NOT a credential, and built so it can never act as one: no secret,
 * and an origin (`lanework-local:`) that no `fetch` can reach. A request made
 * with it by mistake fails on the spot instead of reaching the control plane,
 * which keeps "local mode sends nothing" (FE-52/V2) true even through code
 * written for the cloud. The same record is used signed in and not, so a
 * local board's folder link survives signing in and out.
 */
export const LOCAL_RECORD: MachineRecord = {
  machineId: "local",
  secret: "",
  apiUrl: "lanework-local:",
  name: "local",
  userId: null,
  owner: null,
};

/**
 * Whether the app is in local mode: no credential on disk and "Skip for now"
 * chosen.
 *
 * The rule `currentSession` applies, read from the two files alone.
 *
 * NOTE: Not `currentSession()`. That probes the control plane when its
 * verdict is stale, and the cloud paths below already pay for one probe in
 * {@link authorizedRecord}. A second one in front of it would move every cloud
 * read later, and let callers racing the first `load` each fetch the list
 * again.
 */
export async function inLocalMode(): Promise<boolean> {
  return !(await readRecord()) && (await readLocalMode());
}

/** Signed in, or in local mode — anything else is refused. */
export async function assertCanUse(): Promise<void> {
  if (await inLocalMode()) return;
  await authorizedRecord();
}

/** Local boards as the workspace list carries them, each with its folder. */
export async function localList(): Promise<Workspace[]> {
  const locals = listLocalWorkspaces();
  if (!locals.length) return [];
  const folders = await readFolders(LOCAL_RECORD);
  return locals.map((workspace) =>
    localToWorkspace(workspace, folders[workspace.slug]?.[0] ?? null),
  );
}

/**
 * The local board a board call names, or null when it names a cloud one.
 *
 * NOTE: Matched by ID only (see `findLocalWorkspace`), and only once the
 * session may use the app at all: a signed-out window reads no board, local
 * or not.
 */
export async function localTarget(
  workspaceId: string,
): Promise<LocalBoard | null> {
  const board = localBoard(workspaceId);
  if (!board) return null;
  await assertCanUse();
  return board;
}

/**
 * Which account a folder link keyed by `slug` is filed under.
 *
 * NOTE: The folder channels name a workspace by slug alone, and a local board
 * and a cloud one can share a slug (a moved board and its cloud copy usually
 * do). The cloud project wins that tie when signed in: it is the one the rest
 * of the app — terminals, pull requests — already resolves that slug to.
 */
export async function folderRecordFor(slug: string): Promise<MachineRecord> {
  if (await inLocalMode()) return LOCAL_RECORD;
  const record = await authorizedRecord();
  const cloud = cachedList(record);
  if (
    !cloud?.some((workspace) => workspace.slug === slug) &&
    findLocalWorkspace(slug, { bySlug: true })
  )
    return LOCAL_RECORD;
  return record;
}

/** The local board `key` names, as a list row with its folder. */
async function localKnown(
  key: string,
  bySlug: boolean,
): Promise<Workspace | null> {
  const found = findLocalWorkspace(key, { bySlug });
  if (!found) return null;
  const folders = await readFolders(LOCAL_RECORD);
  return localToWorkspace(found, folders[found.slug]?.[0] ?? null);
}

/** Local mode's `load`: the local list, and the selection filed under it. */
export async function loadLocal(id?: string): Promise<WorkspaceSnapshot> {
  const workspaces = await localList();
  const saved = await readActive(LOCAL_RECORD);
  const selector = id ?? saved?.value;
  const active =
    (selector
      ? workspaces.find(
          (workspace) =>
            workspace.id === selector || workspace.slug === selector,
        )
      : undefined) ?? null;
  if (id !== undefined && !active)
    throw new Error(
      "This workspace is no longer available. Refresh the list and choose another.",
    );
  if (id !== undefined || saved?.by === "slug" || (saved !== null && !active))
    await writeActive(LOCAL_RECORD, {
      id: active?.id ?? null,
      slug: active?.slug ?? null,
    });
  return { workspaces, active };
}

/**
 * The list the last `load` read, and the session it was read under.
 *
 * NOTE: Only SELECTING reuses it (FE-15/D4). Without it, switching projects
 * fetches the whole list again just to write down which one was chosen — a
 * round trip per switch for an answer the renderer already has. Every other
 * read still asks the service, and the session key means a different account
 * never sees it.
 */
let lastList: { session: string; workspaces: Workspace[] } | null = null;

const sessionKey = (record: MachineRecord) =>
  [record.apiUrl, record.machineId, record.userId, record.secret].join("\n");

/** The list the last `load` read, when it was read under `record`'s session. */
export function cachedList(record: MachineRecord): Workspace[] | null {
  return lastList?.session === sessionKey(record) ? lastList.workspaces : null;
}

/** Remember the account's list, as `load` just read it under `record`. */
export function rememberList(
  record: MachineRecord,
  workspaces: Workspace[],
): void {
  lastList = { session: sessionKey(record), workspaces };
}

/** Drop the remembered list, so the next read asks the service. */
export function forgetList(): void {
  lastList = null;
}

/**
 * The folder a terminal for `key` opens in (FE-19/D7).
 *
 * NOTE: Resolved HERE, from the links this process wrote down, never from the
 * renderer. The terminal panel names a workspace and nothing else, so a
 * renderer cannot open a shell in a folder of its choosing.
 *
 * @param key The cloud id or, for a service that sends none, the slug — the
 *   same either-or `load(id)` accepts. The folder link is keyed by slug.
 * @returns The workspace's PRIMARY folder on this machine, or null — the home
 *   folder — when it has none here or it has moved.
 */
export async function terminalFolder(key: string): Promise<string | null> {
  const { record, workspace } = await knownWorkspace(key);
  const [primary] = (await readFolders(record))[workspace.slug] ?? [];
  return primary && (await folderExists(primary)) ? primary : null;
}

/**
 * Every folder of `key` still on this machine, primary first.
 *
 * A port belongs to the project when its process runs inside one of them.
 * Resolved here, like {@link terminalFolder}, never from the renderer.
 */
export async function projectFolders(key: string): Promise<string[]> {
  const { record, workspace } = await knownWorkspace(key);
  const folders = (await readFolders(record))[workspace.slug] ?? [];
  const present = await Promise.all(
    folders.map(async (folder) =>
      (await folderExists(folder)) ? folder : null,
    ),
  );
  return present.filter((folder): folder is string => folder !== null);
}

/**
 * The workspace `key` (id or slug) names on this account, and the credential
 * that read it.
 *
 * Found in the list this process last read, or a fresh one.
 *
 * NOTE: Exported for `../readiness`, which resolves a slug the same way the
 * terminal does rather than trusting anything the renderer says about it.
 */
export async function knownWorkspace(
  key: string,
): Promise<{ record: MachineRecord; workspace: Workspace }> {
  // A local board answers with `LOCAL_RECORD`, whose folder links are the
  // local ones and whose origin no request can reach.
  if (await inLocalMode()) {
    const local = await localKnown(key, true);
    if (!local) throw new Error("That project is not on this machine.");
    return { record: LOCAL_RECORD, workspace: local };
  }
  const byId = await localKnown(key, false);
  if (byId) return { record: LOCAL_RECORD, workspace: byId };
  const record = await authorizedRecord();
  const known = cachedList(record) ?? (await fetchWorkspaces(record));
  const workspace = known.find(
    (entry) => entry.id === key || entry.slug === key,
  );
  if (workspace) return { record, workspace };
  const bySlug = await localKnown(key, true);
  if (bySlug) return { record: LOCAL_RECORD, workspace: bySlug };
  throw new Error("That project is not on this account.");
}

/**
 * The account's projects, for native surfaces.
 *
 * Never reuses another account's list.
 */
export async function menuBarWorkspaces(): Promise<Workspace[]> {
  if (await inLocalMode()) return localList();
  const record = await authorizedRecord();
  const cloud = cachedList(record) ?? (await fetchWorkspaces(record));
  return [...cloud, ...(await localList())];
}
