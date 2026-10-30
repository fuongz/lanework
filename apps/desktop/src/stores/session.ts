import { create } from "zustand";
import type {
  Principal,
  RedactedSession,
  SignInProgress,
} from "../../shared/auth";
import type { Project } from "../../shared/projects";

/**
 * The renderer's view of who is signed in.
 *
 * NOTE: Not persisted, unlike `preferences.ts`. Main owns the session. A copy
 * in `localStorage` could go stale, and a devtools console could edit it.
 * Every value here comes from main, and nothing here is authoritative.
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
   * Not just "log out": main calls `DELETE /v1/machines/me` first, so coming
   * back needs a browser and a fresh approval. Callers confirm before calling.
   */
  signOut: () => Promise<void>;
  /**
   * "Skip for now": use the app without an account (FE-52/D5).
   *
   * Main remembers the choice and answers a session whose principal is
   * `local`, which the gate opens on. Signing in later, from
   * Settings → Account or the rail, turns it into `machine`.
   */
  enterLocalMode: () => Promise<void>;
}

/**
 * Unwrap what Electron does to a main-process throw.
 *
 * `ipcRenderer.invoke` rejects with
 * `Error invoking remote method 'auth:sign-in': Error: <the real message>`.
 * Main writes its messages for a person to read; the prefix is noise.
 *
 * @returns The message main wrote.
 */
function message(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(
    /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,
    "",
  );
}

/**
 * Whether `hydrate` has run.
 *
 * Subscribing twice would double every update, so hydration happens once.
 */
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
    // NOTE: Subscribe before the first read, so a change that lands between
    // the two is not missed. Main pushes on sign-in, sign-out and every
    // heartbeat that finds a change; that is how a server-side revoke arrives.
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
    // Not `busy`: that flag turns the gate into "Waiting for your browser",
    // and nothing here waits on one. This is a quick local write in main.
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
 * Two separate scopes:
 * - App-wide (`machines`, `handoff`) follow the principal. A `local` install
 *   has no machine, no account and no credential for the checkpoint hook,
 *   whatever board is open.
 * - Per board (presence, subscribers, assignees other than yourself,
 *   comments, attachments) follow the project as well. A signed-in machine
 *   still has local boards (D6a), and those have none of it.
 *
 * Pure, like `policy.ts`, so a screen hides what main would refuse anyway.
 * It decides what is drawn, not what is allowed: main routes a local board to
 * the SQLite store, which has none of these surfaces.
 */
interface CloudFeatures {
  /** Signed in with a machine credential. */
  signedIn: boolean;
  /** Settings → Account's machine rows and sign-out, the account orb. */
  machines: boolean;
  /** Checkpoint hook and resume (Settings → Agents, a card's checkpoint). */
  handoff: boolean;
  presence: boolean;
  subscribers: boolean;
  /**
   * Assigning anyone other than yourself.
   *
   * Assigning yourself is always offered.
   */
  assignOthers: boolean;
  comments: boolean;
  attachments: boolean;
}

/** A board that lives in the SQLite store on this machine. */
export function isLocalProject(
  project: Pick<Project, "origin"> | null | undefined,
): boolean {
  return project?.origin === "local";
}

function cloudFeatures(
  principal: Pick<Principal, "kind"> | null | undefined,
  project?: Pick<Project, "origin"> | null,
): CloudFeatures {
  const signedIn = principal?.kind === "machine";
  const board = signedIn && !isLocalProject(project);
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
 * {@link cloudFeatures} for the session on screen and, when given, one board.
 *
 * NOTE: Selects the principal's kind (a string), never the computed object. A
 * new object on every read is a new value to zustand and re-renders forever.
 */
export function useCloudFeatures(
  project?: Pick<Project, "origin"> | null,
): CloudFeatures {
  const kind = useSession((state) => state.session?.principal.kind);
  return cloudFeatures(kind ? { kind } : null, project);
}

/** Whether the person chose "Skip for now" and has not signed in since. */
export function useIsLocalMode(): boolean {
  return useSession((state) => state.session?.principal.kind === "local");
}
