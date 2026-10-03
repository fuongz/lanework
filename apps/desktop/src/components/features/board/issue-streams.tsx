/**
 * A card's work breakdown (BE-19): its streams, wave by wave — who runs first,
 * what each owns, what it waits for, and how far its verify rows are.
 *
 * ⚠️ Read-only. Streams are written by the agent that drafts the card (through
 * the MCP); this section exists so a person reviewing the card can see the
 * split before approving it, not to edit it.
 */
import type {
  BoardCard,
  BoardChecklistItem,
  BoardStream,
} from "#/../shared/workspaces";
import { streamWaves } from "#/../shared/workspaces";

const ROLE_NAME: Record<BoardStream["role"], string> = {
  research: "Research",
  implement: "Implement",
  test: "Test",
};

/**
 * `items` is the checklist as the page shows it — the draft laid over the
 * server's ticks — so a stream's count agrees with the boxes right above it.
 */
export function IssueStreams({
  card,
  items,
}: {
  card: BoardCard;
  items: BoardChecklistItem[];
}) {
  const streams = card.streams ?? [];
  if (!streams.length) return null;
  const waves = streamWaves(streams, card.dispatch);

  return (
    <section
      aria-labelledby={`streams-${card.id}`}
      className="border-border flex flex-col gap-3 rounded-lg border p-3"
    >
      <div className="flex items-baseline gap-2">
        <h2
          id={`streams-${card.id}`}
          className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
        >
          Work breakdown
        </h2>
        <span className="text-muted-foreground text-xs tabular-nums">
          {streams.length} {streams.length === 1 ? "stream" : "streams"},{" "}
          {waves.length} {waves.length === 1 ? "wave" : "waves"}
        </span>
      </div>
      <ol className="flex flex-col gap-3">
        {waves.map((wave, index) => (
          <li
            key={wave.map((stream) => stream.key).join("-")}
            aria-label={`Wave ${index + 1}`}
            data-wave={index + 1}
            className="flex flex-col gap-1.5"
          >
            <span className="text-muted-foreground text-xs font-medium">
              Wave {index + 1}
              {wave.length > 1 && (
                <span className="font-normal">, in parallel</span>
              )}
            </span>
            <ul className="flex flex-col gap-1.5">
              {wave.map((stream) => (
                <StreamRow key={stream.key} stream={stream} items={items} />
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StreamRow({
  stream,
  items,
}: {
  stream: BoardStream;
  items: BoardChecklistItem[];
}) {
  const proofs = items.filter(
    (item) => item.section === "verify" && item.stream === stream.key,
  );
  const done = proofs.filter((item) => item.checked).length;
  return (
    <li
      data-stream={stream.key}
      className="bg-foreground/[0.02] flex flex-col gap-1.5 rounded-md px-2.5 py-2 text-[13px]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <StreamKey value={stream.key} />
        <span className="truncate font-medium" title={stream.goal || undefined}>
          {stream.title}
        </span>
        <span className="border-border text-muted-foreground shrink-0 rounded-full border px-1.5 text-[11px] leading-4">
          {ROLE_NAME[stream.role]}
        </span>
        {stream.isolation === "shared" && (
          <span className="text-muted-foreground shrink-0 text-[11px]">
            shared checkout
          </span>
        )}
        <span
          className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums"
          title="Verify items ticked"
        >
          <span className="sr-only">Verify </span>
          {done}/{proofs.length}
        </span>
      </div>
      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt>Owns</dt>
        <dd className="flex min-w-0 flex-wrap gap-1">
          {stream.owns.length ? (
            stream.owns.map((path) => (
              <code
                key={path}
                className="bg-foreground/[0.04] text-foreground/80 max-w-full truncate rounded px-1 font-mono text-[11px]"
              >
                {path}
              </code>
            ))
          ) : (
            <span>Nothing</span>
          )}
        </dd>
        {stream.dependsOn.length > 0 && (
          <>
            <dt>Depends on</dt>
            <dd className="flex flex-wrap gap-1">
              {stream.dependsOn.map((key) => (
                <StreamKey key={key} value={key} />
              ))}
            </dd>
          </>
        )}
      </dl>
    </li>
  );
}

/** `W1` as a small mono chip — also what a verify row carries. */
export function StreamKey({ value }: { value: string }) {
  return (
    <span className="border-border text-muted-foreground inline-flex h-[18px] shrink-0 items-center rounded border px-1 font-mono text-[11px]">
      {value}
    </span>
  );
}
