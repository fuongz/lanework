import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { tagColor } from "@/lib/tag-color";
import { cn } from "@/lib/utils";

interface TagMoreProps {
  owner: string;
  repo: string;
  tags: { name: string; count: number }[];
  activeTag?: string;
}

export function TagMore({ owner, repo, tags, activeTag }: TagMoreProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  function choose(name: string) {
    setOpen(false);
    navigate({ to: "/board/$owner/$repo", params: { owner, repo }, search: { tag: name } });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[popup-open]:bg-sidebar-accent">
        <HugeiconsIcon icon={MoreHorizontalIcon} className="size-4 text-muted-foreground" />
        More
      </PopoverTrigger>

      <PopoverContent align="start" sideOffset={6} className="w-64 gap-0 overflow-hidden rounded-xl p-0">
        <Command>
          <CommandInput placeholder="Search tags…" />
          <CommandList>
            <CommandEmpty>No tags found.</CommandEmpty>
            <CommandGroup>
              {tags.map((t) => (
                <CommandItem
                  key={t.name}
                  value={t.name}
                  data-checked={activeTag === t.name ? "true" : "false"}
                  onSelect={() => choose(t.name)}
                >
                  <span className={cn("size-2 shrink-0 rounded-full", tagColor(t.name))} />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <span className="text-[11px] text-muted-foreground">{t.count}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
