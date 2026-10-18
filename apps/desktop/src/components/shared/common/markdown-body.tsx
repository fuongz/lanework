import { createContext, Fragment, type ReactNode, useContext } from "react";
import {
  FileTypeIcon,
  fileIconToken,
} from "#/components/shared/diff/diff-icons";
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
 * What a file badge does when clicked: opens the file in Repository › Files
 * (FE-66; an image's badge opened a lightbox before, FE-65). Only the chat
 * provides one — it alone knows the project a path is relative to — so every
 * other reader's badges stay plain.
 */
export type FileOpener = (path: string) => void;
export const FileOpenerContext = createContext<FileOpener | null>(null);

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

/** A CSS colour as it is written in prose: hex, or a colour function. */
const COLOR_SHAPE =
  /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\))$/i;

/**
 * A bare hex colour in running text: six or eight digits, standing alone.
 * ⚠️ Not three or four, and not all digits — `#123` and `#204812` are an
 * issue or a pull request far more often than a colour.
 */
const BARE_HEX = /(?<![\w&#/])#(?:[0-9a-f]{8}|[0-9a-f]{6})(?![\w-])/gi;

/**
 * `text` when it is exactly one CSS colour, else null.
 *
 * ⚠️ The browser has the last word (`CSS.supports`), so `rgb(nope)` stays
 * plain code. Where there is no `CSS` — the prerender — the shape alone.
 */
function cssColor(text: string): string | null {
  const value = text.trim();
  if (!COLOR_SHAPE.test(value)) return null;
  if (typeof CSS === "undefined" || !CSS.supports) return value;
  return CSS.supports("color", value) ? value : null;
}

/** A path as code is written: no spaces, no parentheses, no scheme. */
const PATH_SHAPE = /^[\w@~.+\-/[\]$]+$/;
/** `file.ts:42`, `file.ts:42-50`, `file.ts:42:7` — a place in the file. */
const LINE_SUFFIX = /:\d+(?:[-:]\d+)*$/;

/**
 * The file `text` names, when the inline code is one — `permission-card.tsx`,
 * `apps/desktop/src/styles/app.css:152` — else null.
 *
 * ⚠️ The icon set decides, not a dot: it knows `.tsx` is React and
 * `Dockerfile` is Docker, and answers `default` for `window.desktop` and
 * `useBoard.dismiss`. `text` — which it gives `console.log` and `process.env`
 * too — counts only for `.txt`, a dotfile, or a path with a folder in it.
 */
function filePath(text: string): string | null {
  const value = text.trim();
  if (value.length === 0 || value.length > 300) return null;
  const path = value.replace(LINE_SUFFIX, "");
  if (!PATH_SHAPE.test(path) || path.endsWith("/")) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!name || /^\.+$/.test(name)) return null;
  const folder = path.includes("/");
  const token = fileIconToken(path);
  if (token === undefined || token === "default")
    return folder && /\.[A-Za-z0-9]{1,10}$/.test(name) ? path : null;
  if (token === "text")
    return folder || name.startsWith(".") || /\.txt$/i.test(name) ? path : null;
  return path;
}

const CODE_CHAT =
  "bg-foreground/[0.07] rounded-md px-1.5 py-0.5 font-mono text-[0.82em] [overflow-wrap:anywhere]";
const CODE_DEFAULT =
  "bg-foreground/[0.06] rounded px-1 py-0.5 font-mono text-[0.85em]";

/**
 * A badge — inline code with an icon before it (a colour, a file).
 *
 * ⚠️ `inline-flex items-center`, the icon `1em` — as tall as the text, on its
 * middle — and the badge `align-middle` in the line. Drawn inline with a
 * `vertical-align` nudge instead, the icon sat below the text and the two
 * never quite lined up. `leading-[1.25]` keeps the pill as tall as a plain
 * code pill: a flex box takes the paragraph's whole line-height otherwise.
 *
 * ⚠️ A badge is one box, so a line never breaks between its icon and its
 * name: it moves to the next line whole. Only a name wider than the column
 * wraps, inside the badge — whose radius is then fixed, not `rounded-full`,
 * which turned a two-line badge into a lozenge.
 */
const badgeClass = (chat: boolean) =>
  `${chat ? "bg-foreground/[0.07] text-[0.82em]" : "bg-foreground/[0.06] text-[0.85em]"} inline-flex max-w-full rounded-[0.85em] py-0.5 pr-1.5 pl-1 align-middle font-mono leading-[1.25]`;

/**
 * A colour value as a badge: a round swatch of the colour itself, then the
 * value as written — the way GitHub draws `#e87e42` in code.
 *
 * ⚠️ The swatch has an inset ring, so white on a white page and black on a
 * dark one still show where the colour is.
 */
function ColorBadge({
  value,
  color,
  chat,
}: {
  value: string;
  color: string;
  chat: boolean;
}) {
  return (
    <code
      data-color={color}
      className={`${badgeClass(chat)} items-center gap-[0.4em] whitespace-nowrap`}
    >
      <span
        aria-hidden="true"
        className="ring-foreground/20 size-[0.8em] shrink-0 rounded-full ring-1 ring-inset"
        style={{ background: color }}
      />
      <span>{value}</span>
    </code>
  );
}

/**
 * A file named in inline code as a badge: its language's icon, then the name
 * as written — the same icon the Changes list and the diff draw for it.
 */
function FileBadge({
  value,
  path,
  chat,
}: {
  value: string;
  path: string;
  chat: boolean;
}) {
  const open = useContext(FileOpenerContext);
  const body = (
    <>
      {/* On the FIRST line's middle — (1.25 − 1) / 2 — which on one line is
          `items-center`, and on a wrapped path keeps the icon by its start. */}
      <FileTypeIcon path={path} className="mt-[0.125em] size-[1em] shrink-0" />
      {/* A long path still wraps, inside the badge. */}
      <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
    </>
  );
  // In the chat, the badge opens the file in Repository › Files (FE-66).
  if (open)
    return (
      <button
        type="button"
        data-file={path}
        title={`Open ${path}`}
        onClick={() => open(path)}
        className={`${badgeClass(chat)} hover:bg-foreground/[0.12] focus-visible:ring-ring/40 cursor-pointer items-start gap-[0.3em] text-left transition-colors outline-none focus-visible:ring-2`}
      >
        {body}
      </button>
    );
  return (
    <code
      data-file={path}
      className={`${badgeClass(chat)} items-start gap-[0.3em]`}
    >
      {body}
    </code>
  );
}

/** `text` with each bare hex colour in it drawn as a badge (chat only). */
function colored(text: string, at: number): ReactNode {
  const parts: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(BARE_HEX)) {
    const start = match.index ?? 0;
    const hex = match[0];
    // All digits is a number with a hash in front, not a colour.
    const color = /[a-f]/i.test(hex) ? cssColor(hex) : null;
    if (!color) continue;
    if (start > from) parts.push(text.slice(from, start));
    parts.push(
      <ColorBadge key={`hex-${at + start}`} value={hex} color={color} chat />,
    );
    from = start + hex.length;
  }
  if (from === 0) return text;
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/**
 * Running text in the chat (FE-62): its bare URLs drawn by `link`, its bare
 * hex colours as badges, the rest as written.
 *
 * ⚠️ URLs first: a `#…` inside one is its fragment, not a colour.
 */
function prose(text: string, link: LinkRenderer | null): ReactNode {
  if (!link) return colored(text, 0);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(BARE_URL)) {
    const start = match.index ?? 0;
    if (start > at) parts.push(colored(text.slice(at, start), at));
    const url = match[0];
    parts.push(
      <Fragment key={`url-${start}`}>
        {link({ kind: "link", text: url, href: url, wiki: false, raw: url })}
      </Fragment>,
    );
    at = start + url.length;
  }
  if (at === 0) return colored(text, 0);
  if (at < text.length) parts.push(colored(text.slice(at), at));
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
        if (span.kind === "code") {
          const color = cssColor(span.text);
          if (color)
            return (
              <ColorBadge
                key={key}
                value={span.text}
                color={color}
                chat={chat}
              />
            );
          const path = filePath(span.text);
          if (path)
            return (
              <FileBadge key={key} value={span.text} path={path} chat={chat} />
            );
          return (
            <code key={key} className={chat ? CODE_CHAT : CODE_DEFAULT}>
              {span.text}
            </code>
          );
        }
        if (span.kind === "strong")
          return (
            <strong key={key} className="font-semibold">
              {span.text}
            </strong>
          );
        if (span.kind === "em") return <em key={key}>{span.text}</em>;
        // ⚠️ Bare URLs and bare colours only in the chat (FE-62): a card
        // body keeps its text exactly as written.
        if (chat)
          return <Fragment key={key}>{prose(span.text, link)}</Fragment>;
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
              <th key={index} className="px-3 py-2 leading-[1.7] font-semibold">
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
                // ⚠️ `leading-[1.7]`: a cell of code pills that wraps had its
                // pills touching line to line at the table's 13px.
                // biome-ignore lint/suspicious/noArrayIndexKey: a parsed document is positional and never reorders — the index is the row's identity.
                <td key={index} className="px-3 py-2 align-top leading-[1.7]">
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
