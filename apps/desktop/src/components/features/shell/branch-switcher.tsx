import {
  ArrowDown01Icon,
  GitBranchIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
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
import { cn } from "#/lib/utils";
import { useWorktree } from "#/stores/worktree";

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
export function BranchSwitcher({
  slug,
  variant = "rail",
}: {
  slug: string;
  /**
   * `composer`: the chat composer's top row — a quiet label that opens
   * upward, since the composer sits at the window's bottom.
   */
  variant?: "rail" | "composer";
}) {
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
          variant === "composer" ? (
            <button
              type="button"
              aria-label={`Switch branch — currently ${branches.current ?? "detached HEAD"}`}
              className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] aria-expanded:bg-foreground/[0.06] aria-expanded:text-foreground focus-visible:ring-ring/30 -mx-1.5 flex h-6 max-w-64 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[13px] transition-colors outline-none focus-visible:ring-2"
            >
              <HugeiconsIcon
                icon={GitBranchIcon}
                className="size-3.5 shrink-0"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">{label}</span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                className="size-3.5 shrink-0 opacity-60"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </button>
          ) : (
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
          )
        }
      />
      <PopoverContent
        variant="menu"
        align={variant === "composer" ? "start" : "end"}
        side={variant === "composer" ? "top" : undefined}
      >
        <Command>
          <CommandInput placeholder="Switch branch…" />
          <CommandList className="max-h-80">
            <CommandEmpty>No branch matches.</CommandEmpty>
            <CommandGroup>
              {/* One list, locals first (ảnh 19): the current one ticked,
                  a remote one named without its remote, which is its tag. */}
              {[...branches.local, ...branches.remote].map((name) => {
                const remote = branches.remote.includes(name)
                  ? name.slice(0, name.indexOf("/"))
                  : null;
                const shown = remote ? name.slice(remote.length + 1) : name;
                const current = name === branches.current;
                return (
                  <CommandItem
                    key={name}
                    value={name}
                    disabled={switching !== null}
                    onSelect={() => pick(name)}
                    className="gap-2.5"
                  >
                    <HugeiconsIcon
                      icon={current ? Tick02Icon : GitBranchIcon}
                      className={cn(
                        "size-3.5",
                        !current && "text-muted-foreground",
                      )}
                      strokeWidth={current ? 2 : 1.8}
                      aria-hidden="true"
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        current && "font-medium",
                      )}
                      title={name}
                    >
                      {shown}
                    </span>
                    {remote && (
                      <span className="bg-foreground/[0.06] text-muted-foreground shrink-0 rounded px-1.5 py-px text-[11px]">
                        {remote}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
          {switchError && (
            <p
              role="alert"
              className="text-destructive border-foreground/10 max-w-80 border-t px-3 py-2 text-xs/relaxed break-words whitespace-pre-wrap"
            >
              {switchError}
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
