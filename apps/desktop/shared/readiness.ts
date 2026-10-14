// Whether a project's folder is ready for an agent to work its board (FE-30):
// checked in the background each time a project is opened or switched to.

/** How much a failed check matters. */
export type ReadinessLevel = "blocker" | "warning" | "info";

export type ReadinessId =
  | "folder"
  | "agents-md"
  | "claude-md"
  | "claude-mcp"
  | "codex-mcp"
  | "hook"
  | "legacy-reviews";

/**
 * A file the app offers to change in the project's folder (FE-30/D5).
 *
 * ⚠️ Only these three, only in the folder, and only after the diff was shown.
 * `~/.claude.json` and Codex's `config.toml` are the user's own and get an
 * instruction instead.
 */
export type ReadinessFix = "agents-md" | "claude-md" | "mcp-json";

export const READINESS_FIXES: readonly ReadinessFix[] = [
  "agents-md",
  "claude-md",
  "mcp-json",
];

export function isReadinessFix(value: unknown): value is ReadinessFix {
  return READINESS_FIXES.includes(value as ReadinessFix);
}

/** What a check that writes no file offers instead: a settings page. */
export type ReadinessAction = "project-settings" | "agent-settings";

export interface ReadinessCheck {
  id: ReadinessId;
  level: ReadinessLevel;
  ok: boolean;
  title: string;
  /** What is wrong and what to do about it; empty when `ok`. */
  detail: string;
  fix: ReadinessFix | null;
  action: ReadinessAction | null;
}

export interface ReadinessReport {
  slug: string;
  /** The primary folder that was checked, for display; null when there is none. */
  folder: string | null;
  checkedAt: string;
  /**
   * Only the checks that apply: nothing about the folder's files when there
   * is no folder, nothing about Codex on a machine that has never run it.
   */
  checks: ReadinessCheck[];
}

/** What a fix would write, shown before anything is written. */
export interface ReadinessPreview {
  fix: ReadinessFix;
  /** The file's name inside the folder, e.g. `AGENTS.md`. */
  file: string;
  /** The file as it is now; null when it does not exist yet. */
  before: string | null;
  after: string;
}

export const readinessChannels = {
  check: "readiness:check",
  preview: "readiness:preview",
  apply: "readiness:apply",
} as const;

export interface DesktopReadinessApi {
  check: (slug: string) => Promise<ReadinessReport>;
  preview: (slug: string, fix: ReadinessFix) => Promise<ReadinessPreview>;
  /**
   * Write the previewed change. `before` is the file as the preview showed
   * it: if the file has changed since, nothing is written and this throws.
   */
  apply: (
    slug: string,
    fix: ReadinessFix,
    before: string | null,
  ) => Promise<ReadinessReport>;
}

/** The count the indicator shows: failed checks that are not just information. */
export function readinessProblems(report: ReadinessReport | null): {
  blockers: number;
  warnings: number;
} {
  let blockers = 0;
  let warnings = 0;
  for (const check of report?.checks ?? []) {
    if (check.ok) continue;
    if (check.level === "blocker") blockers++;
    else if (check.level === "warning") warnings++;
  }
  return { blockers, warnings };
}
