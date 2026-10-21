#!/usr/bin/env node
/**
 * The loading-state gate (docs/standards/loading-states.md): a pane, list or
 * panel that is still being read draws a skeleton, never a line of text.
 *
 * Flags a `<p>` or `<div>` whose only content is a progress sentence —
 * "Reading the history…", "Loading…", "Checking…". Button and menu labels
 * ("Fetching…" on a button while it runs) are not matched: they are not
 * the element's only content in a `<p>`/`<div>`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "apps/desktop/src";
const PATTERN =
  /<(p|div)\b[^>]*>\s*(?:\{[^}]*\}\s*)?(Reading|Loading|Checking|Fetching)\b[^<]*…\s*<\/\1>/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith(".tsx")) yield path;
  }
}

const problems = [];
for (const file of walk(ROOT)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(PATTERN)) {
    const line = text.slice(0, match.index).split("\n").length;
    problems.push(
      `${relative(".", file)}:${line}  ${match[0].replace(/\s+/g, " ")}`,
    );
  }
}

if (problems.length) {
  console.error(
    `${problems.length} text-only loading state(s) — use a skeleton from shared/loading/skeletons.tsx:\n`,
  );
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log("loading OK — no text-only loading states");
