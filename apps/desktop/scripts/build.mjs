import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// A shell inherited from another app may set NODE_ENV=development. A release
// build must never inherit that choice or ship React's development runtime.
const require = createRequire(import.meta.url);
const vite = join(dirname(require.resolve("vite/package.json")), "bin/vite.js");
const result = spawnSync(process.execPath, [vite, "build"], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await import("./build-electron.mjs");
