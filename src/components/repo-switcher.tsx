import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HugeiconsIcon } from "@hugeicons/react";
import { UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import type { Repo } from "@/lib/github";

interface RepoSwitcherProps {
  repos: Repo[];
  active?: { owner: string; repo: string };
  className?: string;
}

export function RepoSwitcher({ repos, active, className }: RepoSwitcherProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  // "/" opens the switcher from anywhere (unless typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = document.activeElement?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function choose(repo: Repo) {
    setOpen(false);
    navigate({ to: "/board/$owner/$repo", params: { owner: repo.owner, repo: repo.name } });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent",
          className,
        )}
      >
        <img src="/logo.png" alt="Lanework" className="size-7 shrink-0 rounded-lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold leading-tight">
            {active?.repo ?? "Select project"}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {active?.owner ?? "Switch repository"}
          </span>
        </span>
        <HugeiconsIcon icon={UnfoldMoreIcon} className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>

      <PopoverContent align="start" sideOffset={6} className="w-72 gap-0 overflow-hidden rounded-xl p-0">
        <Command>
          <CommandInput placeholder="Search repositories…" />
          <CommandList>
            <CommandEmpty>No repositories found.</CommandEmpty>
            <CommandGroup>
              {repos.map((repo) => {
                const isActive = active?.owner === repo.owner && active?.repo === repo.name;
                return (
                  <CommandItem
                    key={repo.id}
                    value={repo.fullName}
                    data-checked={isActive ? "true" : "false"}
                    onSelect={() => choose(repo)}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{repo.name}</span>
                      <span className="truncate text-[11px] text-muted-foreground">{repo.owner}</span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
