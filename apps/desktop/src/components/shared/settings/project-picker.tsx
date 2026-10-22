import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { useBoard } from "#/stores/board";

/**
 * The project Settings › Memory and Settings › Instructions show.
 *
 * `?project=` when it names one, else the project last open, else ""
 * (FE-51/D3).
 *
 * NOTE: "" only ever reaches the layouts. They render no `<Outlet />` without
 * a project, so the screens inside can treat the slug as real.
 */
export function useSettingsProject(): string {
  const { project } = useSearch({ strict: false }) as { project?: string };
  const active = useBoard((state) => state.active?.slug ?? null);
  const ready = useBoard((state) => state.ready);
  const hydrate = useBoard((state) => state.hydrate);
  useEffect(() => {
    if (!ready) void hydrate();
  }, [ready, hydrate]);
  return project ?? active ?? "";
}

/** Switches the project, back to the page's own first view. */
export function ProjectPicker({
  slug,
  to,
}: {
  slug: string;
  to: "/settings/memory" | "/settings/instructions";
}) {
  const workspaces = useBoard((state) => state.workspaces);
  const navigate = useNavigate();
  const name = (value: string) =>
    workspaces.find((workspace) => workspace.slug === value)?.name ?? value;

  return (
    <Select
      value={slug}
      onValueChange={(value) => {
        if (value) void navigate({ to, search: { project: value as string } });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Project"
        className="min-w-0 max-w-44"
      >
        <SelectValue>
          {(value: string) => (
            <span className="truncate">
              {value ? name(value) : "Pick a project"}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {workspaces.map((workspace) => (
          <SelectItem key={workspace.slug} value={workspace.slug}>
            {workspace.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The bar above Memory or Instructions when no list beside it carries the
 * picker.
 *
 * Drawn when there is no project, no folder or nothing written yet, so
 * another project is always one click away.
 */
export function ProjectBar({
  title,
  slug,
  to,
}: {
  title: string;
  slug: string;
  to: "/settings/memory" | "/settings/instructions";
}) {
  return (
    <header className="window-drag-region border-border flex h-11 shrink-0 items-center gap-2 border-b px-3.5">
      <h2 className="text-[13px] font-medium">{title}</h2>
      <div className="ml-auto min-w-0">
        <ProjectPicker slug={slug} to={to} />
      </div>
    </header>
  );
}
