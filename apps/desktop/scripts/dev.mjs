import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { context } from "esbuild";
import { createServer } from "vite";
import { brandDevBundle } from "./brand-dev-bundle.mjs";
import {
  electronBuildOptions,
  stageNativeModules,
} from "./electron-bundle.mjs";

const require = createRequire(import.meta.url);
const electron = brandDevBundle(require("electron"));
const server = await createServer();
await server.listen();
let child;
let shuttingDown = false;
let restarting = false;
// node-pty is copied once; it only changes with the lockfile, not with a save.
await stageNativeModules();
const ctx = await context({
  ...electronBuildOptions,
  plugins: [
    {
      name: "restart-electron",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length || shuttingDown) return;
          restarting = true;
          if (child && child.exitCode === null && child.signalCode === null) {
            await new Promise((resolve) => {
              child.once("exit", resolve);
              child.kill();
            });
          }
          restarting = false;
          const env = {
            ...process.env,
            ELECTRON_RENDERER_URL: "http://127.0.0.1:5175",
          };
          delete env.ELECTRON_RUN_AS_NODE;
          const args = ["."];
          if (process.env.LANEWORK_DEV_DEBUG_PORT) {
            args.push(
              `--remote-debugging-port=${process.env.LANEWORK_DEV_DEBUG_PORT}`,
            );
          }
          child = spawn(electron, args, { stdio: "inherit", env });
          console.log(`Electron started (pid ${child.pid})`);
          child.on("error", (error) => {
            console.error(error);
            void shutdown(1);
          });
          child.on("exit", (code) => {
            if (!restarting && !shuttingDown) void shutdown(code ?? 0);
          });
        });
      },
    },
  ],
});
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  child?.kill();
  await Promise.all([ctx.dispose(), server.close()]);
  process.exit(code);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await ctx.watch();
console.log("Lanework desktop dev: renderer HMR + main/preload restart.");
