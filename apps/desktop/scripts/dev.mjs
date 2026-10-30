import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { context } from "esbuild";
import { createLogger, createServer } from "vite";
import { brandDevBundle } from "./brand-dev-bundle.mjs";
import { buildDictation } from "./build-dictation.mjs";
import {
  electronBuildOptions,
  stageNativeModules,
} from "./electron-bundle.mjs";

/**
 * One log standard for the whole dev session: `HH:MM:SS [who] text`.
 *
 * Everything the session prints goes through {@link say} — this module's own
 * lines, Vite's (a rewritten custom logger, info still on) and the Electron
 * child (its stdout/stderr are read back line by line). A tag says WHO spoke:
 * `dev` is this script, `vite` the renderer server, `app` the Electron main
 * process, `build` esbuild. The stamp is dim, the tag bold in its speaker's
 * colour, and the body's colour carries the kind of line, Vite-style: "hmr
 * update" green, warnings yellow, errors red.
 *
 * Colours follow the usual contract, but TTY-DETECTING last: `NO_COLOR` wins,
 * `FORCE_COLOR=0` wins, then a terminal gets colours — which is assumed by
 * `TERM` alone too, because `bun run` on some versions robbers the flag, and
 * an isTTY-off but TERM-on buffer (an app's embedded pane) is still a
 * terminal. A log redirected to a file (`TERM` gone or `dumb`) stays plain.
 */
const NO = process.env.NO_COLOR !== undefined;
const FORCE = process.env.FORCE_COLOR;
const FORCE_OFF = FORCE === "0";
const FORCE_ON = FORCE !== undefined && FORCE !== "0";
const TTY = process.stdout.isTTY;
const TERM = process.env.TERM ?? "";
const CAPABLE = TERM !== "" && TERM !== "dumb";
const COLOUR = !NO && !FORCE_OFF && (TTY || CAPABLE || FORCE_ON);
const tone = (code) => (COLOUR ? `\x1b[${code}m` : "");
const RESET = COLOUR ? "\x1b[0m" : "";
const DIM = COLOUR ? "\x1b[2m" : "";
const BOLD = COLOUR ? "\x1b[1m" : "";
/**
 * Each speaker's tag colour, so a glance tells who spoke: Vite cyan as Vite
 * draws it, this script magenta, Electron blue, the app's own lines green,
 * esbuild yellow. The body's colour still says the kind of line.
 */
const WHO = { vite: 36, dev: 35, electron: 34, app: 32, build: 33 };
const stamp = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

/**
 * Print one text as `stamp [who] (context) text`, one line per line.
 *
 * `color` (an ANSI SGR code) tints the body only, so it means a kind of
 * line; the tag's own colour ({@link WHO}) means the speaker.
 */
function say(who, text, color, context) {
  const stream = color && color < 35 ? process.stderr : process.stdout;
  // The stamp's DIM is reset before the tag: SGR 1 does not cancel 2, so a
  // tag drawn while DIM is on is as faint as the stamp.
  const head =
    `${DIM}${stamp()}${RESET} ${BOLD}${tone(WHO[who] ?? 37)}[${who}]${RESET} ` +
    (context ? `${DIM}(${context})${RESET} ` : "");
  const body = color ? `${tone(color)}${text}${RESET}` : text;
  for (const line of String(body).split("\n")) stream.write(`${head}${line}\n`);
}

const ESC = String.fromCharCode(27);
const stripAnsi = (value) =>
  value
    .split(ESC)
    .map((part, index) => (index > 0 ? part.replace(/^\[[0-9;]*m/, "") : part))
    .join("");

/**
 * Vite's own message, without its head: Vite prefixes an own timestamp and
 * the `[vite]` tag; a leading `(client)` / `(ssr)` MARKS WHICH SURFACE spoke,
 * so it goes down one level, dim.
 *
 * Its own colours go too. picocolors decides them by the TTY alone, so they
 * came and went with the terminal, and `hmr update` wrapped in green never
 * matched; the kind of line is coloured here instead, one way everywhere.
 */
const stripHead = (message) => {
  const text = stripAnsi(String(message))
    .replace(/^\[\d{2}:\d{2}:\d{2}(?:\s*[AP]M)?\]\s*/, "")
    .replace(/^\[vite\]\s*/, "")
    .trim();
  const surface = /^\((client|ssr)\)\s+(.*)$/.exec(text);
  return surface
    ? { surface: surface[1], text: surface[2] }
    : { surface: null, text };
};
const viteLogger = createLogger("info");
// Vite names the surface a line belongs to in the call's options
// (`environment`: "(client)" or "(ssr)"), and its value carries its OWN
// colouring; that is stripped, so the context speaks in OUR dim slot.
const surfaceOf = (options) =>
  stripAnsi(options?.environment ?? "").replace(/^\(|\)$/g, "");
viteLogger.info = (message, options) => {
  const { surface, text } = stripHead(message);
  say(
    "vite",
    text,
    /^(hmr update|page reload)/.test(text) ? 32 : undefined,
    surface ?? surfaceOf(options),
  );
};
viteLogger.warn = (message, options) => {
  const { surface, text } = stripHead(message);
  say("vite", text, 33, surface ?? surfaceOf(options));
};
viteLogger.error = (message, options) => {
  const { surface, text } = stripHead(message);
  say("vite", text, 31, surface ?? surfaceOf(options));
};

const require = createRequire(import.meta.url);
const electron = brandDevBundle(require("electron"));
const server = await createServer({ customLogger: viteLogger });
await server.listen();
let child;
let shuttingDown = false;
let restarting = false;
// node-pty is copied once; it only changes with the lockfile, not with a save.
await stageNativeModules();
// The dictation helper; rebuilt only when its Swift source changed.
await buildDictation();
const ctx = await context({
  ...electronBuildOptions,
  plugins: [
    {
      name: "restart-electron",
      setup(build) {
        build.onEnd(async (result) => {
          for (const warning of result.warnings)
            say(
              "build",
              `${warning.location?.file ?? "?"}:${warning.location?.line ?? "?"} ${warning.text}`,
              33,
            );
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
          // Lines, not `stdio: "inherit"`: every line the main process prints
          // reads as `[app] …`, the same standard as everything else here.
          child = spawn(electron, args, {
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          for (const [stream, color] of [
            [child.stdout, undefined],
            [child.stderr, 31],
          ])
            relay(stream, color);
          say("electron", `started (pid ${child.pid})`);
          child.on("error", (error) => {
            say("electron", String(error), 31);
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

/**
 * The colour of one of the app's stderr lines: `console.warn` and
 * `console.error` share the stream, so a line that says it warns is yellow,
 * not red. Its own colours, if any, are kept.
 */
const WARNS = /\b(warn(ing)?|deprecat\w*|fell back)\b/i;
const kindOf = (line, color) =>
  color === 31 && WARNS.test(stripAnsi(line)) ? 33 : color;

/**
 * Read `stream` back line by line into the same standard.
 *
 * A chunk may hold several lines and may end mid-line; whatever trails goes
 * back and carries the next chunk.
 */
function relay(stream, color) {
  let trailing = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    trailing += chunk;
    let end = trailing.indexOf("\n");
    while (end >= 0) {
      const line = trailing.slice(0, end);
      if (line.trim()) say("app", line, kindOf(line, color));
      trailing = trailing.slice(end + 1);
      end = trailing.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (trailing.trim()) say("app", trailing, kindOf(trailing, color));
    trailing = "";
  });
}

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
say("dev", "renderer HMR + main/preload restart");
say(
  "dev",
  `vite at http://127.0.0.1:${server.config.server.port}, Electron restarting on every main/preload change`,
);
