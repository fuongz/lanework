import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Plugin order matters: the Cloudflare plugin must come before TanStack Start.
export default defineConfig({
  // Resolve the `@/*` alias from tsconfig natively (replaces vite-tsconfig-paths).
  resolve: { tsconfigPaths: true },
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
    tanstackStart(),
    viteReact(),
  ],
});
