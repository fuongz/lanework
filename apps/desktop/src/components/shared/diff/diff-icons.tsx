import {
  createFileTreeIconResolver,
  type FileTreeIconConfig,
  getBuiltInSpriteSheet,
} from "@pierre/trees";
import type { CSSProperties } from "react";

// One file-type icon, drawn the same way in the tree and in the diff.
//
// `@pierre/trees` owns this iconography even though half its callers here are
// not a tree. The library resolves a path to an icon (`package.json` to a
// braces glyph, `bun.lock` to bun's), and that table is worth far more than
// the one-shape-fits-all glyph `@pierre/diffs` draws in a header. Resolving it
// twice, from two tables, is how `package.json` ends up as braces in the tree
// and a blank page in the header directly above it.

/**
 * Which built-in set.
 *
 * `complete`, not `standard`. It is the difference between `bun.lock`,
 * `pnpm-lock.yaml` and `app.tsx` reading as bun, YAML and React, and all three
 * reading as the same grey default; on a review screen the file list is what
 * somebody scans first. It costs ~38KB of SVG against `standard`'s 17KB, paid
 * once, in a desktop app that already ships a syntax highlighter.
 */
const ICON_SET = "complete";

/** The tree's icon options, same set, so the two surfaces cannot disagree. */
export const FILE_TREE_ICONS: FileTreeIconConfig = {
  set: ICON_SET,
  colored: true,
};

const resolver = createFileTreeIconResolver(FILE_TREE_ICONS);

/**
 * The library's file-type token for each of its thirteen hues.
 *
 * NOTE: Mirrored from the library's own stylesheet, where each token resolves
 * to `var(--trees-icon-<hue>)`. It is restated because the sprite is also used
 * OUTSIDE the tree's shadow root, in each diff's file header, and the rules
 * that colour it live only inside that root.
 *
 * A token missing here (`font`, `nextjs` and `stylelint` have no colour in
 * the library either, and a future release may add more) falls through to the
 * muted foreground, which is what an uncoloured icon should look like.
 */
const TOKEN_HUE: Record<string, string> = {
  astro: "purple",
  babel: "yellow",
  bash: "green",
  biome: "blue",
  bootstrap: "indigo",
  browserslist: "yellow",
  bun: "mauve",
  c: "blue",
  claude: "orange",
  cpp: "blue",
  css: "indigo",
  database: "purple",
  default: "gray",
  docker: "blue",
  eslint: "indigo",
  git: "vermilion",
  go: "cyan",
  graphql: "pink",
  html: "orange",
  image: "pink",
  javascript: "yellow",
  json: "orange",
  markdown: "green",
  mcp: "teal",
  npm: "red",
  oxc: "cyan",
  postcss: "red",
  prettier: "teal",
  python: "blue",
  react: "cyan",
  ruby: "red",
  rust: "orange",
  sass: "pink",
  svelte: "red",
  svg: "orange",
  svgo: "green",
  swift: "orange",
  table: "teal",
  tailwind: "cyan",
  terraform: "indigo",
  text: "gray",
  typescript: "blue",
  vite: "purple",
  vscode: "blue",
  vue: "green",
  wasm: "indigo",
  webpack: "blue",
  yml: "red",
  zig: "orange",
  zip: "orange",
};

const HUES = [
  "gray",
  "red",
  "vermilion",
  "orange",
  "yellow",
  "green",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "purple",
  "pink",
  "mauve",
] as const;

/**
 * The app's icon palette, handed to the tree as the library's hue variables.
 *
 * NOTE: Set on the HOST element, where an inline style beats the `:host` rule
 * that declares them and custom properties still inherit through the shadow
 * boundary. This keeps the tree and the diff headers the same colour, and is
 * what gets the tree a dark theme at all: the library's defaults are
 * `light-dark()`, which reads `color-scheme`, and `color-scheme` cannot follow
 * a `.dark` class (see `use-theme.ts`).
 */
export const TREE_ICON_TONES: CSSProperties = Object.fromEntries(
  HUES.map((hue) => [`--trees-icon-${hue}`, `var(--file-icon-${hue})`]),
);

/**
 * Give the tree's icons their file type back on a row that has a git status.
 *
 * Handed to the tree as `unsafeCSS`, which the library puts in a CSS layer
 * that outranks its own. Its stylesheet paints EVERYTHING on a row with a git
 * status (the name, the M/A/D letter and the icon) in that status's colour,
 * and a tree where every file is changed has no file types left in it. The
 * name and the letter keep the status colour; only the icon is taken back,
 * which is the split every editor makes.
 *
 * Generated from {@link TOKEN_HUE}, so a hue that moves there moves here.
 */
export const TREE_ICON_TINT_CSS = Object.entries(TOKEN_HUE)
  .map(
    ([token, hue]) =>
      `[data-item-git-status] > [data-item-section="icon"] > [data-icon-token="${token}"]{color:var(--file-icon-${hue})}`,
  )
  .join("\n");

/**
 * The sprite, installed into the document once.
 *
 * NOTE: Into the LIGHT DOM, because `<use href="#id">` only resolves within
 * its own root and these icons are rendered beside app markup. The tree
 * injects its own copy into its shadow root; the two do not share, and must
 * not: a `<use>` cannot reach across the boundary in either direction.
 *
 * NOTE: The sheet's one non-namespaced id is renamed on the way in. The
 * `nextjs` glyph carries `<linearGradient id="a">`, harmless inside a shadow
 * root and a collision waiting to happen in a document.
 */
const SPRITE_ID = "pierre-file-icon-sprite";

function installSprite(): void {
  // The server build evaluates this module while prerendering; there is no
  // document to install into, and the client installs it before first paint.
  if (typeof document === "undefined") return;
  if (document.getElementById(SPRITE_ID) !== null) return;
  const host = document.createElement("div");
  host.id = SPRITE_ID;
  host.hidden = true;
  host.innerHTML = getBuiltInSpriteSheet(ICON_SET)
    .replace('id="a"', 'id="pierre-file-icon-gradient-a"')
    .replace("url(#a)", "url(#pierre-file-icon-gradient-a)");
  (document.body ?? document.documentElement).append(host);
}

installSprite();

/**
 * The file type the icon set gives `path`: `react`, `json`, `docker`, …
 *
 * `default` / `text` when it only knows the generic glyph.
 */
export function fileIconToken(path: string): string | undefined {
  return resolver.resolveIcon("file-tree-icon-file", path).token;
}

/**
 * The icon for one path.
 *
 * `aria-hidden`, always. It says the same thing as the filename beside it,
 * which is never optional, and an icon that announced "JSON file" would make
 * every row of a file list read twice.
 */
export function FileTypeIcon({
  path,
  className,
  inherit,
}: {
  path: string;
  className?: string;
  /** Drawn in the text's colour, not the file type's: a composer chip. */
  inherit?: boolean;
}) {
  const icon = resolver.resolveIcon("file-tree-icon-file", path);
  const hue = icon.token === undefined ? undefined : TOKEN_HUE[icon.token];
  return (
    <svg
      viewBox={icon.viewBox ?? "0 0 16 16"}
      className={className}
      style={{
        color: inherit
          ? "currentColor"
          : hue === undefined
            ? "var(--color-muted-foreground)"
            : `var(--file-icon-${hue})`,
      }}
      aria-hidden="true"
    >
      <use href={`#${icon.name}`} />
    </svg>
  );
}
