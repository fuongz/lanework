import { OrbitSpinner } from "#/components/shared/common/orbit-spinner";

/**
 * Working: a spinner where the agent's icon was (FE-25/D5) — no extra
 * column, so a row that spins is still the only row that moved. Reduced
 * motion gets a still dot in the same place.
 *
 * ⚠️ Shared by the rail's rows and the sub-agent viewer's header (FE-35/D11),
 * so "working" looks the same wherever an agent is.
 */
export function WorkingMark() {
  return (
    <span
      className="relative grid size-3 shrink-0 place-items-center"
      data-working=""
    >
      <OrbitSpinner className="text-foreground size-3 gap-px motion-reduce:hidden" />
      <span
        aria-hidden="true"
        className="bg-tone-emerald hidden size-1.5 rounded-full motion-reduce:block"
      />
    </span>
  );
}
