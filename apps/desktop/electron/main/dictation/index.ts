// Dictation in the composer: one `lanework-dictation` helper per dictation,
// its JSON lines forwarded to the renderer as events.
//
// NOTE: The helper opens the microphone, not the renderer (FE-69/D8). The
// window's permission handler keeps refusing `media`, and the microphone is
// open only while a helper runs. One runs at a time: a new start cancels the
// old one, and the app's quit kills it.
//
// NOTE: A start needs a focused window, and main stops any dictation after
// `SESSION_MAX_MS` (FE-81/D2): a script in the renderer cannot open the
// microphone behind the person's back, nor keep it open.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { release } from "node:os";
import { join, sep } from "node:path";
import { createInterface } from "node:readline";
import { app, BrowserWindow } from "electron";
import {
  type DictationEvent,
  dictationChannels,
  HINT_LENGTH_MAX,
  HINT_MAX,
  isDictationLocale,
} from "../../../shared/dictation";
import { broadcast, handle } from "../ipc";

/**
 * The helper's path, outside the asar archive.
 *
 * An executable inside the archive cannot be spawned, so
 * `electron-builder.yml` unpacks `dist/electron/bin/**`. Unpackaged (dev,
 * tests) there is no archive and the path is left as it is.
 */
function helperPath(): string {
  return join(__dirname, "..", "bin", "lanework-dictation").replace(
    `app.asar${sep}`,
    `app.asar.unpacked${sep}`,
  );
}

/**
 * Whether this Mac can dictate: macOS 26 or later, with the helper there.
 *
 * macOS 26 is Darwin 25, the first with SpeechAnalyzer.
 */
function supported(): boolean {
  return (
    process.platform === "darwin" &&
    Number(release().split(".")[0]) >= 25 &&
    existsSync(helperPath())
  );
}

/** The longest one dictation runs before main stops it (FE-81/D2). */
const SESSION_MAX_MS = 120_000;

/**
 * How long a stopped helper has to report its words before it is killed.
 *
 * Only the cap's own stop waits on it.
 */
const STOP_GRACE_MS = 10_000;

/** The one helper running, and the session it serves. */
let running: { session: number; child: ChildProcess } | null = null;
/** The last session number handed out. */
let sessions = 0;

/** Send a dictation event to every window. */
const send = (event: DictationEvent) =>
  broadcast(dictationChannels.event, event);

/**
 * End a dictation, when `session` is still the running one.
 *
 * `stop` asks the helper to finish and report its text; `cancel` kills it.
 */
function end(session: number, command: "stop" | "cancel") {
  if (running?.session !== session) return;
  const { child } = running;
  if (command === "cancel") {
    running = null;
    child.kill();
    return;
  }
  child.stdin?.write("stop\n");
}

/**
 * Start a helper for a new dictation, cancelling any running one.
 *
 * @param hints Words the recognizer should expect.
 * @returns The new session's number, which every event carries.
 */
function start(locale: string, hints: string[]): number {
  if (running) end(running.session, "cancel");
  const session = ++sessions;
  const args = ["--locale", locale];
  for (const hint of hints) args.push("--hint", hint);
  const child = spawn(helperPath(), args, {
    stdio: ["pipe", "pipe", "ignore"],
  });
  running = { session, child };
  let reported = false;
  // The cap: stop, so the words so far still arrive. A helper that does not
  // finish soon after is killed, and its exit still ends the session in the
  // renderer.
  let grace: ReturnType<typeof setTimeout> | undefined;
  const cap = setTimeout(() => {
    end(session, "stop");
    grace = setTimeout(() => {
      if (running?.session === session) child.kill();
    }, STOP_GRACE_MS);
  }, SESSION_MAX_MS);
  const clearCap = () => {
    clearTimeout(cap);
    clearTimeout(grace);
  };
  // stdio is "pipe", so stdout is always there.
  createInterface({ input: child.stdout as NodeJS.ReadableStream }).on(
    "line",
    (line) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      const type = parsed.type;
      const text = (key: string) =>
        typeof parsed[key] === "string" ? (parsed[key] as string) : "";
      if (type === "preparing" || type === "listening") send({ session, type });
      else if (type === "level" && typeof parsed.value === "number")
        send({ session, type, value: Math.min(1, Math.max(0, parsed.value)) });
      else if (type === "text")
        send({
          session,
          type,
          final: text("final"),
          volatile: text("volatile"),
        });
      else if (type === "done" || type === "error") {
        reported = true;
        send(
          type === "done"
            ? { session, type, text: text("text") }
            : {
                session,
                type,
                code: text("code") || "engine",
                message: text("message"),
              },
        );
      }
    },
  );
  child.on("error", (error) => {
    clearCap();
    reported = true;
    send({ session, type: "error", code: "spawn", message: error.message });
  });
  child.on("exit", () => {
    clearCap();
    const cancelled = running?.session !== session;
    if (!cancelled) running = null;
    // A helper that dies without a word, a crash, still ends the session.
    if (!reported && !cancelled)
      send({
        session,
        type: "error",
        code: "exited",
        message: "Dictation stopped unexpectedly.",
      });
  });
  return session;
}

/** Register dictation's IPC handlers. */
export function registerDictation(devUrl: string | undefined): void {
  handle(dictationChannels.supported, devUrl, () => supported());
  handle(dictationChannels.start, devUrl, ([locale, hints]) => {
    if (!supported()) throw new Error("Dictation is not available on this Mac");
    if (!BrowserWindow.getFocusedWindow())
      throw new Error("Dictation starts only in a focused window");
    if (!isDictationLocale(locale))
      throw new Error("Unknown dictation language");
    if (!Array.isArray(hints) || hints.length > HINT_MAX)
      throw new Error("Invalid dictation hints");
    const words = hints.filter(
      (hint): hint is string =>
        typeof hint === "string" &&
        hint.trim().length > 0 &&
        hint.length <= HINT_LENGTH_MAX,
    );
    return start(locale, words);
  });
  for (const command of ["stop", "cancel"] as const)
    handle(dictationChannels[command], devUrl, ([session]) => {
      if (typeof session !== "number") throw new Error("Invalid session");
      end(session, command);
    });
  app.on("will-quit", () => {
    if (running) end(running.session, "cancel");
  });
}
