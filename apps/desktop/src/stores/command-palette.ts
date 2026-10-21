import { create } from "zustand";

/**
 * Whether the palette is open.
 *
 * A store rather than state in the shell, because the two things that open it
 * are far apart: a button in the sidebar and a ⌘K listener on the window.
 * Their nearest common parent is the component that owns the whole app.
 */
interface CommandPaletteState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export const useCommandPalette = create<CommandPaletteState>()((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
}));
