import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactElement } from "react";
import { Button } from "#/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { ACCENT_PRESETS } from "#/lib/accent";
import { cn } from "#/lib/utils";
import { usePreferences } from "#/stores/preferences";

const SWATCH =
  "relative grid size-6 shrink-0 place-items-center rounded-full outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none";

/** The ring round the chosen swatch, a gap of the page between. */
const CHOSEN = "ring-2 ring-foreground/70 ring-offset-2 ring-offset-background";

function Tip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A tick drawn in white on a dark swatch, in ink on a light one. */
function Tick() {
  return (
    <HugeiconsIcon
      icon={Tick02Icon}
      strokeWidth={2.5}
      aria-hidden="true"
      className="size-3.5 text-white drop-shadow-[0_0_1px_rgb(0_0_0/0.6)]"
    />
  );
}

/**
 * The accent colour (FE-143): Lanework's orange and the presets beside it,
 * no free colour. "Reset" shows once the accent is not the default.
 */
export function AccentPicker() {
  const accent = usePreferences((state) => state.accent);
  const setAccent = usePreferences((state) => state.setAccent);
  return (
    <div className="flex items-center gap-3">
      {accent !== null && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setAccent(null)}
          className="text-muted-foreground h-7 rounded-lg px-2 text-[12px]"
        >
          Reset
        </Button>
      )}
      <fieldset
        aria-label="Accent colour"
        className="m-0 flex min-w-0 items-center gap-2.5 border-0 p-0"
      >
        {ACCENT_PRESETS.map((preset) => {
          const chosen = preset.value === accent;
          return (
            <Tip key={preset.name} label={preset.name}>
              <button
                type="button"
                aria-pressed={chosen}
                aria-label={preset.name}
                onClick={() => setAccent(preset.value)}
                className={cn(SWATCH, chosen && CHOSEN)}
                style={{ backgroundColor: preset.swatch }}
              >
                {chosen && <Tick />}
              </button>
            </Tip>
          );
        })}
      </fieldset>
    </div>
  );
}
