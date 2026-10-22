import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import {
  RouteError,
  RouteNotFound,
} from "#/components/features/shell/route-error";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    defaultPreload: "intent",
    // Loader data stays fresh for the session, so loaders do not re-run on
    // window refocus. That is safe only while server data is cached
    // elsewhere: with no other cache, the user can sit on stale data forever.
    // A route calls `router.invalidate()` to force a refresh.
    defaultStaleTime: Infinity,
    scrollRestoration: true,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
