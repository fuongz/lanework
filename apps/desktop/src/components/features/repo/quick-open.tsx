// ⌘P in Repository › Files (FE-66/D8): a file by name, fuzzily.
//
// - Over git's list only: what is tracked or untracked, not what is ignored.
//   `node_modules` is not read until somebody opens it, and a search that
//   walked it would answer every query with a thousand copies of `index.js`.
//   An editor leaves it out of Quick Open for the same reason.
// - Scored here, not by cmdk (`shouldFilter={false}`): cmdk ranks every item
//   it is handed on each keystroke, and a repository holds tens of thousands.
import { useMemo, useState } from "react";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "#/components/ui/command";
import { useFiles } from "#/stores/files";

/** Results drawn. Past this nobody scrolls; they type another letter. */
const LIMIT = 50;

/**
 * How well `query` matches `path` as a subsequence, or -1 for not at all.
 *
 * Letters in the file's name, at the start of a word, and in a run count for
 * more: `fv` finds `file-view.tsx` before `features/views/index.ts`.
 */
function score(path: string, query: string): number {
  const lower = path.toLowerCase();
  const nameAt = lower.lastIndexOf("/") + 1;
  let at = 0;
  let total = 0;
  let run = 0;
  for (const char of query) {
    const found = lower.indexOf(char, at);
    if (found === -1) return -1;
    run = found === at ? run + 1 : 0;
    total += 1 + run * 2;
    if (found >= nameAt) total += 3;
    const before = lower[found - 1];
    if (
      found === 0 ||
      before === "/" ||
      before === "-" ||
      before === "_" ||
      before === "."
    )
      total += 4;
    at = found + 1;
  }
  // Shorter paths first among equals: `src/index.ts` over a deep one.
  return total - path.length / 100;
}

export function QuickOpen({ paths }: { paths: string[] }) {
  const open = useFiles((state) => state.quickOpen);
  const setOpen = useFiles((state) => state.setQuickOpen);
  const openFile = useFiles((state) => state.openFile);
  const [query, setQuery] = useState("");

  const files = useMemo(
    () => paths.filter((path) => !path.endsWith("/")),
    [paths],
  );

  const matched = useMemo(() => {
    const needle = query.replace(/\s+/g, "").toLowerCase();
    if (!needle) return files.slice(0, LIMIT);
    const ranked: { path: string; score: number }[] = [];
    for (const path of files) {
      const value = score(path, needle);
      if (value >= 0) ranked.push({ path, score: value });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, LIMIT).map((item) => item.path);
  }, [files, query]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      title="Go to File"
      description="Find a file in this repository by name"
    >
      <Command shouldFilter={false}>
        <CommandInput
          placeholder="Go to file…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-96">
          <CommandEmpty>No files match.</CommandEmpty>
          {matched.map((path) => {
            const cut = path.lastIndexOf("/");
            return (
              <CommandItem
                key={path}
                value={path}
                onSelect={() => {
                  openFile(path, true);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <FileTypeIcon path={path} className="size-3.5 shrink-0" />
                <span className="shrink-0">{path.slice(cut + 1)}</span>
                {cut > 0 && (
                  <span className="text-muted-foreground min-w-0 truncate text-xs">
                    {path.slice(0, cut)}
                  </span>
                )}
              </CommandItem>
            );
          })}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
