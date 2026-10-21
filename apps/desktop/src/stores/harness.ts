import { useEffect } from "react";
import { create } from "zustand";
import type {
  DesktopHarnessApi,
  HarnessAgent,
  HarnessInfo,
} from "../../shared/harness";

/**
 * The agent CLIs' versions and updates, as main last reported them.
 *
 * Which version of each CLI this machine runs, whether a newer one is out,
 * and an update in flight.
 *
 * NOTE: Main owns every one of these facts, the update command included. The
 * renderer names an agent, never a command. Whatever it gets back, from a
 * call or from `onChanged`, replaces the whole list.
 */
interface HarnessState {
  list: HarnessInfo[];
  /** Whether the first list has come back. */
  loaded: boolean;
  checking: boolean;
  error: string | null;
  load: () => Promise<void>;
  check: () => Promise<void>;
  update: (agent: HarnessAgent) => Promise<void>;
  dismiss: (agent: HarnessAgent, version: string) => Promise<void>;
  openInTerminal: (agent: HarnessAgent) => Promise<void>;
}

/**
 * The request ticket for lists.
 *
 * A list that was asked for before a later one must not land after it.
 */
let generation = 0;

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const useHarness = create<HarnessState>((set) => {
  /** Run a call that answers with the list, and keep the newest answer. */
  async function apply(
    call: (surface: DesktopHarnessApi) => Promise<HarnessInfo[]>,
    fallback: string,
  ): Promise<void> {
    const surface = harnessSurface();
    if (!surface) return;
    const mine = ++generation;
    try {
      const list = await call(surface);
      if (generation !== mine) return;
      set({ list, loaded: true, error: null });
    } catch (error) {
      if (generation !== mine) return;
      // A failed call keeps the last list. An island that vanished because
      // one check timed out would hide an update that is still out there.
      set({ error: message(error, fallback) });
    }
  }
  return {
    list: [],
    loaded: false,
    checking: false,
    error: null,
    load: () => apply((surface) => surface.list(), "Could not read versions."),
    check: async () => {
      set({ checking: true });
      try {
        await apply(
          (surface) => surface.check(),
          "Could not check for updates.",
        );
      } finally {
        set({ checking: false });
      }
    },
    update: (agent) =>
      apply((surface) => surface.update(agent), "Could not update."),
    dismiss: (agent, version) =>
      apply((surface) => surface.dismiss(agent, version), "Could not dismiss."),
    openInTerminal: async (agent) => {
      await harnessSurface()?.openInTerminal(agent);
    },
  };
});

/**
 * Read the list once and follow every change main pushes, while mounted.
 *
 * The island and Settings › Agents both call it; the second subscription
 * only costs a listener.
 */
export function useHarnessWatch(): void {
  const load = useHarness((state) => state.load);
  useEffect(() => {
    const surface = harnessSurface();
    if (!surface) return;
    const stop = surface.onChanged((list) => {
      // A push is newer than any answer still on its way.
      generation++;
      useHarness.setState({ list, loaded: true, error: null });
    });
    void load();
    return stop;
  }, [load]);
}

/**
 * A dev-only fake of main's harness surface.
 *
 * Remove once the e2e fake CLI (`LANEWORK_CODEX_BIN`) covers the island.
 *
 * In a dev build, `localStorage['lanework.harness.fake']` serves a made-up
 * list instead of main's: Codex 0.162.1 → 0.163.0 (brew-cask). Words in the
 * value change it:
 * - `claude` adds a pending Claude Code too;
 * - `fail` makes Update fail.
 *
 * Update takes 2s. A production build never reads the key.
 */
let fake: DesktopHarnessApi | null | undefined;

function harnessSurface(): DesktopHarnessApi | undefined {
  if (import.meta.env.DEV) {
    if (fake === undefined) fake = makeFake();
    if (fake) return fake;
  }
  return window.desktop?.harness;
}

function makeFake(): DesktopHarnessApi | null {
  let mode: string | null = null;
  try {
    mode = window.localStorage.getItem("lanework.harness.fake");
  } catch {
    return null;
  }
  if (!mode) return null;
  const fails = mode.includes("fail");
  const entry = (
    agent: HarnessAgent,
    version: string,
    latest: string,
  ): HarnessInfo => ({
    agent,
    path: `/opt/homebrew/bin/${agent}`,
    version,
    latest,
    installMethod: "brew-cask",
    updateCommand: `brew upgrade --cask ${agent}`,
    dismissed: null,
    update: { state: "idle" },
    checkedAt: new Date().toISOString(),
  });
  let list: HarnessInfo[] = [
    entry("codex", "0.162.1", "0.163.0"),
    mode.includes("claude")
      ? entry("claude", "2.1.3", "2.1.7")
      : entry("claude", "2.1.7", "2.1.7"),
  ];
  const listeners = new Set<(list: HarnessInfo[]) => void>();
  const patch = (agent: HarnessAgent, next: Partial<HarnessInfo>) => {
    list = list.map((info) =>
      info.agent === agent ? { ...info, ...next } : info,
    );
    for (const listener of listeners) listener(list);
    return list;
  };
  return {
    list: async () => list,
    accounts: async () => [
      {
        agent: "claude",
        signedIn: true,
        email: "you@example.com",
        org: "Example",
        plan: "team",
      },
      {
        agent: "codex",
        signedIn: true,
        email: "you@example.com",
        org: "Personal",
        plan: "plus",
      },
    ],
    check: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return patch("codex", { checkedAt: new Date().toISOString() });
    },
    update: async (agent) => {
      setTimeout(() => {
        const info = list.find((item) => item.agent === agent);
        if (!info?.latest) return;
        patch(
          agent,
          fails
            ? {
                update: {
                  state: "failed",
                  message: "brew exited with code 1.",
                },
              }
            : {
                version: info.latest,
                update: { state: "done", version: info.latest },
              },
        );
      }, 2000);
      return patch(agent, { update: { state: "updating" } });
    },
    dismiss: async (agent, version) => patch(agent, { dismissed: version }),
    openInTerminal: async (agent) => {
      console.info(`[harness fake] open in terminal: ${agent}`);
    },
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
