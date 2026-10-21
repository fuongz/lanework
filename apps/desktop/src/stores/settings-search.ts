import { create } from "zustand";

/**
 * What is typed in the settings search box.
 *
 * A store rather than props because two unrelated subtrees read it: the
 * sidebar (to filter nav items) and the page (to filter its own rows).
 *
 * Not persisted. A box that remembers yesterday's query greets you with a
 * filtered app and no explanation.
 */
interface SettingsSearchState {
  query: string;
  setQuery: (query: string) => void;
}

export const useSettingsSearch = create<SettingsSearchState>()((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
}));
