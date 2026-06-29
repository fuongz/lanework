#!/usr/bin/env node
// lanework plugin MCP launcher.
//
// Prefers the in-repo local build (so `claude --plugin-dir ./plugin` and a freshly
// cloned repo work with the latest code) and falls back to the published npm
// package for end users who installed only the plugin. It is a pure stdio
// pass-through (`stdio: "inherit"`), so the JSON-RPC channel stays clean — this
// process writes nothing to stdout.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const passthru = process.argv.slice(2); // e.g. ["--no-dashboard"]
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const localCli = fileURLToPath(new URL("../../apps/local/cli.mjs", import.meta.url));
const localLib = fileURLToPath(new URL("../../apps/local/dist-local/reviews-lib.mjs", import.meta.url));
const useLocal = existsSync(localCli) && existsSync(localLib);

const [cmd, args] = useLocal
  ? [process.execPath, [localCli, "mcp", projectDir, ...passthru]]
  : ["npx", ["-y", "@phake/lanework", "mcp", projectDir, ...passthru]];

console.error(`[lanework] starting MCP via ${useLocal ? "local build" : "npx @phake/lanework"} for ${projectDir}`);

const child = spawn(cmd, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (e) => {
  console.error("[lanework] launcher failed:", e.message);
  process.exit(1);
});
