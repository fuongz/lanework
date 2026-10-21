// OS notifications (FE-70): every one goes through `notify`, which checks
// Settings → Notifications, skips what a focused window already shows
// (FE-70/D2a), and on a click brings the window back at the notification's
// target (FE-70/D5).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, BrowserWindow, Notification } from "electron";
import {
  checkNotificationSettings,
  isNotificationDelivery,
  isNotificationKind,
  type NotificationKind,
  type NotificationSettings,
  type NotificationTarget,
  notificationChannels,
} from "../../../shared/notifications";
import { handle } from "../ipc";

const settingsFile = () => join(app.getPath("userData"), "notifications.json");

let cache: NotificationSettings | null = null;
let writing: Promise<void> = Promise.resolve();

async function readSettings(): Promise<NotificationSettings> {
  if (cache) return cache;
  try {
    cache = checkNotificationSettings(
      JSON.parse(await readFile(settingsFile(), "utf8")),
    );
  } catch {
    cache = checkNotificationSettings(null);
  }
  return cache;
}

function persist(value: NotificationSettings): Promise<void> {
  const file = settingsFile();
  writing = writing
    .then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(value));
      await rename(temp, file);
    })
    .catch(() => {
      // The memory copy still answers this run.
    });
  return writing;
}

/** Whether `kind` is switched on. Read before doing any work for one. */
export async function notificationsOn(
  kind: NotificationKind,
): Promise<boolean> {
  return (await readSettings())[kind] === "push";
}

/** The path the window last said it shows (FE-70/D2a). */
let location: string | null = null;

/** The path a target opens, as the renderer's router spells it. */
function targetPath(target: NotificationTarget): string {
  const slug = encodeURIComponent(target.slug);
  return target.kind === "session"
    ? `/w/${slug}/agents/chat/${encodeURIComponent(target.conversation)}`
    : `/w/${slug}/pulls/${target.number}`;
}

// Keep delivered notifications alive so their click listeners survive GC.
const active = new Set<Notification>();

let showWindow: () => BrowserWindow | null = () => null;

interface NotifyOptions {
  kind: NotificationKind;
  title: string;
  body: string;
  target: NotificationTarget;
  /**
   * Paths that already show what this is about. A focused window on one of
   * them gets no notification (FE-70/D2a). The target's own path is always
   * one.
   */
  onScreen?: string[];
}

export async function notify(options: NotifyOptions): Promise<void> {
  if (!Notification.isSupported()) return;
  if (!(await notificationsOn(options.kind))) return;
  const shown = [targetPath(options.target), ...(options.onScreen ?? [])];
  if (
    BrowserWindow.getFocusedWindow() &&
    location !== null &&
    shown.includes(location)
  )
    return;
  deliver(options.title, options.body, options.target);
}

/**
 * Put one on screen. A click brings the window back, and at `target` when
 * there is one.
 */
function deliver(
  title: string,
  body: string,
  target: NotificationTarget | null,
): boolean {
  try {
    const notification = new Notification({
      title,
      body,
      // One sound, owned by the OS (and subject to its notification settings).
      silent: false,
    });
    active.add(notification);
    // OSes do not always emit close; bound retained native objects.
    if (active.size > 64) {
      const oldest = active.values().next().value;
      if (oldest) {
        oldest.close();
        active.delete(oldest);
      }
    }
    const release = () => active.delete(notification);
    notification.once("close", release);
    notification.once("failed", (_event, error) => {
      release();
      // macOS refuses an app without a valid signature, or one the user has
      // switched off, here — never at `show()`.
      console.error("Notification failed:", error);
    });
    notification.once("click", () => {
      release();
      const window = showWindow();
      if (!target || !window || window.isDestroyed()) return;
      window.webContents.send(notificationChannels.open, target);
    });
    notification.show();
    return true;
  } catch {
    // An unsupported/denied native notification must not break its caller.
    return false;
  }
}

/**
 * `show` brings the app's window forward — making one if none is open — and
 * answers with it, for a click to navigate.
 */
export function registerNotifications(
  devUrl: string | undefined,
  show: () => BrowserWindow | null,
): void {
  showWindow = show;

  handle(
    notificationChannels.get,
    devUrl,
    async (): Promise<NotificationSettings> => readSettings(),
  );

  handle(
    notificationChannels.set,
    devUrl,
    async (args): Promise<NotificationSettings> => {
      if (args.length !== 2)
        throw new Error("A notification and a delivery are required.");
      const [kind, delivery] = args;
      if (!isNotificationKind(kind))
        throw new Error("That is not a notification.");
      if (!isNotificationDelivery(delivery))
        throw new Error("That is not a way to deliver a notification.");
      const next = { ...(await readSettings()), [kind]: delivery };
      cache = next;
      await persist(next);
      return next;
    },
  );

  // ⚠️ Past the settings and the focus check on purpose: it answers "can
  // this Mac show Lanework's notifications at all", whatever the rows say.
  handle(notificationChannels.test, devUrl, (args): boolean => {
    if (args.length) throw new Error("This operation takes no arguments");
    if (!Notification.isSupported()) return false;
    return deliver(
      "Lanework",
      "Test notification — notifications from Lanework will look like this.",
      null,
    );
  });

  handle(notificationChannels.location, devUrl, (args): void => {
    const [path] = args;
    if (args.length !== 1 || typeof path !== "string" || path.length > 2000)
      throw new Error("A path is required.");
    location = path;
  });
}
