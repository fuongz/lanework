/** The state a rail row's dot says; at rest a row has none. */
export type StatusTone = "working" | "awaiting" | "running" | "done";

const COLOR: Record<StatusTone, string> = {
  working: "bg-tone-blue",
  awaiting: "bg-destructive",
  running: "bg-tone-emerald",
  done: "bg-tone-emerald",
};

/**
 * A rail row's state, pinned under its icon's bottom-right corner: blue
 * while a turn runs, red while it waits on the person, a still green while
 * it is running between turns or has finished unseen (`done`), nothing at
 * rest. Shared by the sessions and
 * the conductors, so both read the same.
 *
 * Only blue and red ping: they are what changes. Reduced motion keeps the
 * dot and drops the ring.
 */
export function StatusPing({
  tone,
  inline = false,
}: {
  tone: StatusTone;
  /** In the row's flow, centred on its line, not pinned under an icon. */
  inline?: boolean;
}) {
  const color = COLOR[tone];
  return (
    <span
      aria-hidden="true"
      data-testid={tone === "awaiting" ? "awaiting-dot" : undefined}
      data-working={tone === "working" ? "" : undefined}
      className={`ring-sidebar grid size-1.5 shrink-0 place-items-center rounded-full ring-[1.5px] ${inline ? "relative" : "absolute -right-0.5 -bottom-0.5"}`}
    >
      {(tone === "working" || tone === "awaiting") && (
        <span
          className={`${color} absolute size-full animate-ping rounded-full opacity-75 motion-reduce:hidden`}
        />
      )}
      <span className={`${color} relative size-full rounded-full`} />
    </span>
  );
}
