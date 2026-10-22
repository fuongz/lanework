import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  type ConfigFile,
  parseSkillId,
  type SkillRoot,
} from "#/../shared/agent-config";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { RAIL_ROW, RailHover } from "#/components/shared/navigation/rail-hover";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import {
  CodeEditor,
  useConfigFile,
} from "#/components/shared/settings/agent-config-editor";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "#/components/ui/input-group";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistedLayout,
} from "#/components/ui/resizable";
import { ScrollArea } from "#/components/ui/scroll-area";
import { Separator } from "#/components/ui/separator";
import { ClaudeAiIcon } from "#/components/ui/svgs/claudeAiIcon";
import { CodexDark } from "#/components/ui/svgs/codexDark";
import { CodexLight } from "#/components/ui/svgs/codexLight";
import { Opencode } from "#/components/ui/svgs/opencode";
import { OpencodeDark } from "#/components/ui/svgs/opencodeDark";
import { relativeTime } from "#/lib/board-view";
import { fileSize } from "#/lib/instructions";
import { ipcMessage } from "#/lib/ipc-error";
import { cn } from "#/lib/utils";

const ROUTE = "/settings/skills";

/** Where each root's skills live, for the mark's tooltip and the list's order. */
const ROOTS: Record<SkillRoot, { folder: string; order: number }> = {
  claude: { folder: "~/.claude/skills", order: 0 },
  agents: { folder: "~/.agents/skills", order: 1 },
  codex: { folder: "~/.codex/skills", order: 2 },
};

function rootOf(file: ConfigFile): SkillRoot {
  return parseSkillId(file.id)?.root ?? "claude";
}

/**
 * Settings › Skills (FE-47/D9): the user's skills for every project.
 *
 * One list of every skill on the left, by name, each with the mark of the
 * folder it is in. The open one fills the rest as its text, read-only for
 * now, with the search in the title bar and its path, size and age in a
 * status bar under it.
 *
 * The open skill is in the URL (`?file=<id>`), so Back returns to the
 * previous one.
 */
export function SkillsPage() {
  const { file: openId } = useSearch({ strict: false }) as { file?: string };
  const navigate = useNavigate();
  const [files, setFiles] = useState<ConfigFile[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:skills",
    ["list", "file"],
  );

  const refresh = useCallback(async () => {
    const surface = window.desktop?.agentConfig;
    if (!surface) return;
    try {
      setFiles(await surface.list());
      setListError(null);
    } catch (failure) {
      setListError(ipcMessage(failure, "Could not read your skills."));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Agents add skills and rewrite them themselves; look again on coming
    // back to the window.
    const again = () => void refresh();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [refresh]);

  const skills = (files ?? [])
    .filter((file) => file.kind === "skill")
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label) ||
        ROOTS[rootOf(a)].order - ROOTS[rootOf(b)].order,
    );
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? skills.filter(
        (file) =>
          file.label.toLowerCase().includes(needle) ||
          file.description.toLowerCase().includes(needle),
      )
    : skills;
  const current = skills.find((file) => file.id === openId) ?? null;

  const skill = useConfigFile(current, () => {});
  const { base, text, load } = skill;

  // An agent rewrote the open skill: show what is on disk now.
  const changedAt = current?.modifiedAt;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read only when the file changes on disk
  useEffect(() => {
    if (base) void load();
  }, [changedAt]);

  const [revealError, setRevealError] = useState<string | null>(null);
  async function reveal(id: string) {
    setRevealError(null);
    try {
      await window.desktop?.agentConfig.reveal(id as ConfigFile["id"]);
    } catch (failure) {
      setRevealError(
        ipcMessage(failure, "Could not show that skill in Finder."),
      );
    }
  }

  function open(id: string) {
    if (id === openId) return;
    void navigate({ to: ROUTE, search: { file: id } });
  }

  const title = current
    ? `${current.label} — ${current.agent === "claude" ? "Claude Code" : "Codex"} skill`
    : "Skill";

  return (
    <>
      <WindowTitlebar>
        <h1 className={WINDOW_TITLE}>Skills</h1>
        <InputGroup className="ml-auto w-56 shrink">
          <InputGroupAddon>
            <HugeiconsIcon
              icon={Search01Icon}
              className="size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills…"
            aria-label="Search skills"
            className="text-xs"
          />
        </InputGroup>
      </WindowTitlebar>

      <ResizablePanelGroup
        id="lanework:skills"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel
          id="list"
          defaultSize="280px"
          minSize="15%"
          maxSize="45%"
          groupResizeBehavior="preserve-pixel-size"
        >
          <aside
            aria-label="Skill list"
            className="bg-sidebar flex h-full min-h-0 flex-col"
          >
            {listError ? (
              <p
                role="alert"
                className="text-destructive px-3.5 py-2 text-[13px]"
              >
                {listError}
              </p>
            ) : files ? (
              <SkillList
                skills={shown}
                active={openId ?? null}
                onOpen={open}
                onReveal={(id) => void reveal(id)}
                empty={
                  skills.length ? `No skills match “${query.trim()}”.` : null
                }
              />
            ) : (
              <ListSkeleton label="Reading skills" rows={10} icon={false} />
            )}
            {revealError && (
              <p
                role="alert"
                className="text-destructive border-border shrink-0 border-t px-3.5 py-2 text-[13px]"
              >
                {revealError}
              </p>
            )}
          </aside>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize skills list" />
        <ResizablePanel id="file" minSize="40%">
          <section
            aria-label={title}
            className="flex h-full min-h-0 min-w-0 flex-col"
          >
            {current ? (
              <>
                {base ? (
                  <CodeEditor
                    key={current.id}
                    value={text}
                    onChange={() => {}}
                    onSave={() => {}}
                    format={current.format}
                    label={title}
                    gutter={false}
                    readOnly
                    className="min-h-0 flex-1 overflow-hidden"
                  />
                ) : (
                  <div className="flex-1" />
                )}
                {skill.error && (
                  <p
                    role="alert"
                    className="text-destructive border-border shrink-0 border-t px-4 py-2.5 text-[13px]"
                  >
                    {skill.error}
                  </p>
                )}
                <StatusBar file={current} />
              </>
            ) : (
              <Empty className="flex-1">
                <EmptyHeader>
                  <EmptyTitle>
                    {openId && files
                      ? "That skill is no longer there"
                      : "Pick a skill"}
                  </EmptyTitle>
                  <EmptyDescription>
                    Your skills for every project.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}

/** Every skill by name, one row each, with the mark of its folder. */
function SkillList({
  skills,
  active,
  onOpen,
  onReveal,
  empty,
}: {
  skills: ConfigFile[];
  active: string | null;
  onOpen: (id: string) => void;
  onReveal: (id: string) => void;
  /** Said when the search leaves nothing; null when there are no skills. */
  empty: string | null;
}) {
  if (!skills.length)
    return (
      <p className="text-muted-foreground px-3.5 py-3 text-xs">
        {empty ?? "No skills yet."}
      </p>
    );
  return (
    <ScrollArea className="flex-1">
      <nav aria-label="Skills" className="px-2 py-1.5">
        {/* One hover background sliding from row to row, as on the rail. */}
        <RailHover>
          <ul className="flex flex-col gap-px">
            {skills.map((file) => {
              const current = file.id === active;
              return (
                <li key={file.id}>
                  <ContextMenu>
                    <ContextMenuTrigger
                      render={
                        <button
                          type="button"
                          aria-current={current ? "page" : undefined}
                          title={file.description || file.path}
                          onClick={() => onOpen(file.id)}
                          className={cn(
                            RAIL_ROW,
                            "relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none transition-[background-color,scale] duration-150 ease-out active:scale-[0.98]",
                            "focus-visible:ring-ring/30 focus-visible:ring-2",
                            // As the Settings sections mark the open one.
                            current && "bg-foreground/[0.08] font-medium",
                          )}
                        />
                      }
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {file.label}
                      </span>
                      <RootMark root={rootOf(file)} />
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => onReveal(file.id)}>
                        Reveal in Finder
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </li>
              );
            })}
          </ul>
        </RailHover>
      </nav>
    </ScrollArea>
  );
}

/**
 * The mark of the folder a skill is in: Claude's, Codex's, or the shared
 * `~/.agents`, drawn as OpenCode's, which reads it as Codex does.
 */
function RootMark({ root }: { root: SkillRoot }) {
  const label = ROOTS[root].folder;
  let mark: ReactNode;
  if (root === "claude")
    mark = <ClaudeAiIcon aria-hidden="true" className="size-3.5" />;
  else if (root === "codex")
    mark = (
      <>
        <CodexLight aria-hidden="true" className="size-3.5 dark:hidden" />
        <CodexDark aria-hidden="true" className="hidden size-3.5 dark:block" />
      </>
    );
  else
    mark = (
      <>
        <Opencode
          aria-hidden="true"
          className="size-3.5 rounded-[3px] dark:hidden"
        />
        <OpencodeDark
          aria-hidden="true"
          className="hidden size-3.5 rounded-[3px] dark:block"
        />
      </>
    );
  return (
    <span
      title={label}
      className="text-muted-foreground flex shrink-0 items-center opacity-80"
    >
      {mark}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The open skill's folder mark, path, size and age, under its text. */
function StatusBar({ file }: { file: ConfigFile }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const age = relativeTime(file.modifiedAt, now);
  return (
    <footer className="border-border text-muted-foreground flex h-7 shrink-0 items-center gap-3 border-t px-3 text-[11px] tabular-nums">
      <RootMark root={rootOf(file)} />
      <span className="min-w-0 truncate" title={file.path}>
        {file.path}
      </span>
      {file.size !== null && (
        <>
          <Separator orientation="vertical" className="my-2" />
          <span className="shrink-0">{fileSize(file.size)}</span>
        </>
      )}
      <span className="ml-auto shrink-0">{age && `Changed ${age}`}</span>
    </footer>
  );
}
