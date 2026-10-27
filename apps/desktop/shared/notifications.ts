// OS notifications: an agent run finishing, a new pull request on a
// linked repository — each switched on or off from Settings → Notifications.

/** What can notify. One row each in Settings → Notifications. */
const NOTIFICATION_KINDS = ["sessions", "pulls"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * How a kind is delivered (FE-70/D1). `push` is the OS notification; there is
 * no in-app inbox for an "in-app" choice to mean anything yet.
 */
export const NOTIFICATION_DELIVERIES = ["push", "off"] as const;
export type NotificationDelivery = (typeof NOTIFICATION_DELIVERIES)[number];

export type NotificationSettings = Record<
  NotificationKind,
  NotificationDelivery
>;

/** Both on (FE-70/D6): a run finishing notified before this page existed. */
const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  sessions: "push",
  pulls: "push",
};

export function isNotificationKind(value: unknown): value is NotificationKind {
  return NOTIFICATION_KINDS.includes(value as NotificationKind);
}

export function isNotificationDelivery(
  value: unknown,
): value is NotificationDelivery {
  return NOTIFICATION_DELIVERIES.includes(value as NotificationDelivery);
}

/** Whatever was on disk, with anything unknown back at its default. */
export function checkNotificationSettings(
  value: unknown,
): NotificationSettings {
  const saved =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const out = { ...DEFAULT_NOTIFICATION_SETTINGS };
  for (const kind of NOTIFICATION_KINDS) {
    const delivery = saved[kind];
    if (isNotificationDelivery(delivery)) out[kind] = delivery;
  }
  return out;
}

/** Where clicking a notification takes the window (FE-70/D5). */
export type NotificationTarget =
  | { kind: "session"; slug: string; conversation: string }
  | { kind: "pull"; slug: string; number: number };

export const notificationChannels = {
  get: "notifications:get",
  set: "notifications:set",
  /** Show one now, whatever the settings say. */
  test: "notifications:test",
  /**
   * Renderer → main: the path on screen, so main skips a notification about
   * it (FE-70/D2a).
   */
  location: "notifications:location",
  /** Main → renderer: a notification was clicked, go to its target. */
  open: "notifications:open",
  /** The unseen pull requests per project, for the rail (FE-76). */
  unseenPulls: "notifications:unseen-pulls",
  /** Main → renderer: those counts changed. */
  unseenPullsChanged: "notifications:unseen-pulls-changed",
} as const;

export interface DesktopNotificationsApi {
  get: () => Promise<NotificationSettings>;
  set: (
    kind: NotificationKind,
    delivery: NotificationDelivery,
  ) => Promise<NotificationSettings>;
  /**
   * Show a test notification, ignoring the settings and the focus check.
   * False when this OS cannot show one.
   */
  test: () => Promise<boolean>;
  /**
   * Tell main which path the window shows. A notification about what is
   * already on screen in a focused window is not shown (FE-70/D2a).
   */
  reportLocation: (path: string) => void;
  onOpen: (listener: (target: NotificationTarget) => void) => () => void;
  /**
   * New pull requests, yours included, not seen yet, by project slug
   * (FE-76). A project with none is absent.
   */
  unseenPulls: () => Promise<Record<string, number>>;
  onUnseenPulls: (
    listener: (counts: Record<string, number>) => void,
  ) => () => void;
}
