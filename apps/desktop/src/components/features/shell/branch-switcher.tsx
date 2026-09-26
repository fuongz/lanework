import { ArrowDown01Icon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { useWorktree } from "#/stores/worktree";

/**
 * ⚠️ 13px rows, the rail's own size. The registry's `text-xs` suits a dense
 * command palette; a branch name is read, often long, and sat beside 13px
 * navigation it looked a size too small.
 */
const ITEM = "min-h-8 text-[13px]";
const GROUP = "**:[[cmdk-group-heading]]:text-[12px]";

/**
 * The project's current branch, beside the REPOSITORY label, and the way to
 * another one.
 *
 * ⚠️ Read with `for-each-ref` on project change, on window focus and when the
 * menu opens — never a `git status`. A branch name on every screen is worth one
 * cheap read; the file list is not, and stays on the Changes screen.
 *
 * ⚠️ Hidden, not disabled, when the project has no repository. The Changes
 * screen explains why there is none; a greyed-out control beside the label
 * would raise the question in a place with no room to answer it.
 */
export function BranchSwitcher({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const branches = useWorktree((state) =>
    state.branches?.slug === slug ? state.branches.list : undefined,
  );
  const loadBranches = useWorktree((state) => state.loadBranches);
  const switchBranch = useWorktree((state) => state.switchBranch);
  const switching = useWorktree((state) => state.switching);
  const switchError = useWorktree((state) => state.switchError);

  useEffect(() => {
    void loadBranches(slug);
    const onFocus = () => void loadBranches(slug);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadBranches, slug]);

  if (!branches) return null;
  const label = switching ?? branches.current ?? "Detached";

  const pick = (name: string) => {
    if (name === branches.current) {
      setOpen(false);
      return;
    }
    void switchBranch(slug, name).then((done) => {
      if (done) setOpen(false);
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void loadBranches(slug);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="secondary"
            size="xs"
            aria-label={`Switch branch — currently ${branches.current ?? "detached HEAD"}`}
            // ⚠️ `shrink` over the button's own `shrink-0`: a long branch name
            // gives way — truncated — instead of pushing the row wider than
            // the rail and scrolling it sideways.
            className="max-w-[9.5rem] min-w-0 shrink gap-1 text-[11px]"
          >
            <HugeiconsIcon
              icon={GitBranchIcon}
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">{label}</span>
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              strokeWidth={1.8}
              className="opacity-60"
              aria-hidden="true"
            />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-72 gap-0 p-0">
        <Command className="[&_[data-slot=command-input-wrapper]]:p-0 [&_[data-slot=command-input-wrapper]]:pb-1">
          <CommandInput placeholder="Switch branch…" className="text-[13px]" />
          <CommandList className="max-h-80">
            <CommandEmpty>No branch matches.</CommandEmpty>
            {branches.local.length > 0 && (
              <CommandGroup heading="Local" className={GROUP}>
                {branches.local.map((name) => (
                  <CommandItem
                    key={name}
                    value={name}
                    // The item's own tick, not a second one drawn here.
                    data-checked={
                      name === branches.current ? "true" : undefined
                    }
                    disabled={switching !== null}
                    onSelect={() => pick(name)}
                    className={ITEM}
                  >
                    <span className="min-w-0 flex-1 truncate" title={name}>
                      {name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {branches.remote.length > 0 && (
              <CommandGroup heading="Remote" className={GROUP}>
                {branches.remote.map((name) => (
                  <CommandItem
                    key={name}
                    value={name}
                    disabled={switching !== null}
                    onSelect={() => pick(name)}
                    className={ITEM}
                  >
                    <span className="min-w-0 flex-1 truncate" title={name}>
                      {name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          {switchError && (
            <p
              role="alert"
              className="text-destructive border-border border-t px-2.5 py-2 text-xs/relaxed break-words whitespace-pre-wrap"
            >
              {switchError}
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
