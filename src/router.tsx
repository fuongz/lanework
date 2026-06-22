import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    defaultPreload: "intent",
    // Treat loader data as fresh for the session so loaders don't re-run on
    // window refocus / revisit. Server data is already bounded by the 60s KV
    // cache, and routes can still call router.invalidate() to force a refresh.
    defaultStaleTime: Infinity,
    scrollRestoration: true,
    defaultNotFoundComponent: () => <div className="p-8">Not found.</div>,
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
