import { create } from "zustand";
import type { RedactedSession, SignInProgress } from "../../shared/auth";

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
