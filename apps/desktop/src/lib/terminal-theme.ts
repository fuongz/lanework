/**
 * The terminal's colours, read from the app's own tokens (FE-19/D9).
 *
 * ⚠️ Through a canvas, because xterm cannot parse `oklch()` — which is what
 * every token in `styles/app.css` is written in. A 1×1 fill read back as RGB
 * is the browser doing the conversion it already knows how to do.
 *
 * ⚠️ Two ANSI palettes, not one. xterm's defaults are made for a dark ground:
 * on this app's white page, ANSI yellow and white are unreadable. These are
 * VS Code's Dark+ and Light+ terminal palettes, which exist for that reason.
 */

export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

type Ansi = Omit<
  TerminalColors,
  | "background"
  | "foreground"
  | "cursor"
  | "cursorAccent"
  | "selectionBackground"
>;

const DARK_ANSI: Ansi = {
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

const LIGHT_ANSI: Ansi = {
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

let scratch: CanvasRenderingContext2D | null = null;

/** Any CSS colour as `#rrggbb`, or `fallback` when it cannot be read. */
export function cssColorToHex(value: string, fallback: string): string {
  if (!value) return fallback;
  if (!scratch) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    scratch = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!scratch) return fallback;
  scratch.clearRect(0, 0, 1, 1);
  // An unparseable value leaves `fillStyle` as it was; start from a known one
  // so that is detectable rather than reading back the last colour drawn.
  scratch.fillStyle = "#010203";
  scratch.fillStyle = value;
  if (scratch.fillStyle === "#010203" && value.trim() !== "#010203")
    return fallback;
  scratch.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = scratch.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** The terminal's colours for the theme the window is showing right now. */
export function readTerminalColors(
  root: HTMLElement = document.documentElement,
): TerminalColors {
  const style = getComputedStyle(root);
  const dark = root.classList.contains("dark");
  const token = (name: string, fallback: string) =>
    cssColorToHex(style.getPropertyValue(name).trim(), fallback);
  const background = token("--background", dark ? "#0a0a0a" : "#ffffff");
  const foreground = token("--foreground", dark ? "#fafafa" : "#0a0a0a");
  const accent = token("--accent-brand", "#8b7cf6");
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    // xterm takes an alpha on the selection, and needs one: an opaque fill
    // would hide the text it is selecting.
    selectionBackground: `${accent}59`,
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
  };
}

/** The app's monospace stack, with the fonts xterm can measure behind it. */
export function terminalFontFamily(
  root: HTMLElement = document.documentElement,
): string {
  const token = getComputedStyle(root).getPropertyValue("--font-mono").trim();
  return [token || "ui-monospace", "SFMono-Regular", "Menlo", "monospace"].join(
    ", ",
  );
}
