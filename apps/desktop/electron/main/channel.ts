// Which build of the app runs, in the one place it is decided: the release,
// or "Lanework (Preview)", a packaged dev build installed beside it.
//
// The Preview shares nothing with the release:
// - its own name, so `userData` is `~/Library/Application Support/Lanework
//   (Preview)` (`applyChannel`, before anything reads it);
// - its own app home, `~/.lanew-preview` (`paths.ts`);
// - and it never writes the agents' config. The release app owns the
//   Lanework MCP entry, the hooks and the folder trust; the Preview only
//   reads them ({@link refuseInPreview}, {@link skipInPreview}).
//
// NOTE: Only a PACKAGED dev build is the Preview. `bun run dev` and the test
// suite are unpackaged and stay "Lanework", exactly as before: they isolate
// themselves with `LANEWORK_HOME` and `LANEWORK_TEST_USER_DATA`.
import { app } from "electron";
import {
  type AppChannel,
  PREVIEW_AGENT_SETUP_REFUSAL,
} from "../../shared/desktop";
import { lockAgentConfig } from "./agent-setup/mcp-entry";
import { selectPreviewAppHome } from "./paths";

/** Whether this is the Preview: packaged, with a `-preview-` version. */
export function isPreview(): boolean {
  return app.isPackaged && /-preview-\d+$/.test(app.getVersion());
}

/** `YYYYMMDDHHmm`, local time. */
function stampOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * The version the app shows (About, `AppInfo`).
 *
 * - A release or the Preview: its own, `0.1.0` or `0.1.0-preview-…`.
 * - An unpackaged run (`mise run dev`): the release it builds on and when
 *   the session started, `0.1.0-dev-YYYYMMDDHHmm`, so a report from it is
 *   never mistaken for the release. `app.getVersion()` stays the plain
 *   release version: the updater is off unpackaged anyway.
 */
export const APP_DISPLAY_VERSION = app.isPackaged
  ? app.getVersion()
  : `${app.getVersion()}-dev-${process.env.LANEWORK_DEV_STAMP || stampOf(new Date())}`;

/** This build's channel, for the renderer (`AppInfo.channel`). */
export const APP_CHANNEL: AppChannel = isPreview() ? "preview" : "release";

/** The name every window, menu, notification and About panel shows. */
export const APP_DISPLAY_NAME =
  APP_CHANNEL === "preview" ? "Lanework (Preview)" : "Lanework";

/**
 * Throw {@link PREVIEW_AGENT_SETUP_REFUSAL} in the Preview.
 *
 * For an IPC handler that would write the agents' own config: the page shows
 * the message.
 */
export function refuseInPreview(): void {
  if (APP_CHANNEL === "preview") throw new Error(PREVIEW_AGENT_SETUP_REFUSAL);
}

/**
 * Whether a background write into the agents' config is skipped, because this
 * is the Preview. Logs one line when it is.
 *
 * @param what What is skipped, for the log.
 */
export function skipInPreview(what: string): boolean {
  if (APP_CHANNEL !== "preview") return false;
  console.info(`Preview build: skipped ${what}; the release app manages it.`);
  return true;
}

/**
 * Give this build its name, app home and agent-config lock.
 *
 * Main calls it first, before anything reads `app.getPath("userData")` or
 * the app home: `setName` is what moves `userData`.
 */
export function applyChannel(): void {
  app.setName(APP_DISPLAY_NAME);
  if (APP_CHANNEL !== "preview") return;
  selectPreviewAppHome();
  lockAgentConfig(PREVIEW_AGENT_SETUP_REFUSAL);
}
