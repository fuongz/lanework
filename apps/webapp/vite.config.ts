import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// All app source lives in the shared package; this app only adds the Cloudflare
// target + platform config. The route scanner reads routes from there too.
// srcDirectory must stay RELATIVE — the plugin path.joins it onto the vite root.
const sharedSrc = "../../packages/shared/src";
const sharedPublic = fileURLToPath(new URL("../../packages/shared/public", import.meta.url));

// Plugin order matters: the Cloudflare plugin must come before TanStack Start.
export default defineConfig({
  // `@/*` resolves via this app's tsconfig paths → ../../packages/shared/src.
  resolve: { tsconfigPaths: true },
  publicDir: sharedPublic,
  // Statically false here so the local-only filesystem branch (and its node:*
  // imports) is dead-code-eliminated from the Workers bundle. See apps/local.
  define: { __LANEWORK_LOCAL__: "false" },
  build: {
    rollupOptions: {
      // @hugeicons/core-free-icons ships `/*#__PURE__*/` annotations that Rolldown
      // can't position-match — harmless, but very noisy. Drop just that warning.
      onLog(level, log, handler) {
        if (log.code === "INVALID_ANNOTATION") return;
        handler(level, log);
      },
    },
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart({ srcDirectory: sharedSrc }),
    viteReact(),
  ],
});
