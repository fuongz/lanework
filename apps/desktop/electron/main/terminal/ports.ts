// The TCP ports a project's processes listen on: the dev servers an agent, or
// anyone, left running in it. Like PortKiller, but per project.
//
// Nothing here imports Electron: main calls it with the project's folders and
// its terminals' pids, both resolved in main, never sent by the renderer.
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import type { ListeningPort } from "../../../shared/terminal";
import { ownUid, type Proc, processTable, visible } from "./process-table";

const runFile = promisify(execFile);

/** How long a stopped process has to exit before it is killed. */
const GRACE_MS = 2000;
/** How much of a command line a row carries. */
const COMMAND_MAX = 300;

/**
 * Processes a stop never climbs past: whatever runs them is a shell or an
 * agent someone is still using, not part of the server.
 */
const BOUNDARY = new Set([
  "bash",
  "zsh",
  "sh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
  "claude",
  "codex",
  "opencode",
  "login",
  "tmux",
  "screen",
]);

/** What `lsof` printed, also when it exits 1 because it found nothing. */
async function lsof(args: string[]): Promise<string> {
  try {
    return (await runFile("lsof", args, { maxBuffer: 16 * 1024 * 1024 }))
      .stdout;
  } catch (error) {
    const out = (error as { stdout?: unknown }).stdout;
    if ((error as { code?: unknown }).code === 1 && typeof out === "string")
      return out;
    throw error;
  }
}

interface Listener {
  pid: number;
  name: string;
  port: number;
  address: string;
}

/** `*:5173`, `127.0.0.1:3000`, `[::1]:8787` → address and port. */
function splitAddress(text: string): { address: string; port: number } | null {
  const at = text.lastIndexOf(":");
  const port = Number(text.slice(at + 1));
  if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535)
    return null;
  return { address: text.slice(0, at), port };
}

/** This user's TCP listeners, one per pid, port and address. */
async function listeners(uid: number): Promise<Listener[]> {
  const out = await lsof([
    "-nP",
    "-a",
    "-u",
    String(uid),
    "-iTCP",
    "-sTCP:LISTEN",
    "-F",
    "pcn",
  ]);
  const found: Listener[] = [];
  let pid = 0;
  let name = "";
  for (const line of out.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) pid = Number(value);
    else if (line.startsWith("c")) name = value;
    else if (line.startsWith("n") && pid > 0) {
      const split = splitAddress(value);
      if (split) found.push({ pid, name, ...split });
    }
  }
  return found;
}

/** Each pid's working folder, those `lsof` could read. */
async function workingFolders(pids: number[]): Promise<Map<number, string>> {
  const folders = new Map<number, string>();
  if (!pids.length) return folders;
  const out = await lsof(["-a", "-d", "cwd", "-p", pids.join(","), "-F", "pn"]);
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) folders.set(pid, line.slice(1));
  }
  return folders;
}

/** Whether `path` is one of `folders` or inside one. */
function inside(path: string, folders: string[]): boolean {
  return folders.some((folder) => {
    const rel = relative(folder, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/** Whether `pid` runs under one of `roots`, `roots` included. */
function under(
  pid: number,
  roots: Set<number>,
  byPid: Map<number, Proc>,
): boolean {
  const seen = new Set<number>();
  for (let at = byPid.get(pid); at && at.pid > 1 && !seen.has(at.pid); ) {
    if (roots.has(at.pid)) return true;
    seen.add(at.pid);
    at = byPid.get(at.ppid);
  }
  return false;
}

/** `Mon Oct 19 09:00:00 2026` → epoch ms, or null. */
function startedAt(start: string): number | null {
  const parts = start.split(" ");
  if (parts.length !== 5) return null;
  const [, month, day, time, year] = parts;
  const ms = Date.parse(`${month} ${day} ${year} ${time}`);
  return Number.isFinite(ms) ? ms : null;
}

interface Scan {
  ports: ListeningPort[];
  procs: Proc[];
  uid: number;
}

/**
 * The project's listening ports, with the process table they were read from.
 *
 * A port counts when its process works inside one of `folders`, or runs
 * under one of `terminals`.
 */
async function scan(folders: string[], terminals: number[]): Promise<Scan> {
  const uid = ownUid();
  const real = (
    await Promise.all(
      folders.map((folder) => realpath(folder).catch(() => null)),
    )
  ).filter((folder): folder is string => folder !== null);
  const [found, procs] = await Promise.all([listeners(uid), processTable()]);
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const cwd = await workingFolders([...new Set(found.map((row) => row.pid))]);
  const roots = new Set(terminals);
  const rows = new Map<string, ListeningPort>();
  for (const row of found) {
    const proc = byPid.get(row.pid);
    // Gone between the two reads, someone else's, or the app's own.
    if (!proc || proc.uid !== uid || proc.pid === process.pid) continue;
    const folder = cwd.get(row.pid);
    const via =
      folder && inside(folder, real)
        ? "folder"
        : under(row.pid, roots, byPid)
          ? "terminal"
          : null;
    if (!via) continue;
    const id = `${row.pid}:${row.port}`;
    const seen = rows.get(id);
    if (seen) {
      if (!seen.addresses.includes(row.address))
        seen.addresses.push(row.address);
      continue;
    }
    rows.set(id, {
      port: row.port,
      pid: row.pid,
      start: proc.start,
      startedAt: startedAt(proc.start),
      name: row.name,
      command: visible(proc.args).trim().slice(0, COMMAND_MAX),
      addresses: [row.address],
      via,
    });
  }
  const ports = [...rows.values()].sort(
    (a, b) => a.port - b.port || a.pid - b.pid,
  );
  return { ports, procs, uid };
}

/**
 * The TCP ports the project's processes listen on, sorted by port.
 *
 * Those of `folders`' processes, and those of every process under one of
 * `terminals` (pty pids). Empty on Windows.
 */
export async function listPorts(
  folders: string[],
  terminals: number[],
): Promise<ListeningPort[]> {
  if (process.platform === "win32") return [];
  return (await scan(folders, terminals)).ports;
}

/** `pid` and every process under it. */
function subtree(pid: number, procs: Proc[]): Proc[] {
  const children = new Map<number, Proc[]>();
  for (const proc of procs)
    children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc]);
  const out: Proc[] = [];
  const queue = procs.filter((proc) => proc.pid === pid);
  const seen = new Set<number>();
  while (queue.length) {
    const at = queue.shift() as Proc;
    if (seen.has(at.pid)) continue;
    seen.add(at.pid);
    out.push(at);
    queue.push(...(children.get(at.pid) ?? []));
  }
  return out;
}

/** A process's program name: `node`, `zsh`, and `zsh` for `-zsh` too. */
function program(args: string): string {
  return basename(args.split(/\s+/)[0] ?? "").replace(/^-/, "");
}

/**
 * Stop the process listening on a port of the project, with what launched it.
 *
 * It climbs to what launched the server (`bun run dev` above `vite`), up to
 * the nearest shell, agent, terminal or the app, which are never signalled.
 * SIGTERM first; whatever still runs with the same pid and start time after
 * {@link GRACE_MS} is killed.
 *
 * NOTE: By process tree, not process group: a server an agent started
 * without job control shares the agent's group, and signalling it would
 * stop the agent too.
 *
 * @param start the process's start time as the listing gave it, so a pid
 * reused since is never signalled.
 * @returns how many processes were signalled.
 * @throws when the arguments are malformed, on Windows, or when that pid no
 * longer listens in this project.
 */
export async function stopPort(
  folders: string[],
  terminals: number[],
  pid: number,
  start: string,
): Promise<{ stopped: number }> {
  if (!Number.isInteger(pid) || pid <= 1)
    throw new Error("A valid pid is required");
  if (typeof start !== "string" || !start)
    throw new Error("A start time is required");
  if (process.platform === "win32") throw new Error("Not supported here.");
  const { ports, procs, uid } = await scan(folders, terminals);
  if (!ports.some((row) => row.pid === pid && row.start === start))
    throw new Error("That port is no longer open in this project.");
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  // Never the app, its ancestors, a terminal, or a shell or agent above.
  const fenced = new Set<number>([1, ...terminals]);
  let at = byPid.get(process.pid);
  while (at && !fenced.has(at.pid)) {
    fenced.add(at.pid);
    at = byPid.get(at.ppid);
  }
  let top = byPid.get(pid) as Proc;
  for (;;) {
    const parent = byPid.get(top.ppid);
    if (
      !parent ||
      fenced.has(parent.pid) ||
      parent.uid !== uid ||
      BOUNDARY.has(program(parent.args))
    )
      break;
    top = parent;
  }
  const targets = subtree(top.pid, procs).filter(
    (proc) => proc.uid === uid && !fenced.has(proc.pid),
  );
  const signaled: Proc[] = [];
  for (const proc of targets) {
    try {
      process.kill(proc.pid, "SIGTERM");
      signaled.push(proc);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  if (!signaled.length) return { stopped: 0 };
  await new Promise((resolve) => setTimeout(resolve, GRACE_MS));
  const after = await processTable();
  for (const proc of signaled) {
    // The same pid AND start time: never kill a pid reused since.
    if (
      !after.some(
        (now) =>
          now.pid === proc.pid && now.start === proc.start && now.uid === uid,
      )
    )
      continue;
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return { stopped: signaled.length };
}
