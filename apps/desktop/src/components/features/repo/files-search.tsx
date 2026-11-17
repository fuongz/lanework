// ⌘⇧F in Repository › Files (FE-149): the text in every file of the folder on
// screen, found by the bundled ripgrep in main.
//
// - It takes the tree's place in the left pane; Esc gives the tree back. The
//   query and its toggles are kept per project and folder, so ⌘⇧F again finds
//   them where they were.
// - Main aborts the previous search of this window when a new one starts and
//   answers the superseded one with `[]`, so only the newest answer is drawn
//   (a sequence number, not the query text: the same text with another toggle
//   is another search).
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Loading03Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  LIST_ACTION,
  LIST_ACTION_ICON,
  ListSearch,
} from "#/components/shared/common/list-search";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { ipcMessage } from "#/lib/ipc-error";
import { useFiles } from "#/stores/files";
import type { FileMatch, MatchLine } from "../../../../shared/fs-search";

/** Typing settles for this long before a search starts. */
const DEBOUNCE_MS = 200;
/** Main's file limit: this many files back means there may be more. */
const FILE_LIMIT = 200;
/** A match further into its line than this is drawn with the start cut. */
const LEAD = 32;

interface SearchInput {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
}

/** The last search of each project and folder (`slug#folder`). */
const searchMemory = new Map<string, SearchInput>();

type Outcome =
  | { kind: "idle" }
  | { kind: "loading"; previous: FileMatch[] | null }
  | { kind: "done"; files: FileMatch[] }
  | { kind: "error"; message: string };

/** The matches, sorted and clamped to the line. */
function rangesOf(line: MatchLine): [number, number][] {
  return line.ranges
    .map(
      ([start, end]) =>
        [
          Math.max(0, Math.min(start, line.text.length)),
          Math.max(0, Math.min(end, line.text.length)),
        ] as [number, number],
    )
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
}

/**
 * A line's text with its matches marked.
 *
 * Leading indentation goes, and a line whose first match sits far in is cut
 * before it, so the match is on screen in a narrow pane.
 */
function Preview({ line }: { line: MatchLine }) {
  const ranges = rangesOf(line);
  const indent = line.text.length - line.text.trimStart().length;
  const first = ranges[0]?.[0] ?? indent;
  const from = first - indent > LEAD ? first - LEAD / 2 : indent;
  const text = line.text.slice(from);

  const parts: ReactNode[] = [];
  let at = 0;
  for (const [rawStart, rawEnd] of ranges) {
    const start = Math.max(rawStart - from, at);
    const end = rawEnd - from;
    if (end <= start) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark
        key={start}
        className="bg-primary/20 text-foreground rounded-[2px] ring-1 ring-primary/25"
      >
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));

  return (
    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
      {from > indent && <span className="text-muted-foreground">…</span>}
      {parts}
    </span>
  );
}

/** One file's matches: its row, then a row per matching line. */
function FileGroup({
  file,
  collapsed,
  onToggle,
  onOpen,
}: {
  file: FileMatch;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (path: string, line: number) => void;
}) {
  const cut = file.path.lastIndexOf("/");
  const name = file.path.slice(cut + 1);
  const dir = cut > 0 ? file.path.slice(0, cut) : "";
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={file.path}
        className="hover:bg-muted/60 flex h-6 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[13px]"
      >
        <HugeiconsIcon
          icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
          className="text-muted-foreground size-3 shrink-0"
          strokeWidth={2}
          aria-hidden="true"
        />
        <FileTypeIcon path={file.path} className="size-4 shrink-0" />
        <span className="shrink-0 truncate">{name}</span>
        {dir && (
          <span className="text-muted-foreground min-w-0 truncate text-[12px]">
            {dir}
          </span>
        )}
        <span className="text-muted-foreground ml-auto shrink-0 pl-1 text-[11px] tabular-nums">
          {file.lines.length.toLocaleString()}
        </span>
      </button>
      {!collapsed && (
        <ul>
          {file.lines.map((line) => (
            <li key={line.line}>
              <button
                type="button"
                onClick={() => onOpen(file.path, line.line)}
                title={`${file.path}:${line.line}`}
                className="hover:bg-muted/60 focus-visible:bg-muted/60 flex h-6 w-full items-center gap-2 rounded-md pr-1.5 pl-6 text-left outline-none"
              >
                <span className="text-muted-foreground w-8 shrink-0 text-right text-[11px] tabular-nums">
                  {line.line}
                </span>
                <Preview line={line} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function SearchEmpty({
  icon,
  title,
  description,
  spin,
}: {
  icon: typeof Search01Icon;
  title: string;
  description: ReactNode;
  spin?: boolean;
}) {
  return (
    <Empty className="py-8">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon
            icon={icon}
            strokeWidth={1.8}
            className={spin ? "animate-spin" : undefined}
          />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription className="break-words">
          {description}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** A toggle beside the search box: on while `pressed`. */
function Toggle({
  pressed,
  onPress,
  label,
  children,
}: {
  pressed: boolean;
  onPress: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onPress}
      className={cn(
        LIST_ACTION,
        "font-mono text-[11px]",
        pressed
          ? "bg-primary/15 text-foreground hover:bg-primary/20"
          : "text-muted-foreground",
      )}
    >
      {children}
    </Button>
  );
}

/**
 * Search the text of project `slug`'s folder `folder` (its index among the
 * linked folders; 0 is the primary), in the Files pane.
 */
export function FilesSearch({
  slug,
  folder,
  focusRequest,
  onClose,
}: {
  slug: string;
  folder: number;
  /** Moves on every ⌘⇧F: the box takes focus again, its text selected. */
  focusRequest: number;
  /** Back to the tree: Esc, or the close button. */
  onClose: () => void;
}) {
  const memory = `${slug}#${folder}`;
  const openFile = useFiles((state) => state.openFile);
  const remembered = searchMemory.get(memory);
  const [query, setQuery] = useState(remembered?.query ?? "");
  const [regex, setRegex] = useState(remembered?.regex ?? false);
  const [caseSensitive, setCaseSensitive] = useState(
    remembered?.caseSensitive ?? false,
  );
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const seq = useRef(0);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    searchMemory.set(memory, { query, regex, caseSensitive });
  }, [memory, query, regex, caseSensitive]);

  // Focused, its text selected, on every ⌘⇧F: typing replaces the last query.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `focusRequest` is the trigger.
  useEffect(() => {
    const input = root.current?.querySelector("input");
    input?.focus();
    input?.select();
  }, [focusRequest]);

  useEffect(() => {
    const current = ++seq.current;
    if (!query.trim()) {
      setOutcome({ kind: "idle" });
      return;
    }
    setOutcome((was) => ({
      kind: "loading",
      previous:
        was.kind === "done"
          ? was.files
          : was.kind === "loading"
            ? was.previous
            : null,
    }));
    const timer = window.setTimeout(() => {
      const api = window.desktop?.fsSearch;
      if (!api) {
        setOutcome({
          kind: "error",
          message: "This window is not connected to the desktop app.",
        });
        return;
      }
      api
        .searchText(slug, folder, query, { regex, caseSensitive })
        .then((files) => {
          if (seq.current !== current) return;
          setCollapsed(new Set());
          setOutcome({ kind: "done", files });
        })
        .catch((error: unknown) => {
          if (seq.current !== current) return;
          setOutcome({
            kind: "error",
            message: ipcMessage(error, "The search failed."),
          });
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [slug, folder, query, regex, caseSensitive]);

  // The file opens scrolled to the line, which is selected (file-view.tsx).
  const open = (path: string, line: number) => openFile(path, false, line);

  const files =
    outcome.kind === "done"
      ? outcome.files
      : outcome.kind === "loading"
        ? outcome.previous
        : null;
  const lineCount = files?.reduce((sum, file) => sum + file.lines.length, 0);
  const capped =
    !!files &&
    (files.length >= FILE_LIMIT || files[files.length - 1]?.truncated === true);

  let body: ReactNode;
  if (outcome.kind === "idle")
    body = (
      <SearchEmpty
        icon={Search01Icon}
        title="Search in files"
        description="Find text in every file of this folder. Files git ignores are left out."
      />
    );
  else if (outcome.kind === "error")
    body = (
      <SearchEmpty
        icon={Alert02Icon}
        title="The search did not finish"
        description={outcome.message}
      />
    );
  else if (!files)
    body = (
      <SearchEmpty
        icon={Loading03Icon}
        spin
        title="Searching"
        description="Reading the files in this folder."
      />
    );
  else if (files.length === 0)
    body = (
      <SearchEmpty
        icon={Search01Icon}
        title="No results"
        description={`Nothing in this folder matches “${query.trim()}”.`}
      />
    );
  else
    body = (
      <ul
        aria-label="Search results"
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 transition-opacity",
          outcome.kind === "loading" && "opacity-60",
        )}
      >
        {files.map((file) => (
          <FileGroup
            key={file.path}
            file={file}
            collapsed={collapsed.has(file.path)}
            onToggle={() =>
              setCollapsed((was) => {
                const next = new Set(was);
                if (!next.delete(file.path)) next.add(file.path);
                return next;
              })
            }
            onOpen={open}
          />
        ))}
      </ul>
    );

  return (
    <search
      ref={root}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <ListSearch
        query={query}
        onQuery={setQuery}
        label="Search in files"
        className="shrink-0 px-2 pt-2 pb-1.5"
        actions={
          <>
            <Toggle
              pressed={caseSensitive}
              onPress={() => setCaseSensitive((was) => !was)}
              label="Match case"
            >
              Aa
            </Toggle>
            <Toggle
              pressed={regex}
              onPress={() => setRegex((was) => !was)}
              label="Use regular expression"
            >
              .*
            </Toggle>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back to files"
              title="Back to files (Esc)"
              onClick={onClose}
              className={LIST_ACTION}
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                strokeWidth={1.8}
                aria-hidden="true"
                className={LIST_ACTION_ICON}
              />
            </Button>
          </>
        }
      />
      {files && files.length > 0 && (
        <div className="text-muted-foreground flex shrink-0 flex-col gap-0.5 px-3 pb-1.5 text-xs">
          <p className="flex items-center gap-1.5 tabular-nums">
            {lineCount?.toLocaleString()}{" "}
            {lineCount === 1 ? "result" : "results"} in{" "}
            {files.length.toLocaleString()}{" "}
            {files.length === 1 ? "file" : "files"}
            {outcome.kind === "loading" && (
              <HugeiconsIcon
                icon={Loading03Icon}
                className="size-3 animate-spin"
                strokeWidth={1.8}
                aria-label="Searching"
              />
            )}
          </p>
          {capped && (
            <p>
              Showing the first {files.length.toLocaleString()}{" "}
              {files.length === 1 ? "file" : "files"}. Narrow the query to see
              the rest.
            </p>
          )}
        </div>
      )}
      {body}
    </search>
  );
}
