import { create } from "zustand";
import type {
  Principal,
  RedactedSession,
  SignInProgress,
} from "../../shared/auth";
import type { Workspace } from "../../shared/workspaces";

/**
 * The renderer's view of who is signed in.
 *
 * ⚠️ Deliberately NOT persisted, unlike `preferences.ts`. The session is a fact
 * owned by the main process; writing it to `localStorage` would create a second
 * copy that can be stale, and one a devtools console can edit. Every value here
 * arrives from main and nothing here is authoritative.
 */
interface SessionState {
  /** True once the first read has settled, successfully or not. */
  ready: boolean;
  session: RedactedSession | null;
  /** What a running sign-in has reported so far. */
  progress: SignInProgress | null;
  error: string | null;
  busy: boolean;
  hydrate: () => void;
  signIn: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  /**
   * Revoke this machine and drop the credential.
   *
   * Not merely "log out": main calls `DELETE /v1/machines/me` first, so coming
   * back needs a browser and a fresh approval. Callers are expected to confirm
   * before reaching here.
   */
  signOut: () => Promise<void>;
  /**
   * FE-52/D5: "Skip for now". Main remembers the choice and answers a session
   * whose principal is `local`, which the gate opens on. Signing in later, from
   * Settings → Account or the rail, turns it into `machine`.
   */
  enterLocalMode: () => Promise<void>;
}

/**
 * Unwrap what Electron does to a main-process throw.
 *
 * `ipcRenderer.invoke` rejects with `Error invoking remote method 'auth:sign-in':
 * Error: <the real message>`. Main writes messages meant to be read by a person,
 * and that prefix is the one part of them nobody should ever see.
 */
function message(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(
    /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,
    "",
  );
}

/** Subscribing twice would double every update, so hydration happens once. */
let hydrated = false;

export const useSession = create<SessionState>()((set) => ({
  ready: false,
  session: null,
  progress: null,
  error: null,
  busy: false,

  hydrate: () => {
    if (hydrated) return;
    hydrated = true;
    const auth = window.desktop?.auth;
    if (!auth) {
      set({
        ready: true,
        error: "This window is not connected to the desktop app.",
      });
      return;
    }
    // Subscribed BEFORE the first read, so a change that lands between the two
    // is not missed. Main pushes on sign-in, sign-out and every heartbeat that
    // finds something different — which is how a server-side revoke arrives.
    auth.onSessionChange((session) => set({ session, ready: true }));
    void auth
      .getSession()
      .then((session) => set({ session, ready: true }))
      .catch((error: unknown) => set({ ready: true, error: message(error) }));
  },

  signIn: async () => {
    const auth = window.desktop?.auth;
    if (!auth) return;
    set({ busy: true, error: null, progress: null });
    const stop = auth.onSignInProgress((progress) => set({ progress }));
    try {
      set({ session: await auth.signIn() });
    } catch (error) {
      set({ error: message(error) });
    } finally {
      stop();
      set({ busy: false, progress: null });
    }
  },

  cancelSignIn: async () => {
    // The rejection this causes in `signIn` is what clears `busy`, so there is
    // nothing to set here.
    await window.desktop?.auth.cancelSignIn().catch(() => {});
  },

  enterLocalMode: async () => {
    const auth = window.desktop?.auth;
    if (!auth) return;
    // ⚠️ Not `busy`: that flag is what turns the gate into "Waiting for your
    // browser", and nothing here waits on one. A local write in main, answered
    // in a beat.
    set({ error: null });
    try {
      set({ session: await auth.enterLocalMode() });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  signOut: async () => {
    const auth = window.desktop?.auth;
    if (!auth) return;
    set({ busy: true, error: null });
    try {
      set({ session: await auth.signOut() });
    } catch (error) {
      set({ error: message(error) });
    } finally {
      set({ busy: false });
    }
  },
}));

/**
 * What the app can offer right now that only the cloud can back (FE-52/D10).
 *
 * Two scopes, and they are separate on purpose:
 *   • APP-WIDE — `machines`, `handoff` — follow the PRINCIPAL. A `local`
 *     install has no machine, no account and no credential for the checkpoint
 *     hook, whatever board is open.
 *   • PER BOARD — presence, subscribers, assignees other than yourself,
 *     comments, attachments — follow the WORKSPACE as well. A signed-in machine
 *     still has local boards (D6a), and those have none of it.
 *
 * ⚠️ Pure, like `policy.ts`, so a screen hides what main would refuse anyway.
 * It decides what is DRAWN, not what is allowed: main routes a local board to
 * the SQLite store, which has none of these surfaces.
 */
export interface CloudFeatures {
  /** Signed in with a machine credential. */
  signedIn: boolean;
  /** Settings → Account's machine rows and sign-out, the account orb. */
  machines: boolean;
  /** The checkpoint hook and resume (Settings → Agents, a card's checkpoint). */
  handoff: boolean;
  presence: boolean;
  subscribers: boolean;
  /** Assigning anyone other than yourself; assigning yourself stays. */
  assignOthers: boolean;
  comments: boolean;
  attachments: boolean;
}

/** A board that lives in the SQLite store on this machine (FE-52). */
export function isLocalWorkspace(
  workspace: Pick<Workspace, "origin"> | null | undefined,
): boolean {
  return workspace?.origin === "local";
}

export function cloudFeatures(
  principal: Pick<Principal, "kind"> | null | undefined,
  workspace?: Pick<Workspace, "origin"> | null,
): CloudFeatures {
  const signedIn = principal?.kind === "machine";
  const board = signedIn && !isLocalWorkspace(workspace);
  return {
    signedIn,
    machines: signedIn,
    handoff: signedIn,
    presence: board,
    subscribers: board,
    assignOthers: board,
    comments: board,
    attachments: board,
  };
}

/**
 * `cloudFeatures` for the session on screen and, when given, one board.
 *
 * ⚠️ Selects the principal's KIND (a string), never the computed object: a new
 * object on every read is a new value to zustand and would re-render forever.
 */
export function useCloudFeatures(
  workspace?: Pick<Workspace, "origin"> | null,
): CloudFeatures {
  const kind = useSession((state) => state.session?.principal.kind);
  return cloudFeatures(kind ? { kind } : null, workspace);
}

/** True while the person chose "Skip for now" and has not signed in since. */
export function useIsLocalMode(): boolean {
  return useSession((state) => state.session?.principal.kind === "local");
}
