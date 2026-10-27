// What the user did to a proposal card (FE-87): their edits, a cancel, and
// the run an approval started. The proposal itself is the transcript's
// (`orchestration-panel.prompt.ts`); this is only what lies on top of it.
//
// Kept in localStorage, so a card edited, then left, comes back as it was
// left, and an approved card finds its run again after a restart.

import { create } from "zustand";
import type { ProposedTask } from "#/../shared/orchestration";

export interface ProposalEdits {
  /** The tasks as the user edited them; absent: the lead's, untouched. */
  tasks?: ProposedTask[];
  maxWorkers?: number;
  /** The user cancelled the card: nothing will run from it. */
  cancelled?: boolean;
  /** The run its approval started. */
  runId?: string;
  /** When it was last touched, to forget the oldest first. */
  at: number;
}

const KEY = "lanework.orchestration.proposals";
/** The most cards remembered; the oldest go first. */
const KEEP = 200;

function load(): Record<string, ProposalEdits> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, ProposalEdits>)
      : {};
  } catch {
    return {};
  }
}

function save(edits: Record<string, ProposalEdits>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(edits));
  } catch {
    // A full or unavailable storage only costs the edits.
  }
}

interface EditsState {
  edits: Record<string, ProposalEdits>;
  patch: (id: string, patch: Partial<Omit<ProposalEdits, "at">>) => void;
  /**
   * The proposal just approved, by id: whatever draws it next (its run
   * panel, or the card when the run is gone) takes the focus once, so it
   * does not fall back to the page (FE-91). Not kept in localStorage.
   */
  focus: string | null;
  setFocus: (id: string | null) => void;
}

export const useProposalEdits = create<EditsState>((set, get) => ({
  edits: load(),
  focus: null,
  setFocus: (focus) => set({ focus }),
  patch: (id, patch) => {
    const edits = {
      ...get().edits,
      [id]: { ...get().edits[id], ...patch, at: Date.now() },
    };
    const kept = Object.entries(edits)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, KEEP);
    const next = Object.fromEntries(kept);
    save(next);
    set({ edits: next });
  },
}));
