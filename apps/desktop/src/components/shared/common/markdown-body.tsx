import { createContext, Fragment, type ReactNode, useContext } from "react";
import { Empty, EmptyDescription, EmptyHeader } from "#/components/ui/empty";
import {
  type Block,
  type Inline,
  inlines,
  type LinkSpan,
  parseMarkdown,
} from "#/lib/markdown";

/** What a link is drawn as, by the one reader that follows links (FE-36). */
export type LinkRenderer = (span: LinkSpan) => ReactNode;

/**
 * The body's link renderer. None — every card body — and links are not even
 * parsed: they stay the text they were written as.
 */
const LinkContext = createContext<LinkRenderer | null>(null);

function Spans({ spans }: { spans: Inline[] }) {
  const link = useContext(LinkContext);
  return (
    <>
      {spans.map((span, index) => {
        const key = `${span.kind}-${index}`;
        if (span.kind === "link")
          return <Fragment key={key}>{link ? link(span) : span.raw}</Fragment>;
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

/**
 * One line of markdown's INLINE marks — `**bold**`, `*em*`, `` `code` `` — with
 * no block structure, for short text that sits inside something else: a
 * checklist item, a note under it.
 *
 * ⚠️ Built from the same parser as `MarkdownBody`, so a decision written
 * `**D1.** use \`foo\`` reads the same in the body and in the checklist.
 */
export function InlineMarkdown({ source }: { source: string }) {
  return <Spans spans={inlines(source)} />;
}

/**
 * A card's body, built as elements — never as HTML. See `lib/markdown`.
 *
 * `link` reads `[text](href)` and `[[name]]` as links and draws each one
 * (FE-36); without it they are left as written.
 */
export function MarkdownBody({
  source,
  link,
  empty = "No description.",
}: {
  source: string;
  link?: LinkRenderer;
  empty?: string;
}) {
  if (!source.trim())
    return (
      <Empty className="items-start py-6 text-left">
        <EmptyHeader className="items-start">
          <EmptyDescription>{empty}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <LinkContext.Provider value={link ?? null}>
      <div className="font-content flex flex-col gap-3 text-[13px] leading-relaxed [font-weight:var(--content-font-weight)]">
        {parseMarkdown(source, { links: link !== undefined }).map(
          (block, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a parsed document is positional and never reorders — the index is the block's identity.
            <BlockView key={`${block.kind}-${index}`} block={block} />
          ),
        )}
      </div>
    </LinkContext.Provider>
  );
}

function BlockView({ block }: { block: Block }) {
  const links = useContext(LinkContext) !== null;
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
                  <Spans spans={inlines(cell, { links })} />
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
                    <Spans spans={inlines(cell, { links })} />
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
