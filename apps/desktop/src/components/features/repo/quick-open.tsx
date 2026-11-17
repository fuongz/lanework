// ⌘P in Repository › Files (FE-66/D8): a file by name, fuzzily.
//
// - Main finds the files (FE-151): fff's index of the folder, honouring
//   `.gitignore`, so `node_modules` never answers a query with a thousand
//   copies of `index.js`. Scoring the whole list here cost a frame per
//   keystroke on a big repository; main answers in a few milliseconds.
// - Asked per keystroke, after {@link DEBOUNCE_MS}; an answer to a query
//   since replaced is dropped, so the latest one wins.
// - With no query, the first files of the tree's list, as before.
// - Ranked by main, not by cmdk (`shouldFilter={false}`).
import { useEffect, useMemo, useState } from "react";
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
/** How long typing must pause before main is asked. */
const DEBOUNCE_MS = 60;

export function QuickOpen({ paths }: { paths: string[] }) {
  const open = useFiles((state) => state.quickOpen);
  const setOpen = useFiles((state) => state.setQuickOpen);
  const openFile = useFiles((state) => state.openFile);
  const slug = useFiles((state) => state.slug);
  const folder = useFiles((state) => state.folder);
  const [query, setQuery] = useState("");
  /** Main's answer, with the query it answers. */
  const [found, setFound] = useState<{ query: string; paths: string[] }>({
    query: "",
    paths: [],
  });

  const needle = query.trim();
  const first = useMemo(
    () => paths.filter((path) => !path.endsWith("/")).slice(0, LIMIT),
    [paths],
  );

  useEffect(() => {
    if (!open || !needle || !slug) return;
    const api = window.desktop?.fsSearch;
    if (!api) return;
    let current = true;
    const timer = setTimeout(() => {
      api
        .findFiles(slug, folder, needle, LIMIT)
        .then((hits) => {
          if (current)
            setFound({ query: needle, paths: hits.map((hit) => hit.path) });
        })
        .catch(() => {
          if (current) setFound({ query: needle, paths: [] });
        });
    }, DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, needle, slug, folder]);

  // The last answer stays up while the next query is out, so the list does
  // not flash empty between keystrokes.
  const matched = needle ? found.paths : first;
  const pending = Boolean(needle) && found.query !== needle;

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setFound({ query: "", paths: [] });
        }
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
          {!pending && <CommandEmpty>No files match.</CommandEmpty>}
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
                  setFound({ query: "", paths: [] });
                }}
              >
                <FileTypeIcon path={path} className="size-4 shrink-0" />
                <span className="shrink-0">{path.slice(cut + 1)}</span>
                {cut > 0 && (
                  <span className="text-muted-foreground min-w-0 truncate text-[12.5px]">
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
