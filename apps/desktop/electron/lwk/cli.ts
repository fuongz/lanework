// The JS side of `lwk` (FE-152): `dist/electron/lwk/standalone.cjs`, run on
// the app's own Node by the native lwk (`apps/desktop/lwk/`, Rust) when it
// needs JavaScript:
//
//   lwk find|grep|sg|ls|sessions ...   the app is not up (no socket, a
//                                      refused connect, or busy): the tool
//                                      runs here, in the working folder
//                                      (`standalone.ts`)
//   lwk hook on|off|status             always (`hook.ts`)
//
// The native lwk does everything else itself: the passthrough (`lwk git
// status` exec()s git), `lwk rewrite`, help and version, and the kit's tools
// through the app's socket. It execs this script as
// `ELECTRON_RUN_AS_NODE=1 <app> standalone.cjs ARGS...`, with the same
// arguments it was given, and `LWK_SELF` set to its own path.
//
// NOTE: Electron-free; an esbuild entry of `scripts/electron-bundle.mjs`,
// unpacked from the asar by `electron-builder.yml`, so it runs from a real
// file and finds the bundled ripgrep and natives beside it.
import { runKitCommand } from "./commands";
import { runHookCommand } from "./hook";

const KIT_COMMANDS = new Set(["find", "grep", "sg", "ls", "sessions"]);

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first !== undefined && KIT_COMMANDS.has(first))
    return runKitCommand(first, rest);
  if (first === "hook") return runHookCommand(rest);
  process.stderr.write(
    `lwk: ${first ?? "(nothing)"}: not a command of the kit's script; run lwk itself. See lwk help.\n`,
  );
  return 2;
}

// NOTE: `exitCode`, not `process.exit()`: stdout may be a pipe, and exiting
// at once can cut what is still being written.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `lwk: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  },
);
