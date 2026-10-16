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

/**
 * How the body is drawn. `default` is every card body's; `chat` is the
 * conversation view's (FE-62): bigger type, bordered tables with rounded
 * corners, inline code as pills, and bare `https://…` read as links.
 */
export type MarkdownVariant = "default" | "chat";
const VariantContext = createContext<MarkdownVariant>("default");

/**
 * A bare URL in running text. It stops before trailing punctuation, so
 * `see https://x.dev.` links `https://x.dev`.
 */
const BARE_URL = /https?:\/\/[^\s<>()[\]`]*[^\s<>()[\]`.,;:!?'"]/g;

/** `text`, its bare URLs drawn by `link` (FE-62) and the rest as written. */
function autolinked(text: string, link: LinkRenderer): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(BARE_URL)) {
    const start = match.index ?? 0;
    if (start > at) parts.push(text.slice(at, start));
    const url = match[0];
    parts.push(
      <Fragment key={`url-${start}`}>
        {link({ kind: "link", text: url, href: url, wiki: false, raw: url })}
      </Fragment>,
    );
    at = start + url.length;
  }
  if (at === 0) return text;
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

function Spans({ spans }: { spans: Inline[] }) {
  const link = useContext(LinkContext);
  const chat = useContext(VariantContext) === "chat";
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
              className={
                chat
                  ? "bg-foreground/[0.07] rounded-md px-1.5 py-0.5 font-mono text-[0.82em] [overflow-wrap:anywhere]"
                  : "bg-foreground/[0.06] rounded px-1 py-0.5 font-mono text-[0.85em]"
              }
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
        // ⚠️ Bare URLs only in the chat (FE-62): a card body keeps every
        // link exactly as written.
        if (chat && link)
          return <Fragment key={key}>{autolinked(span.text, link)}</Fragment>;
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
 * Plain text that keeps its line breaks, with its links — `[text](href)` and
 * bare `https://…` — drawn by `link` (FE-62): what a person typed into the
 * composer, which is not a document and must not be reflowed as one.
 */
export function LinkedText({
  source,
  link,
}: {
  source: string;
  link: LinkRenderer;
}) {
  return (
    <LinkContext.Provider value={link}>
      <VariantContext.Provider value="chat">
        <Spans spans={inlines(source, { links: true })} />
      </VariantContext.Provider>
    </LinkContext.Provider>
  );
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
  variant = "default",
}: {
  source: string;
  link?: LinkRenderer;
  empty?: string;
  /** `chat` for the conversation view (FE-62); every other reader, unset. */
  variant?: MarkdownVariant;
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
      <VariantContext.Provider value={variant}>
        <div
          className={
            variant === "chat"
              ? "font-content flex min-w-0 flex-col gap-3 text-[14px] leading-[1.7] [font-weight:var(--content-font-weight)]"
              : "font-content flex flex-col gap-3 text-[13px] leading-relaxed [font-weight:var(--content-font-weight)]"
          }
        >
          {parseMarkdown(source, { links: link !== undefined }).map(
            (block, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a parsed document is positional and never reorders — the index is the block's identity.
              <BlockView key={`${block.kind}-${index}`} block={block} />
            ),
          )}
        </div>
      </VariantContext.Provider>
    </LinkContext.Provider>
  );
}

function BlockView({ block }: { block: Block }) {
  const links = useContext(LinkContext) !== null;
  const chat = useContext(VariantContext) === "chat";
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
        className={`flex flex-col ${chat ? "gap-1.5 pl-6" : "gap-1 pl-5"} ${block.ordered ? "list-decimal" : "list-disc"}`}
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
  if (block.kind === "table" && chat)
    return <ChatTable header={block.header} rows={block.rows} links={links} />;
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

/**
 * A table in the chat (FE-62): bordered, rounded, a tinted header row — the
 * body's own table, as a card, since a reply's tables are its summaries.
 */
function ChatTable({
  header,
  rows,
  links,
}: {
  header: string[];
  rows: string[][];
  links: boolean;
}) {
  return (
    // Wide tables scroll inside their own box; the page never scrolls sideways.
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-[13px]">
        <thead className="bg-foreground/[0.03]">
          <tr className="border-border border-b">
            {header.map((cell, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a parsed document is positional and never reorders — the index is the row's identity.
              <th key={index} className="px-3 py-2 font-semibold">
                <Spans spans={inlines(cell, { links })} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: a parsed document is positional and never reorders — the index is the row's identity.
              key={rowIndex}
              className="border-border/70 border-b last:border-b-0"
            >
              {row.map((cell, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a parsed document is positional and never reorders — the index is the row's identity.
                <td key={index} className="px-3 py-2 align-top">
                  <Spans spans={inlines(cell, { links })} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
