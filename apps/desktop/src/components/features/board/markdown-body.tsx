import { Fragment } from "react";
import { Empty, EmptyDescription, EmptyHeader } from "#/components/ui/empty";
import {
  type Block,
  type Inline,
  inlines,
  parseMarkdown,
} from "#/lib/markdown";

function Spans({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((span, index) => {
        const key = `${span.kind}-${index}`;
        if (span.kind === "code")
          return (
            <code
              key={key}
              className="bg-foreground/[0.06] rounded px-1 py-0.5 font-mono text-[0.85em]"
            >
              {span.text}
            </code>
          );
        if (span.kind === "strong")
          return (
            <strong key={key} className="font-semibold">
              {span.text}
            </strong>
          );
        if (span.kind === "em") return <em key={key}>{span.text}</em>;
        return <Fragment key={key}>{span.text}</Fragment>;
      })}
    </>
  );
}

/** A card's body, built as elements — never as HTML. See `lib/markdown`. */
export function MarkdownBody({ source }: { source: string }) {
  if (!source.trim())
    return (
      <Empty className="items-start py-6 text-left">
        <EmptyHeader className="items-start">
          <EmptyDescription>No description.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <div className="flex flex-col gap-3 text-[13px] leading-relaxed">
      {parseMarkdown(source).map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a parsed document is positional and never reorders — the index is the block's identity.
        <BlockView key={`${block.kind}-${index}`} block={block} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === "heading") {
    const size =
      block.level <= 2
        ? "text-[15px]"
        : block.level === 3
          ? "text-sm"
          : "text-[13px]";
    return (
      <p className={`${size} mt-2 font-semibold tracking-tight`}>
        <Spans spans={block.spans} />
      </p>
    );
  }
  if (block.kind === "code")
    return (
      // Wide code scrolls inside its own box; the page never scrolls sideways.
      <pre className="bg-foreground/[0.04] overflow-x-auto rounded-lg p-3 font-mono text-xs">
        <code>{block.text}</code>
      </pre>
    );
  if (block.kind === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return (
      <Tag
        className={`flex flex-col gap-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}
      >
        {block.items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a parsed document is positional and never reorders — the index is the row's identity.
          <li key={index}>
            <Spans spans={item} />
          </li>
        ))}
      </Tag>
    );
  }
  if (block.kind === "quote")
    return (
      <blockquote className="border-border text-muted-foreground border-l-2 pl-3">
        <Spans spans={block.spans} />
      </blockquote>
    );
  if (block.kind === "table")
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-border border-b">
              {block.header.map((cell, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a parsed document is positional and never reorders — the index is the row's identity.
                <th key={index} className="py-1.5 pr-3 font-medium">
                  <Spans spans={inlines(cell)} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a parsed document is positional and never reorders — the index is the row's identity.
              <tr key={rowIndex} className="border-border/60 border-b">
                {row.map((cell, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a parsed document is positional and never reorders — the index is the row's identity.
                  <td key={index} className="py-1.5 pr-3 align-top">
                    {/* ⚠️ Cells carry inline markup too — these tables are the
                        "files touched" ones, and every path in them is written
                        in backticks. Rendering the cell raw printed the
                        backticks and lost the code styling. */}
                    <Spans spans={inlines(cell)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <p>
      <Spans spans={block.spans} />
    </p>
  );
}
