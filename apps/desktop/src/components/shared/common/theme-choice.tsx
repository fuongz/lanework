import { cn } from "#/lib/utils";
import { usePreferences } from "#/stores/preferences";
import { THEME_SOURCES, type ThemeSource } from "../../../../shared/desktop";

const THEME_LABEL: Record<ThemeSource, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * Colours for the miniatures, hard-coded rather than taken from tokens.
 *
 * NOTE: The Light card has to look light while the app is dark, and the other
 * way round. Reading `--background` here would paint all three the same and
 * leave the choice illustrated by nothing.
 */
const TONE = {
  light: {
    page: "#f4f4f5",
    panel: "#ffffff",
    edge: "#e4e4e7",
    bar: "#d4d4d8",
    barSoft: "#e6e6e9",
  },
  dark: {
    page: "#2b2b2e",
    panel: "#18181a",
    edge: "#3a3a3e",
    bar: "#4d4d52",
    barSoft: "#3a3a3e",
  },
} as const;

/** A mock of the app at this tone: a header, then a panel of rows. */
function Preview({ tone }: { tone: keyof typeof TONE }) {
  const c = TONE[tone];
  return (
    <div
      className="flex h-full w-full flex-col gap-1.5 p-3"
      style={{ backgroundColor: c.page }}
    >
      <div
        className="h-1.5 w-1/2 rounded-full"
        style={{ backgroundColor: c.bar }}
      />
      <div
        className="h-1.5 w-2/3 rounded-full"
        style={{ backgroundColor: c.barSoft }}
      />
      <div
        // `rounded-xs` (2px) is concentric with the card: the wrapper insets
        // this panel by 12px inside a 14px radius, so 14 - 12 = 2. It is also
        // the app's own `rounded-xl` card at this scale.
        className="mt-1.5 flex flex-1 flex-col gap-2 rounded-xs p-2.5"
        style={{ backgroundColor: c.panel, border: `1px solid ${c.edge}` }}
      >
        <div
          className="h-1.5 w-2/5 rounded-full"
          style={{ backgroundColor: c.bar }}
        />
        <div
          className="h-1.5 w-3/5 rounded-full"
          style={{ backgroundColor: c.barSoft }}
        />
        <div
          className="h-1.5 w-1/2 rounded-full"
          style={{ backgroundColor: c.bar }}
        />
      </div>
    </div>
  );
}

/**
 * The "System" card: one window, split down the middle.
 *
 * The dark half is a full-width preview clipped to the right, not a second
 * half-width preview, so the bars line up across the seam and it reads as one
 * window in two appearances rather than two little windows.
 */
function SystemPreview() {
  return (
    <div className="relative h-full w-full">
      <Preview tone="light" />
      <div className="absolute inset-y-0 right-0 w-1/2 overflow-hidden">
        <div className="absolute inset-y-0 right-0 w-[200%]">
          <Preview tone="dark" />
        </div>
      </div>
    </div>
  );
}

/**
 * The illustrated picker for the app's appearance.
 *
 * Shared rather than owned by Settings: onboarding asks the same question on
 * its second step, and two drawings of the same choices would drift apart.
 *
 * @param name keeps two radio groups apart if they ever mount together.
 */
export function ThemeChoice({ name = "theme" }: { name?: string }) {
  const theme = usePreferences((state) => state.theme);
  const setTheme = usePreferences((state) => state.setTheme);

  return (
    // A radiogroup, not buttons in a toolbar: this is one choice out of
    // three, and arrow-key navigation is what a reader expects of it.
    <div
      role="radiogroup"
      aria-label="Theme"
      // NOTE: `w-full`. Settings gives this a full-width block parent, but
      // onboarding centres it in a flex column, where a grid of `aspect-4/3`
      // boxes has no intrinsic width and collapses to about a third of the
      // room, clipping all three previews.
      className="grid w-full grid-cols-3 gap-4"
    >
      {THEME_SOURCES.map((source) => {
        const selected = theme === source;
        return (
          // A real radio, not a button with `role="radio"`: it brings
          // arrow-key navigation and checked state for free. It is stretched
          // over the whole card and transparent, so the card is the hit area
          // and the input is still a first-class control.
          <label
            key={source}
            className="relative flex cursor-pointer flex-col gap-2"
          >
            <input
              type="radio"
              name={name}
              value={source}
              checked={selected}
              onChange={() => setTheme(source)}
              className="peer absolute inset-0 z-10 m-0 cursor-pointer appearance-none opacity-0"
            />
            <div
              className={cn(
                "aspect-4/3 overflow-hidden rounded-xl",
                "transition-[box-shadow,scale] duration-150 ease-out peer-active:scale-[0.96]",
                // Focus as an outline, not a ring. `ring` already shows the
                // selected state, and a focus ring on the same property
                // outranks it, hiding which card is chosen while arrowing.
                "peer-focus-visible:outline-ring peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2",
                selected
                  ? "ring-foreground ring-2"
                  : // NOTE: `peer-hover:`, never a bare `hover:`. The radio
                    // is a sibling stretched over this card, so it is the
                    // hit target and `:hover` never matches here.
                    "ring-border peer-hover:ring-foreground/25 ring-1",
              )}
            >
              {source === "system" ? (
                <SystemPreview />
              ) : (
                <Preview tone={source} />
              )}
            </div>
            <span
              className={cn(
                "text-center text-sm",
                selected
                  ? "text-foreground font-medium"
                  : "text-muted-foreground",
              )}
            >
              {THEME_LABEL[source]}
            </span>
          </label>
        );
      })}
    </div>
  );
}
