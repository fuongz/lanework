import {
  ArrowRight01Icon,
  Clock01Icon,
  Folder01Icon,
  FolderOpenIcon,
  Layers01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import type {
  InstructionAgent,
  InstructionList as InstructionListing,
  InstructionNode,
} from "#/../shared/instructions";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import {
  AGENT_LABELS,
  fileSize,
  MODE_LABELS,
  type NestedFolder,
  nestedFolders,
  SCOPE_LABELS,
} from "#/lib/instructions";
import { shortPath } from "#/lib/memory";
import { cn } from "#/lib/utils";

/**
 * What each agent reads, as a tree (FE-44, after FE-37/D3): Claude, then
 * Codex, each in the order it reads its files with imports folded under the
 * file that names them — and the files below the folder that load as an
 * agent works there, under their folders (FE-44/D3).
 *
 * ⚠️ Drawn here, not by `@pierre/trees` (FE-44/D1). That library is a tree of
 * PATHS: it would sort these files by folder and lose the one thing this list
 * says — the order an agent reads them in — and it has no room on a row for
 * the scope beside each name.
 *
 * ⚠️ Rows stay LINKS inside a `nav`, the way they were: the chevron is a
 * button of its own beside the link, never inside it, and the arrow keys move
 * between rows by hand rather than through an ARIA `tree`, which would take
 * every link's role away.
 */

/** Pixels each level of the tree sits further in. */
const STEP = 12;
/** Where a depth-0 row's chevron starts. */
const START = 6;

const ROW =
  "hover:bg-foreground/[0.04] aria-[current]:bg-foreground/[0.06] focus-visible:ring-accent-brand relative flex h-7 min-w-0 items-center gap-1.5 rounded-md pe-2 outline-none focus-visible:ring-2";

const pad = (depth: number) => ({ paddingInlineStart: START + depth * STEP });

/** Which nodes are folded, per project; anything not in it is open. */
function useCollapsed(slug: string) {
  const key = `lanework:instructions-collapsed:${slug}`;
  const read = useCallback((): Set<string> => {
    try {
      const raw = localStorage.getItem(key);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  }, [key]);
  const [collapsed, setCollapsed] = useState(read);
  useEffect(() => setCollapsed(read()), [read]);
  const toggle = useCallback(
    (id: string, open?: boolean) =>
      setCollapsed((previous) => {
        const isOpen = !previous.has(id);
        if (open !== undefined && open === isOpen) return previous;
        const next = new Set(previous);
        if (isOpen) next.add(id);
        else next.delete(id);
        try {
          localStorage.setItem(key, JSON.stringify([...next]));
        } catch {
          // Private window or blocked storage: it just won't be remembered.
        }
        return next;
      }),
    [key],
  );
  return { collapsed, toggle };
}

type Toggle = (id: string, open?: boolean) => void;

function Chevron({
  open,
  label,
  onToggle,
}: {
  open: boolean;
  label?: string;
  onToggle?: () => void;
}) {
  const icon = (
    <HugeiconsIcon
      icon={ArrowRight01Icon}
      className={cn("size-3 transition-transform", open && "rotate-90")}
      strokeWidth={2}
      aria-hidden="true"
    />
  );
  // A row that toggles as a whole draws the chevron as a mark; a link row
  // needs it as a button of its own, since clicking the link opens the file.
  if (!onToggle)
    return (
      <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
    );
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      aria-expanded={open}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] relative z-10 flex size-4 shrink-0 items-center justify-center rounded"
    >
      {icon}
    </button>
  );
}

/** The thin line down the side of a branch, under its parent's chevron. */
function Branch({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <div className="relative flex flex-col">
      <span
        aria-hidden="true"
        className="bg-sidebar-border pointer-events-none absolute inset-y-0 w-px"
        style={{ insetInlineStart: START + depth * STEP + 7.5 }}
      />
      {children}
    </div>
  );
}

/** One file an agent reads, and what it imports beneath it. */
function FileRow({
  slug,
  list,
  node,
  depth,
  path,
  parent,
  showFolder = true,
  collapsed,
  toggle,
}: {
  slug: string;
  list: InstructionListing;
  node: InstructionNode;
  depth: number;
  /** Where this node sits, as a key for its fold. */
  path: string;
  /** The row ← steps out to. */
  parent: string;
  /** Under a folder row its folder is already said. */
  showFolder?: boolean;
  collapsed: Set<string>;
  toggle: Toggle;
}) {
  const file = list.files[node.file];
  if (!file) return null;
  const segments = (
    file.name === file.path ? shortPath(file.path) : file.name
  ).split("/");
  const base = segments.pop() ?? file.name;
  const folder = showFolder ? segments.join("/") : "";
  const off = node.load === "skipped" || file.missing;
  const label =
    node.scope === "nested"
      ? node.agents.map((agent) => AGENT_LABELS[agent]).join(" · ")
      : SCOPE_LABELS[node.scope];
  const expandable = node.children.length > 0;
  const open = expandable && !collapsed.has(path);
  // The note left the row (FE-44/D4): the detail's header says it in full.
  const title = [
    file.missing
      ? `No file at ${file.path}`
      : file.markdown
        ? file.path
        : `${file.path} — not shown`,
    node.note,
  ]
    .filter(Boolean)
    .join("\n");

  const content = (
    <>
      {/* The chevron's slot: the button itself sits over it, outside the link. */}
      <span className="size-4 shrink-0" />
      <FileTypeIcon
        path={base}
        className={cn("size-4 shrink-0", off && "opacity-50")}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px]",
          off && "text-muted-foreground",
        )}
      >
        <span className={cn(off && "line-through decoration-1")}>{base}</span>
        {folder && (
          <span className="text-muted-foreground ms-1.5 text-[11px]">
            {folder}
          </span>
        )}
      </span>
      {node.load === "conditional" && (
        <span title="Loads only when needed" className="flex shrink-0">
          <HugeiconsIcon
            icon={Clock01Icon}
            className="text-muted-foreground size-3"
            strokeWidth={1.8}
            aria-label="when needed"
          />
        </span>
      )}
      <span className="text-muted-foreground shrink-0 text-[11px]">
        {label}
        {!file.markdown && !file.missing && ` · ${fileSize(file.size)}`}
      </span>
    </>
  );

  const rowProps = {
    "data-tree-row": path,
    "data-tree-parent": parent,
    "data-tree-expanded": expandable ? String(open) : undefined,
    style: pad(depth),
    title,
  };

  return (
    <>
      <div className="relative flex flex-col">
        {expandable && (
          <span
            className="absolute top-1.5 z-10 flex"
            style={{ insetInlineStart: START + depth * STEP }}
          >
            <Chevron
              open={open}
              label={`${open ? "Collapse" : "Expand"} imports of ${base}`}
              onToggle={() => toggle(path)}
            />
          </span>
        )}
        {/* Only Markdown that exists opens: anything else is listed by name (FE-37/D6). */}
        {file.markdown && !file.missing ? (
          <Link
            to="/settings/instructions/$id"
            params={{ id: file.id }}
            search={{ project: slug }}
            className={ROW}
            {...rowProps}
          >
            {content}
          </Link>
        ) : (
          <div
            tabIndex={-1}
            className={cn(ROW, "hover:bg-transparent")}
            {...rowProps}
          >
            {content}
          </div>
        )}
      </div>
      {open && (
        <Branch depth={depth}>
          {node.children.map((child) => (
            <FileRow
              key={`${child.file}-${child.scope}`}
              slug={slug}
              list={list}
              node={child}
              depth={depth + 1}
              path={`${path}/${child.file}`}
              parent={path}
              collapsed={collapsed}
              toggle={toggle}
            />
          ))}
        </Branch>
      )}
    </>
  );
}

/** A group's root: an agent, or the subfolders. Folds what is under it. */
function Root({
  id,
  title,
  collapsed,
  toggle,
  children,
}: {
  id: string;
  title: string;
  collapsed: Set<string>;
  toggle: Toggle;
  children: ReactNode;
}) {
  const open = !collapsed.has(id);
  return (
    <div className="flex flex-col pt-2 first:pt-1">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          data-tree-row={id}
          data-tree-expanded={String(open)}
          onClick={() => toggle(id)}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-accent-brand flex h-7 w-full items-center gap-1.5 rounded-md text-[11px] font-medium tracking-wide uppercase outline-none focus-visible:ring-2"
          style={pad(0)}
        >
          <Chevron open={open} />
          {title}
        </button>
      </h3>
      {open && children}
    </div>
  );
}

function AgentGroup({
  slug,
  list,
  agent,
  collapsed,
  toggle,
}: {
  slug: string;
  list: InstructionListing;
  agent: InstructionAgent;
  collapsed: Set<string>;
  toggle: Toggle;
}) {
  const nodes = list[agent];
  return (
    <Root
      id={agent}
      title={AGENT_LABELS[agent]}
      collapsed={collapsed}
      toggle={toggle}
    >
      {/* Everything it reads at launch, in one view (FE-37/D4). */}
      <Link
        to="/settings/instructions/effective/$agent"
        params={{ agent }}
        search={{ project: slug }}
        className={ROW}
        style={pad(0)}
        data-tree-row={`${agent}/effective`}
        data-tree-parent={agent}
        title={
          agent === "claude"
            ? `Everything Claude reads at launch, as ${MODE_LABELS[list.claudeMode]}`
            : "Everything Codex reads at launch"
        }
      >
        <span className="size-4 shrink-0" />
        <HugeiconsIcon
          icon={Layers01Icon}
          className="text-accent-brand size-4 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[13px]">Effective</span>
        <span className="text-muted-foreground shrink-0 text-[11px]">
          {nodes.length} {nodes.length === 1 ? "file" : "files"}
        </span>
      </Link>
      {nodes.length ? (
        nodes.map((node) => (
          <FileRow
            key={`${node.file}-${node.scope}`}
            slug={slug}
            list={list}
            node={node}
            depth={0}
            path={`${agent}/${node.file}`}
            parent={agent}
            collapsed={collapsed}
            toggle={toggle}
          />
        ))
      ) : (
        <p
          className="text-muted-foreground py-1.5 text-xs"
          style={{ paddingInlineStart: START + 16 + 6 }}
        >
          {AGENT_LABELS[agent]} reads no instruction file here.
        </p>
      )}
    </Root>
  );
}

/** A folder of the subfolder group (FE-44/D3), and what is under it. */
function FolderRow({
  slug,
  list,
  folder,
  depth,
  parent,
  collapsed,
  toggle,
}: {
  slug: string;
  list: InstructionListing;
  folder: NestedFolder;
  depth: number;
  parent: string;
  collapsed: Set<string>;
  toggle: Toggle;
}) {
  const id = `dir:${folder.path}`;
  const open = !collapsed.has(id);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        data-tree-row={id}
        data-tree-parent={parent}
        data-tree-expanded={String(open)}
        onClick={() => toggle(id)}
        className={cn(ROW, "w-full text-start")}
        style={pad(depth)}
        title={folder.path}
      >
        <Chevron open={open} />
        <HugeiconsIcon
          icon={open ? FolderOpenIcon : Folder01Icon}
          className="text-muted-foreground size-4 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[13px]">
          {folder.name}
        </span>
      </button>
      {open && (
        <Branch depth={depth}>
          <NestedRows
            slug={slug}
            list={list}
            folder={folder}
            depth={depth + 1}
            parent={id}
            collapsed={collapsed}
            toggle={toggle}
          />
        </Branch>
      )}
    </>
  );
}

function NestedRows({
  slug,
  list,
  folder,
  depth,
  parent,
  collapsed,
  toggle,
}: {
  slug: string;
  list: InstructionListing;
  folder: NestedFolder;
  depth: number;
  parent: string;
  collapsed: Set<string>;
  toggle: Toggle;
}) {
  return (
    <>
      {folder.folders.map((child) => (
        <FolderRow
          key={child.path}
          slug={slug}
          list={list}
          folder={child}
          depth={depth}
          parent={parent}
          collapsed={collapsed}
          toggle={toggle}
        />
      ))}
      {folder.files.map((node) => (
        <FileRow
          key={node.file}
          slug={slug}
          list={list}
          node={node}
          depth={depth}
          path={`nested/${node.file}`}
          parent={parent}
          showFolder={false}
          collapsed={collapsed}
          toggle={toggle}
        />
      ))}
    </>
  );
}

/**
 * ↑/↓ between rows, ← folds a row or steps out to its parent, → unfolds it
 * or steps into its first child (FE-44/D4). Enter is the link's own.
 */
function onTreeKey(event: KeyboardEvent<HTMLElement>, toggle: Toggle) {
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLElement>("[data-tree-row]"),
  ];
  const current = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-tree-row]",
  );
  const at = current ? rows.indexOf(current) : -1;
  if (at < 0) return;
  const id = current?.dataset.treeRow ?? "";
  const expanded = current?.dataset.treeExpanded;
  const move = (to: number) => {
    rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
    event.preventDefault();
  };
  switch (event.key) {
    case "ArrowDown":
      return move(at + 1);
    case "ArrowUp":
      return move(at - 1);
    case "Home":
      return move(0);
    case "End":
      return move(rows.length - 1);
    case "ArrowRight":
      event.preventDefault();
      if (expanded === "false") toggle(id, true);
      else if (expanded === "true") move(at + 1);
      return;
    case "ArrowLeft": {
      event.preventDefault();
      if (expanded === "true") return toggle(id, false);
      const parent = rows.findIndex(
        (row) => row.dataset.treeRow === current?.dataset.treeParent,
      );
      if (parent >= 0) move(parent);
      return;
    }
  }
}

export function InstructionsList({
  slug,
  list,
}: {
  slug: string;
  list: InstructionListing;
}) {
  const { collapsed, toggle } = useCollapsed(slug);
  const nested = nestedFolders(list);
  return (
    <nav
      aria-label="Instruction files"
      onKeyDown={(event) => onTreeKey(event, toggle)}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pt-0 pb-1.5"
    >
      <AgentGroup
        slug={slug}
        list={list}
        agent="claude"
        collapsed={collapsed}
        toggle={toggle}
      />
      <AgentGroup
        slug={slug}
        list={list}
        agent="codex"
        collapsed={collapsed}
        toggle={toggle}
      />
      {list.nested.length > 0 && (
        <Root
          id="nested"
          title="In subfolders"
          collapsed={collapsed}
          toggle={toggle}
        >
          <NestedRows
            slug={slug}
            list={list}
            folder={nested}
            depth={0}
            parent="nested"
            collapsed={collapsed}
            toggle={toggle}
          />
          {list.nestedTruncated && (
            <p
              className="text-muted-foreground py-2 text-xs"
              style={{ paddingInlineStart: START + 16 + 6 }}
            >
              More subfolders than one scan covers; the first ones are shown.
            </p>
          )}
        </Root>
      )}
    </nav>
  );
}
