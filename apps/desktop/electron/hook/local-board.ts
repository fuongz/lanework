// The checkpoint hook's offline path (FE-52/D9): a repo whose board lives in
// the local SQLite file, not in the cloud, gets its checkpoint written there.
//
// ⚠️ There is no global "local mode" switch. The repo decides: its origin
// remote maps to exactly one live local workspace that has not been moved to
// the cloud (`cloudId` null) → local. Anything else — no file, no such board,
// a board already on the cloud — is the cloud path, untouched.
//
// ⚠️ Never creates the file. A machine that never used the local board has no
// `~/.lanew/data.sqlite`, and a hook run must not leave one behind.
//
// ⚠️ `node:sqlite` needs Node 22.5+. The plugin runs on the user's `node`
// (18+), where it may be missing: opening then throws, the caller logs it and
// falls back to the cloud path. Under the app it is always there (Node 24).
import { existsSync } from "node:fs";
import type { CheckpointRequest } from "@lanework/protocol";
import {
  type LocalStore,
  localStorePath,
  openLocalStore,
} from "../local-store/index";

export interface LocalBoard {
  store: LocalStore;
  workspaceId: string;
}

/** The local board `remote` belongs to, opened — or null. Close `store` when done. */
export function localBoardFor(
  remote: string,
  path: string = localStorePath(),
): LocalBoard | null {
  if (!existsSync(path)) return null;
  const store = openLocalStore({ path });
  try {
    const boards = store
      .findWorkspacesByRepo(remote)
      .filter((workspace) => !workspace.cloudId);
    const board = boards.length === 1 ? boards[0] : undefined;
    if (!board) {
      store.close();
      return null;
    }
    return { store, workspaceId: board.id };
  } catch (error) {
    store.close();
    throw error;
  }
}

/** Writes the checkpoint on the card `taskId` names; throws `LocalStoreError` when refused. */
export function writeLocalCheckpoint(
  board: LocalBoard,
  taskId: string,
  body: CheckpointRequest,
  agent: string,
): string {
  return board.store.addCheckpoint(taskId, body, {
    workspace: board.workspaceId,
    agent,
  }).id;
}
