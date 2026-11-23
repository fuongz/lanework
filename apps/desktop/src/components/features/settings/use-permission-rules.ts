import { useCallback, useEffect, useState } from "react";
import type { AutoAllowEntry, PermissionRule } from "#/../shared/permissions";
import { ipcMessage } from "#/lib/ipc-error";

/** A project's permission rules and its audit list (FE-165). */
export interface PermissionRules {
  /** Null until the first read answers. */
  rules: PermissionRule[] | null;
  /** Oldest first, as main keeps it; null until read. */
  audit: AutoAllowEntry[] | null;
  error: string | null;
  /** Add or replace a rule by id; the message of a refusal, else null. */
  save: (rule: PermissionRule) => Promise<string | null>;
  remove: (id: string) => Promise<string | null>;
}

/**
 * Read `project`'s rules and audit list once, and again only when main says
 * they changed (`permissions.onChange`). Never on a timer or a focus.
 *
 * @param project The project's key, its cloud id or slug.
 */
export function usePermissionRules(project: string | null): PermissionRules {
  const [rules, setRules] = useState<PermissionRule[] | null>(null);
  const [audit, setAudit] = useState<AutoAllowEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRules(null);
    setAudit(null);
    setError(null);
    const surface = window.desktop?.permissions;
    if (!surface || !project) return;
    let gone = false;
    const read = () => {
      surface.list(project).then(
        (next) => {
          if (gone) return;
          setRules(next);
          setError(null);
        },
        (failure: unknown) =>
          !gone &&
          setError(ipcMessage(failure, "Could not read the permission rules.")),
      );
      surface.audit(project).then(
        (next) => !gone && setAudit(next),
        (failure: unknown) =>
          !gone &&
          setError(ipcMessage(failure, "Could not read the audit list.")),
      );
    };
    read();
    const off = surface.onChange((event) => {
      if (event.project === project) read();
    });
    return () => {
      gone = true;
      off();
    };
  }, [project]);

  const save = useCallback(
    async (rule: PermissionRule) => {
      const surface = window.desktop?.permissions;
      if (!surface || !project) return "Could not reach the desktop app.";
      try {
        setRules(await surface.save(project, rule));
        return null;
      } catch (failure) {
        return ipcMessage(failure, "Could not save the rule.");
      }
    },
    [project],
  );

  const remove = useCallback(
    async (id: string) => {
      const surface = window.desktop?.permissions;
      if (!surface || !project) return "Could not reach the desktop app.";
      try {
        setRules(await surface.remove(project, id));
        return null;
      } catch (failure) {
        return ipcMessage(failure, "Could not remove the rule.");
      }
    },
    [project],
  );

  return { rules, audit, error, save, remove };
}
