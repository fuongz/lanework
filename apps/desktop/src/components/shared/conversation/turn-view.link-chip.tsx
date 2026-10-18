import { memo, useEffect, useState } from "react";
import { isPreviewUrl, type LinkPreview } from "#/../shared/conversation";
import type { LinkRenderer } from "#/components/shared/common/markdown-body";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";

/**
 * Each URL's preview, for the whole session (D4): a link drawn twice — or
 * redrawn by the next read — never asks main again. Main keeps its own cache
 * on disk per domain; this one only saves the round trip.
 */
const previews = new Map<string, LinkPreview | Promise<LinkPreview>>();

function preview(url: string): LinkPreview | Promise<LinkPreview> {
  const known = previews.get(url);
  if (known) return known;
  const surface = window.desktop?.conversation;
  if (!surface) {
    const none = { url, title: null, icon: null };
    previews.set(url, none);
    return none;
  }
  const pending = surface
    .linkPreview(url)
    .catch(() => ({ url, title: null, icon: null }))
    .then((found) => {
      previews.set(url, found);
      return found;
    });
  previews.set(url, pending);
  return pending;
}

function usePreview(url: string | null): LinkPreview | null {
  const [found, setFound] = useState<LinkPreview | null>(() => {
    if (!url) return null;
    const known = previews.get(url);
    return known && !(known instanceof Promise) ? known : null;
  });
  useEffect(() => {
    if (!url) return;
    const next = preview(url);
    if (!(next instanceof Promise)) {
      setFound(next);
      return;
    }
    let gone = false;
    void next.then((value) => {
      if (!gone) setFound(value);
    });
    return () => {
      gone = true;
    };
  }, [url]);
  return found && found.url === url ? found : null;
}

/**
 * A link in the chat (D4): the site's favicon and its page title when main
 * found them, else the link's own text; the URL in a tooltip.
 *
 * ⚠️ Only http(s) is ever fetched or opened. Anything else — a relative path
 * the agent wrote — stays text with its target in the tooltip.
 */
export const LinkChip = memo(function LinkChip({
  href,
  text,
}: {
  href: string;
  text: string;
}) {
  const web = isPreviewUrl(href);
  const found = usePreview(web ? href : null);
  // A link written as its own URL reads better as the page's title; one the
  // author named keeps their words.
  const label = found?.title && text === href ? found.title : text;
  return (
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
                void window.desktop?.conversation.openLink(href);
              }}
              className="text-accent-brand decoration-accent-brand/50 hover:decoration-accent-brand underline underline-offset-[3px] transition-colors [overflow-wrap:anywhere]"
            />
          ) : (
            <span className="decoration-foreground/30 underline decoration-dotted underline-offset-[3px] [overflow-wrap:anywhere]" />
          )
        }
      >
        {found?.icon && (
          <img
            src={found.icon}
            alt=""
            aria-hidden="true"
            className="mr-1 inline-block size-4 -translate-y-px rounded-full align-middle"
          />
        )}
        {label}
      </TooltipTrigger>
      <TooltipContent className="max-w-md break-all">{href}</TooltipContent>
    </Tooltip>
  );
});

/** The chat's link renderer, for `MarkdownBody` and `LinkedText`. */
export const chatLink: LinkRenderer = (span) =>
  span.wiki ? span.raw : <LinkChip href={span.href} text={span.text} />;
