import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { HARNESS_NAMES } from "#/components/shared/agents/harness-island";
import { useHarness } from "#/stores/harness";
import { CLI_MINIMUMS, type HarnessAgent } from "../../../../shared/harness";

/**
 * The chat's notice that its CLI is older than Lanework needs (FE-168/D1):
 * a row of the tab on the composer, like the trust notice. It still runs
 * (D2); the row says so, and offers the update the island offers. Nothing
 * while the version is unknown (D4) or new enough.
 */
export function OutdatedNotice({ agent }: { agent: HarnessAgent }) {
  const info = useHarness((state) =>
    state.list.find((entry) => entry.agent === agent),
  );
  const update = useHarness((state) => state.update);
  if (!info?.belowMinimum) return null;
  const name = HARNESS_NAMES[agent];
  const text = `${name} ${info.version} is older than Lanework needs (${info.minimum} or newer). It still runs, without: ${CLI_MINIMUMS[agent].needs.join("; ")}.`;
  const updating = info.update.state === "updating";
  return (
    <div role="status" className="flex h-6 items-center gap-2">
      <HugeiconsIcon
        icon={Alert02Icon}
        className="text-tone-amber size-3.5 shrink-0"
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
      {info.updateCommand && (
        <button
          type="button"
          disabled={updating}
          onClick={() => void update(agent)}
          className="hover:bg-foreground/[0.06] hover:text-foreground flex h-6 shrink-0 items-center rounded-md px-1.5 transition-colors disabled:pointer-events-none disabled:opacity-50"
        >
          {updating ? `Updating ${name}…` : `Update ${name}`}
        </button>
      )}
    </div>
  );
}

/** Whether {@link OutdatedNotice} draws anything for `agent`. */
export function useOutdated(agent: HarnessAgent | null): boolean {
  return useHarness(
    (state) =>
      agent !== null &&
      !!state.list.find((entry) => entry.agent === agent)?.belowMinimum,
  );
}
