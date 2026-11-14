import { useEffect } from "react";
import { create } from "zustand";

/** What signs Claude Code in again from a terminal. */
export const CLAUDE_LOGIN_COMMAND = "claude auth login";

/** The chat whose turn Claude refused for its sign-in. */
export interface ClaudeAuthFailure {
  /** Its project's key, as main names it. */
  project: string;
  conversation: string;
  /** The CLI's own words. */
  message: string | null;
  /** Epoch ms. */
  at: number;
}

/**
 * Whether Claude Code has to sign in again (FE-139).
 *
 * Known only from a chat turn the CLI refused: the token's expiry time cannot
 * tell a routine renewal from a sign-in that ran out, so nothing is guessed
 * ahead. The next Claude turn that goes through clears it.
 */
interface ClaudeAuthState {
  failure: ClaudeAuthFailure | null;
  /** The failure the user waved away; a later one brings the island back. */
  dismissedAt: number | null;
  /** When Terminal was opened on `claude auth login` (epoch ms). */
  openedAt: number | null;
  signIn: () => Promise<void>;
  dismiss: () => void;
}

export const useClaudeAuth = create<ClaudeAuthState>((set, get) => ({
  failure: null,
  dismissedAt: null,
  openedAt: null,
  signIn: async () => {
    await window.desktop?.harness?.signIn("claude");
    set({ openedAt: Date.now() });
  },
  dismiss: () => {
    const at = get().failure?.at;
    if (at !== undefined) set({ dismissedAt: at });
  },
}));

/** The failure the island shows: not dismissed, or null. */
export function useClaudeAuthFailure(): ClaudeAuthFailure | null {
  return useClaudeAuth((state) =>
    state.failure && state.failure.at !== state.dismissedAt
      ? state.failure
      : null,
  );
}

/** Follow the engine's `claude-auth` events while the shell is mounted. */
export function useClaudeAuthWatch(): void {
  useEffect(() => {
    const surface = window.desktop?.conversation;
    if (!surface) return;
    return surface.onEvent((event) => {
      if (event.type !== "claude-auth") return;
      if (event.state === "ok") {
        if (useClaudeAuth.getState().failure)
          useClaudeAuth.setState({ failure: null, openedAt: null });
        return;
      }
      useClaudeAuth.setState({
        failure: {
          project: event.project,
          conversation: event.conversation,
          message: event.message,
          at: Date.now(),
        },
      });
    });
  }, []);
}
