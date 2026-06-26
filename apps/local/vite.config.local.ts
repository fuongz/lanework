import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Local (no-Cloudflare) build target. Builds the shared app source into a Node
// SSR fetch handler + client assets (dist-local/) that cli.mjs + server.mjs
// serve with srvx on 127.0.0.1 — the "run like Serena" mode. Differences from
// the webapp config:
//  - No `@cloudflare/vite-plugin` (we're not targeting Workers).
//  - `cloudflare:workers` is aliased to a Node shim so imports resolve.
// srcDirectory must stay RELATIVE — the plugin path.joins it onto the vite root.
const sharedSrcRel = "../../packages/shared/src";
const sharedSrcAbs = fileURLToPath(new URL("../../packages/shared/src", import.meta.url));
const sharedPublic = fileURLToPath(new URL("../../packages/shared/public", import.meta.url));
const shim = fileURLToPath(new URL("./cloudflare-workers-shim.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": shim,
      "@": sharedSrcAbs,
    },
  },
  publicDir: sharedPublic,
  // Mark local mode at build time so server functions branch to the filesystem
  // data source and skip auth/GitHub/D1/KV.
  define: { __LANEWORK_LOCAL__: "true" },
  build: {
    outDir: "dist-local",
    rollupOptions: {
      onLog(level, log, handler) {
        if (log.code === "INVALID_ANNOTATION") return;
        handler(level, log);
      },
    },
  },
  plugins: [tailwindcss(), tanstackStart({ srcDirectory: sharedSrcRel }), viteReact()],
});
