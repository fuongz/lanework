// What the composer sends, checked and turned into one stream-json user
// message (FE-62/D1). Nothing here imports Electron.
import { open, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import {
  checkSettings,
  type OutgoingAttachment,
  PASTE_MAX,
  type SendRequest,
} from "../../../shared/conversation";
import { isAgentSessionId, isAgentSessionIdOf } from "../../../shared/terminal";

/** The longest prompt main passes on, in characters. */
const PROMPT_MAX = 256 * 1024;
/** The most attachments one message carries. */
const ATTACHMENTS_MAX = 20;
/** The MIME type of each image extension sent as an image block. */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** The MIME types a pasted image may have. */
const PASTE_TYPES = new Set(Object.values(IMAGE_TYPES));

/** One block of a stream-json user message's content. */
export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

/** A message's id, as the page names it: short, and nothing but a name. */
export function isMessageId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value);
}

/**
 * A send request off the wire, every field checked.
 *
 * @throws When any field is missing, invalid or too large, or there is
 *   nothing to send.
 */
export function sendRequest(value: unknown): SendRequest {
  if (!value || typeof value !== "object")
    throw new Error("A request is required");
  const v = value as Record<string, unknown>;
  if (
    typeof v.project !== "string" ||
    !v.project.trim() ||
    v.project.length > 200
  )
    throw new Error("A valid project is required");
  // A UUID, or OpenCode's own `ses_` id (FE-104).
  if (
    !isAgentSessionId(v.conversation) &&
    !isAgentSessionIdOf("opencode", v.conversation)
  )
    throw new Error("A valid conversation is required");
  if (typeof v.text !== "string" || v.text.length > PROMPT_MAX)
    throw new Error("The message is too long.");
  const settings = checkSettings(v.settings);
  if (!settings) throw new Error("Unknown settings");
  if (!Array.isArray(v.attachments) || v.attachments.length > ATTACHMENTS_MAX)
    throw new Error("Too many attachments.");
  const attachments: OutgoingAttachment[] = v.attachments.map((entry) => {
    const a = (entry ?? {}) as Record<string, unknown>;
    if (a.kind === "path") {
      if (
        typeof a.path !== "string" ||
        !isAbsolute(a.path) ||
        a.path.length > 4096 ||
        a.path.includes("\0")
      )
        throw new Error("A file must be an absolute path.");
      return { kind: "path", path: a.path };
    }
    if (a.kind === "data") {
      if (typeof a.mediaType !== "string" || !PASTE_TYPES.has(a.mediaType))
        throw new Error("Only PNG, JPEG, GIF or WebP images can be pasted.");
      if (
        typeof a.data !== "string" ||
        a.data.length > Math.ceil((PASTE_MAX * 4) / 3) + 4
      )
        throw new Error("That image is too large.");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(a.data))
        throw new Error("Not base64.");
      const name = typeof a.name === "string" ? a.name.slice(0, 200) : "image";
      return { kind: "data", name, mediaType: a.mediaType, data: a.data };
    }
    throw new Error("Unknown attachment");
  });
  if (!v.text.trim() && attachments.length === 0)
    throw new Error("Nothing to send.");
  if (v.id !== undefined && !isMessageId(v.id))
    throw new Error("A valid message id is required");
  return {
    project: v.project,
    conversation: v.conversation,
    ...(v.id === undefined ? {} : { id: v.id }),
    text: v.text,
    attachments,
    settings,
  };
}

/**
 * A file's bytes, when it is a file of at most `max` bytes.
 *
 * @returns null for anything else.
 */
async function readSmall(path: string, max: number): Promise<Buffer | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > max) return null;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * `@path`, quoted when it has a space — how the CLI reads a file mention. A
 * folder ends in `/`, as the composer writes one (FE-93/D2), so the chat
 * badges it as a folder.
 */
function mention(path: string, folder = false): string {
  const at = folder ? `${path.replace(/\/+$/, "")}/` : path;
  return /\s|"/.test(at) ? `@"${at.replace(/"/g, '\\"')}"` : `@${at}`;
}

/**
 * The message's content blocks.
 *
 * - The text comes first, with every file that is not an image named as
 *   `@<path>` after it.
 * - Images follow as base64 blocks: a pasted one, or a path that is an
 *   image, read from disk, of at most `PASTE_MAX` bytes.
 *
 * @throws When a pasted image is too large or an attached path is gone.
 */
export async function contentOf(
  text: string,
  attachments: readonly OutgoingAttachment[],
): Promise<ContentBlock[]> {
  const images: ContentBlock[] = [];
  const mentions: string[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "data") {
      if (Buffer.from(attachment.data, "base64").length > PASTE_MAX)
        throw new Error("That image is too large.");
      images.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mediaType,
          data: attachment.data,
        },
      });
      continue;
    }
    const type = IMAGE_TYPES[extname(attachment.path).toLowerCase()];
    const info = await stat(attachment.path).catch(() => null);
    if (!info?.isFile() && !info?.isDirectory())
      throw new Error(`${basename(attachment.path)} is not there any more.`);
    const bytes = type ? await readSmall(attachment.path, PASTE_MAX) : null;
    if (type && bytes)
      images.push({
        type: "image",
        source: {
          type: "base64",
          media_type: type,
          data: bytes.toString("base64"),
        },
      });
    else mentions.push(mention(attachment.path, info.isDirectory()));
  }
  const body = [text.trim(), mentions.join(" ")].filter(Boolean).join("\n\n");
  return [...(body ? [{ type: "text" as const, text: body }] : []), ...images];
}
