#!/usr/bin/env node
/**
 * The HTML-sink gate (INF-06, SI-01): renderer code never writes markup
 * through `innerHTML`, `outerHTML` or `insertAdjacentHTML`. The renderer draws
 * hostile content (agent transcripts, PR and issue bodies, link-preview
 * titles, terminal output), and its preload bridge can run commands, so an
 * XSS there is code execution as the user.
 *
 * `dangerouslySetInnerHTML` is not matched here: Biome's recommended
 * `security/noDangerouslySetInnerHtml` already fails lint on it.
 *
 * A use that is genuinely safe (a constant built into the bundle, never
 * user or remote content) goes in ALLOWED with the reason, file by file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = "apps/desktop/src";
const PATTERN = /\.(innerHTML|outerHTML)\b|\binsertAdjacentHTML\b/g;

/** Repo-relative path → why it may use a sink. */
const ALLOWED = {
  // @pierre/diffs' built-in icon sprite: a constant string from the package,
  // injected once into a hidden host element.
  "apps/desktop/src/components/shared/diff/diff-icons.tsx":
    "built-in diff icon sprite",
};

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(path)) yield path;
  }
}

const problems = [];
for (const file of walk(ROOT)) {
  const rel = relative(".", file).split(sep).join("/");
  if (rel in ALLOWED) continue;
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(PATTERN)) {
    const line = text.slice(0, match.index).split("\n").length;
    problems.push(`${rel}:${line}  ${match[0]}`);
  }
}

if (problems.length) {
  console.error(
    `${problems.length} HTML sink(s) in renderer code — build DOM nodes or JSX instead, or add the file to ALLOWED in scripts/audit-sinks.mjs with the reason:\n`,
  );
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log("sinks OK — no innerHTML/outerHTML/insertAdjacentHTML in renderer");
