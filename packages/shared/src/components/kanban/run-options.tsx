import { useCallback, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Route01Icon, AiBrain01Icon, DashboardSpeed01Icon } from "@hugeicons/core-free-icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  AGENT_MODELS,
  AGENT_EFFORTS,
  AGENT_MODES,
  type AgentMode,
  type AgentEffort,
  type RunOptions,
} from "@/lib/agent-client";

// Radix/Base UI forbid an empty-string item value, so the "default" option (real
// value "") is represented by this sentinel in the trigger and mapped back out.
const RUN_OPT_NONE = "__default__";

/** useState backed by localStorage so run-option choices persist across sessions. */
function useStickyState<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    return (window.localStorage.getItem(key) as T) ?? initial;
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      if (typeof window !== "undefined") window.localStorage.setItem(key, v);
    },
    [key],
  );
  return [value, set];
}

export interface RunOptionsState {
  mode: AgentMode;
  model: string;
  effort: AgentEffort;
  setMode: (v: AgentMode) => void;
  setModel: (v: string) => void;
  setEffort: (v: AgentEffort) => void;
  /** Just the values, shaped for `runAgentForCard(path, opts)`. */
  options: RunOptions;
}

/**
 * Shared, persisted run options (mode · model · effort). One set of localStorage
 * keys backs every run surface — the card Run button, the review dialog, and the
 * create dialog — so a chosen model/effort sticks everywhere. `defaultMode` only
 * seeds the very first use (e.g. the create dialog defaults to "plan").
 */
export function useRunOptions(defaultMode: AgentMode = "implement"): RunOptionsState {
  const [mode, setMode] = useStickyState<AgentMode>("lanework.run.mode", defaultMode);
  const [model, setModel] = useStickyState<string>("lanework.run.model", "");
  const [effort, setEffort] = useStickyState<AgentEffort>("lanework.run.effort", "");
  return { mode, model, effort, setMode, setModel, setEffort, options: { mode, model, effort } };
}

/**
 * Compact select for a run option. Renders a leading `icon` + the selected
 * option's label (not the raw value), and maps the "" default to a sentinel.
 */
function RunOptionSelect({
  value,
  onChange,
  options,
  disabled,
  icon,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
  icon: typeof Route01Icon;
}) {
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <Select
      value={value || RUN_OPT_NONE}
      onValueChange={(v) => onChange(!v || v === RUN_OPT_NONE ? "" : v)}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 w-auto gap-1.5 text-xs">
        <HugeiconsIcon icon={icon} className="size-3.5 text-muted-foreground" />
        <span>{current?.label}</span>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value || RUN_OPT_NONE} value={o.value || RUN_OPT_NONE} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The three run-option selects (mode · model · effort) in a wrapping row. */
export function RunOptionsRow({ state, disabled }: { state: RunOptionsState; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <RunOptionSelect value={state.mode} onChange={(v) => state.setMode(v as AgentMode)} options={AGENT_MODES} disabled={disabled} icon={Route01Icon} />
      <RunOptionSelect value={state.model} onChange={state.setModel} options={AGENT_MODELS} disabled={disabled} icon={AiBrain01Icon} />
      <RunOptionSelect value={state.effort} onChange={(v) => state.setEffort(v as AgentEffort)} options={AGENT_EFFORTS} disabled={disabled} icon={DashboardSpeed01Icon} />
    </div>
  );
}
