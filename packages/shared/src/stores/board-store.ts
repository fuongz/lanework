import { create } from "zustand";
import type { ReviewCard } from "@/lib/github";

interface BoardState {
  /** The card currently open in the detail drawer (null = closed). */
  activeCard: ReviewCard | null;
  openCard: (card: ReviewCard) => void;
  closeCard: () => void;
}

export const useBoardStore = create<BoardState>((set) => ({
  activeCard: null,
  openCard: (card) => set({ activeCard: card }),
  closeCard: () => set({ activeCard: null }),
}));
