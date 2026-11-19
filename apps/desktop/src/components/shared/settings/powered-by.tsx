import logo from "#/components/shared/common/lanework-logo.png";

/** The lanework-kit repository: lwk's source, its license and releases. */
export const LANEWORK_KIT_URL = "https://github.com/lanework-dev/kit";

/**
 * A settings row's byline (`SettingsRowSpec.byline`): "Powered by" and the
 * repository as a badge, Lanework's mark before its name, drawn like a link
 * in the chat (`turn-view.link-chip.tsx`).
 *
 * The badge is a plain `target="_blank"` anchor: the window's open handler
 * sends a github.com page to the user's default browser and denies the
 * popup (`electron/main/index.ts`).
 */
export function PoweredBy({
  name = "@lanework-dev/kit",
  href = LANEWORK_KIT_URL,
}: {
  name?: string;
  href?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      Powered by
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        title={href}
        className="bg-muted/70 border-border hover:bg-muted text-foreground inline-flex items-center gap-1 rounded-md border px-1.5 leading-[1.6] no-underline transition-colors dark:bg-foreground/[0.06] dark:hover:bg-foreground/[0.1]"
      >
        <img src={logo} alt="" className="size-3.5 shrink-0 rounded-[4px]" />
        {name}
      </a>
    </span>
  );
}
