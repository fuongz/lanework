import { create } from "zustand";
import type { ReviewCard, ReviewColumn } from "@/lib/github";

interface BoardState {
  /** The card currently open in the detail drawer (null = closed). */
  activeCard: ReviewCard | null;
  openCard: (card: ReviewCard) => void;
  closeCard: () => void;
  /** Per-column display label overrides for the current board (`status.labels`
   *  in `.agents/reviews/config.json`), kept here so components deep in the
   *  detail drawer can read it without prop-drilling. */
  statusLabels: Partial<Record<ReviewColumn, string>>;
  setStatusLabels: (labels: Partial<Record<ReviewColumn, string>>) => void;
}

export const useBoardStore = create<BoardState>((set) => ({
  activeCard: null,
  openCard: (card) => set({ activeCard: card }),
  closeCard: () => set({ activeCard: null }),
  statusLabels: {},
  setStatusLabels: (statusLabels) => set({ statusLabels }),
}));
