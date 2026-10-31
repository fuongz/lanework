#!/usr/bin/env node
/**
 * The Electron bundle-boundary gate (FE-80, AM-07/AC-08). Run after
 * `bun run build`: it reads the metafile `apps/desktop/scripts/
 * electron-bundle.mjs` writes, so it sees what really went into each output,
 * not what the imports look like.
 *
 * It fails when:
 * - the main bundle requires node-pty, bundles xterm, or has inputs from the
 *   Stop hook or the offline MCP server (only `hook/redact.ts` is shared);
 * - an output run on Electron's plain Node (`ELECTRON_RUN_AS_NODE`: the hook,
 *   the statusline, the offline MCP, `lanework-control`), or the committed
 *   plugin bundle, imports `electron`;
 * - a source file in an Electron-free folder imports `electron`;
 * - a main-process file runs `git` itself instead of through `git/runner.ts`;
 * - `projects/client.ts` builds a `/v1` path by hand.
 *
 * It prints every source file that imports `electron`, by name.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const APP = "apps/desktop";
const META = join(APP, "dist/electron-meta.json");
const PLUGIN = "plugins/lanework/bin/lanework-checkpoint.cjs";

/** The main process's bundle, as the metafile names it (APP-relative). */
const MAIN = "dist/electron/main/index.cjs";
/** Outputs run by Electron's plain Node, where `require("electron")` fails. */
const NODE_OUTPUTS = [
  "dist/electron/hook/lanework-checkpoint.cjs",
  "dist/electron/statusline/claude-usage.cjs",
  "dist/electron/mcp-local/server.cjs",
  "dist/electron/control/lanework-control.cjs",
  "dist/electron/main/session-pull.cjs",
];
/** Source folders (APP-relative) that never import Electron. */
const ELECTRON_FREE = [
  "electron/hook/",
  "electron/mcp-local/",
  "electron/local-store/",
  "electron/statusline/",
  "electron/control/",
  "electron/main/sessions/",
  "electron/session-store/",
  "shared/",
];
/** The one file the main bundle may take from the hook's folder. */
const MAIN_FROM_HOOK = new Set(["electron/hook/redact.ts"]);

/**
 * Main-process files that still run `git` themselves, until the git-runner
 * card moves them onto `git/runner.ts`. Repo-relative path → why.
 */
const GIT_PENDING = {
  "apps/desktop/electron/main/orchestration/git.ts":
    "worktree git for workers (FE-89), not yet on git/runner.ts",
};
const GIT_RUNNER = "apps/desktop/electron/main/git/runner.ts";
const GIT_CALL =
  /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*["'`]git["'`]/g;

const CLIENT = "apps/desktop/electron/main/projects/client.ts";
const V1_LITERAL = /["'`][^"'`\n]*\/v1(?:\/|["'`])/;

const problems = [];
const posix = (path) => path.split(sep).join("/");

if (!existsSync(META)) {
  console.error(`${META} is missing. Run \`bun run build\` first.`);
  process.exit(1);
}
const meta = JSON.parse(readFileSync(META, "utf8"));

// The main bundle.
const main = meta.outputs[MAIN];
if (!main) problems.push(`${MAIN} is not in the metafile`);
else {
  for (const { path } of main.imports)
    if (path === "@lydell/node-pty" || path.startsWith("@lydell/node-pty/"))
      problems.push(
        `${MAIN} requires ${path}: pty belongs in the utility host only (AM-01)`,
      );
  for (const input of Object.keys(main.inputs)) {
    if (
      (input.startsWith("electron/hook/") && !MAIN_FROM_HOOK.has(input)) ||
      input.startsWith("electron/mcp-local/")
    )
      problems.push(`${MAIN} bundles ${input} (AM-02)`);
    if (/(^|\/)node_modules\/@xterm\//.test(input))
      problems.push(`${MAIN} bundles ${input}: xterm belongs in the pty host`);
  }
}

// What runs on plain Node.
for (const name of NODE_OUTPUTS) {
  const output = meta.outputs[name];
  if (!output) {
    problems.push(`${name} is not in the metafile`);
    continue;
  }
  if (output.imports.some(({ path }) => path === "electron"))
    problems.push(`${name} imports electron, and runs without it`);
}
if (/\brequire\(\s*["']electron["']\s*\)/.test(readFileSync(PLUGIN, "utf8")))
  problems.push(`${PLUGIN} requires electron, and runs on plain Node`);

// Which sources import Electron.
const electronImporters = Object.entries(meta.inputs)
  .filter(([, input]) => input.imports.some(({ path }) => path === "electron"))
  .map(([path]) => path)
  .sort();
for (const path of electronImporters)
  if (ELECTRON_FREE.some((folder) => path.startsWith(folder)))
    problems.push(`${APP}/${path} imports electron in an Electron-free folder`);

// `git`, through the runner only.
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.ts$/.test(path) && !/\.test\.ts$/.test(path)) yield path;
  }
}
for (const file of walk(join(APP, "electron/main"))) {
  const rel = posix(relative(".", file));
  if (rel === GIT_RUNNER || rel in GIT_PENDING) continue;
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(GIT_CALL)) {
    const line = text.slice(0, match.index).split("\n").length;
    problems.push(`${rel}:${line} runs git itself; use ${GIT_RUNNER}`);
  }
}

// `/v1` paths come from the protocol, not string literals.
readFileSync(CLIENT, "utf8")
  .split("\n")
  .forEach((text, at) => {
    const code = text.trim();
    if (code.startsWith("*") || code.startsWith("/*") || code.startsWith("//"))
      return;
    if (V1_LITERAL.test(code))
      problems.push(`${CLIENT}:${at + 1} builds a /v1 path by hand`);
  });

console.log(
  `electron is imported by ${electronImporters.length} source file(s):`,
);
for (const path of electronImporters) console.log(`  ${APP}/${path}`);

if (problems.length) {
  console.error(`\n${problems.length} bundle-boundary problem(s):\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  "\nelectron boundaries OK: main has no pty, xterm, hook or MCP code; the Node outputs and the plugin have no electron",
);
