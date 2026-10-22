// The fonts Settings → Appearance picks from, and how a pick reaches the page.
//
// The list comes from `queryLocalFonts()`, Chromium's own enumeration of what
// this Mac has installed. Main grants its `local-fonts` permission and nothing
// else about it: no IPC, no file walking.
import type {
  FontChoice,
  FontPreferences,
  FontRole,
} from "#/stores/preferences";

/** One style a family offers, as the picker lists it. */
export interface FontStyle {
  style: string;
  weight: number;
}

/** Installed families, sorted, each with its upright styles lightest first. */
export type FontCatalog = Array<{ family: string; styles: FontStyle[] }>;

interface LocalFontData {
  family: string;
  style: string;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}

/**
 * CSS weights by the words style names use. Longest first, so "ExtraBold"
 * is not read as "Bold".
 */
const WEIGHT_WORDS: Array<[RegExp, number]> = [
  [/(extra|ultra)\s*light/i, 200],
  [/(extra|ultra)\s*bold/i, 800],
  [/(semi|demi)\s*bold/i, 600],
  [/hairline|thin/i, 100],
  [/light/i, 300],
  [/medium/i, 500],
  [/bold/i, 700],
  [/heavy|black/i, 900],
];

/** The weight a style name stands for; anything unrecognised is 400. */
function weightOf(style: string): number {
  for (const [pattern, weight] of WEIGHT_WORDS)
    if (pattern.test(style)) return weight;
  return 400;
}

/**
 * Groups what the system reports into families.
 *
 * Italics are left out: a picker choosing the face the whole UI is set in has
 * no use for one. Two styles landing on the same weight keep the first — a
 * family with both "Regular" and "Book" shows one 400.
 */
function groupFonts(fonts: LocalFontData[]): FontCatalog {
  const families = new Map<string, Map<number, string>>();
  for (const { family, style } of fonts) {
    // Dot-prefixed families are macOS's private system faces (".SF NS…");
    // they are not addressable by name from CSS.
    if (!family || family.startsWith(".")) continue;
    if (/italic|oblique/i.test(style)) continue;
    const styles = families.get(family) ?? new Map<number, string>();
    const weight = weightOf(style);
    if (!styles.has(weight)) styles.set(weight, style);
    families.set(family, styles);
  }
  return [...families]
    .filter(([, styles]) => styles.size > 0)
    .map(([family, styles]) => ({
      family,
      styles: [...styles]
        .sort(([a], [b]) => a - b)
        .map(([weight, style]) => ({ style, weight })),
    }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

let catalog: Promise<FontCatalog> | null = null;

/**
 * The installed fonts, read once per window.
 *
 * A failure is not cached: the next picker to open asks again, since the
 * reason may have been a missing user gesture rather than a refusal.
 */
export function loadFontCatalog(): Promise<FontCatalog> {
  if (!window.queryLocalFonts)
    return Promise.reject(new Error("This build cannot list fonts"));
  catalog ??= window.queryLocalFonts().then(groupFonts);
  catalog.catch(() => {
    catalog = null;
  });
  return catalog;
}

/** The app's own stacks, which a picked family goes in front of. */
const DEFAULT_STACK: Record<"ui" | "code", string> = {
  ui: '"Inter Variable", sans-serif',
  code: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

function quote(family: string): string {
  return `"${family.replace(/["\\]/g, "\\$&")}"`;
}

/** The `font-family` value for a pick, with the app's stack behind it. */
export function fontStack(role: "ui" | "code", choice: FontChoice | null) {
  return choice
    ? `${quote(choice.family)}, ${DEFAULT_STACK[role]}`
    : DEFAULT_STACK[role];
}

/** The custom properties `styles/app.css` reads, one pair per role. */
const PROPERTIES: Record<FontRole, [family: string, weight: string]> = {
  ui: ["--ui-font", "--ui-font-weight"],
  content: ["--content-font", "--content-font-weight"],
  code: ["--code-font", "--code-font-weight"],
};

/**
 * Writes the picks onto `<html>`.
 *
 * A role left at its default REMOVES its properties, so the stylesheet's own
 * values — content following UI — apply.
 */
export function applyFonts(
  fonts: FontPreferences,
  root: HTMLElement = document.documentElement,
): void {
  const set = (role: FontRole, family: string | null, weight: number) => {
    const [familyProperty, weightProperty] = PROPERTIES[role];
    if (family === null) {
      root.style.removeProperty(familyProperty);
      root.style.removeProperty(weightProperty);
      return;
    }
    root.style.setProperty(familyProperty, family);
    root.style.setProperty(weightProperty, String(weight));
  };
  set("ui", fonts.ui && fontStack("ui", fonts.ui), fonts.ui?.weight ?? 400);
  set(
    "content",
    fonts.content && `${quote(fonts.content.family)}, var(--ui-font)`,
    fonts.content?.weight ?? 400,
  );
  set(
    "code",
    fonts.code && fontStack("code", fonts.code),
    fonts.code?.weight ?? 400,
  );
}
