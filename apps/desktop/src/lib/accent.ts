// The accent colour picked in Settings → Appearance (FE-143), and how a pick
// reaches the page.
//
// One colour drives the brand's three tokens in `styles/app.css`:
// `--primary` (filled buttons, switches, checkboxes), `--accent-brand` (focus
// rings, drop lines, links) and `--selection` (selected text). Its hue and
// chroma are kept; its lightness is moved only as far as legibility needs.
// Null keeps the stylesheet's own values, #bb4d00, untouched.

/** A preset in the picker: its name and its colour as `#rrggbb`. */
export interface AccentPreset {
  name: string;
  /** Null for Lanework's own orange: the stylesheet's values, no override. */
  value: string | null;
  /** What the swatch shows. */
  swatch: string;
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { name: "Lanework orange", value: null, swatch: "#bb4d00" },
  { name: "Blue", value: "#2563eb", swatch: "#2563eb" },
  { name: "Indigo", value: "#4f46e5", swatch: "#4f46e5" },
  { name: "Violet", value: "#7c3aed", swatch: "#7c3aed" },
  { name: "Pink", value: "#db2777", swatch: "#db2777" },
  { name: "Red", value: "#dc2626", swatch: "#dc2626" },
  { name: "Green", value: "#16a34a", swatch: "#16a34a" },
  { name: "Teal", value: "#0d9488", swatch: "#0d9488" },
  { name: "Graphite", value: "#52525b", swatch: "#52525b" },
];

/**
 * A saved accent, or null (the default) for anything that is not one of the
 * presets: the picker offers no free colour, so a stray value is not kept.
 */
export function readAccent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.toLowerCase();
  return ACCENT_PRESETS.some((preset) => preset.value === hex) ? hex : null;
}

type Rgb = [number, number, number];
interface Lch {
  l: number;
  c: number;
  h: number;
}

const toLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

function hexToLinear(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    toLinear(v / 255),
  ) as Rgb;
}

function linearToOklch([r, g, b]: Rgb): Lch {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

function oklchToLinear({ l, c, h }: Lch): Rgb {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const B = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** The same lightness and hue, its chroma cut until sRGB can show it. */
function fit(color: Lch): Lch {
  if (inGamut(oklchToLinear(color))) return color;
  let low = 0;
  let high = color.c;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    if (inGamut(oklchToLinear({ ...color, c: mid }))) low = mid;
    else high = mid;
  }
  return { ...color, c: low };
}

/** WCAG relative luminance, from linear sRGB. */
function luminance(color: Lch): number {
  const [r, g, b] = oklchToLinear(fit(color)).map((v) =>
    Math.min(1, Math.max(0, v)),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** `--foreground`'s near-white and near-black, as luminance. */
const WHITE = luminance({ l: 0.985, c: 0, h: 0 });
const INK = luminance({ l: 0.145, c: 0, h: 0 });
/** WCAG AA for text. */
const AA = 4.5;

/**
 * The lightness nearest `color`'s own at which it holds AA against `against`,
 * searching down (darker) or up (lighter).
 */
function settle(color: Lch, against: number, down: boolean): Lch {
  const ok = (l: number) => contrast(luminance({ ...color, l }), against) >= AA;
  if (ok(color.l)) return color;
  let bad = color.l;
  let good = down ? 0 : 1;
  for (let i = 0; i < 24; i++) {
    const mid = (bad + good) / 2;
    if (ok(mid)) good = mid;
    else bad = mid;
  }
  return { ...color, l: good };
}

const css = ({ l, c, h }: Lch, alpha?: number) =>
  `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)}${alpha === undefined ? "" : ` / ${alpha}`})`;

/**
 * The stylesheet that puts `hex` in place of the brand, for both themes.
 *
 * The primary keeps white text at AA by darkening; a colour already too light
 * for that (a yellow, a mint) takes the dark ink instead, and is lightened as
 * far as the ink needs. Hairlines (links, focus) hold AA on the page in light
 * mode and use a lifted shade in dark mode, as the stylesheet does for
 * #bb4d00, whose values this reproduces.
 */
export function accentStylesheet(hex: string): string {
  const picked = fit(linearToOklch(hexToLinear(hex)));
  const light = picked.l >= 0.78;
  // Never lighter than 0.9: a white button on a white page is no button.
  const primary = fit(
    settle(
      { ...picked, l: Math.min(picked.l, 0.9) },
      light ? INK : WHITE,
      !light,
    ),
  );
  const onPrimary = light ? "oklch(0.145 0 0)" : "oklch(0.985 0 0)";
  // A link or focus ring is a hairline on the page: light mode darkens a
  // light pick until it reads on white; dark mode lifts it off the ground.
  const hairline = fit(settle(primary, WHITE, true));
  const lifted = fit({
    l: Math.max(primary.l, 0.72),
    c: Math.min(primary.c, 0.15),
    h: primary.h,
  });
  const tint = fit({
    l: 0.93,
    c: Math.min(primary.c * 0.35, 0.055),
    h: primary.h,
  });
  const dusk = fit({ ...primary, l: Math.max(primary.l, 0.45) });
  // The ground and the surfaces carry the hue faintly, scaled by how vivid
  // the pick is: a grey pick leaves them grey. Lightness as the stylesheet's.
  const k = Math.min(1, primary.c / 0.158);
  const tone = (l: number, c: number) =>
    css(fit({ l, c: c * k, h: primary.h }));
  return [
    ":root {",
    `  --primary: ${css(primary)};`,
    `  --primary-foreground: ${onPrimary};`,
    `  --accent-brand: ${css(hairline)};`,
    "  --accent-brand-foreground: oklch(0.985 0 0);",
    `  --selection: ${css(tint)};`,
    `  --sidebar: ${tone(0.975, 0.006)};`,
    `  --sidebar-accent: ${tone(0.948, 0.009)};`,
    `  --sidebar-border: ${tone(0.93, 0.007)};`,
    `  --panel-rule: ${tone(0.93, 0.007)};`,
    "}",
    ".dark {",
    `  --primary: ${css(primary)};`,
    `  --primary-foreground: ${onPrimary};`,
    `  --accent-brand: ${css(lifted)};`,
    "  --accent-brand-foreground: oklch(0.145 0 0);",
    `  --selection: ${css(dusk, 0.38)};`,
    `  --sidebar: ${tone(0.148, 0.009)};`,
    `  --background: ${tone(0.168, 0.009)};`,
    `  --card: ${tone(0.205, 0.008)};`,
    `  --popover: ${tone(0.205, 0.008)};`,
    `  --secondary: ${tone(0.269, 0.008)};`,
    `  --muted: ${tone(0.269, 0.008)};`,
    `  --accent: ${tone(0.269, 0.008)};`,
    `  --sidebar-accent: ${tone(0.269, 0.008)};`,
    `  --panel-rule: ${tone(0.235, 0.008)};`,
    `  --panel-edge: ${tone(0.2, 0.009)};`,
    "}",
  ].join("\n");
}

const STYLE_ID = "lanework-accent";

/**
 * Puts the picked accent on the page, or takes it off for the default.
 *
 * NOTE: A `<style>` after the app's stylesheet, not inline properties on
 * `<html>`: light and dark need different values, and an inline property
 * would beat `.dark`'s.
 */
export function applyAccent(hex: string | null, doc: Document = document) {
  const existing = doc.getElementById(STYLE_ID);
  if (!hex) {
    existing?.remove();
    return;
  }
  const style = existing ?? doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = accentStylesheet(hex);
  // Last in <head>, so it follows the app's stylesheet at equal specificity.
  doc.head.appendChild(style);
}
