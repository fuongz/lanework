// Regenerates the Preview build's icon from the release icon (docs/agents/
// versioning.md, "Preview builds"): build/icon.png -> build/icon-preview.png
// and build/icon-preview.icns. Run it after build/icon.png changes:
//
//   node scripts/make-preview-icon.mjs
//
// The mark is an amber band across the bottom of the icon artwork with
// "PREVIEW" in bold white, clipped to the artwork's own shape. Needs macOS
// tools: ImageMagick (`magick`), `sips` and `iconutil`.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const build = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
const source = join(build, "icon.png");
const png = join(build, "icon-preview.png");
const icns = join(build, "icon-preview.icns");

const AMBER = "#F59E0B";
const RULE = "#B45309";
const FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";
const SIZE = 1024;

const run = (cmd, args) =>
  execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

// The artwork sits inside transparent padding: find its box ("WxH+X+Y").
const box = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(
  out("magick", [
    source,
    "-alpha",
    "extract",
    "-threshold",
    "50%",
    "-format",
    "%@",
    "info:",
  ]),
);
if (!box) throw new Error("could not measure the artwork in icon.png");
const [width, height, left, top] = box.slice(1).map(Number);

// Bottom third of the artwork.
const bandHeight = Math.round(height * 0.32);
const bandTop = top + height - bandHeight;
const textWidth = Math.round(width * 0.78);

// Layers: the artwork, then an amber band and the text, both clipped to the
// artwork's own alpha so the rounded corners stay clean. Built in a temporary
// folder, step by step.
const work = mkdtempSync(join(tmpdir(), "lanework-preview-icon-"));
try {
  const band = join(work, "band.png");
  const text = join(work, "text.png");
  const mask = join(work, "mask.png");
  const textHeight = Math.round(bandHeight * 0.5);

  run("magick", [source, "-alpha", "extract", mask]);
  // The band, full canvas, transparent outside it, with a thin darker rule
  // on its top edge to set it off from the (also orange) artwork.
  run("magick", [
    "-size",
    `${SIZE}x${SIZE}`,
    "xc:none",
    "-fill",
    AMBER,
    "-draw",
    `rectangle ${left},${bandTop} ${left + width},${top + height}`,
    "-fill",
    RULE,
    "-draw",
    `rectangle ${left},${bandTop} ${left + width},${bandTop + 8}`,
    "(",
    mask,
    "-alpha",
    "off",
    ")",
    "-compose",
    "DstIn",
    "-composite",
    band,
  ]);
  // The text, trimmed and fitted to the band.
  run("magick", [
    "-background",
    "none",
    "-font",
    FONT,
    "-fill",
    "white",
    "-pointsize",
    "400",
    `label:PREVIEW`,
    "-trim",
    "+repage",
    "-resize",
    `${textWidth}x${textHeight}`,
    text,
  ]);
  const textBox = out("magick", [text, "-format", "%w %h", "info:"])
    .split(" ")
    .map(Number);
  const x = left + Math.round((width - textBox[0]) / 2);
  const y = bandTop + Math.round((bandHeight - textBox[1]) / 2) + 4;
  run("magick", [
    source,
    band,
    "-compose",
    "over",
    "-composite",
    text,
    "-geometry",
    `+${x}+${y}`,
    "-composite",
    png,
  ]);
  // .icns: a temporary .iconset with the standard sizes, @1x and @2x.
  const iconset = join(work, "icon-preview.iconset");
  mkdirSync(iconset);
  for (const s of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const name = `icon_${s}x${s}${scale === 2 ? "@2x" : ""}.png`;
      run("sips", [
        "-z",
        s * scale,
        s * scale,
        png,
        "--out",
        join(iconset, name),
      ]);
    }
  }
  run("iconutil", ["-c", "icns", iconset, "-o", icns]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Wrote ${png} and ${icns}`);
