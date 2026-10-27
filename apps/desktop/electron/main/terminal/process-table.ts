// The machine's process table, as `ps` lists it: what stopping a background
// task and the ports panel both read.
//
// NOTE: Split out of `background-tasks.ts` (FE-80, AM-13) so the ports panel
// does not load a transcript parser for a `ps` wrapper. Node only.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** `execFile`, awaited. */
const runFile = promisify(execFile);

/** One row of `ps`: enough to tell a task's process from any other. */
export interface Proc {
  pid: number;
  /** The parent's pid. */
  ppid: number;
  /** The process group's id. */
  pgid: number;
  uid: number;
  /** `lstart` as `ps` writes it: with the pid, it tells a reused pid apart. */
  start: string;
  /** The whole command line. */
  args: string;
}

/** One row of {@link processTable}'s `ps`. */
const PS_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/;

/** Every process on this machine, in one `ps`. */
export async function processTable(): Promise<Proc[]> {
  const { stdout } = await runFile(
    "ps",
    ["-axww", "-o", "pid=,ppid=,pgid=,uid=,lstart=,args="],
    { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.split("\n").flatMap((line) => {
    const match = PS_ROW.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            uid: Number(match[4]),
            start: match[5].replace(/\s+/g, " "),
            args: match[6],
          },
        ]
      : [];
  });
}

/**
 * This process's user id.
 *
 * @throws on a platform without Unix process groups.
 */
export function ownUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("Stopping tasks requires Unix process groups.");
  return uid;
}

/**
 * A command line as `ps` shows it.
 *
 * A control character, escaped or not, is `?`.
 */
export function visible(text: string): string {
  return (
    text
      .replace(/\\[0-7]{3}/g, "?")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: they are what it hides.
      .replace(/[\u0000-\u001f]/g, "?")
  );
}
