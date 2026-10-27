import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConfigFile } from "#/../shared/agent-config";
import { EditorTabs } from "#/components/shared/editor/editor-tabs";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { AgentConfigPane } from "#/components/shared/settings/agent-config-editor";
import {
  FileBrowserLayout,
  FileBrowserTree,
  treePath,
} from "#/components/shared/settings/file-browser";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import { ipcMessage } from "#/lib/ipc-error";
import { readStored, writeStored } from "#/lib/stored";

/**
 * The files open as tabs, per page kind, in the order they were opened.
 *
 * Per viewer, like the folds. The active one is `?file=`, not kept here.
 */
function useOpenTabs(kind: "config" | "skill") {
  const key = `lanework:agent-config-tabs:${kind}`;
  const [tabs, setTabs] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(readStored(key) ?? "[]");
      return Array.isArray(stored)
        ? stored.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => writeStored(key, JSON.stringify(tabs)), [key, tabs]);
  return [tabs, setTabs] as const;
}

const CLOSE_DIRTY =
  "Close this file without saving? Your changes will be lost.";

const PAGES = {
  config: {
    route: "/settings/config",
    title: "Config files",
    empty:
      "Claude Code and Codex settings for every project. Saving keeps a backup.",
  },
  skill: {
    route: "/settings/skills",
    title: "Skills",
    empty: "Your skills for every project. Saving keeps a backup.",
  },
} as const;

/**
 * Settings › Config files and Settings › Skills (FE-47/D8, D9).
 *
 * The user's own Claude Code and Codex config files, or skills, as a tree by
 * agent, beside the ones open as tabs in an editor, the way the Files screen
 * is.
 *
 * The active tab is in the URL (`?file=<id>`), so Back returns to the
 * previous one. Every open tab's pane stays mounted, only hidden, so its
 * edits survive switching away; closing one with edits not saved asks first.
 */
export function AgentConfigPage({ kind }: { kind: "config" | "skill" }) {
  const page = PAGES[kind];
  const { file: openId } = useSearch({ strict: false });
  const navigate = useNavigate();
  const [files, setFiles] = useState<ConfigFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabs, setTabs] = useOpenTabs(kind);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());

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

  const mine = (files ?? []).filter((file) => file.kind === kind);

  // Once the list is in: drop the tabs of files that are gone, and give the
  // active file a tab if it has none: Back and links land here too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `mine` comes from `files`
  useEffect(() => {
    if (!files) return;
    const ids = new Set<string>(mine.map((file) => file.id));
    setTabs((previous) => {
      const kept = previous.filter((id) => ids.has(id));
      if (openId && ids.has(openId) && !kept.includes(openId))
        kept.push(openId);
      return kept.length === previous.length &&
        kept.every((id, index) => id === previous[index])
        ? previous
        : kept;
    });
  }, [files, openId, setTabs]);

  // One stable callback per file, so a pane does not report again each render.
  const dirtyCallbacks = useRef(new Map<string, (value: boolean) => void>());
  function onDirtyChange(id: string) {
    let callback = dirtyCallbacks.current.get(id);
    if (!callback) {
      callback = (value: boolean) =>
        setDirty((previous) => {
          if (previous.has(id) === value) return previous;
          const next = new Set(previous);
          if (value) next.add(id);
          else next.delete(id);
          return next;
        });
      dirtyCallbacks.current.set(id, callback);
    }
    return callback;
  }

  function open(id: string) {
    if (id === openId) return;
    // A file already in a tab keeps its edits in its pane: nothing to ask.
    setTabs((previous) =>
      previous.includes(id) ? previous : [...previous, id],
    );
    void navigate({ to: page.route, search: { file: id } });
  }

  const close = useCallback(
    (id: string) => {
      if (dirty.has(id) && !window.confirm(CLOSE_DIRTY)) return;
      const index = tabs.indexOf(id);
      const rest = tabs.filter((tab) => tab !== id);
      setTabs(rest);
      setDirty((previous) => {
        if (!previous.has(id)) return previous;
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
      dirtyCallbacks.current.delete(id);
      if (id !== openId) return;
      // The neighbour on the right, else the one on the left, else none.
      const next = rest[index] ?? rest[index - 1];
      void navigate({ to: page.route, search: next ? { file: next } : {} });
    },
    [dirty, tabs, openId, navigate, page.route, setTabs],
  );

  // ⌘W closes the active tab while this page is up. The app menu leaves it
  // unbound for this.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== "w"
      )
        return;
      if (!openId || !tabs.includes(openId)) return;
      event.preventDefault();
      close(openId);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openId, tabs, close]);

  const openFiles = tabs
    .map((id) => mine.find((file) => file.id === id))
    .filter((file): file is ConfigFile => !!file);

  return (
    <FileBrowserLayout
      id={`lanework:agent-config:${kind}`}
      title={page.title}
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Refresh ${page.title.toLowerCase()}`}
          title="Refresh"
          onClick={() => void refresh()}
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </Button>
      }
      sidebar={
        error ? (
          <p role="alert" className="text-destructive px-3.5 py-2 text-[13px]">
            {error}
          </p>
        ) : files ? (
          mine.length ? (
            <FileBrowserTree
              entries={mine.map((file) => ({
                id: file.id,
                path: treePath(file.path),
              }))}
              active={openId ?? null}
              onOpen={open}
              noun={kind === "skill" ? "skill" : "file"}
            />
          ) : (
            <p className="text-muted-foreground px-3.5 py-3 text-xs">
              {kind === "skill" ? "No skills yet." : "No files yet."}
            </p>
          )
        ) : (
          <ListSkeleton
            label={`Reading ${page.title.toLowerCase()}`}
            rows={6}
          />
        )
      }
    >
      <EditorTabs
        label={kind === "skill" ? "Open skills" : "Open files"}
        tabs={openFiles.map((file) => ({
          id: file.id,
          label: file.label,
          path: file.kind === "skill" ? "SKILL.md" : file.label,
          dirty: dirty.has(file.id),
        }))}
        active={openId ?? null}
        onActivate={open}
        onClose={close}
      />
      {/* Every tab's pane stays mounted, so its edits outlive a switch. */}
      {openFiles.map((file) => (
        <div
          key={file.id}
          role="tabpanel"
          aria-label={file.label}
          hidden={file.id !== openId}
          className="min-h-0 flex-1"
        >
          <AgentConfigPane
            file={file}
            onSaved={() => void refresh()}
            onDirtyChange={onDirtyChange(file.id)}
          />
        </div>
      ))}
      {!openFiles.some((file) => file.id === openId) && (
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
      )}
    </FileBrowserLayout>
  );
}
