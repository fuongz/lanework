import { Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo } from "react";
import { isOpenableUrl, isPreviewUrl } from "#/../shared/conversation";
import type { LinkRenderer } from "#/components/shared/common/markdown-body";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";
import { notify } from "#/stores/notify";
import { LinkIcon, usePreview } from "./link-icon";

/** A link's host, for a link written as its own URL that main won't preview. */
function hostOf(href: string): string {
  try {
    return new URL(href).hostname;
  } catch {
    return href;
  }
}

/** Put `text` on the clipboard, and say so on the island. */
function copyLink(text: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => notify("success", "Link copied"))
    .catch(() => notify("error", "Could not copy the link"));
}

/**
 * A link in the chat: the site's favicon and page title, the URL in a tooltip.
 * Right-click offers Open in Browser and Copy Link.
 *
 * Without a favicon and title from main, it shows the link's own text; a
 * link written as its own URL to a host main won't preview shows its host.
 *
 * NOTE: Only http(s) is ever opened, and only a link to one of
 * PREVIEW_HOSTS is ever fetched (FE-79/D4): any other link makes no DNS
 * lookup or request, so an agent's reply cannot reach a host it chose. While
 * the turn is still streaming (`live`), nothing is fetched at all (FE-79/D3).
 * Anything else, such as a relative path the agent wrote, stays text with
 * its target in the tooltip.
 */
const LinkChip = memo(function LinkChip({
  href,
  text,
  live,
}: {
  href: string;
  text: string;
  live: boolean;
}) {
  const web = isOpenableUrl(href);
  const previewed = isPreviewUrl(href);
  const found = usePreview(previewed && !live ? href : null);
  // A link written as its own URL reads better as the page's title (or its
  // host, when main won't fetch it); one the author named keeps their words.
  const label =
    text !== href
      ? text
      : found?.title
        ? found.title
        : web && !previewed
          ? hostOf(href)
          : text;
  const open = () => void window.desktop?.conversation.openLink(href);
  return (
    <ContextMenu>
      {/* NOTE: `contents`: the menu's trigger adds no box, so the link
          still wraps inline with the sentence it is in. */}
      <ContextMenuTrigger render={<span className="contents" />}>
        <Tooltip>
          <TooltipTrigger
            render={
              web ? (
                // biome-ignore lint/a11y/useAnchorContent: the trigger's children — the icon and the label — are drawn inside this anchor.
                <a
                  href={href}
                  rel="noreferrer noopener"
                  onClick={(event) => {
                    event.preventDefault();
                    open();
                  }}
                  // A badge: the page's mark and its host (or the link's
                  // words), on one line within the sentence.
                  className="bg-muted/70 border-border hover:bg-muted text-foreground mx-px inline-flex max-w-full translate-y-[-1px] items-center gap-1 rounded-md border px-1.5 align-middle text-[0.86em] leading-[1.6] no-underline transition-colors dark:bg-foreground/[0.06] dark:hover:bg-foreground/[0.1]"
                />
              ) : (
                <span className="decoration-foreground/30 underline decoration-dotted underline-offset-[3px] [overflow-wrap:anywhere]" />
              )
            }
          >
            {found?.icon ? (
              <img
                src={found.icon}
                alt=""
                aria-hidden="true"
                className="size-3.5 shrink-0 rounded-[4px]"
              />
            ) : (
              // NOTE: A well-known site's favicon, else the globe: any other
              // host is never reached (FE-79/D4). Nothing while it streams.
              web &&
              (live ? (
                <HugeiconsIcon
                  icon={Globe02Icon}
                  className="text-muted-foreground size-3.5 shrink-0"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              ) : (
                <LinkIcon
                  host={hostOf(href)}
                  className="text-muted-foreground"
                />
              ))
            )}
            {web ? (
              <span
                className={cn(
                  "min-w-0 truncate",
                  // The host of a bare URL reads as an address.
                  text === href && !found?.title && "font-mono",
                )}
              >
                {label}
              </span>
            ) : (
              label
            )}
          </TooltipTrigger>
          <TooltipContent className="max-w-md break-all">{href}</TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent finalFocus={false}>
        {web && (
          <ContextMenuItem onClick={open}>Open in Browser</ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => copyLink(href)}>
          {web ? "Copy Link" : "Copy"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** The chat's link renderer for {@link MarkdownBody} and {@link LinkedText}. */
export const chatLink: LinkRenderer = (span) =>
  span.wiki ? (
    span.raw
  ) : (
    <LinkChip href={span.href} text={span.text} live={false} />
  );

/**
 * {@link chatLink} for a turn still streaming: its links ask main for no
 * preview until the turn closes (FE-79/D3).
 */
export const liveChatLink: LinkRenderer = (span) =>
  span.wiki ? span.raw : <LinkChip href={span.href} text={span.text} live />;
