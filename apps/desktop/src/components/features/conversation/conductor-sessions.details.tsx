import {
  ArrowDown01Icon,
  CommandLineIcon,
  FileDiffIcon,
  FolderGitTwoIcon,
  GitBranchIcon,
  GitCommitIcon,
  Globe02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentCommit,
  AgentFiles,
  AgentFileTouch,
  AgentSession,
  AgentWorkspace,
  TerminalAgent,
} from "#/../shared/terminal";
import type { WorktreeFile } from "#/../shared/worktree";
import {
  BackgroundTaskRow,
  backgroundCue,
  useOpenBackgroundTask,
  useStopBackgroundTask,
} from "#/components/shared/agents/background-tasks";
import { useBackgroundTasks } from "#/components/shared/agents/use-background-tasks";
import { FileOpenerContext } from "#/components/shared/common/markdown-body";
import { splitPath } from "#/components/shared/diff/diff-file-header";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { MARK } from "#/components/shared/repo/file-tree";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { Badge } from "#/components/ui/badge";
import { ipcMessage } from "#/lib/ipc-error";
import { relativeTime } from "#/lib/relative-time";
import { cn } from "#/lib/utils";
import {
  mergeWebSearches,
  type WebSearch,
  webSources,
} from "#/lib/web-sources";
import { useWorktree } from "#/stores/worktree";
import { SourceRows } from "./conductor-sessions.sources";

/**
 * Each set of conversations' last read, by project and conversations, for
 * the app's session: the panel shows it at once on coming back.
 */
const lastReads = new Map<string, Reads[]>();

/** Files listed before "Show all": a long session would bury its commits. */
const FILES_SHOWN = 12;

/** What one conversation's details were read as; each half degrades alone. */
interface Reads {
  workspace: AgentWorkspace | null;
  files: AgentFiles | null;
  /** The web searches it ran and pages it read; null when unread. */
  web: { searches: WebSearch[]; partial: boolean } | null;
  /** Both reads failed: why. */
  error: string | null;
}

/** A conversation whose details are read: the conductor's own, or a session. */
export interface ReadSource {
  agent: TerminalAgent;
  id: string;
  /** A turn of it runs now: its details are read again once it ends. */
  working: boolean;
}

/**
 * Where each of `sources` works, what it edited and committed: read on
 * mount, when the list changes, and again whenever a turn of one ends.
 *
 * @returns One read per source, in order, or null until the first lands.
 */
function useReads(project: string, slug: string, sources: ReadSource[]) {
  const peek = useWorktree((state) => state.peek);
  const key = sources.map((source) => `${source.agent}:${source.id}`).join(",");
  const cacheKey = `${project}|${key}`;
  // The last read of the same conversations, drawn at once while they are
  // read again: coming back to a chat shows its panel as it was, not a
  // skeleton that then pushes the groups down.
  const [read, setRead] = useState<{ key: string; reads: Reads[] } | null>(
    () => {
      const known = lastReads.get(cacheKey);
      return known ? { key: cacheKey, reads: known } : null;
    },
  );
  const asked = useRef(0);
  const latest = useRef(sources);
  latest.current = sources;

  const load = useCallback(async () => {
    const surface = window.desktop?.terminal;
    if (!surface) return;
    const mine = ++asked.current;
    // The +/− beside the files are git's, from this project's status.
    void peek(slug);
    const out = await Promise.all(
      latest.current.map(async ({ agent, id }): Promise<Reads> => {
        const [workspace, files, chat] = await Promise.allSettled([
          surface.agentWorkspace(project, agent, id),
          surface.agentFiles(project, agent, id),
          // Its tool calls, for the pages it searched and read: nothing is
          // fetched, the transcript already holds them.
          window.desktop?.conversation.read(project, id) ??
            Promise.reject(new Error("No conversation surface")),
        ]);
        return {
          workspace: workspace.status === "fulfilled" ? workspace.value : null,
          files: files.status === "fulfilled" ? files.value : null,
          web:
            chat.status === "fulfilled" ? webSources(chat.value.turns) : null,
          error:
            workspace.status === "rejected" && files.status === "rejected"
              ? ipcMessage(workspace.reason, "This session could not be read.")
              : null,
        };
      }),
    );
    if (mine !== asked.current) return;
    const readKey = `${project}|${latest.current.map((source) => `${source.agent}:${source.id}`).join(",")}`;
    lastReads.set(readKey, out);
    setRead({ key: readKey, reads: out });
  }, [project, slug, peek]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the list.
  useEffect(() => {
    void load();
  }, [load, key]);

  // A turn that ended may have edited, committed or switched branch.
  const busy = sources.filter((source) => source.working).map((s) => s.id);
  const was = useRef<string[]>(busy);
  const busyKey = busy.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `busyKey` stands for the list.
  useEffect(() => {
    if (was.current.some((id) => !busy.includes(id))) void load();
    was.current = busy;
  }, [busyKey, load]);

  return read?.key === cacheKey
    ? read.reads
    : (lastReads.get(cacheKey) ?? null);
}

/** A worktree some of the conversations work in, and on which branch. */
interface Workspace {
  path: string;
  linked: boolean;
  branch: string | null;
  /** How many of the conversations work there. */
  count: number;
}

/** The reads folded into one: workspaces, files and commits, deduplicated. */
function merge(reads: Reads[]) {
  const places = new Map<string, Workspace>();
  const byPath = new Map<string, AgentFileTouch>();
  const commits = new Map<string, AgentCommit>();
  let partial = false;
  let webPartial = false;
  for (const read of reads) {
    webPartial ||= read.web?.partial ?? false;
    const where = read.workspace?.worktree;
    if (where) {
      const key = `${where.path}\n${read.workspace?.branch ?? ""}`;
      const known = places.get(key);
      if (known) known.count++;
      else
        places.set(key, {
          path: where.path,
          linked: where.linked,
          branch: read.workspace?.branch ?? null,
          count: 1,
        });
    }
    for (const touch of read.files?.files ?? []) {
      const known = byPath.get(touch.path);
      if (!known) byPath.set(touch.path, touch);
      else
        byPath.set(touch.path, {
          ...(touch.lastAt > known.lastAt ? touch : known),
          edits: known.edits + touch.edits,
        });
    }
    partial ||= read.files?.partial ?? false;
    for (const commit of read.workspace?.commits ?? [])
      if (!commits.has(commit.sha)) commits.set(commit.sha, commit);
  }
  return {
    workspaces: [...places.values()].sort((a, b) => b.count - a.count),
    files: {
      files: [...byPath.values()].sort((a, b) =>
        b.lastAt.localeCompare(a.lastAt),
      ),
      partial,
    } satisfies AgentFiles,
    commits: [...commits.values()].sort((a, b) =>
      (b.at ?? "").localeCompare(a.at ?? ""),
    ),
    web: {
      searches: mergeWebSearches(reads.map((read) => read.web?.searches ?? [])),
      partial: webPartial,
    },
  };
}

/**
 * One session in the Sessions panel, opened: its branch, its worktree, the
 * files it changed, its commits and its running background tasks, each
 * group left out when it has nothing.
 */
export function SessionDetails({
  session,
  working,
  project,
  slug,
  now,
}: {
  session: AgentSession;
  working: boolean;
  project: string;
  slug: string;
  now: number;
}) {
  const sources = useMemo(
    () => [{ agent: session.agent, id: session.id, working }],
    [session.agent, session.id, working],
  );
  const reads = useReads(project, slug, sources);
  const tasks = session.agent === "claude" && session.background.running > 0;
  const read = reads?.[0];

  if (!read)
    return (
      <Section>
        <ListSkeleton label="Reading this session" rows={4} />
      </Section>
    );
  if (read.error && !tasks)
    return (
      <Section>
        <p role="alert" className="text-destructive px-3 py-1 text-xs">
          {read.error}
        </p>
      </Section>
    );
  return (
    <Facts
      slug={slug}
      now={now}
      merged={merge([read])}
      tasks={
        tasks ? (
          <TasksGroup slug={slug} project={project} session={session} />
        ) : null
      }
    />
  );
}

/** A session the overview counts, with what it needs to be drawn and opened. */
export interface OverviewSession {
  session: AgentSession;
  working: boolean;
}

/**
 * The conductor at a glance: where it and its sessions work, every file
 * they changed, every commit they made, and the background tasks still
 * running, all folded together. A session's own are one click away.
 */
export function ConductorOverview({
  project,
  slug,
  self,
  sessions,
  now,
  onOpenSession,
}: {
  project: string;
  slug: string;
  /** The conductor's own conversation, once it has one. */
  self: (ReadSource & { session: AgentSession | null }) | null;
  sessions: OverviewSession[];
  now: number;
  onOpenSession: (id: string) => void;
}) {
  const sources = useMemo(
    () => [
      ...(self
        ? [{ agent: self.agent, id: self.id, working: self.working }]
        : []),
      ...sessions.map(({ session, working }) => ({
        agent: session.agent,
        id: session.id,
        working,
      })),
    ],
    [self, sessions],
  );
  const reads = useReads(project, slug, sources);
  const ownTasks =
    self?.session?.agent === "claude" && self.session.background.running > 0
      ? self.session
      : null;
  const busy = sessions.filter(
    ({ session }) =>
      session.agent === "claude" && session.background.running > 0,
  );

  if (!reads)
    return (
      <Section>
        <ListSkeleton label="Reading the conductor's work" rows={4} />
      </Section>
    );
  const tasks =
    ownTasks || busy.length > 0 ? (
      <Group
        icon={CommandLineIcon}
        label="Background tasks"
        count={
          (ownTasks?.background.running ?? 0) +
          busy.reduce((sum, { session }) => sum + session.background.running, 0)
        }
      >
        {ownTasks && (
          <TaskRows slug={slug} project={project} session={ownTasks} />
        )}
        {busy.map(({ session }) => (
          <li key={session.id}>
            <button
              type="button"
              onClick={() => onOpenSession(session.id)}
              className={cn(SUB_ROW, "hover:bg-foreground/[0.04] text-left")}
            >
              <TerminalKindIcon kind={session.agent} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">
                {session.title || "Session"}
              </span>
              <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                {session.background.running} running
              </span>
            </button>
          </li>
        ))}
      </Group>
    ) : null;
  return <Facts slug={slug} now={now} merged={merge(reads)} tasks={tasks} />;
}

/**
 * The groups of one or more reads, folded, as two blocks of the panel's
 * card: where they work, then what they did. Nothing to show, nothing drawn:
 * the panel has no empty states.
 */
function Facts({
  slug,
  now,
  merged,
  tasks,
}: {
  slug: string;
  now: number;
  merged: ReturnType<typeof merge>;
  tasks: ReactNode;
}) {
  const { workspaces, files, commits, web } = merged;
  const pages = new Set(
    web.searches.flatMap((search) => search.sources.map((s) => s.url)),
  ).size;
  const single = workspaces.length === 1 ? workspaces[0] : null;
  const where =
    workspaces.length === 0 ? null : (
      <Section>
        {single ? (
          <>
            <Fact
              icon={FolderGitTwoIcon}
              aside={<CheckoutKind linked={single.linked} />}
            >
              <span className="truncate" title={single.path}>
                {folderName(single.path)}
              </span>
            </Fact>
            <Fact icon={GitBranchIcon}>
              <BranchName branch={single.branch} />
            </Fact>
          </>
        ) : (
          <Group
            icon={FolderGitTwoIcon}
            label="Worktrees"
            count={workspaces.length}
          >
            {workspaces.map((workspace) => (
              <li
                key={`${workspace.path}:${workspace.branch}`}
                className={SUB_ROW}
              >
                <BranchName branch={workspace.branch} />
                <span
                  className="text-muted-foreground min-w-0 flex-1 truncate text-right text-xs"
                  title={workspace.path}
                >
                  {folderName(workspace.path)}
                </span>
                <span
                  className="text-muted-foreground shrink-0 text-[11px] tabular-nums"
                  title={`${workspace.count} ${workspace.count === 1 ? "conversation works" : "conversations work"} here`}
                >
                  {workspace.count}
                </span>
              </li>
            ))}
          </Group>
        )}
      </Section>
    );
  const work =
    commits.length > 0 ||
    files.files.length > 0 ||
    web.searches.length > 0 ||
    tasks ? (
      <Section>
        {commits.length > 0 && <CommitsGroup commits={commits} now={now} />}
        {files.files.length > 0 && (
          <ChangesGroup
            slug={slug}
            files={files}
            // A linked worktree has its own working tree: the project's
            // status says nothing about its files.
            mainCheckout={workspaces.every((workspace) => !workspace.linked)}
          />
        )}
        {web.searches.length > 0 && (
          <Group icon={Globe02Icon} label="Sources" count={pages}>
            <SourceRows searches={web.searches} partial={web.partial} />
          </Group>
        )}
        {tasks}
      </Section>
    ) : null;
  if (!where && !work) return null;
  return (
    <>
      {where}
      {work}
    </>
  );
}

/** "Main checkout" or "Worktree", small, at a worktree row's end. */
function CheckoutKind({ linked }: { linked: boolean }) {
  return (
    <span className="bg-foreground/[0.05] text-muted-foreground shrink-0 rounded px-1.5 py-px text-[11px]">
      {linked ? "Worktree" : "Main checkout"}
    </span>
  );
}

function BranchName({ branch }: { branch: string | null }) {
  return branch ? (
    <span className="min-w-0 truncate" title={branch}>
      {branch}
    </span>
  ) : (
    <span className="text-muted-foreground">Detached HEAD</span>
  );
}

/** Commits, newest first: a struck-through one was reset or rebased away. */
function CommitsGroup({
  commits,
  now,
}: {
  commits: AgentCommit[];
  now: number;
}) {
  return (
    <Group icon={GitCommitIcon} label="Commits" count={commits.length}>
      {commits.map((commit) => (
        <li
          key={commit.sha}
          title={`${commit.sha}${commit.at ? `\n${relativeTime(commit.at, now)}` : ""}${commit.onBranch ? "" : "\nNo longer on this branch: reset or rebased away"}`}
          className={SUB_ROW}
        >
          <span
            className={cn(
              "text-muted-foreground shrink-0 font-mono text-[11px]",
              !commit.onBranch && "line-through",
            )}
          >
            {commit.shortSha}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              !commit.onBranch && "text-muted-foreground",
            )}
          >
            {commit.subject}
          </span>
          {!commit.onBranch && (
            <span className="text-muted-foreground shrink-0 text-[11px]">
              Not on branch
            </span>
          )}
        </li>
      ))}
    </Group>
  );
}

/**
 * The panel's one card: its blocks one under another, a hairline between.
 * A block that draws nothing leaves no line behind.
 */
export function PanelCard({ children }: { children: ReactNode }) {
  return (
    <div className="divide-border bg-card shadow-card flex flex-col divide-y overflow-hidden rounded-2xl">
      {children}
    </div>
  );
}

/** One block of the card: rows grouped together. */
export function Section({ children }: { children: ReactNode }) {
  return <div className="flex flex-col">{children}</div>;
}

/** A row of the card: its icon, what it says, anything at its end. */
const ROW = "flex h-8 w-full min-w-0 items-center gap-2.5 px-3 text-[13px]";
/** A row inside an unfolded group: flush with the card's edge, as Runs. */
const SUB_ROW = "flex h-8 w-full min-w-0 items-center gap-2.5 px-3 text-[13px]";

/** One fact on one line: its icon, its value, anything at its end. */
function Fact({
  icon,
  aside,
  children,
}: {
  icon: IconSvgElement;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={ROW}>
      <HugeiconsIcon
        icon={icon}
        className="text-muted-foreground size-4 shrink-0"
        strokeWidth={1.6}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      {aside}
    </div>
  );
}

/**
 * A group that unfolds: its row says what and how much, its rows show
 * under it on a click. Folded to start with, so the card stays short.
 */
export function Group({
  icon,
  label,
  count,
  aside,
  defaultOpen = false,
  live = false,
  children,
}: {
  icon: IconSvgElement;
  label: string;
  /** How many, or how many are busy ("2 running"). */
  count: ReactNode;
  aside?: ReactNode;
  /** Unfolded to start with. Every group of the panel starts folded. */
  defaultOpen?: boolean;
  /** Something in it works now: the count turns blue, with a ping. */
  live?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section aria-label={label} className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
        className={cn(
          ROW,
          "hover:bg-foreground/[0.03] focus-visible:ring-accent-brand text-left outline-none focus-visible:ring-2 focus-visible:ring-inset",
        )}
      >
        <HugeiconsIcon
          icon={icon}
          className="text-muted-foreground size-4 shrink-0"
          strokeWidth={1.6}
          aria-hidden="true"
        />
        <span className="shrink-0 font-medium">{label}</span>
        <Badge
          variant="secondary"
          className={cn(
            "rounded-[5px] px-1.5 leading-none tabular-nums",
            live
              ? "bg-tone-blue/10 text-tone-blue gap-1.5"
              : "text-muted-foreground",
          )}
        >
          {live && (
            // The rail's working dot (StatusPing): blue, pinging.
            <span aria-hidden="true" className="relative grid size-1.5">
              <span className="bg-tone-blue absolute size-full animate-ping rounded-full opacity-75 motion-reduce:hidden" />
              <span className="bg-tone-blue relative size-full rounded-full" />
            </span>
          )}
          {count}
        </Badge>
        <span className="ml-auto flex items-center">{aside}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className={cn(
            "text-muted-foreground size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-180",
          )}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      <ul id={id} hidden={!open} className="flex flex-col">
        {children}
      </ul>
    </section>
  );
}

/** The last part of a folder's path. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Line counts as `+81 −20`, coloured as the rail's Changes is. */
function LineCounts({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums">
      {added > 0 && (
        <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
      )}
      {removed > 0 && (
        <span className="text-rose-600 dark:text-rose-400">−{removed}</span>
      )}
    </span>
  );
}

/**
 * The files the session edited with its file tools. One still changed in
 * the working tree shows git's +/− and opens its diff in Changes; any other
 * opens in Files.
 */
function ChangesGroup({
  slug,
  files,
  mainCheckout,
}: {
  slug: string;
  files: AgentFiles;
  mainCheckout: boolean;
}) {
  const navigate = useNavigate();
  const focusFile = useWorktree((state) => state.focusFile);
  const openInFiles = useContext(FileOpenerContext);
  const changes = useWorktree((state) =>
    mainCheckout && state.slug === slug && state.state?.kind === "ready"
      ? state.state.files
      : null,
  );
  const [all, setAll] = useState(false);
  const byPath = useMemo(() => {
    const map = new Map<string, WorktreeFile>();
    for (const file of changes ?? []) {
      map.set(file.path, file);
      // A file the agent edited, then renamed, is the rename's.
      if (file.previousPath) map.set(file.previousPath, file);
    }
    return map;
  }, [changes]);
  let added = 0;
  let removed = 0;
  const counted = new Set<WorktreeFile>();
  for (const touch of files.files) {
    const file = byPath.get(touch.path);
    if (!file || counted.has(file)) continue;
    counted.add(file);
    added += file.additions;
    removed += file.deletions;
  }
  const shown = all ? files.files : files.files.slice(0, FILES_SHOWN);
  const hidden = files.files.length - shown.length;

  // A file the transcript says was written may be gone since (written, then
  // deleted or moved): asked once per row git does not list, so a click
  // never lands on "Not found".
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const unchecked = mainCheckout
    ? shown
        .filter((touch) => !byPath.has(touch.path) && touch.op !== "deleted")
        .map((touch) => touch.path)
    : [];
  const uncheckedKey = unchecked.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `uncheckedKey` stands for the list.
  useEffect(() => {
    const surface = window.desktop?.worktree;
    if (!surface || unchecked.length === 0) return;
    let live = true;
    void Promise.all(
      unchecked.map((path) =>
        surface
          .locate(slug, path)
          .then((found) => (found ? null : path))
          .catch(() => null),
      ),
    ).then((missing) => {
      if (live)
        setGone(
          new Set(missing.filter((path): path is string => path !== null)),
        );
    });
    return () => {
      live = false;
    };
  }, [uncheckedKey, slug]);

  const open = (touch: AgentFileTouch, changed: WorktreeFile | undefined) => {
    if (changed) {
      focusFile(changed.path);
      void navigate({ to: "/w/$slug/changes", params: { slug } });
    } else openInFiles?.(touch.path);
  };

  return (
    <Group
      icon={FileDiffIcon}
      label="Changes"
      count={files.files.length}
      aside={<LineCounts added={added} removed={removed} />}
    >
      {shown.map((touch) => (
        <li key={touch.path}>
          <FileRow
            touch={touch}
            changed={byPath.get(touch.path)}
            gone={gone.has(touch.path)}
            onOpen={
              // Outside the main checkout, Files would open another copy;
              // a deleted or vanished file has nothing left to open.
              byPath.has(touch.path) ||
              (mainCheckout &&
                openInFiles &&
                touch.op !== "deleted" &&
                !gone.has(touch.path))
                ? (changed) => open(touch, changed)
                : null
            }
          />
        </li>
      ))}
      {hidden > 0 && (
        <li>
          <button
            type="button"
            onClick={() => setAll(true)}
            className="text-muted-foreground hover:text-foreground h-6 px-3 text-left text-[11px] transition-colors"
          >
            Show all {files.files.length}
          </button>
        </li>
      )}
      {files.partial && (
        <li className="text-muted-foreground px-3 pt-1 text-[11px]">
          A long transcript: older edits may be missing.
        </li>
      )}
    </Group>
  );
}

/** One edited file: its name, folder, what was done, and git's +/−. */
function FileRow({
  touch,
  changed,
  gone,
  onOpen,
}: {
  touch: AgentFileTouch;
  changed: WorktreeFile | undefined;
  /** No longer in the project: written, then deleted or moved. */
  gone: boolean;
  onOpen: ((changed: WorktreeFile | undefined) => void) | null;
}) {
  const { name } = splitPath(touch.path);
  const mark = MARK[touch.op];
  const body = (
    <>
      <FileTypeIcon path={touch.path} className="size-4 shrink-0" />
      <span
        className={cn(
          "min-w-0 shrink truncate",
          (touch.op === "deleted" || gone) && "line-through",
          gone && "text-muted-foreground",
        )}
      >
        {name}
      </span>
      {/* The name alone: its folder is in the row's tooltip. */}
      <span className="min-w-0 flex-1" />
      {changed ? (
        <LineCounts added={changed.additions} removed={changed.deletions} />
      ) : null}
      <span
        className={cn(
          "w-2.5 shrink-0 font-mono text-[10px] font-semibold",
          mark.tone,
        )}
        title={touch.op}
      >
        {mark.letter}
      </span>
    </>
  );
  const row = SUB_ROW;
  if (!onOpen)
    return (
      <div
        title={gone ? `${touch.path}\nNo longer in the project` : touch.path}
        className={row}
      >
        {body}
      </div>
    );
  return (
    <button
      type="button"
      title={touch.path}
      aria-label={
        changed ? `Open the diff of ${touch.path}` : `Open ${touch.path}`
      }
      onClick={() => onOpen(changed)}
      className={cn(
        row,
        "hover:bg-foreground/[0.04] focus-visible:ring-accent-brand text-left outline-none focus-visible:ring-2 focus-visible:ring-inset",
      )}
    >
      {body}
    </button>
  );
}

/** Its running background tasks under their heading. */
function TasksGroup({
  slug,
  project,
  session,
}: {
  slug: string;
  project: string;
  session: AgentSession;
}) {
  return (
    <Group
      icon={CommandLineIcon}
      label="Background tasks"
      count={session.background.running}
    >
      <TaskRows slug={slug} project={project} session={session} />
    </Group>
  );
}

/** One conversation's running background tasks, each opening as the agent view's do. */
function TaskRows({
  slug,
  project,
  session,
}: {
  slug: string;
  project: string;
  session: AgentSession;
}) {
  const stopping = useStopBackgroundTask(project, session.id);
  const opener = useOpenBackgroundTask(slug, session.id);
  const { tasks, error } = useBackgroundTasks(
    project,
    session.id,
    `${backgroundCue(session)}:${stopping.revision}`,
  );
  const running = (tasks ?? []).filter((task) => task.status === "running");
  const now = Date.now();
  return (
    <>
      {/* Its Stop's confirm, and what a stop said: inside a list, so a row. */}
      <li className="contents">{stopping.feedback}</li>
      {error && !tasks ? (
        <li role="alert" className="text-destructive px-3 text-xs">
          {error}
        </li>
      ) : !tasks ? (
        <li>
          <ListSkeleton
            label="Reading its background tasks"
            rows={Math.min(session.background.running, 3)}
          />
        </li>
      ) : (
        running.map((task) => (
          <li key={task.id} className="px-1">
            <BackgroundTaskRow
              task={task}
              now={now}
              onOpen={opener.openTask}
              onOpenAgent={opener.openAgent}
              onStop={stopping.requestStop}
            />
          </li>
        ))
      )}
    </>
  );
}
