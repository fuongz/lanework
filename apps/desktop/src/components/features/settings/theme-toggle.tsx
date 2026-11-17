import { cn } from "#/lib/utils";
import { usePreferences } from "#/stores/preferences";
import { THEME_SOURCES, type ThemeSource } from "../../../../shared/desktop";

const LABEL: Record<ThemeSource, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * Colours of the miniature, fixed rather than read from tokens: the Light
 * one has to look light while the app is dark, and the other way round.
 * The accent is the live one (`--primary`), so a pick shows in all three.
 * Light and dark are the app's own grounds and cards (app.css).
 */
const TONE = {
  light: {
    ground: "#f2f1f0",
    page: "#ffffff",
    edge: "#e2e1df",
    line: "#d9d8d6",
    chip: "#e7e6e4",
    bubble: "#efefef",
  },
  dark: {
    ground: "#141210",
    page: "#1b1917",
    edge: "#2e2b28",
    line: "#4a4744",
    chip: "#26231f",
    bubble: "#2c2926",
  },
} as const;

/**
 * Lanework's own window in miniature: the session tabs across the top, the
 * rail on the ground with its open row lit, and the page card inset beside
 * it, a prompt on the right, the reply under it and the composer at the foot.
 */
function Window({ tone }: { tone: keyof typeof TONE }) {
  const c = TONE[tone];
  return (
    <div
      className="flex size-full flex-col gap-[3px] p-[3px]"
      style={{ backgroundColor: c.ground }}
    >
      {/* Title bar: the open tab white, another beside it. */}
      <div className="flex h-[5px] shrink-0 gap-[2px] pl-[24%]">
        <span
          className="w-[22%] rounded-[1.5px]"
          style={{ backgroundColor: c.page }}
        />
        <span
          className="w-[18%] rounded-[1.5px]"
          style={{ backgroundColor: c.chip }}
        />
      </div>
      <div className="flex min-h-0 flex-1 gap-[3px]">
        {/* The rail: the project, then its rows, the open one in the
            accent's tint. */}
        <div className="flex w-[22%] shrink-0 flex-col gap-[3px] pt-[1px]">
          <span className="bg-primary size-[5px] rounded-[1.5px]" />
          <span className="bg-primary/25 h-[3px] w-full rounded-[1px]" />
          <span
            className="h-[2px] w-3/4 rounded-full"
            style={{ backgroundColor: c.line }}
          />
          <span
            className="h-[2px] w-2/3 rounded-full"
            style={{ backgroundColor: c.line }}
          />
        </div>
        {/* The page card. */}
        <div
          className="flex min-w-0 flex-1 flex-col gap-[3px] rounded-[3px] px-[4px] pt-[4px] pb-[3px]"
          style={{ backgroundColor: c.page, border: `1px solid ${c.edge}` }}
        >
          <span
            className="ml-auto h-[5px] w-1/2 rounded-[2px]"
            style={{ backgroundColor: c.bubble }}
          />
          <span
            className="h-[2px] w-4/5 rounded-full"
            style={{ backgroundColor: c.line }}
          />
          <span
            className="h-[2px] w-3/5 rounded-full"
            style={{ backgroundColor: c.line }}
          />
          <span
            className="mt-auto flex h-[7px] items-center justify-end rounded-[3px] px-[2px]"
            style={{ border: `1px solid ${c.edge}` }}
          >
            <span className="bg-primary size-[3px] rounded-full" />
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The theme as one row's control, beside the accent's swatches: three
 * miniatures of the window, System split down the middle. Onboarding keeps
 * its large previews (`ThemeChoice`); this is the same choice, smaller.
 */
export function ThemeToggle() {
  const theme = usePreferences((state) => state.theme);
  const setTheme = usePreferences((state) => state.setTheme);
  return (
    <fieldset
      aria-label="Theme"
      className="m-0 flex min-w-0 items-center gap-2.5 border-0 p-0"
    >
      {THEME_SOURCES.map((source) => {
        const chosen = theme === source;

        return (
          <button
            key={source}
            type="button"
            aria-pressed={chosen}
            aria-label={LABEL[source]}
            title={LABEL[source]}
            onClick={() => setTheme(source)}
            className={cn(
              "relative h-14 w-20 shrink-0 overflow-hidden rounded-lg outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring/50",
              chosen
                ? "ring-primary ring-2"
                : "ring-foreground/10 hover:ring-foreground/25 ring-1",
            )}
          >
            {source === "system" ? (
              // One window in two appearances: the dark half clipped from
              // a full-width dark window, so the two halves line up.
              <span className="relative block size-full">
                <Window tone="light" />
                <span className="absolute inset-y-0 right-0 block w-1/2 overflow-hidden">
                  <span className="absolute inset-y-0 right-0 block w-[200%]">
                    <Window tone="dark" />
                  </span>
                </span>
              </span>
            ) : (
              <Window tone={source} />
            )}
          </button>
        );
      })}
    </fieldset>
  );
}
