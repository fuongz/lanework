import type { CSSProperties } from "react";
// ⚠️ In `shared/common/`, not beside this file: the sign-in gate shows the
// same mark, and an asset owned by one screen that another reaches into is an
// import nobody can explain a year later.
import logo from "#/components/shared/common/lanework-logo.png";

/**
 * Shared by the pre-hydration shell and the pending session gate.
 *
 * ⚠️ The app's own icon, shimmering, and a spinner. It used to show a mark, the
 * word "Lanework" under it, and "Opening Lanework…" under that — the same fact
 * said three times on a screen that lives for about a second.
 */
export function StartupLoading() {
  return (
    <div className="startup-loading bg-background text-foreground flex min-h-svh flex-col">
      <div
        className="startup-loading-titlebar h-14 shrink-0"
        aria-hidden="true"
      />
      <main className="flex flex-1 items-center justify-center px-6 pb-14">
        <div role="status" className="flex flex-col items-center gap-6">
          {/* ⚠️ The logo's URL travels as a custom property because the shine
              above it is MASKED to the icon's own alpha — the highlight has to
              follow the rounded square and the letter, not a box around them.
              A stylesheet cannot name a Vite-hashed asset, so the component
              hands it over. */}
          <div
            className="relative size-20"
            style={{ "--startup-logo": `url(${logo})` } as CSSProperties}
          >
            <img
              src={logo}
              // Decorative: the sr-only sentence below says what is happening.
              alt=""
              className="size-20 select-none"
              draggable={false}
            />
            <span
              aria-hidden="true"
              className="startup-loading-shine pointer-events-none absolute inset-0"
            />
          </div>
          <span
            aria-hidden="true"
            className="startup-loading-spinner border-foreground/20 border-t-foreground/75 size-5 rounded-full border-2"
          />
          {/* ⚠️ The sentence stays for a screen reader. Removing the visible
              caption must not remove the only thing that says what is
              happening to somebody who cannot see the shimmer. */}
          <span className="sr-only">Opening Lanework…</span>
        </div>
      </main>
    </div>
  );
}
