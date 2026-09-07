import { isAbsolute, relative, resolve } from "node:path";
export const appOrigin = "app://lanework";
export function isTrustedUrl(value: string, devUrl?: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (devUrl) return url.origin === new URL(devUrl).origin;
    return url.protocol === "app:" && url.host === "lanework";
  } catch {
    return false;
  }
}
export function assetPath(root: string, pathname: string): string | undefined {
  try {
    const decoded = decodeURIComponent(pathname);
    if (
      !decoded.startsWith("/") ||
      decoded.includes("\0") ||
      decoded.includes("\\")
    )
      return;
    const target = resolve(root, `.${decoded}`);
    const rel = relative(root, target);
    if (
      rel === ".." ||
      rel.startsWith("../") ||
      rel.startsWith("..\\") ||
      isAbsolute(rel)
    )
      return;
    return target;
  } catch {
    return;
  }
}
