import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/settings/")({
  // Bare `/settings` is the sidebar with nothing open, which is never what
  // someone meant.
  //
  // ⚠️ Account by NAME, not "whichever section is first". Reordering the nav
  // must not silently move where `/settings` lands — and the account is what
  // people come here to check.
  beforeLoad: () => {
    throw redirect({ to: "/settings/account" });
  },
});
