import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  type FileVersion,
  type FileWriteResult,
  MAX_TEXT_FILE_BYTES,
} from "../../../shared/worktree";

export function fileVersion(mtimeMs: number, bytes: Buffer): FileVersion {
  return { mtimeMs, hash: createHash("sha1").update(bytes).digest("hex") };
}

export function sameVersion(a: FileVersion, b: FileVersion): boolean {
  return a.mtimeMs === b.mtimeMs && a.hash === b.hash;
}

type Refusal = Extract<FileWriteResult, { kind: "error" }>;
export type TextSnapshot =
  | {
      kind: "text";
      text: string;
      size: number;
      version: FileVersion;
      mode: number;
    }
  | Refusal;

/** Bounded reads also catch a file growing after stat, without decoding loss. */
export async function textSnapshot(handle: FileHandle): Promise<TextSnapshot> {
  const info = await handle.stat();
  if (!info.isFile())
    return {
      kind: "error",
      reason: "directory",
      message: "Only regular text files can be saved.",
    };
  if (info.size > MAX_TEXT_FILE_BYTES)
    return {
      kind: "error",
      reason: "too-large",
      message: "Text files must be at most 2 MB.",
    };
  const bytes = Buffer.alloc(MAX_TEXT_FILE_BYTES + 1);
  let size = 0;
  while (size < bytes.length) {
    const { bytesRead } = await handle.read(
      bytes,
      size,
      bytes.length - size,
      size,
    );
    if (!bytesRead) break;
    size += bytesRead;
  }
  if (size > MAX_TEXT_FILE_BYTES)
    return {
      kind: "error",
      reason: "too-large",
      message: "Text files must be at most 2 MB.",
    };
  const content = bytes.subarray(0, size);
  if (content.includes(0) || !isUtf8(content))
    return {
      kind: "error",
      reason: "binary",
      message: "Only UTF-8 text files can be saved.",
    };
  return {
    kind: "text",
    text: content.toString("utf8"),
    size,
    version: fileVersion(info.mtimeMs, content),
    mode: info.mode,
  };
}
