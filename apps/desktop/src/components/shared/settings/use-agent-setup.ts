import { useEffect, useState } from "react";
import type { AgentSetup } from "#/../shared/agent-setup";
import { ipcMessage } from "#/lib/ipc-error";

/** How old a read may be before focusing the window reads again. */
const FOCUS_MIN_AGE_MS = 30_000;

/**
 * One project's agent setup, as main last read it.
 *
 * Read on opening the page, when its folders change, and on window focus once
 * the last read is half a minute old: config files change in an editor, not
 * here.
 *
 * NOTE: Filed under the slug it was read for, so a read that lands after
 * another project was picked is never shown on it.
 */
export function useAgentSetup(
  slug: string,
  folders: string[],
): { setup: AgentSetup | null; error: string | null } {
  const [state, setState] = useState<{
    slug: string;
    setup: AgentSetup | null;
    error: string | null;
  }>({ slug: "", setup: null, error: null });
  const key = folders.join("\n");

  useEffect(() => {
    void key;
    const surface = window.desktop?.agentSetup;
    if (!surface) return;
    let gone = false;
    let readAt = 0;
    const read = () => {
      readAt = Date.now();
      surface.read(slug).then(
        (setup) => !gone && setState({ slug, setup, error: null }),
        (error: unknown) =>
          !gone &&
          // A read that failed keeps what the last one showed.
          setState((previous) => ({
            slug,
            setup: previous.slug === slug ? previous.setup : null,
            error: ipcMessage(error, "Could not read this project's setup."),
          })),
      );
    };
    read();
    const onFocus = () => {
      if (Date.now() - readAt >= FOCUS_MIN_AGE_MS) read();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      gone = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [slug, key]);

  return state.slug === slug
    ? { setup: state.setup, error: state.error }
    : { setup: null, error: null };
}
