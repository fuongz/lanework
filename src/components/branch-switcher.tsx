import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { GitBranchIcon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Skeleton } from "@/components/ui/skeleton";
import { getBranches } from "@/server/reviews";
import { cn } from "@/lib/utils";

interface BranchSwitcherProps {
  owner: string;
  repo: string;
  /** The branch currently shown. */
  current: string;
  onSelect: (branch: string) => void;
}

/** Branch pill that opens a searchable dropdown of the repo's branches. */
export function BranchSwitcher({ owner, repo, current, onSelect }: BranchSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Lazy-load branches the first time the dropdown opens.
  useEffect(() => {
    if (!open || branches || loading) return;
    setLoading(true);
    getBranches({ data: { owner, repo } })
      .then((b) => setBranches(b))
      .catch(() => setBranches([]))
      .finally(() => setLoading(false));
  }, [open, branches, loading, owner, repo]);

  function choose(branch: string) {
    setOpen(false);
    if (branch !== current) onSelect(branch);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-transparent bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors",
          "hover:bg-muted data-[popup-open]:bg-muted data-[popup-open]:text-foreground",
        )}
      >
        <HugeiconsIcon icon={GitBranchIcon} className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="max-w-[12rem] truncate font-mono">{current}</span>
        <HugeiconsIcon icon={UnfoldMoreIcon} className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={6} className="w-64 overflow-hidden rounded-xl p-0">
        <Command>
          <CommandInput placeholder="Search branches…" />
          <CommandList>
            {loading ? (
              <div className="space-y-1 p-1">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}
              </div>
            ) : (
              <>
                <CommandEmpty>No branches found.</CommandEmpty>
                <CommandGroup>
                  {(branches ?? []).map((branch) => {
                    const isActive = branch === current;
                    return (
                      <CommandItem
                        key={branch}
                        value={branch}
                        data-checked={isActive ? "true" : "false"}
                        onSelect={() => choose(branch)}
                      >
                        <HugeiconsIcon
                          icon={GitBranchIcon}
                          className="size-3.5 shrink-0 text-muted-foreground/70"
                        />
                        <span className="truncate font-mono text-xs">{branch}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
