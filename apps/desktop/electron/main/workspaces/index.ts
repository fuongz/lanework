import { can } from "../../../shared/policy";
import {
  type WorkspaceSnapshot,
  workspaceChannels,
} from "../../../shared/workspaces";
import { currentSession } from "../auth";
import { resolveApi } from "../auth/client";
import { type MachineRecord, readRecord } from "../auth/store";
import { handle } from "../ipc";
import { fetchWorkspaces } from "./client";
import { readActive, writeActive } from "./store";

async function authorizedRecord(): Promise<MachineRecord> {
  const session = await currentSession();
  if (
    !can(session.principal, "app:use") ||
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

async function assertSameSession(record: MachineRecord): Promise<void> {
  const current = await authorizedRecord();
  if (
    current.secret !== record.secret ||
    current.machineId !== record.machineId ||
    current.userId !== record.userId ||
    current.apiUrl !== record.apiUrl
  )
    throw new Error("Your session changed. Try again.");
}

async function load(slug?: string): Promise<WorkspaceSnapshot> {
  const record = await authorizedRecord();
  const workspaces = await fetchWorkspaces(record);
  const saved = await readActive(record);
  await assertSameSession(record);
  const active =
    workspaces.find((workspace) => workspace.slug === (slug ?? saved)) ?? null;
  if (slug !== undefined && !active)
    throw new Error(
      "This workspace is no longer available. Refresh the list and choose another.",
    );
  if (slug !== undefined || (saved !== null && !active))
    await writeActive(record, active?.slug ?? null);
  await assertSameSession(record);
  return { workspaces, active };
}

export function registerWorkspaces(devUrl?: string): void {
  handle(workspaceChannels.load, devUrl, (args) => {
    if (args.length) throw new Error("This operation takes no arguments");
    return load();
  });
  handle(workspaceChannels.select, devUrl, (args) => {
    if (
      args.length !== 1 ||
      typeof args[0] !== "string" ||
      !args[0].trim() ||
      args[0].length > 200
    )
      throw new Error("A valid workspace slug is required");
    return load(args[0]);
  });
}
