import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSessionUser } from "@/server/reviews";
import { MarketingLanding } from "@/components/marketing/landing";

export const Route = createFileRoute("/")({
  loader: async () => {
    // Local mode (`lanework`): there's exactly one board (the working directory),
    // so jump straight to it. In the cloud build `__LANEWORK_LOCAL__` is statically
    // false, so this whole branch is dropped — the marketing page is fully static
    // and makes no server-side calls.
    if (__LANEWORK_LOCAL__) {
      const user = await getSessionUser();
      if (user) {
        throw redirect({
          to: "/board/$owner/$repo",
          params: { owner: "local", repo: user.name.replace(/[^A-Za-z0-9._-]/g, "-") || "local" },
        });
      }
    }
  },
  head: () => ({
    meta: [{ title: "Lanework — every agent review, in its lane." }],
  }),
  component: MarketingLanding,
});
