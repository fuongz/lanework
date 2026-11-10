// INF-11: every check, download and install, one line each, in
// ~/Library/Logs/Lanework/updater.log (Electron's `logs` path), so a report
// of "it never updated" can be read back. Also on stdout.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";

/** Past this size the file moves to updater.old.log and starts again. */
const LOG_MAX_BYTES = 256 * 1024;

function logFile(): string {
  return join(app.getPath("logs"), "updater.log");
}

function write(level: "info" | "warn" | "error", message: string): void {
  const line = `${new Date().toISOString()} ${level} ${message}`;
  if (level === "info") console.log(`[updater] ${message}`);
  else console.warn(`[updater] ${message}`);
  try {
    const file = logFile();
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > LOG_MAX_BYTES)
        renameSync(file, join(dirname(file), "updater.old.log"));
    } catch {
      // No file yet.
    }
    appendFileSync(file, `${line}\n`);
  } catch {
    // A log line is never worth failing an update over.
  }
}

const text = (value: unknown): string =>
  value instanceof Error
    ? value.message
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

/** The logger handed to electron-updater, and used by this module. */
export const updaterLog = {
  info: (message?: unknown) => write("info", text(message)),
  warn: (message?: unknown) => write("warn", text(message)),
  error: (message?: unknown) => write("error", text(message)),
  debug: (message: string) => write("info", message),
};
