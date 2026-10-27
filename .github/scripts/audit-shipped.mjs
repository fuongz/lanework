#!/usr/bin/env node
/**
 * INF-06 (SR-02): fail CI on a critical or high advisory in a package the
 * desktop app SHIPS: Electron itself, node-pty, and whatever lands in
 * app.asar. Advisories in build and test tooling (vite, shadcn, electron-builder,
 * Playwright, …) stay in the report that `bun audit` prints, without failing.
 *
 *   bun audit --json > audit.json; node .github/scripts/audit-shipped.mjs audit.json
 *
 * "Shipped" is computed, not listed: every bare package that
 * apps/desktop/{src,shared,electron} imports (the code the bundlers put in
 * dist/, which is what app.asar holds), plus its `dependencies` and
 * `optionalDependencies`, transitively, as installed in node_modules.
 * `electron` counts as shipped but is not walked: its npm dependencies only
 * download the binary.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

const APP = "apps/desktop";
const SOURCES = ["src", "shared", "electron"].map((dir) => join(APP, dir));
const FAIL_ON = new Set(["critical", "high"]);
const NOT_WALKED = new Set(["electron"]);

const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']((?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*(?:\/[^"'\s]*)?)["']/g;
const TYPE_ONLY =
  /\b(?:import|export)\s+type\b[^;]*?\bfrom\s*["'][^"']*["']|\bdeclare\s+module\s*["'][^"']*["']/gs;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") yield* walk(path);
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) {
      if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) yield path;
    }
  }
}

function packageName(specifier) {
  if (specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The installed directory of `name` as seen from `fromDir`, like Node resolves it. */
function findPackage(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    if (dirname(dir) === dir) return null;
  }
}

const roots = new Set(["electron"]);
for (const source of SOURCES) {
  for (const file of walk(source)) {
    // Type-only imports are erased by the bundler and ship nothing.
    const code = readFileSync(file, "utf8").replace(TYPE_ONLY, "");
    for (const match of code.matchAll(IMPORT)) {
      const name = packageName(match[1]);
      if (name) roots.add(name);
    }
  }
}

const shipped = new Set();
const appDir = realpathSync(APP);
const queue = [...roots].map((name) => [appDir, name]);
const seenDirs = new Set();
while (queue.length) {
  const [fromDir, name] = queue.shift();
  const dir = findPackage(fromDir, name);
  if (!dir) {
    // A Node built-in imported without `node:` (e.g. "fs"), or an optional
    // dependency for another platform: nothing installed, nothing shipped.
    continue;
  }
  shipped.add(name);
  if (NOT_WALKED.has(name) || seenDirs.has(dir)) continue;
  seenDirs.add(dir);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  })) {
    queue.push([dir, dep]);
  }
}

const reportPath = process.argv[2];
if (!reportPath) {
  console.error(
    "usage: node .github/scripts/audit-shipped.mjs <bun-audit.json>",
  );
  process.exit(2);
}
const text = readFileSync(reportPath, "utf8").trim();
const report = text ? JSON.parse(text) : {};

const failing = [];
for (const [name, advisories] of Object.entries(report)) {
  if (!shipped.has(name)) continue;
  for (const advisory of advisories) {
    if (FAIL_ON.has(advisory.severity)) failing.push({ name, ...advisory });
  }
}

console.log(
  `${shipped.size} shipped packages (${roots.size} imported directly); ${Object.keys(report).length} packages with advisories in the whole tree.`,
);
if (failing.length) {
  console.error(
    `\n${failing.length} critical/high advisory(ies) in shipped packages:\n`,
  );
  for (const a of failing) {
    console.error(
      `  ${a.severity.padEnd(8)} ${a.name} ${a.vulnerable_versions}  ${a.title}\n           ${a.url}`,
    );
  }
  process.exit(1);
}
console.log("No critical or high advisories in shipped packages.");
