#!/usr/bin/env node
/**
 * The AGENTS.md size gate (DOC-02): every agent loads the root AGENTS.md each
 * session, plus the AGENTS.md of each area it works in, so they stay small.
 *
 * - the root AGENTS.md is at most 12,000 characters;
 * - each root → area chain (the root plus every AGENTS.md on the path down to
 *   a nested one, e.g. AGENTS.md + apps/desktop/AGENTS.md) is at most 30,000.
 *
 * History that agents only need now and then (old task ids, …) lives under
 * docs/agents/ and is linked from AGENTS.md instead.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT_LIMIT = 12_000;
const CHAIN_LIMIT = 30_000;
// Never another checkout's copy (.claude/worktrees/…) or a build output.
const SKIP = new Set(["node_modules", "dist", ".git", ".claude"]);

/** Characters, not bytes or UTF-16 units: "—" and "→" count as one. */
const size = (file) => [...readFileSync(file, "utf8")].length;

/** Every nested AGENTS.md git knows of, tracked or new (ignored files skipped). */
function* walk() {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "*AGENTS.md",
    ],
    { encoding: "utf8" },
  );
  for (const path of out.split("\n")) {
    const parts = path.split("/");
    if (parts.length < 2 || parts.at(-1) !== "AGENTS.md") continue;
    if (parts.some((part) => SKIP.has(part))) continue;
    if (existsSync(path)) yield path;
  }
}

const problems = [];
const rootSize = size("AGENTS.md");
if (rootSize > ROOT_LIMIT) {
  problems.push(
    `AGENTS.md is ${rootSize} chars — limit ${ROOT_LIMIT}. Move history or reference material to docs/agents/ and link it.`,
  );
}

const chains = [];
for (const nested of walk()) {
  // Every AGENTS.md from the root down to this one.
  const files = [];
  for (let dir = dirname(nested); dir !== "."; dir = dirname(dir)) {
    const candidate = join(dir, "AGENTS.md");
    if (existsSync(candidate)) files.unshift(candidate);
  }
  files.unshift("AGENTS.md");
  const total = files.reduce((sum, file) => sum + size(file), 0);
  const label = files.join(" + ");
  chains.push(`${label} = ${total}`);
  if (total > CHAIN_LIMIT) {
    problems.push(`${label} is ${total} chars — limit ${CHAIN_LIMIT}.`);
  }
}

if (problems.length) {
  console.error(`${problems.length} AGENTS.md file(s) over the size limit:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `agents-size OK — AGENTS.md ${rootSize}/${ROOT_LIMIT}${chains.length ? `; ${chains.join("; ")} (limit ${CHAIN_LIMIT})` : ""}`,
);
