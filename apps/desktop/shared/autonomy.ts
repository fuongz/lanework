// The autonomy dial (PD-08): one level per project that sets how far an
// agent handed a card may go on its own, learned from nanochat's single
// `--depth` dial. The level derives four knobs; a person may still turn one
// knob by hand, and the dial then reads "Custom".
//
// Stored per project in `<project folder>/autonomy.json`. No file means the
// dial is not set: agents follow the repo's own rules and their CLI's own
// settings, as before the dial existed.

import { isPermission, type Permission } from "./conversation";

/**
 * - `ask`: the agent asks for everything; nothing is approved for it.
 * - `recommended`: recommended decisions are approved when a card is
 *   assigned, edits go through, commands still ask.
 * - `full`: no prompts; the agent commits locally and moves the card to
 *   review once verified.
 * - `overnight`: `full`, and it keeps going until the checklist or budget is
 *   done. NOTE: The keep-going part needs FE-172's card loop; until that
 *   ships, `overnight` sets exactly what `full` sets.
 */
export const AUTONOMY_LEVELS = [
  "ask",
  "recommended",
  "full",
  "overnight",
] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** What the dial sets (PD-08/D2). */
export interface AutonomyKnobs {
  /** The permission mode an assigned agent starts in. */
  permission: Permission;
  /** Approve a card's recommended decisions on assign, without the dialog. */
  autoApprove: boolean;
  /** The agent may commit locally (never push). */
  commit: boolean;
  /** The agent moves the card to the review lane once it is verified. */
  toReview: boolean;
}

export const AUTONOMY_KNOBS = [
  "permission",
  "autoApprove",
  "commit",
  "toReview",
] as const satisfies readonly (keyof AutonomyKnobs)[];

/** Each level's knobs. Looser levels never set a knob tighter. */
export const LEVEL_KNOBS: Record<AutonomyLevel, AutonomyKnobs> = {
  ask: {
    permission: "manual",
    autoApprove: false,
    commit: false,
    toReview: false,
  },
  recommended: {
    permission: "acceptEdits",
    autoApprove: true,
    commit: false,
    toReview: true,
  },
  full: {
    permission: "bypassPermissions",
    autoApprove: true,
    commit: true,
    toReview: true,
  },
  overnight: {
    permission: "bypassPermissions",
    autoApprove: true,
    commit: true,
    toReview: true,
  },
};

export const AUTONOMY_COPY: Record<
  AutonomyLevel,
  { label: string; description: string }
> = {
  ask: {
    label: "Ask",
    description:
      "Asks before every command and edit. You approve the card's decisions yourself.",
  },
  recommended: {
    label: "Recommended",
    description:
      "Approves the recommended decisions and accepts edits. Commands still ask.",
  },
  full: {
    label: "Full",
    description:
      "No prompts. Commits locally and moves the card to review once it is verified.",
  },
  overnight: {
    label: "Overnight",
    description:
      "As Full, and keeps going until the checklist is done. Keeping going needs the card loop, coming next.",
  },
};

/**
 * The permission an agent the app starts on its own (an assigned card, an
 * automation run) may have in a folder (FE-173/D3).
 *
 * NOTE: A folder its CLI does not trust still hands the agent the repo's own
 * words: CLAUDE.md, AGENTS.md, the code. With nobody approving commands,
 * those words could steer it into running anything, so an untrusted folder
 * starts Supervised whatever the dial or the automation says.
 */
export function permissionInFolder(
  permission: Permission,
  trusted: boolean,
): Permission {
  return trusted ? permission : "manual";
}

/** A project's dial as stored. */
export interface AutonomySettings {
  level: AutonomyLevel;
  /** Knobs turned by hand away from the level's own value (PD-08/D4). */
  overrides: Partial<AutonomyKnobs>;
}

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return AUTONOMY_LEVELS.includes(value as AutonomyLevel);
}

/**
 * The knobs `settings` comes to: its level's, with the overrides on top.
 * An override equal to the level's value is dropped, so it never reads as
 * Custom.
 */
export function effectiveKnobs(settings: AutonomySettings): AutonomyKnobs {
  return { ...LEVEL_KNOBS[settings.level], ...settings.overrides };
}

/** The overrides that differ from `level`'s own knobs. */
export function realOverrides(
  level: AutonomyLevel,
  overrides: Partial<AutonomyKnobs>,
): Partial<AutonomyKnobs> {
  const out: Partial<AutonomyKnobs> = {};
  const base = LEVEL_KNOBS[level];
  for (const key of AUTONOMY_KNOBS) {
    const value = overrides[key];
    if (value !== undefined && value !== base[key])
      (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Whether a knob was turned away from the level: the dial reads Custom. */
export function isCustom(settings: AutonomySettings): boolean {
  return (
    Object.keys(realOverrides(settings.level, settings.overrides)).length > 0
  );
}

/**
 * Settings from a file or the page, checked field by field.
 *
 * @returns null when the level is missing or unknown. A knob of the wrong
 *   type is dropped, not fatal.
 */
export function checkAutonomySettings(value: unknown): AutonomySettings | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isAutonomyLevel(v.level)) return null;
  const raw =
    v.overrides && typeof v.overrides === "object"
      ? (v.overrides as Record<string, unknown>)
      : {};
  const overrides: Partial<AutonomyKnobs> = {};
  if (isPermission(raw.permission)) overrides.permission = raw.permission;
  for (const key of ["autoApprove", "commit", "toReview"] as const)
    if (typeof raw[key] === "boolean") overrides[key] = raw[key];
  return { level: v.level, overrides: realOverrides(v.level, overrides) };
}

/** Pushed to every window when a project's dial changes. */
export interface AutonomyEvent {
  project: string;
}

export const autonomyChannels = {
  get: "autonomy:get",
  set: "autonomy:set",
  /** Main → renderer: a project's dial changed. */
  changed: "autonomy:changed",
} as const;

export interface DesktopAutonomyApi {
  /** A project's dial, or null when it is not set. */
  get: (project: string) => Promise<AutonomySettings | null>;
  /**
   * Set a project's dial, or clear it with null (agents go back to the
   * repo's rules and their CLI's settings).
   *
   * @returns What was stored, overrides equal to the level dropped.
   */
  set: (
    project: string,
    settings: AutonomySettings | null,
  ) => Promise<AutonomySettings | null>;
  onChanged: (listener: (event: AutonomyEvent) => void) => () => void;
}
