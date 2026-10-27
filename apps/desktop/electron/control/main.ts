// The bundle entry of `lanework-control` (see `cli.ts`). Run by the app's own
// Node through `~/.lanew/bin/lanework-control`.
import { runControlCli } from "./cli";

// NOTE: `exitCode`, not `process.exit()`: stdout may be a pipe, and exiting
// at once can cut the one line the lead is waiting for.
void runControlCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  },
);
