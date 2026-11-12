import { GithubIcon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
  isFaviconUrl,
  isPreviewUrl,
  type LinkPreview,
} from "#/../shared/conversation";
import { cn } from "#/lib/utils";

/**
 * Each URL's preview, kept for the whole session.
 *
 * A link drawn twice, or redrawn by the next read, never asks main again.
 * Main keeps its own cache on disk per domain; this one only saves the round
 * trip.
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

export function usePreview(url: string | null): LinkPreview | null {
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

/** A host's root page, asked for its icon alone; null when main won't. */
function iconUrlOf(host: string): string | null {
  const root = `https://${host}/`;
  return isPreviewUrl(root) || isFaviconUrl(root) ? root : null;
}

/** The hosts drawn as GitHub's mark while no favicon is had. */
const GITHUB = /(^|\.)github\.com$/;

/**
 * A web page's mark: its site's favicon when it is a well-known one
 * (`FAVICON_HOSTS`, or a host main previews), else GitHub's mark for GitHub
 * and the globe for any other.
 *
 * NOTE: Main fetches only `https://<host>/favicon.ico` for the well-known
 * sites, never the page; any other host is never reached (FE-79/D4).
 */
export function LinkIcon({
  host,
  className,
}: {
  host: string;
  className?: string;
}) {
  const found = usePreview(iconUrlOf(host.toLowerCase()));
  if (found?.icon)
    return (
      <img
        src={found.icon}
        alt=""
        aria-hidden="true"
        className={cn("size-3.5 shrink-0 rounded-[3px]", className)}
      />
    );
  return (
    <HugeiconsIcon
      icon={GITHUB.test(host) ? GithubIcon : Globe02Icon}
      className={cn("size-3.5 shrink-0", className)}
      strokeWidth={1.8}
      aria-hidden="true"
    />
  );
}
