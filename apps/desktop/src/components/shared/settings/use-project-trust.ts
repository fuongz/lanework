import { useCallback, useEffect, useState } from "react";
import type { ProjectTrust } from "#/../shared/agent-setup";
import type { RepoTrust } from "#/../shared/worktree";
import type { TrustAgent } from "#/components/shared/settings/trust-dialog";
import { ipcMessage } from "#/lib/ipc-error";

/**
 * Whether Claude Code and Codex trust a project's folder (OpenCode asks no
 * such question), and the user's
 * answer written back (FE-101).
 *
 * Read on opening, and again on window focus: the user may answer a CLI's own
 * trust prompt in a terminal meanwhile.
 *
 * NOTE: Filed under the slug it was read for, so a read that lands after
 * another project was picked is never shown on it.
 */
export function useProjectTrust(slug: string | null): {
  trust: ProjectTrust | null;
  error: string | null;
  busy: TrustAgent | null;
  set: (agent: TrustAgent, on: boolean) => Promise<boolean>;
} {
  const [state, setState] = useState<{
    slug: string | null;
    trust: ProjectTrust | null;
    error: string | null;
  }>({ slug: null, trust: null, error: null });
  const [busy, setBusy] = useState<TrustAgent | null>(null);

  useEffect(() => {
    const surface = window.desktop?.agentSetup;
    if (!slug || !surface) return;
    let gone = false;
    const read = () =>
      surface.trust(slug).then(
        (trust) => !gone && setState({ slug, trust, error: null }),
        () => {},
      );
    void read();
    window.addEventListener("focus", read);
    return () => {
      gone = true;
      window.removeEventListener("focus", read);
    };
  }, [slug]);

  const set = useCallback(
    async (agent: TrustAgent, on: boolean) => {
      const surface = window.desktop?.agentSetup;
      if (!slug || !surface) return false;
      setBusy(agent);
      try {
        const trust = await surface.setTrust(slug, agent, on);
        setState({ slug, trust, error: null });
        return true;
      } catch (error) {
        setState((previous) => ({
          slug,
          trust: previous.slug === slug ? previous.trust : null,
          error: ipcMessage(error, "Could not change the folder's trust."),
        }));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [slug],
  );

  const mine = state.slug === slug;
  return {
    trust: mine ? state.trust : null,
    error: mine ? state.error : null,
    busy,
    set,
  };
}

/**
 * Where a project's repository's git settings stand for Lanework's own git
 * gate, and the way to change it (FE-102).
 *
 * Read on opening and on window focus, as {@link useProjectTrust}.
 */
export function useRepoTrust(slug: string | null): {
  trust: RepoTrust | null;
  busy: boolean;
  /** Re-read, Ask again (opens the native prompt), or Stop running. */
  run: (action: "read" | "ask" | "restrict") => Promise<void>;
} {
  const [state, setState] = useState<{
    slug: string | null;
    trust: RepoTrust | null;
  }>({ slug: null, trust: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const surface = window.desktop?.worktree;
    if (!slug || !surface) return;
    let gone = false;
    const read = () =>
      surface.repoTrust(slug).then(
        (trust) => !gone && setState({ slug, trust }),
        () => {},
      );
    void read();
    window.addEventListener("focus", read);
    return () => {
      gone = true;
      window.removeEventListener("focus", read);
    };
  }, [slug]);

  const run = useCallback(
    async (action: "read" | "ask" | "restrict") => {
      const surface = window.desktop?.worktree;
      if (!slug || !surface) return;
      setBusy(true);
      try {
        const trust = await (action === "ask"
          ? surface.askAgain(slug)
          : action === "restrict"
            ? surface.restrict(slug)
            : surface.repoTrust(slug));
        setState({ slug, trust });
      } catch {
        // The row keeps what it showed; the next focus reads again.
      } finally {
        setBusy(false);
      }
    },
    [slug],
  );

  return { trust: state.slug === slug ? state.trust : null, busy, run };
}
