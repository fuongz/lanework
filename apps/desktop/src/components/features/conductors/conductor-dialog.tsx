import {
  Folder01Icon,
  NoteEditIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import { allModels } from "#/../shared/conversation";
import {
  LEAD_ICONS,
  type LeadIcon,
  type LeadsList,
  type TeamLead,
  type TeamLeadInput,
} from "#/../shared/orchestration";
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
import { leadIcon } from "#/lib/orchestration-prompt";
import { cn } from "#/lib/utils";
import { ConductorContext } from "./conductor-context";
import {
  blankDraft,
  conductorEditor,
  type Draft,
  draftFrom,
  freeId,
  ICONS,
  iconLabel,
  slugify,
} from "./conductor-editor";

/** What the dialog opens on: a new conductor, or one to edit or copy. */
export type ConductorDialogMode =
  | { kind: "new" }
  | { kind: "edit"; lead: TeamLead }
  | { kind: "duplicate"; lead: TeamLead };

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
    key: "context",
    label: "Context",
    icon: Folder01Icon,
    description: "Project files it reads before it answers.",
    sections: [],
  },
] as const;
type PageKey = (typeof PAGES)[number]["key"];

/** The draft a mode starts from. */
function startDraft(mode: ConductorDialogMode, taken: Set<string>): Draft {
  const models = allModels();
  if (mode.kind === "new") return blankDraft(models);
  if (mode.kind === "edit") return draftFrom(mode.lead, mode.lead.id);
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
  const [page, setPage] = useState<PageKey>("general");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editor = conductorEditor({
    draft,
    setDraft,
    takenIds: taken,
  });
  const { problem, parsed } = editor;
  // Who it is, on top of General: the icon to pick and the name to type, as
  // Monocode's Mono settings have. The id follows the name until it is saved.
  const identity = (
    <Identity
      icon={draft.input.icon}
      name={draft.input.name}
      onIcon={(icon) => setDraft({ ...draft, input: { ...draft.input, icon } })}
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
  const current = PAGES.find((entry) => entry.key === page) ?? PAGES[0];
  const name = draft.input.name.trim();
  const title =
    mode.kind === "edit" ? `Edit ${mode.lead.name}` : name || "New conductor";

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
      <DialogContent className="flex h-[min(560px,85vh)] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <nav
          aria-label="Conductor settings"
          className="bg-sidebar flex w-44 shrink-0 flex-col gap-0.5 border-r p-2.5"
        >
          <div className="text-muted-foreground flex min-w-0 items-center gap-2 px-2 pt-1 pb-2 text-xs">
            <HugeiconsIcon
              icon={leadIcon(draft.input.icon)}
              className="size-4 shrink-0"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span className="truncate">{name || "New conductor"}</span>
          </div>
          {PAGES.map((entry) => (
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
          ) : page === "context" ? (
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
                    "Only in this project. Another project makes its own.")
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

/** The big icon to pick from, and the name under it, edited in place. */
function Identity({
  icon,
  name,
  onIcon,
  onName,
}: {
  icon: LeadIcon;
  name: string;
  onIcon: (icon: LeadIcon) => void;
  onName: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`Icon: ${iconLabel(icon)}. Change it`}
              className="bg-foreground/[0.04] hover:bg-foreground/[0.07] border-border focus-visible:ring-ring/30 grid size-14 place-items-center rounded-xl border transition-colors outline-none focus-visible:ring-2"
            >
              <HugeiconsIcon
                icon={ICONS[icon]}
                className="size-6"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </button>
          }
        />
        <PopoverContent className="w-auto p-2">
          <div className="grid grid-cols-6 gap-1">
            {LEAD_ICONS.map((option) => (
              <button
                key={option}
                type="button"
                aria-label={iconLabel(option)}
                aria-pressed={option === icon}
                title={iconLabel(option)}
                onClick={() => {
                  onIcon(option);
                  setOpen(false);
                }}
                className="hover:bg-foreground/[0.06] aria-pressed:bg-foreground/[0.1] grid size-9 place-items-center rounded-lg transition-colors"
              >
                <HugeiconsIcon
                  icon={ICONS[option]}
                  className="size-4.5"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
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
