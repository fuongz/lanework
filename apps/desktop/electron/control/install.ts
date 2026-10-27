// Installs `lanework-control` (FE-87) at `~/.lanew/bin/lanework-control`: a
// shell script that runs the bundled CLI on this app's own Node, the same way
// the checkpoint hook's and the offline MCP server's shims do. The lead's
// prompt names this path; its environment carries the endpoint and token.
//
// NOTE: Rewritten on every launch. The app's binary and the bundle move with
// every update or move of the app; the shim's own path never does.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { shellQuote } from "../main/handoff/claude-settings";
import { appHomeDir } from "../main/paths";
import { CONTROL_SELF_ENV } from "./cli";

/** `~/.lanew/bin/lanework-control` — what the lead agent runs. */
export function controlCliPath(): string {
  return join(appHomeDir(), "bin", "lanework-control");
}

/**
 * The bundled CLI, `dist/electron/control/lanework-control.cjs`.
 *
 * Outside the asar archive, like the hook: a plain Node
 * (`ELECTRON_RUN_AS_NODE`) cannot read a path inside `app.asar`.
 *
 * @param mainDir The main bundle's folder, `dist/electron/main`.
 */
export function controlBundlePath(mainDir: string = __dirname): string {
  return join(mainDir, "..", "control", "lanework-control.cjs").replace(
    `app.asar${sep}`,
    `app.asar.unpacked${sep}`,
  );
}

/** The shim's text. */
export function buildControlShim(options: {
  execPath: string;
  bundlePath: string;
  shimPath: string;
}): string {
  return [
    "#!/bin/sh",
    "# Lanework's orchestration control CLI (FE-87). The Lanework app rewrites",
    "# this file on every launch; edits here are lost.",
    "export ELECTRON_RUN_AS_NODE=1",
    `export ${CONTROL_SELF_ENV}=${shellQuote(options.shimPath)}`,
    `exec ${shellQuote(options.execPath)} ${shellQuote(options.bundlePath)} "$@"`,
    "",
  ].join("\n");
}

/**
 * Write the shim for this build of the app and return its path.
 *
 * Cheap, so every launch does it.
 */
export async function installControlCli(
  execPath: string = process.execPath,
): Promise<string> {
  const path = controlCliPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    buildControlShim({
      execPath,
      bundlePath: controlBundlePath(),
      shimPath: path,
    }),
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
  return path;
}
