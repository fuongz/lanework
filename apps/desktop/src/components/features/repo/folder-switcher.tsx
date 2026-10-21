import { Folder01Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import type { PickedFolder } from "../../../../shared/workspaces";

/**
 * Which of the project's linked folders the Files tree reads (FE-71). Drawn
 * only when there are two or more — a project with one folder has nothing to
 * pick. The primary comes first, as Settings lists them.
 */
export function FolderSwitcher({
  folders,
  index,
  onChange,
}: {
  folders: PickedFolder[];
  index: number;
  onChange: (index: number) => void;
}) {
  const current = folders[index] ?? folders[0];
  if (!current) return null;
  return (
    <div className="shrink-0 px-2 pt-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Folder — ${current.name}`}
          title={current.path}
          className="hover:bg-foreground/[0.06] bg-foreground/[0.035] flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-xs transition-colors duration-150"
        >
          <HugeiconsIcon
            icon={Folder01Icon}
            className="text-muted-foreground size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">{current.name}</span>
          {index === 0 && (
            <span className="text-muted-foreground shrink-0">Primary</span>
          )}
          <HugeiconsIcon
            icon={UnfoldMoreIcon}
            className="text-muted-foreground ml-auto size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuRadioGroup
            value={String(index)}
            onValueChange={(value) => onChange(Number(value))}
          >
            {folders.map((folder, at) => (
              <DropdownMenuRadioItem
                key={folder.id}
                value={String(at)}
                title={folder.path}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {folder.name}
                    {at === 0 && (
                      <span className="text-muted-foreground"> · Primary</span>
                    )}
                  </span>
                  <span className="text-muted-foreground truncate text-[11px]">
                    {folder.path}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
