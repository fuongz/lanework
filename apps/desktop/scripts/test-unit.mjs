#!/usr/bin/env node
// Run each colocated `*.test.ts` under electron/ in its own `bun test`.
// Bun's node:test shim cannot hold two files' top-level describe() blocks
// in one process ("describe() inside another test()"), so one process per
// file keeps every suite independent.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");

function* tests(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* tests(path);
    else if (entry.name.endsWith(".test.ts")) yield path;
  }
}

const failed = [];
for (const file of [...tests(join(root, "electron"))].sort()) {
  const name = `./${relative(root, file)}`;
  const run = spawnSync("bun", ["test", name], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) failed.push(name);
}
if (failed.length) {
  console.error(`\nFailed: ${failed.join(", ")}`);
  process.exit(1);
}
