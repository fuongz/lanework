import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ImagePreview } from "#/../shared/conversation";
import {
  FileTypeIcon,
  fileIconToken,
} from "#/components/shared/diff/diff-icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { Empty, EmptyDescription, EmptyHeader } from "#/components/ui/empty";
import {
  type Block,
  type ImageSpan,
  type Inline,
  inlines,
  type LinkSpan,
  parseMarkdown,
} from "#/lib/markdown";

/** Draws a link, for the readers that follow links. */
export type LinkRenderer = (span: LinkSpan) => ReactNode;

/**
 * The body's link renderer.
 *
 * With none (every card body), links are not even parsed: they stay the text
 * they were written as.
 */
const LinkContext = createContext<LinkRenderer | null>(null);

/**
 * What a file badge does when clicked: opens the file in Repository › Files.
 *
 * Only the chat provides one, since it alone knows the project a path is
 * relative to, so every other reader's badges stay plain.
 */
type FileOpener = (path: string) => void;
export const FileOpenerContext = createContext<FileOpener | null>(null);

/**
 * Shows an image the chat names in the lightbox, without going through
 * Repository › Files: an image badge or a tool call's image chip, on
 * Cmd/Ctrl-click or its context menu. The chat alone provides one, as with {@link FileOpenerContext}.
 */
export const ImageViewerContext = createContext<FileOpener | null>(null);

/**
 * A file badge's context menu, after "Open in Files": Finder, then its paths,
 * the Files tree's menu without "Open in Default App". The chat alone
 * provides one, as with {@link FileOpenerContext}.
 */
export interface FileActions {
  reveal: (path: string) => void;
  copyPath: (path: string) => void;
  copyRelativePath: (path: string) => void;
}
export const FileActionsContext = createContext<FileActions | null>(null);

/**
 * Reads an image the chat names, for drawing it in place: `read` asks main
 * (which keeps it to the conversation's own images), `cached` answers at once
 * for one already read, so a re-render never flashes its skeleton again. The
 * chat alone provides one, as with {@link FileOpenerContext}.
 */
export interface ImageSource {
  read: (path: string) => Promise<ImagePreview>;
  cached: (path: string) => ImagePreview | undefined;
}
export const ImageSourceContext = createContext<ImageSource | null>(null);

/** A path the lightbox can show, by its extension. */
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * An image drawn in place: a skeleton while main reads it, then the image,
 * which opens the lightbox on click.
 *
 * `fallback` is drawn where there is no reader (outside the chat) or the
 * image cannot be read: gone, out of scope, too big.
 */
export function ImageThumb({
  path,
  alt,
  fallback,
  className,
}: {
  path: string;
  alt: string;
  fallback: ReactNode;
  /** The image's size limits, e.g. `max-h-80`. */
  className?: string;
}) {
  const source = useContext(ImageSourceContext);
  const view = useContext(ImageViewerContext);
  const [preview, setPreview] = useState<ImagePreview | undefined>(() =>
    source?.cached(path),
  );
  useEffect(() => {
    if (!source) return;
    const known = source.cached(path);
    setPreview(known);
    if (known) return;
    let live = true;
    void source.read(path).then((found) => {
      if (live) setPreview(found);
    });
    return () => {
      live = false;
    };
  }, [source, path]);
  if (!source || preview?.found === false) return <>{fallback}</>;
  // Spans, not divs: an image in a reply sits inside a `<p>`.
  if (!preview)
    return (
      <span
        role="status"
        aria-label={`Image ${alt || path}`}
        className="bg-muted block aspect-square w-48 max-w-full animate-pulse rounded-lg"
      />
    );
  const image = (
    <img
      src={preview.url}
      alt={alt}
      title={path}
      className={`bg-foreground/[0.03] block max-w-full rounded-lg object-contain ${className ?? "max-h-80"}`}
    />
  );
  if (!view) return image;
  return (
    <button
      type="button"
      onClick={() => view(path)}
      title={`Open ${path}`}
      className="focus-visible:ring-ring/40 block max-w-full cursor-zoom-in rounded-lg outline-none focus-visible:ring-2"
    >
      {image}
    </button>
  );
}

/** A local path from an image's `src`, or null for a remote one. */
function imagePath(src: string): string | null {
  if (src.startsWith("file://"))
    try {
      return decodeURIComponent(new URL(src).pathname);
    } catch {
      return null;
    }
  return /^[a-z][a-z0-9+.-]*:/i.test(src) ? null : src;
}

/**
 * `![alt](src)` in the chat: the image itself, when it is a local image the
 * conversation may read. Otherwise its file badge, or a link to a remote one.
 */
function InlineImage({ span, chat }: { span: ImageSpan; chat: boolean }) {
  const link = useContext(LinkContext);
  const path = imagePath(span.src);
  const asLink = link
    ? link({
        kind: "link",
        text: span.alt || span.src,
        href: span.src,
        wiki: false,
        raw: span.raw,
      })
    : span.raw;
  if (!path || !IMAGE_PATH.test(path)) return <>{asLink}</>;
  return (
    <ImageThumb
      path={path}
      alt={span.alt}
      fallback={<FileBadge value={path} path={path} chat={chat} />}
    />
  );
}

/**
 * How the body is drawn.
 *
 * `default` is every card body's. `chat` is the conversation view's: bigger
 * type, bordered tables with rounded corners, inline code as pills, and bare
 * `https://…` read as links.
 */
type MarkdownVariant = "default" | "chat";
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
 *
 * Not three or four, and not all digits: `#123` and `#204812` are an issue or
 * a pull request far more often than a colour.
 */
const BARE_HEX = /(?<![\w&#/])#(?:[0-9a-f]{8}|[0-9a-f]{6})(?![\w-])/gi;

/**
 * `text` when it is exactly one CSS colour, else null.
 *
 * The browser has the last word (`CSS.supports`), so `rgb(nope)` stays plain
 * code. Where there is no `CSS` (the prerender), the shape alone decides.
 */
function cssColor(text: string): string | null {
  const value = text.trim();
  if (!COLOR_SHAPE.test(value)) return null;
  if (typeof CSS === "undefined" || !CSS.supports) return value;
  return CSS.supports("color", value) ? value : null;
}

/** A path as code is written: no spaces, no parentheses, no scheme. */
const PATH_SHAPE = /^[\w@~.+\-/[\]$]+$/;
/** A place in a file: `file.ts:42`, `file.ts:42-50`, `file.ts:42:7`. */
const LINE_SUFFIX = /:\d+(?:[-:]\d+)*$/;

/**
 * The file `text` names when the inline code is one, else null.
 *
 * Matches `permission-card.tsx` or `apps/desktop/src/styles/app.css:152`. The
 * icon set decides, not a dot: it knows `.tsx` is React and `Dockerfile` is
 * Docker, and answers `default` for `window.desktop` and `useBoard.dismiss`.
 * Its `text` answer, which `console.log` and `process.env` get too, counts
 * only for `.txt`, a dotfile, or a path with a folder in it.
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
 * The classes of a badge: inline code with an icon before it (a colour, a
 * file).
 *
 * - `inline-flex items-center`, the icon `1em` (as tall as the text, on its
 *   middle), and the badge `align-middle` in the line. An inline icon with a
 *   `vertical-align` nudge sits below the text and never quite lines up.
 * - `leading-[1.25]` keeps the pill as tall as a plain code pill; a flex box
 *   otherwise takes the paragraph's whole line-height.
 * - A badge is one box, so a line never breaks between its icon and its name.
 *   Only a name wider than the column wraps, inside the badge, so the radius
 *   is fixed: `rounded-full` turns a two-line badge into a lozenge.
 */
const badgeClass = (chat: boolean) =>
  `${chat ? "bg-foreground/[0.07] text-[0.82em]" : "bg-foreground/[0.06] text-[0.85em]"} inline-flex max-w-full rounded-[0.85em] py-0.5 pr-1.5 pl-1 align-middle font-mono leading-[1.25]`;

/**
 * A colour value as a badge: a round swatch of the colour, then the value as
 * written, the way GitHub draws `#e87e42` in code.
 *
 * The swatch has an inset ring, so white on a white page and black on a dark
 * one still show where the colour is.
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
 * as written.
 *
 * The icon is the one the Changes list and the diff draw for the file.
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
  const view = useContext(ImageViewerContext);
  const actions = useContext(FileActionsContext);
  const body = (
    <>
      {/* On the first line's middle, (1.25 − 1) / 2: on one line that is
          `items-center`, and on a wrapped path it keeps the icon by its
          start. */}
      <FileTypeIcon path={path} className="mt-[0.125em] size-[1em] shrink-0" />
      {/* A long path still wraps, inside the badge. */}
      <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
    </>
  );
  // In the chat, the badge opens the file in Repository › Files; an image's
  // opens the lightbox instead on Cmd/Ctrl-click, or from its context menu.
  // Right-click offers the same, then Finder and its paths.
  if (open) {
    const image = view && IMAGE_PATH.test(path) ? view : null;
    const button = (
      <button
        type="button"
        data-file={path}
        title={`Open ${path}`}
        onClick={(event) =>
          image && (event.metaKey || event.ctrlKey) ? image(path) : open(path)
        }
        className={`${badgeClass(chat)} hover:bg-foreground/[0.12] focus-visible:ring-ring/40 cursor-pointer items-start gap-[0.3em] text-left transition-colors outline-none focus-visible:ring-2`}
      >
        {body}
      </button>
    );
    return (
      <ContextMenu>
        <ContextMenuTrigger render={button} />
        <ContextMenuContent>
          <ContextMenuItem onClick={() => open(path)}>
            Open in Files
          </ContextMenuItem>
          {image && (
            <ContextMenuItem onClick={() => image(path)}>
              Open image
            </ContextMenuItem>
          )}
          {actions && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => actions.reveal(path)}>
                Reveal in Finder
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => actions.copyPath(path)}>
                Copy Path
              </ContextMenuItem>
              <ContextMenuItem onClick={() => actions.copyRelativePath(path)}>
                Copy Relative Path
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  }
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
 * Running text in the chat: bare URLs drawn by `link`, bare hex colours as
 * badges, the rest as written.
 *
 * NOTE: URLs first, because a `#…` inside one is its fragment, not a colour.
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
        if (span.kind === "image")
          return <InlineImage key={key} span={span} chat={chat} />;
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
        // Bare URLs and bare colours only in the chat: a card body keeps its
        // text as written.
        if (chat)
          return <Fragment key={key}>{prose(span.text, link)}</Fragment>;
        return <Fragment key={key}>{span.text}</Fragment>;
      })}
    </>
  );
}

/**
 * One line of markdown's inline marks, with no block structure.
 *
 * For short text inside something else, like a checklist item or the note
 * under it: `**bold**`, `*em*`, `` `code` ``. It uses the same parser as
 * {@link MarkdownBody}, so a decision written `**D1.** use \`foo\`` reads the
 * same in the body and in the checklist.
 */
export function InlineMarkdown({ source }: { source: string }) {
  return <Spans spans={inlines(source)} />;
}

/**
 * Plain text that keeps its line breaks, with its links drawn by `link`.
 *
 * For what a person typed into the composer, which is not a document and must
 * not be reflowed as one. Links are `[text](href)` and bare `https://…`.
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
 * A card's body, built as elements, never as HTML. See `lib/markdown`.
 *
 * @param link reads `[text](href)` and `[[name]]` as links and draws each
 *   one; without it they are left as written.
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
  /** `chat` for the conversation view; unset for every other reader. */
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
                    {/* Cells carry inline markup too: these are the "files
                        touched" tables, and every path in them is written in
                        backticks. */}
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
 * A table in the chat: bordered, rounded, with a tinted header row.
 *
 * It is drawn as a card because a reply's tables are its summaries.
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
                // `leading-[1.7]` keeps a wrapping cell's code pills from
                // touching line to line at the table's 13px.
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
