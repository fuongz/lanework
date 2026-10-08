import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ConfigFile } from "#/../shared/agent-config";
import { AgentConfigPane } from "#/components/features/settings/agent-config-editor";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistedLayout,
} from "#/components/ui/resizable";
import { ipcMessage } from "#/lib/ipc-error";
import { cn } from "#/lib/utils";

const AGENTS = [
  { agent: "claude", title: "Claude Code" },
  { agent: "codex", title: "Codex" },
] as const;

const ROW =
  "hover:bg-foreground/[0.04] aria-[current]:bg-foreground/[0.06] focus-visible:ring-accent-brand flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pe-2 text-start outline-none focus-visible:ring-2";

function size(bytes: number | null): string {
  if (bytes === null) return "—";
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Which groups are folded; anything not in it is open. Per viewer. */
function useCollapsed() {
  const key = "lanework:agent-config-collapsed";
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((id: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        // Folding is a convenience; a blocked store just forgets it.
      }
      return next;
    });
  }, []);
  return { collapsed, toggle };
}

const PAGES = {
  config: {
    route: "/settings/config",
    title: "Config files",
    empty:
      "Claude Code's and Codex's own settings and instructions — the ones every project uses. Saving keeps the previous version beside the file.",
  },
  skill: {
    route: "/settings/skills",
    title: "Skills",
    empty:
      "Your own skills: ~/.claude/skills for Claude Code, ~/.agents/skills (and the older ~/.codex/skills) for Codex. Saving keeps the previous version beside SKILL.md.",
  },
} as const;

/**
 * Settings › Config files and Settings › Skills (FE-47/D8, D9): the user's
 * own Claude Code and Codex config files — or skills — as a tree by agent,
 * beside the one open in an editor, laid out the way Instructions is.
 *
 * ⚠️ The open file is in the URL (`?file=<id>`), so Back returns to the
 * previous one. Leaving a file with edits not saved asks first.
 */
export function AgentConfigPage({ kind }: { kind: "config" | "skill" }) {
  const page = PAGES[kind];
  const { file: openId } = useSearch({ strict: false }) as { file?: string };
  const navigate = useNavigate();
  const [files, setFiles] = useState<ConfigFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const { collapsed, toggle } = useCollapsed();
  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    `lanework:agent-config:${kind}`,
    ["tree", "editor"],
  );

  const refresh = useCallback(async () => {
    const surface = window.desktop?.agentConfig;
    if (!surface) return;
    try {
      setFiles(await surface.list());
      setError(null);
    } catch (failure) {
      setError(ipcMessage(failure, "Could not read these files."));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Agents rewrite these files and add skills themselves; look again on
    // coming back to the window.
    const again = () => void refresh();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [refresh]);

  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);

  function open(id: string) {
    if (id === openId) return;
    if (
      dirty.current &&
      !window.confirm(
        "Leave this file without saving? Your changes will be lost.",
      )
    )
      return;
    dirty.current = false;
    void navigate({ to: page.route, search: { file: id } });
  }

  const mine = (files ?? []).filter((file) => file.kind === kind);
  const selected = mine.find((file) => file.id === openId) ?? null;

  const row = (file: ConfigFile, depth: number) => (
    <button
      key={file.id}
      type="button"
      aria-current={file.id === openId ? "page" : undefined}
      title={file.description || file.path}
      onClick={() => open(file.id)}
      className={ROW}
      style={{ paddingInlineStart: 6 + depth * 12 }}
    >
      <span className="size-4 shrink-0" />
      <FileTypeIcon
        path={file.kind === "skill" ? "SKILL.md" : file.label}
        className={cn("size-4 shrink-0", !file.exists && "opacity-50")}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px]",
          !file.exists && "text-muted-foreground",
        )}
      >
        {file.label}
        {file.id.startsWith("skill:codex:") && (
          <span className="text-muted-foreground ms-1.5 text-[11px]">
            ~/.codex
          </span>
        )}
      </span>
      <span className="text-muted-foreground shrink-0 text-[11px]">
        {file.exists ? size(file.size) : "New"}
      </span>
    </button>
  );

  const tree = (
    <nav aria-label={page.title} className="flex flex-col px-2 pb-4">
      {AGENTS.map(({ agent, title }) => {
        const rows = mine.filter((file) => file.agent === agent);
        return (
          <Group
            key={agent}
            title={title}
            count={kind === "skill" ? rows.length : null}
            open={!collapsed.has(`${kind}:${agent}`)}
            onToggle={() => toggle(`${kind}:${agent}`)}
          >
            {rows.length ? (
              rows.map((file) => row(file, 0))
            ) : (
              <p
                className="text-muted-foreground py-1 text-[12px]"
                style={{ paddingInlineStart: 6 + 22 }}
              >
                No skills yet
              </p>
            )}
          </Group>
        );
      })}
    </nav>
  );

  return (
    <ResizablePanelGroup
      id={`lanework:agent-config:${kind}`}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        id="tree"
        defaultSize="300px"
        minSize="18%"
        maxSize="45%"
        groupResizeBehavior="preserve-pixel-size"
      >
        <aside className="border-border flex h-full min-h-0 flex-col border-e">
          <header className="window-drag-region border-border flex h-11 shrink-0 items-center gap-2 border-b px-3.5">
            <h1 className="text-[13px] font-medium">{page.title}</h1>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto pt-1">
            {error ? (
              <p
                role="alert"
                className="text-destructive px-3.5 py-2 text-[13px]"
              >
                {error}
              </p>
            ) : files ? (
              tree
            ) : (
              <p className="text-muted-foreground px-3.5 py-2 text-xs">
                Reading {page.title.toLowerCase()}…
              </p>
            )}
          </div>
        </aside>
      </ResizablePanel>
      <ResizableHandle aria-label={`Resize ${page.title.toLowerCase()} list`} />
      <ResizablePanel id="editor" minSize="40%">
        {selected ? (
          <AgentConfigPane
            key={selected.id}
            file={selected}
            onSaved={() => void refresh()}
            onDirtyChange={setDirty}
          />
        ) : (
          <div className="flex h-full flex-col">
            <div className="window-drag-region h-11 shrink-0" />
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyTitle>
                  {openId && files
                    ? "That file is no longer there"
                    : kind === "skill"
                      ? "Pick a skill"
                      : "Pick a file"}
                </EmptyTitle>
                <EmptyDescription>{page.empty}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center">
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        className={cn("size-3 transition-transform", open && "rotate-90")}
        strokeWidth={2}
        aria-hidden="true"
      />
    </span>
  );
}

/** An agent's root: a heading that folds what is under it. */
function Group({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  /** Shown at the end of the heading; null for none. */
  count: number | null;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col pt-2 first:pt-1">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-accent-brand flex h-7 w-full items-center gap-1.5 rounded-md ps-1.5 text-[11px] font-medium tracking-wide uppercase outline-none focus-visible:ring-2"
        >
          <Chevron open={open} />
          <span className="flex-1 text-start">{title}</span>
          {count !== null && (
            <span className="pe-2 font-normal tracking-normal normal-case">
              {count}
            </span>
          )}
        </button>
      </h2>
      {open && children}
    </div>
  );
}
