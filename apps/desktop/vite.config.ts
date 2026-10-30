import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
  server: { host: "127.0.0.1", port: 5175, strictPort: true },
  // The largest chunks are lazy @pierre/diffs grammar chunks (emacs-lisp,
  // wasm, CodeView) fetched on demand over `app://lanework`, so the 500 kB
  // default limit misfires on them. They are already split per language.
  build: { chunkSizeWarningLimit: 900 },
  plugins: [tailwindcss(), tanstackStart({ spa: { enabled: true } }), react()],
});
