import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { protocol } from "electron";
import { assetPath, isTrustedUrl } from "./security";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
/**
 * Serve the built renderer from `root` on the `app:` scheme.
 *
 * A path with no file and no extension, outside `/assets/`, gets the app
 * shell, so the router can handle it. Every page carries a CSP that trusts
 * only the shell's own inline scripts, by hash.
 */
export function registerAppProtocol(root: string) {
  protocol.handle("app", async (request) => {
    if (!isTrustedUrl(request.url))
      return new Response("Forbidden", { status: 403 });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405 });
    const url = new URL(request.url);
    let file = assetPath(root, url.pathname);
    if (!file) return new Response("Forbidden", { status: 403 });
    try {
      if (!(await stat(file).catch(() => undefined))?.isFile()) {
        if (extname(url.pathname) || url.pathname.startsWith("/assets/"))
          return new Response("Not found", { status: 404 });
        file = join(root, "_shell.html");
      }
      const content = await readFile(file);
      // TanStack Start emits inline hydration scripts in the generated shell.
      // Trust only those exact bytes, not any inline JavaScript.
      const hashes =
        extname(file) === ".html"
          ? Array.from(
              content
                .toString()
                .matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
              (match) =>
                `'sha256-${createHash("sha256")
                  .update(
                    (match[1] ?? "")
                      .replace(/\r\n?/g, "\n")
                      .replace(/\0/g, "\uFFFD"),
                  )
                  .digest("base64")}'`,
            ).join(" ")
          : "";
      return new Response(
        request.method === "HEAD" ? null : new Uint8Array(content),
        {
          headers: {
            "Content-Type": mime[extname(file)] ?? "application/octet-stream",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": `default-src 'self'; script-src 'self' ${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'`,
          },
        },
      );
    } catch {
      return new Response("Unable to load app", { status: 500 });
    }
  });
}
