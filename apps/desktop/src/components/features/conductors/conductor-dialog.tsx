import {
  Brain02Icon,
  McpServerIcon,
  NoteEditIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useMemo, useState } from "react";
import { allModels } from "#/../shared/conversation";
import type {
  LeadIcon,
  LeadsList,
  TeamLead,
  TeamLeadInput,
} from "#/../shared/orchestration";
import type { ProjectAvatar } from "#/../shared/project-avatar";
import { AvatarEditor } from "#/components/shared/projects/avatar-dialog";
import { AvatarFace } from "#/components/shared/projects/project-avatar";
import { CodeEditor } from "#/components/shared/settings/agent-config-editor";
import { SettingsPage } from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { ipcMessage } from "#/lib/ipc-error";
import { cn } from "#/lib/utils";
import { ConductorConnectors } from "./conductor-connectors";
import { ConductorContext } from "./conductor-context";
import {
  blankDraft,
  conductorEditor,
  type Draft,
  draftFrom,
  freeId,
  ICONS,
  slugify,
} from "./conductor-editor";
import { ConductorMemory } from "./conductor-memory";

/**
 * What the dialog opens on: a new conductor, or one to edit or copy; or, for
 * a conductor that is its repo's file (FE-166), only its Connectors page.
 */
export type ConductorDialogMode =
  | { kind: "new" }
  | { kind: "edit"; lead: TeamLead }
  | { kind: "duplicate"; lead: TeamLead }
  | { kind: "connectors"; lead: TeamLead };

/** The dialog's pages, and the editor sections each one shows. */
const PAGES = [
  {
    key: "general",
    label: "General",
    icon: Settings01Icon,
    description: "Who it is, and what it runs on.",
    sections: ["Identity", "Model"],
  },
  {
    key: "instructions",
    label: "Instructions",
    icon: NoteEditIcon,
    description: "What it is told before every request.",
    sections: [],
  },
  {
    // FE-166: what its agent may reach from this project.
    key: "connectors",
    label: "Connectors",
    icon: McpServerIcon,
    description: "The MCP servers it may use.",
    sections: [],
  },
  {
    // FE-128: the ledger, runs and notes only a saved conductor in a
    // project has; above them the files it always reads (FE-96), once a
    // Context page of its own.
    key: "memory",
    label: "Memory",
    icon: Brain02Icon,
    description: "What it reads and keeps of this project.",
    sections: [],
  },
] as const;
type PageKey = (typeof PAGES)[number]["key"];

/** The draft a mode starts from. */
function startDraft(mode: ConductorDialogMode, taken: Set<string>): Draft {
  const models = allModels();
  if (mode.kind === "new") return blankDraft(models);
  if (mode.kind === "edit") return draftFrom(mode.lead, mode.lead.id);
  if (mode.kind === "connectors") return draftFrom(mode.lead, mode.lead.id);
  const name = `${mode.lead.name} copy`.slice(0, 60);
  return draftFrom(mode.lead, null, {
    name,
    id: freeId(slugify(name), taken),
  });
}

/**
 * New, Edit and Duplicate from the rail (FE-95): a settings dialog with its
 * own sidebar, as shadcn's, General first. It saves a personal conductor.
 *
 * Mount it with a `key` per opening, so each one starts from its own draft.
 */
export function ConductorDialog({
  mode,
  project,
  list,
  onClose,
  onSaved,
}: {
  mode: ConductorDialogMode;
  /** The project it belongs to (FE-95). */
  project: string;
  list: LeadsList | null;
  onClose: () => void;
  /** Saved: the conductor as it was saved. */
  onSaved: (input: TeamLeadInput) => void;
}) {
  const taken = useMemo(
    () => new Set((list?.leads ?? []).map((lead) => lead.id)),
    [list],
  );
  const [draft, setDraft] = useState(() => startDraft(mode, taken));
  const connectorsOnly = mode.kind === "connectors";
  const [page, setPage] = useState<PageKey>(
    connectorsOnly ? "connectors" : "general",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editor = conductorEditor({
    draft,
    setDraft,
    takenIds: taken,
    source: mode.kind === "connectors" ? mode.lead.source : "personal",
  });
  const { problem, parsed } = editor;
  // Who it is, on top of General: the icon to pick and the name to type, as
  // Monocode's Mono settings have. The id follows the name until it is saved.
  const identity = (
    <Identity
      icon={draft.input.icon}
      avatar={draft.input.avatar ?? null}
      name={draft.input.name}
      onAvatar={(avatar) => {
        const { avatar: _, ...rest } = draft.input;
        setDraft({ ...draft, input: avatar ? { ...rest, avatar } : rest });
      }}
      onName={(next) =>
        setDraft({
          ...draft,
          input: {
            ...draft.input,
            name: next,
            id:
              draft.editing !== null
                ? draft.input.id
                : freeId(slugify(next), taken),
          },
        })
      }
    />
  );
  const sections = [
    { title: "Identity", hideTitle: true, content: identity },
    ...editor.sections,
  ];
  // Memory is per conductor and project (FE-128): a new or copied conductor
  // has none yet, and neither has one outside a project. Its page still
  // shows, for the files it always reads.
  const editing = mode.kind === "edit" && project ? mode.lead : null;
  const pages = PAGES.filter((entry) =>
    connectorsOnly ? entry.key === "connectors" : true,
  );
  const current = pages.find((entry) => entry.key === page) ?? PAGES[0];
  const name = draft.input.name.trim();
  const title =
    mode.kind === "edit"
      ? `Edit ${mode.lead.name}`
      : mode.kind === "connectors"
        ? `Connectors for ${mode.lead.name}`
        : name || "New conductor";

  // Stable: the page's rows are memoized and redraw only when a switch moves.
  const updateConnectors = useCallback(
    (connectors: TeamLeadInput["connectors"]) =>
      setDraft((current) => {
        const { connectors: _old, ...rest } = current.input;
        return {
          ...current,
          input: connectors ? { ...rest, connectors } : rest,
        };
      }),
    [],
  );

  const save = async (input: TeamLeadInput) => {
    const surface = window.desktop?.leads;
    if (!surface) return;
    setBusy(true);
    try {
      await surface.savePersonal(project, input);
      setError(null);
      onSaved(input);
    } catch (failure) {
      setError(ipcMessage(failure, "Could not save the conductor."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(760px,88vh)] gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <nav
          aria-label="Conductor settings"
          className="bg-sidebar flex w-44 shrink-0 flex-col gap-0.5 border-r p-2.5"
        >
          {pages.map((entry) => (
            <button
              key={entry.key}
              type="button"
              aria-current={entry.key === page ? "page" : undefined}
              onClick={() => setPage(entry.key)}
              className={cn(
                "hover:bg-foreground/[0.04] flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs transition-colors",
                entry.key === page && "bg-foreground/[0.06] font-medium",
              )}
            >
              <HugeiconsIcon
                icon={entry.icon}
                className="text-muted-foreground size-3.5 shrink-0"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          {page === "instructions" ? (
            // A file to write, as Monocode's Soul: the whole pane, markdown,
            // in the code font. ⌘S saves the conductor.
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-baseline gap-2 border-b py-3 pr-12 pl-5">
                <h2 className="text-sm font-medium">Instructions</h2>
                <span className="text-muted-foreground truncate text-xs">
                  Markdown, told to it before every request.
                </span>
              </div>
              <CodeEditor
                value={draft.input.instructions}
                onChange={(instructions) =>
                  setDraft({
                    ...draft,
                    input: { ...draft.input, instructions },
                  })
                }
                onSave={() => {
                  if (parsed && !problem && !busy) void save(parsed);
                }}
                format="markdown"
                gutter={false}
                label="Conductor instructions"
                className="min-h-0 flex-1"
              />
            </div>
          ) : page === "memory" ? (
            <ConductorMemory
              project={project}
              conductor={editing?.id ?? null}
              files={
                <ConductorContext
                  project={project}
                  paths={draft.input.contextFiles}
                  onChange={(contextFiles) =>
                    setDraft({
                      ...draft,
                      input: { ...draft.input, contextFiles },
                    })
                  }
                />
              }
            />
          ) : page === "connectors" ? (
            <ConductorConnectors
              project={project}
              agent={draft.input.lead.agent}
              disabled={draft.input.connectors?.disabled ?? []}
              onChange={updateConnectors}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-6">
              <SettingsPage
                title={current.label}
                description={current.description}
                sections={sections.filter((section) =>
                  (current.sections as readonly string[]).includes(
                    section.title,
                  ),
                )}
                searchable={false}
                compact
              />
            </div>
          )}
          <footer className="flex items-center justify-end gap-2 border-t px-5 py-2.5">
            <p
              role={error ? "alert" : undefined}
              className={cn(
                "mr-auto min-w-0 text-xs leading-snug",
                error ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {error ??
                (name
                  ? (problem ??
                    (connectorsOnly
                      ? "Only the connectors change; its file stays as it is."
                      : null))
                  : "Name it to save.")}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || !parsed || !!problem}
              onClick={() => parsed && void save(parsed)}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Its avatar, picked as a project's is (icon, emoji or letter on a colour),
 * and the name under it, edited in place. With no avatar it wears its line
 * icon. Only the draft changes: Save keeps it.
 */
function Identity({
  icon,
  avatar,
  name,
  onAvatar,
  onName,
}: {
  icon: LeadIcon;
  avatar: ProjectAvatar | null;
  name: string;
  onAvatar: (avatar: ProjectAvatar | null) => void;
  onName: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Opened afresh each time, so it starts from the draft's avatar.
  const [opened, setOpened] = useState(0);
  return (
    <div className="flex flex-col items-center gap-2">
      {/* A popover under the avatar, not a dialog over this dialog: two
          modals stacked read as one washed-out layer. */}
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setOpened((count) => count + 1);
          setOpen(next);
        }}
      >
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="Change avatar"
              title="Change avatar"
              className="focus-visible:ring-ring/30 rounded-xl transition-opacity outline-none hover:opacity-90 focus-visible:ring-2"
            />
          }
        >
          {avatar ? (
            <AvatarFace
              avatar={avatar}
              className="size-14 rounded-xl text-xl"
            />
          ) : (
            <span className="bg-foreground/[0.04] border-border grid size-14 place-items-center rounded-xl border">
              <HugeiconsIcon
                icon={ICONS[icon]}
                className="size-6"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </span>
          )}
        </PopoverTrigger>
        <PopoverContent className="flex w-[26rem] flex-col gap-4 p-4">
          <AvatarEditor
            key={opened}
            name={name}
            start={avatar}
            saveLabel="Done"
            onClose={() => setOpen(false)}
            onSave={(next) => {
              onAvatar(next);
              return null;
            }}
          />
        </PopoverContent>
      </Popover>
      <input
        aria-label="Conductor name"
        placeholder="Name it"
        value={name}
        maxLength={60}
        onChange={(event) => onName(event.target.value)}
        className="hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.04] placeholder:text-muted-foreground/70 w-64 rounded-md bg-transparent px-2 py-0.5 text-center text-sm font-medium outline-none"
      />
    </div>
  );
}
