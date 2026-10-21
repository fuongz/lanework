// An image the chat names in inline code, read back for its lightbox
// (FE-65). Nothing here imports Electron.
//
// ⚠️ The page sends a path as Claude wrote it, so main decides what it may
// read: a file inside the workspace's folder, or an image attached to this
// conversation — after symlinks, never `..` out of either — with an image's
// extension and at most IMAGE_MAX bytes.
import { readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { ImagePreview } from "../../../shared/conversation";

/** The largest image the lightbox is sent, in bytes. */
const IMAGE_MAX = 20 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

export interface ImageScope {
  /** The workspace's folder. */
  folder: string;
  /** Absolute paths of the images attached to the conversation. */
  attachments: readonly string[];
  /** The folder's files, relative to it — for a bare name (`details.png`). */
  files: () => Promise<string[]>;
}

function inside(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

/** Where `path` points, as an absolute path to try — or null. */
async function locate(path: string, scope: ImageScope): Promise<string | null> {
  if (isAbsolute(path)) return path;
  const direct = resolve(scope.folder, path);
  if (inside(scope.folder, direct) && (await isFile(direct))) return direct;
  // Not where it says: the one file of that name (or ending in that path).
  const name = basename(path);
  const tail = path.includes("/") ? `/${path}` : null;
  const found = new Set<string>();
  for (const file of await scope.files().catch(() => [])) {
    const rel = file.split(sep).join("/");
    if (tail ? `/${rel}`.endsWith(tail) : basename(rel) === name)
      found.add(resolve(scope.folder, file));
  }
  for (const attached of scope.attachments)
    if (!tail && basename(attached) === name) found.add(attached);
  return found.size === 1 ? [...found][0] : null;
}

/**
 * The image `path` names, as a `data:` URL — or `found: false` for one that
 * is not there, is ambiguous, is too big, or is out of scope.
 */
export async function previewImage(
  path: string,
  scope: ImageScope,
): Promise<ImagePreview> {
  const missing: ImagePreview = { found: false, path };
  const file = await openableImage(path, scope);
  if (!file) return missing;
  const bytes = await readFile(file).catch(() => null);
  if (!bytes || bytes.length > IMAGE_MAX) return missing;
  return {
    found: true,
    path: file,
    url: `data:${IMAGE_TYPES[extname(file).toLowerCase()]};base64,${bytes.toString("base64")}`,
  };
}

/** The real path of the image `path` names, when it is in scope; else null. */
export async function openableImage(
  path: string,
  scope: ImageScope,
): Promise<string | null> {
  if (!IMAGE_TYPES[extname(path).toLowerCase()]) return null;
  const candidate = await locate(path, scope);
  if (!candidate) return null;
  const real = await realpath(candidate).catch(() => null);
  if (!real || !IMAGE_TYPES[extname(real).toLowerCase()]) return null;
  const folder = await realpath(scope.folder).catch(() => scope.folder);
  const attached = await Promise.all(
    scope.attachments.map((entry) => realpath(entry).catch(() => null)),
  );
  if (!inside(folder, real) && !attached.includes(real)) return null;
  const info = await stat(real).catch(() => null);
  if (!info?.isFile() || info.size > IMAGE_MAX) return null;
  return real;
}
