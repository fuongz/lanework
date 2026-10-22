import { OrbitSpinner } from "#/components/shared/common/orbit-spinner";

/**
 * The "working" mark: a spinner on the right of a row, beside its age.
 *
 * The icon on the left keeps saying what the row is (an agent, a shell, a
 * monitor), so which of several running tasks is which still reads at a
 * glance. Reduced motion gets a still dot in the same place.
 *
 * Shared by the rail's rows and the sub-agent viewer's header (FE-35/D11), so
 * "working" looks the same wherever an agent is.
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
