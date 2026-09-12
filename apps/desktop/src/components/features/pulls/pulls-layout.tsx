import { Outlet, useParams, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { usePulls } from "#/stores/pulls";
import { PullsList } from "./pulls-list";

/**
 * The pull-request screen: a list that stays, and one pull request beside it.
 *
 * ⚠️ Refreshed on FOCUS, never on a timer — the same rule `WorkspaceLayout`
 * applies to the board. A desktop window nobody is looking at has nobody to
 * show a change to, and a poll it fires anyway is a request per interval per
 * open window, forever, against an hourly budget.
 */
export function PullsLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug/pulls" });
  // ⚠️ The state filter is read from the URL and passed INTO the read, not
  // applied to what came back: a merged pull request is not in the open list to
  // be filtered out of.
  const { status } = useSearch({ from: "/_app/w/$slug/pulls" });
  const open = usePulls((state) => state.open);
  const refresh = usePulls((state) => state.refresh);
  const watch = usePulls((state) => state.watch);

  useEffect(() => {
    void open(slug, status);
  }, [open, slug, status]);

  useEffect(() => watch(), [watch]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <PullsList />
      <Outlet />
    </div>
  );
}
