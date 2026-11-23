// Each project's permission rules and audit list (FE-165), kept in memory
// once read.
//
// - Read lazily: nothing is touched until a project's first request or call.
//   The result stays in memory; only our own writes change it. No watcher,
//   no polling: an edit to the file by hand is read at the next launch.
// - The file holds the user's rules only. The seeded Ask rules ship with the
//   app: listed first, never written, never removable.
// - Writes are atomic (a temp file, then a rename) and one at a time per
//   file.
// - The audit list is a ring of the newest AUTO_ALLOW_MAX entries per
//   project. A new entry is kept in memory at once and written later, by one
//   debounced async write: the permission path never waits on the disk.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AUTO_ALLOW_MAX,
  type AutoAllowEntry,
  PERMISSION_RULES_MAX,
  PERMISSION_RULES_VERSION,
  PermissionInputError,
  type PermissionRule,
  parseAutoAllowList,
  parsePermissionRule,
  parsePermissionRulesFile,
  SEEDED_ASK_RULES,
} from "../../../shared/permissions";
import { permissionAuditFile, permissionRulesFile } from "../paths";

/** How long new audit entries wait to be written together. */
const AUDIT_WRITE_DELAY_MS = 2_000;

export interface PermissionStoreDeps {
  /** The project's own folder under `<home>/projects`. */
  folderOf: (project: string) => Promise<string>;
  /** A project's rules or audit list changed. */
  changed: (project: string) => void;
}

interface Entry {
  /** The project keys that resolved here (an id and a slug may both). */
  keys: Set<string>;
  rulesFile: string;
  auditFile: string;
  /** The user's rules, once read. */
  rules: Promise<PermissionRule[]>;
  /** Set when the file could not be read: a save would overwrite it. */
  unreadable: string | null;
  /** Newest last; holds what was read, once {@link auditRead} settles. */
  audit: AutoAllowEntry[];
  auditRead: Promise<void> | null;
  auditTimer: ReturnType<typeof setTimeout> | null;
  /** The file's writes, one after another. */
  writes: Promise<void>;
}

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Write `text` to `file` through a temp file and a rename. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** A rule as the user's: never seeded, never a seeded rule's id. */
function own(rule: PermissionRule): boolean {
  return !rule.seeded && !rule.id.startsWith("seed:");
}

export class PermissionStore {
  /** By project key: the entry's rules file, once resolved. */
  private files = new Map<string, Promise<string>>();
  /** By rules file. */
  private entries = new Map<string, Entry>();

  constructor(private readonly deps: PermissionStoreDeps) {}

  private async entry(project: string): Promise<Entry> {
    let file = this.files.get(project);
    if (!file) {
      file = this.deps
        .folderOf(project)
        .then((folder) => permissionRulesFile(folder));
      this.files.set(project, file);
      // A failed lookup (signed out, offline) is tried again next time.
      file.catch(() => this.files.delete(project));
    }
    const rulesFile = await file;
    const found = this.entries.get(rulesFile);
    if (found) {
      found.keys.add(project);
      return found;
    }
    const created: Entry = {
      keys: new Set([project]),
      rulesFile,
      auditFile: permissionAuditFile(dirname(rulesFile)),
      rules: Promise.resolve([]),
      unreadable: null,
      audit: [],
      auditRead: null,
      auditTimer: null,
      writes: Promise.resolve(),
    };
    created.rules = this.readRules(created);
    this.entries.set(rulesFile, created);
    return created;
  }

  private async readRules(entry: Entry): Promise<PermissionRule[]> {
    let text: string;
    try {
      text = await readFile(entry.rulesFile, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      entry.unreadable = (error as Error).message;
      console.error(`Could not read ${entry.rulesFile}`, error);
      return [];
    }
    try {
      return parsePermissionRulesFile(JSON.parse(text)).rules.filter(own);
    } catch (error) {
      // A broken file answers nothing on its own; every request asks.
      entry.unreadable = (error as Error).message;
      console.error(`Could not read ${entry.rulesFile}`, error);
      return [];
    }
  }

  /**
   * The user's rules for `project`, as the matcher reads them: the seeded
   * Ask rules are not among them (it adds those itself).
   */
  async ownRules(project: string): Promise<readonly PermissionRule[]> {
    return (await this.entry(project)).rules;
  }

  /** Every rule for `project`, the seeded ones first. */
  async list(project: string): Promise<PermissionRule[]> {
    return [...SEEDED_ASK_RULES, ...(await this.ownRules(project))];
  }

  /**
   * Run `change` on the user's rules and write the result; the cache moves
   * only once the file did.
   */
  private async change(
    project: string,
    change: (rules: PermissionRule[]) => PermissionRule[],
  ): Promise<PermissionRule[]> {
    const entry = await this.entry(project);
    const run = entry.writes.then(async () => {
      if (entry.unreadable)
        throw new Error(
          `The rules file could not be read (${entry.unreadable}). Fix or delete ${entry.rulesFile} first.`,
        );
      const next = change([...(await entry.rules)]);
      await writeAtomic(
        entry.rulesFile,
        `${JSON.stringify({ version: PERMISSION_RULES_VERSION, rules: next }, null, 2)}\n`,
      );
      entry.rules = Promise.resolve(next);
    });
    entry.writes = run.catch(() => {});
    await run;
    for (const key of entry.keys) this.deps.changed(key);
    return this.list(project);
  }

  /**
   * Add `input` or replace the rule with its id.
   *
   * @throws {PermissionInputError} On a bad rule, a seeded one, or a full
   *   list.
   */
  save(project: string, input: unknown): Promise<PermissionRule[]> {
    const rule = parsePermissionRule(input);
    if (!own(rule))
      throw new PermissionInputError(
        "A seeded rule ships with the app and cannot be changed.",
      );
    return this.change(project, (rules) => {
      const at = rules.findIndex((entry) => entry.id === rule.id);
      if (at >= 0) rules[at] = rule;
      else if (rules.length >= PERMISSION_RULES_MAX)
        throw new PermissionInputError(
          `A project keeps at most ${PERMISSION_RULES_MAX} rules.`,
        );
      else rules.push(rule);
      return rules;
    });
  }

  /**
   * Remove rule `id`; an unknown id changes nothing.
   *
   * @throws {PermissionInputError} For a seeded rule.
   */
  remove(project: string, id: string): Promise<PermissionRule[]> {
    if (
      SEEDED_ASK_RULES.some((rule) => rule.id === id) ||
      id.startsWith("seed:")
    )
      throw new PermissionInputError(
        "A seeded rule ships with the app and cannot be removed.",
      );
    return this.change(project, (rules) =>
      rules.filter((rule) => rule.id !== id),
    );
  }

  // ─── Audit ──────────────────────────────────────────────────────────────

  /** Read the saved list once, under the entries already kept. */
  private readAudit(entry: Entry): Promise<void> {
    entry.auditRead ??= readFile(entry.auditFile, "utf8")
      .then((text) => parseAutoAllowList(JSON.parse(text)))
      .catch((error: unknown) => {
        if (!isMissing(error))
          console.error(`Could not read ${entry.auditFile}`, error);
        return [] as AutoAllowEntry[];
      })
      .then((saved) => {
        entry.audit = [...saved, ...entry.audit].slice(-AUTO_ALLOW_MAX);
      });
    return entry.auditRead;
  }

  /** The audit list of `project`, newest last. */
  async audit(project: string): Promise<AutoAllowEntry[]> {
    const entry = await this.entry(project);
    await this.readAudit(entry);
    return [...entry.audit];
  }

  /**
   * Keep one automatic allow. Returns at once: the write comes later.
   */
  record(project: string, item: AutoAllowEntry): void {
    void this.entry(project)
      .then((entry) => {
        entry.audit.push(item);
        if (entry.audit.length > AUTO_ALLOW_MAX)
          entry.audit.splice(0, entry.audit.length - AUTO_ALLOW_MAX);
        void this.readAudit(entry);
        this.scheduleAudit(entry);
        for (const key of entry.keys) this.deps.changed(key);
      })
      .catch((error: unknown) =>
        console.error("Could not keep a permission audit entry", error),
      );
  }

  private scheduleAudit(entry: Entry): void {
    if (entry.auditTimer) return;
    entry.auditTimer = setTimeout(() => {
      entry.auditTimer = null;
      void this.writeAudit(entry);
    }, AUDIT_WRITE_DELAY_MS);
    entry.auditTimer.unref?.();
  }

  private writeAudit(entry: Entry): Promise<void> {
    const run = entry.writes.then(async () => {
      await this.readAudit(entry);
      await writeAtomic(
        entry.auditFile,
        `${JSON.stringify(entry.audit, null, 2)}\n`,
      );
    });
    entry.writes = run.catch((error: unknown) =>
      console.error(`Could not write ${entry.auditFile}`, error),
    );
    return entry.writes;
  }

  /** Write every audit list still waiting: the app is quitting. */
  async flush(): Promise<void> {
    const waiting: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.auditTimer) continue;
      clearTimeout(entry.auditTimer);
      entry.auditTimer = null;
      waiting.push(this.writeAudit(entry));
    }
    await Promise.all(waiting);
  }
}
