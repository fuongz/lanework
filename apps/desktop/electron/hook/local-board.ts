// The checkpoint hook's offline path (FE-52/D9): a repo whose board lives in
// the local SQLite file, not in the cloud, gets its checkpoint written there.
//
// NOTE:
// - There is no global "local mode" switch. The repo decides: its origin
//   remote maps to exactly one live local project that has not been moved
//   to the cloud (`cloudId` null) → local. Anything else (no file, no such
//   board, a board already on the cloud) takes the cloud path, untouched.
// - This never creates the file. A machine that never used the local board
//   has no `~/.lanew/data.sqlite`, and a hook run must not leave one behind.
// - `node:sqlite` needs Node 22.5+. The plugin runs on the user's `node`
//   (18+), where it may be missing: opening then throws, and the caller logs
//   it and falls back to the cloud path. Under the app it is always there
//   (Node 24).
import { existsSync } from "node:fs";
import type { CheckpointRequest } from "@lanework/protocol";
import {
  type LocalStore,
  localStorePath,
  openLocalStore,
} from "../local-store/index";

export interface LocalBoard {
  store: LocalStore;
  projectId: string;
}

/**
 * Open the local board `remote` belongs to.
 *
 * @returns The opened board, or null when the repo takes the cloud path.
 *   Close its `store` when done.
 */
export function localBoardFor(
  remote: string,
  path: string = localStorePath(),
): LocalBoard | null {
  if (!existsSync(path)) return null;
  const store = openLocalStore({ path });
  try {
    const boards = store
      .findProjectsByRepo(remote)
      .filter((project) => !project.cloudId);
    const board = boards.length === 1 ? boards[0] : undefined;
    if (!board) {
      store.close();
      return null;
    }
    return { store, projectId: board.id };
  } catch (error) {
    store.close();
    throw error;
  }
}

/**
 * Write the checkpoint on the card `taskId` names.
 *
 * @returns The new checkpoint's id.
 * @throws `LocalStoreError` when the store refuses it.
 */
export function writeLocalCheckpoint(
  board: LocalBoard,
  taskId: string,
  body: CheckpointRequest,
  agent: string,
): string {
  return board.store.addCheckpoint(taskId, body, {
    project: board.projectId,
    agent,
  }).id;
}
