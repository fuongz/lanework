import { build } from "esbuild";

await build({
  entryPoints: {
    "main/index": "electron/main/index.ts",
    "preload/index": "electron/preload/index.ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  outdir: "dist/electron",
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
});
