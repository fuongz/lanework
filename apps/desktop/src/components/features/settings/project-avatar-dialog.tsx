import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import {
  PROJECT_AVATAR_GRADIENTS,
  PROJECT_AVATAR_ICONS,
  PROJECT_AVATAR_SOLIDS,
  type ProjectAvatar,
  type ProjectAvatarColor,
  type ProjectAvatarIcon,
  parseProjectAvatar,
} from "#/../shared/project-avatar";
import type { Project } from "#/../shared/projects";
import {
  AVATAR_COLOR_NAMES,
  AVATAR_COLORS,
  AVATAR_ICONS,
  AvatarFace,
} from "#/components/shared/projects/project-avatar";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { cn } from "#/lib/utils";
import { useBoard } from "#/stores/board";
import { AVATAR_EMOJI } from "./project-avatar-dialog.emoji";

type Kind = ProjectAvatar["kind"];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "icon", label: "Icon" },
  { kind: "emoji", label: "Emoji" },
  { kind: "letter", label: "Letter" },
];

/** "Rocket01Icon" → "rocket", the words an icon is searched by. */
const iconWords = (name: string) =>
  name
    .replace(/\d*Icon$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();

const CELL =
  "grid size-8 place-items-center rounded-md transition-colors hover:bg-foreground/[0.06] focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-foreground/10 aria-pressed:ring-1 aria-pressed:ring-foreground/30";

/**
 * Change a project's avatar (FE-162): an icon, an emoji or a letter, on a
 * colour from the fixed palette (solid or gradient; no custom colours).
 *
 * Saved with the project, so every machine and teammate sees it. "Use
 * default" clears it back to the GitHub icon or the letter tile.
 */
export function ProjectAvatarDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setProjectAvatar = useBoard((state) => state.setProjectAvatar);
  const busy = useBoard((state) => state.busy === `avatar:${project.id}`);
  const start = project.avatar ?? null;
  const initial = (project.name || "?").slice(0, 1).toUpperCase();

  const [kind, setKind] = useState<Kind>(start?.kind ?? "letter");
  const [icon, setIcon] = useState<ProjectAvatarIcon>(
    start?.kind === "icon" ? start.icon : "Rocket01Icon",
  );
  const [emoji, setEmoji] = useState(
    start?.kind === "emoji" ? start.emoji : "🚀",
  );
  const [text, setText] = useState(
    start?.kind === "letter" ? start.text : initial,
  );
  const [color, setColor] = useState<ProjectAvatarColor>(
    start?.color ?? "violet",
  );
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState<string | null>(null);

  const draft: ProjectAvatar | null = parseProjectAvatar(
    kind === "icon"
      ? { kind, icon, color }
      : kind === "emoji"
        ? { kind, emoji: emoji.trim(), color }
        : { kind, text: text.trim(), color },
  );

  const q = query.trim().toLowerCase();
  const icons = useMemo(
    () =>
      PROJECT_AVATAR_ICONS.filter((name) => !q || iconWords(name).includes(q)),
    [q],
  );
  const emojis = useMemo(
    () => AVATAR_EMOJI.filter(([, words]) => !q || words.includes(q)),
    [q],
  );

  const save = async (avatar: ProjectAvatar | null) => {
    if (!project.id) return;
    setFailed(null);
    const { error } = await setProjectAvatar(project.id, avatar);
    if (error) setFailed(error);
    else onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change avatar</DialogTitle>
          <DialogDescription>
            {project.name} wears it everywhere, on every machine.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex items-center gap-4">
            {draft ? (
              <AvatarFace avatar={draft} className="size-14 text-xl" />
            ) : (
              <span className="bg-muted size-14 shrink-0 rounded-md" />
            )}
            <div
              role="tablist"
              aria-label="Avatar kind"
              className="bg-muted inline-flex rounded-lg p-0.5"
            >
              {KINDS.map((entry) => (
                <button
                  key={entry.kind}
                  type="button"
                  role="tab"
                  aria-selected={kind === entry.kind}
                  onClick={() => {
                    setKind(entry.kind);
                    setQuery("");
                  }}
                  className="text-muted-foreground aria-selected:bg-background aria-selected:text-foreground h-7 rounded-md px-3 text-[13px] font-medium transition-colors aria-selected:shadow-sm"
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          {kind === "letter" ? (
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="avatar-letter"
                className="text-[13px] font-medium"
              >
                Letters
              </label>
              <Input
                id="avatar-letter"
                value={text}
                maxLength={4}
                onChange={(event) => setText(event.target.value)}
                className="h-9 w-24 text-[13px] md:text-[13px]"
              />
              <p className="text-muted-foreground text-xs">
                One or two characters.
              </p>
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-2">
              <div className="border-input flex h-8 items-center gap-2 rounded-md border px-2.5">
                <HugeiconsIcon
                  icon={Search01Icon}
                  className="text-muted-foreground size-3.5 shrink-0"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={
                    kind === "icon" ? "Search icons" : "Search emoji"
                  }
                  aria-label={kind === "icon" ? "Search icons" : "Search emoji"}
                  className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                />
              </div>
              <div className="grid max-h-52 grid-cols-10 gap-1 overflow-y-auto">
                {kind === "icon"
                  ? icons.map((name) => (
                      <button
                        key={name}
                        type="button"
                        aria-label={iconWords(name)}
                        title={iconWords(name)}
                        aria-pressed={icon === name}
                        onClick={() => setIcon(name)}
                        className={CELL}
                      >
                        <HugeiconsIcon
                          icon={AVATAR_ICONS[name]}
                          className="size-4"
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      </button>
                    ))
                  : emojis.map(([value, words]) => (
                      <button
                        key={value}
                        type="button"
                        aria-label={words.split(" ")[0]}
                        title={words}
                        aria-pressed={emoji === value}
                        onClick={() => setEmoji(value)}
                        className={cn(CELL, "text-lg leading-none")}
                      >
                        {value}
                      </button>
                    ))}
              </div>
              {kind === "emoji" && (
                <div className="flex items-center gap-2">
                  <label
                    htmlFor="avatar-emoji"
                    className="text-muted-foreground text-xs"
                  >
                    Or type one
                  </label>
                  <Input
                    id="avatar-emoji"
                    value={emoji}
                    onChange={(event) => setEmoji(event.target.value)}
                    className="h-8 w-16 text-center text-base"
                  />
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <span id="avatar-color" className="text-[13px] font-medium">
              Color
            </span>
            <div
              role="radiogroup"
              aria-labelledby="avatar-color"
              className="flex flex-col gap-2"
            >
              {[PROJECT_AVATAR_SOLIDS, PROJECT_AVATAR_GRADIENTS].map((row) => (
                <div key={row[0]} className="flex flex-wrap gap-2">
                  {row.map((id) => (
                    // biome-ignore lint/a11y/useSemanticElements: colour swatches, not a column of radio inputs.
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={color === id}
                      aria-label={AVATAR_COLOR_NAMES[id]}
                      title={AVATAR_COLOR_NAMES[id]}
                      onClick={() => setColor(id)}
                      className={cn(
                        "ring-offset-background size-6 rounded-full transition-shadow focus-visible:outline-2 focus-visible:outline-ring aria-checked:ring-2 aria-checked:ring-foreground aria-checked:ring-offset-2",
                        AVATAR_COLORS[id],
                      )}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          {(failed || (!draft && kind !== "icon")) && (
            <p role="alert" className="text-destructive text-xs">
              {failed ??
                (kind === "letter"
                  ? "Use one or two letters or digits."
                  : "Pick one emoji.")}
            </p>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            disabled={busy || !project.id || !start}
            onClick={() => void save(null)}
          >
            Use default
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="lg"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="lg"
              disabled={busy || !draft || !project.id}
              onClick={() => draft && void save(draft)}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
