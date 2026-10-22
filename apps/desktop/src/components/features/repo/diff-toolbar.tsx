import {
  StretchHorizontalIcon,
  StretchVerticalIcon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { SegmentedControl } from "#/components/shared/common/segmented-control";
import { type DiffStyle, useWorktree } from "#/stores/worktree";

/**
 * The strip above a local diff: how it is drawn, and what it adds up to.
 *
 * Unified by default, with Split one click away: the owner's call, over
 * FE-22/D4's Split. The choice is remembered per viewer (`readStyle`).
 */
export function DiffToolbar({
  additions,
  deletions,
  children,
}: {
  additions: number;
  deletions: number;
  /** Controls on the right — navigation, stage. */
  children?: ReactNode;
}) {
  const diffStyle = useWorktree((state) => state.diffStyle);
  const setDiffStyle = useWorktree((state) => state.setDiffStyle);
  return (
    <div className="border-sidebar-border flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <SegmentedControl<DiffStyle>
        label="Diff layout"
        value={diffStyle}
        options={[
          { value: "split", label: "Split", icon: StretchVerticalIcon },
          { value: "unified", label: "Unified", icon: StretchHorizontalIcon },
        ]}
        onChange={setDiffStyle}
      />
      <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums">
        <span className="text-emerald-600 dark:text-emerald-400">
          +{additions}
        </span>{" "}
        <span className="text-rose-600 dark:text-rose-400">−{deletions}</span>
      </span>
      {children}
    </div>
  );
}
