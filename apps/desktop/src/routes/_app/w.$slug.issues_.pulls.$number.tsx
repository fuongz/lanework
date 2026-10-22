import { createFileRoute } from "@tanstack/react-router";
import {
  PullDetail,
  parsePullDetailSearch,
} from "#/components/features/pulls/pull-detail";
export const Route = createFileRoute("/_app/w/$slug/issues_/pulls/$number")({
  // The tab lives in the URL for the same reason the list's does: a link
  // somebody sends carries what they were looking at, and Back undoes the
  // switch rather than leaving the pull request entirely.
  validateSearch: parsePullDetailSearch,
  component: PullDetail,
});
