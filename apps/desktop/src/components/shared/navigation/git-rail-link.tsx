import { Link, useMatch } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { cn } from "#/lib/utils";
import { useGitView } from "#/stores/git-view";

/**
 * The rail's one Git entry, open or folded (FE-130/D4).
 *
 * It opens the tab last used in this project (and History on the commit
 * last open there), and it is the current page on either tab: a plain Link
 * would light only on the one address it points at.
 */
export function GitRailLink({
  slug,
  className,
  activeClassName,
  ...props
}: {
  slug: string;
  /** Added while the Git view is open, the way `activeProps` would. */
  activeClassName?: string;
} & Omit<ComponentProps<"a">, "href">) {
  const match = useMatch({ from: "/_app/w/$slug/_git", shouldThrow: false });
  const place = useGitView((state) => state.bySlug[slug]);
  const active = match?.params.slug === slug;
  const link = {
    ...props,
    className: cn(className, active && activeClassName),
    "aria-current": active ? ("page" as const) : undefined,
  };
  if (place?.tab === "history")
    return place.sha ? (
      <Link
        to="/w/$slug/history/$sha"
        params={{ slug, sha: place.sha }}
        {...link}
      />
    ) : (
      <Link to="/w/$slug/history" params={{ slug }} {...link} />
    );
  return <Link to="/w/$slug/changes" params={{ slug }} {...link} />;
}
