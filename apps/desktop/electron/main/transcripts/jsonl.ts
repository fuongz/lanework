// Reading the agents' JSONL transcripts: a byte range, its whole lines, a
// title-sized line, and where Claude keeps a folder's conversations.
//
// NOTE: A leaf (FE-80, AM-03). The terminal, chat, memory and usage features
// all read transcripts; they import these from here, not from one another.
// Node only, no Electron.
import { open } from "node:fs/promises";

/** How much of a transcript's start and end is read; never the whole file. */
export const CHUNK = 64 * 1024;
/** A Codex `session_meta` line carries the whole system prompt. */
export const META_CHUNK = 256 * 1024;
/** The longest title a rail row shows, in characters. */
const TITLE_MAX = 120;
/** Claude's name for a sub-agent's transcript, beside its `.meta.json`. */
export const CLAUDE_SUBAGENT_FILE = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/;

/** One parsed line of a transcript. */
export type Line = Record<string, unknown>;

/** Up to `length` bytes of `file` from byte `start`, as text. */
export async function readRange(
  file: string,
  start: number,
  length: number,
): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * The whole lines of a chunk, parsed.
 *
 * A chunk cut mid-line loses that line: the first one of a tail, the last one
 * of a head. A line that is not JSON is skipped, never thrown on.
 *
 * @param head The chunk is a file's start, not its end.
 */
export function lines(text: string, { head }: { head: boolean }): Line[] {
  const parts = text.split("\n");
  if (head) parts.pop();
  else parts.shift();
  const out: Line[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    try {
      const value: unknown = JSON.parse(part);
      if (value && typeof value === "object") out.push(value as Line);
    } catch {
      // Cut, or not ours.
    }
  }
  return out;
}

/** One line, whitespace collapsed, short enough for a rail row. */
export function tidy(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

/** Claude's folder name for `cwd`: every character but [A-Za-z0-9] is `-`. */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** How much of a file one step of {@link eachLine} reads. */
const LINE_STEP = 1024 * 1024;

/**
 * Hand each whole line of `file` from byte `start` to `visit`, in order.
 *
 * A line still being written (no newline after it yet) is left for the next
 * read. A line longer than one step is handed over cut, as its first step:
 * what it starts with is all a reader of markers needs.
 *
 * @param start The start of a line.
 * @returns Where the whole lines read end: the next read's `start`.
 */
export async function eachLine(
  file: string,
  start: number,
  visit: (line: string) => void,
): Promise<number> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    if (start >= size) return start;
    const buffer = Buffer.alloc(Math.min(LINE_STEP, size - start));
    let at = start;
    // Inside a line longer than a step, already handed over.
    let skipping = false;
    while (at < size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - at),
        at,
      );
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let from = 0;
      for (;;) {
        const end = chunk.indexOf(0x0a, from);
        if (end === -1) break;
        if (!skipping) visit(chunk.toString("utf8", from, end));
        skipping = false;
        from = end + 1;
      }
      if (from > 0) {
        at += from;
        continue;
      }
      // Not one newline in a whole step: still being written, or that long.
      if (at + bytesRead >= size) break;
      if (!skipping) visit(chunk.toString("utf8"));
      skipping = true;
      at += bytesRead;
    }
    return at;
  } finally {
    await handle.close();
  }
}
