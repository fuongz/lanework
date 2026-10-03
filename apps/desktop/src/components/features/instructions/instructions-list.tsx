import { Link } from "@tanstack/react-router";
import type {
  InstructionAgent,
  InstructionList as InstructionListing,
  InstructionNode,
} from "#/../shared/instructions";
import {
  AGENT_LABELS,
  fileSize,
  MODE_LABELS,
  SCOPE_LABELS,
} from "#/lib/instructions";
import { shortPath } from "#/lib/memory";
import { cn } from "#/lib/utils";

const ROW =
  "hover:bg-foreground/[0.04] aria-[current]:bg-foreground/[0.06] focus-visible:ring-accent-brand flex min-w-0 flex-col gap-0.5 rounded-md py-1.5 pe-2.5 outline-none focus-visible:ring-2";

/** Where a row starts: deeper imports sit further in (FE-37/D3). */
const indent = (depth: number) => ({ paddingInlineStart: 10 + depth * 14 });

function Row({
  slug,
  list,
  node,
  depth,
}: {
  slug: string;
  list: InstructionListing;
  node: InstructionNode;
  depth: number;
}) {
  const file = list.files[node.file];
  if (!file) return null;
  const name = file.name === file.path ? shortPath(file.path) : file.name;
  const off = node.load === "skipped" || file.missing;
  const label =
    node.scope === "nested"
      ? node.agents.map((agent) => AGENT_LABELS[agent]).join(" and ")
      : SCOPE_LABELS[node.scope];
  const content = (
    <>
      <span className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn(
            "min-w-0 truncate text-[13px]",
            off && "text-muted-foreground line-through decoration-1",
          )}
        >
          {name}
        </span>
        <span className="text-muted-foreground flex shrink-0 gap-2 text-[11px]">
          <span>{label}</span>
          {node.load === "conditional" && <span>when needed</span>}
          {!file.markdown && !file.missing && (
            <span>{fileSize(file.size)}</span>
          )}
        </span>
      </span>
      {node.note && (
        <span className="text-muted-foreground min-w-0 text-xs leading-snug">
          {node.note}
        </span>
      )}
    </>
  );
  return (
    <>
      {/* Only Markdown that exists opens: anything else is listed by name (FE-37/D6). */}
      {file.markdown && !file.missing ? (
        <Link
          to="/w/$slug/instructions/$id"
          params={{ slug, id: file.id }}
          className={ROW}
          style={indent(depth)}
          title={file.path}
        >
          {content}
        </Link>
      ) : (
        <div
          className={cn(ROW, "hover:bg-transparent")}
          style={indent(depth)}
          title={
            file.missing
              ? `No file at ${file.path}`
              : `${file.path} — not shown`
          }
        >
          {content}
        </div>
      )}
      {node.children.map((child) => (
        <Row
          key={`${child.file}-${child.scope}`}
          slug={slug}
          list={list}
          node={child}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

function Heading({ children }: { children: string }) {
  return (
    <h3 className="text-muted-foreground px-2.5 pt-3 pb-1 text-[11px] font-medium tracking-wide uppercase">
      {children}
    </h3>
  );
}

function AgentGroup({
  slug,
  list,
  agent,
}: {
  slug: string;
  list: InstructionListing;
  agent: InstructionAgent;
}) {
  const nodes = list[agent];
  return (
    <div className="flex flex-col">
      <Heading>{AGENT_LABELS[agent]}</Heading>
      {/* Everything it reads at launch, in one view (FE-37/D4). */}
      <Link
        to="/w/$slug/instructions/effective/$agent"
        params={{ slug, agent }}
        className={ROW}
        style={indent(0)}
      >
        <span className="min-w-0 truncate text-[13px]">Effective</span>
        <span className="text-muted-foreground min-w-0 truncate text-xs">
          {agent === "claude"
            ? `Everything Claude reads at launch, as ${MODE_LABELS[list.claudeMode]}`
            : "Everything Codex reads at launch"}
        </span>
      </Link>
      {nodes.length ? (
        nodes.map((node) => (
          <Row
            key={`${node.file}-${node.scope}`}
            slug={slug}
            list={list}
            node={node}
            depth={0}
          />
        ))
      ) : (
        <p className="text-muted-foreground px-2.5 py-1.5 text-xs">
          {AGENT_LABELS[agent]} reads no instruction file here.
        </p>
      )}
    </div>
  );
}

/**
 * What each agent reads (FE-37/D3) — Claude, then Codex, each in the order it
 * reads them with imports under the file that names them — and the files
 * below the folder that load as an agent works there (D5).
 */
export function InstructionsList({
  slug,
  list,
}: {
  slug: string;
  list: InstructionListing;
}) {
  return (
    <nav
      aria-label="Instruction files"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pt-0 pb-1.5"
    >
      <AgentGroup slug={slug} list={list} agent="claude" />
      <AgentGroup slug={slug} list={list} agent="codex" />
      {list.nested.length > 0 && (
        <div className="flex flex-col">
          <Heading>In subfolders</Heading>
          {list.nested.map((node) => (
            <Row
              key={node.file}
              slug={slug}
              list={list}
              node={node}
              depth={0}
            />
          ))}
          {list.nestedTruncated && (
            <p className="text-muted-foreground px-2.5 py-2 text-xs">
              More subfolders than one scan covers; the first ones are shown.
            </p>
          )}
        </div>
      )}
    </nav>
  );
}
