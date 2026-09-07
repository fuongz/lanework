import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    defaultPreload: "intent",
    // Treat loader data as fresh for the session so loaders don't re-run on window
    // refocus. Drop this if your server data is NOT cache-bounded elsewhere —
    // without it, every refocus re-runs every loader; with it and no other cache,
    // the user can sit on stale data indefinitely. Routes can always call
    // `router.invalidate()` to force a refresh.
    defaultStaleTime: Infinity,
    scrollRestoration: true,
    defaultNotFoundComponent: () => <div className="p-8">Not found.</div>,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
