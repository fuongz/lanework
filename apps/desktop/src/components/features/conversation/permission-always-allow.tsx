import { useMemo, useState } from "react";
import type { PermissionRule } from "#/../shared/permissions";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Switch } from "#/components/ui/switch";
import { ipcMessage } from "#/lib/ipc-error";
import { draftProblem, suggestRule } from "#/lib/permission-rules";

/**
 * "Always allow…" on a permission card (FE-165): the rule this request
 * suggests, ready to edit, and Save and allow.
 *
 * Saving creates an Allow rule for the project (optionally for this conductor
 * only), then allows this request.
 */
export function PermissionAlwaysAllow({
  project,
  tool,
  input,
  conductor,
  onAllow,
  onCancel,
}: {
  /** The project's key. */
  project: string;
  tool: string;
  /** The request's input JSON, which the suggestion reads. */
  input: string;
  /** The conductor whose conversation this is; null for any other. */
  conductor: string | null;
  /** Answers this request with Allow. */
  onAllow: () => Promise<void>;
  onCancel: () => void;
}) {
  const suggested = useMemo(() => suggestRule(tool, input), [tool, input]);
  const [name, setName] = useState(suggested.tool);
  const [pattern, setPattern] = useState(suggested.pattern);
  const [only, setOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problem = draftProblem({ tool: name, pattern });

  const save = async () => {
    const surface = window.desktop?.permissions;
    if (!surface || problem) return;
    setBusy(true);
    setFailure(null);
    const rule: PermissionRule = {
      id: `rule-${crypto.randomUUID()}`,
      effect: "allow",
      tool: name.trim(),
      ...(pattern.trim() ? { pattern: pattern.trim() } : {}),
      ...(only && conductor ? { conductor } : {}),
      createdAt: new Date().toISOString(),
    };
    try {
      await surface.save(project, rule);
    } catch (caught) {
      setFailure(ipcMessage(caught, "Could not save the rule."));
      setBusy(false);
      return;
    }
    // The rule is kept; this request goes through as asked.
    await onAllow();
    setBusy(false);
  };

  return (
    <form
      aria-label="Always allow"
      className="bg-foreground/[0.04] flex flex-col gap-2.5 rounded-lg p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-2">
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Tool</span>
          <Input
            aria-label="Tool"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            className="font-mono"
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">
            Pattern, empty for the whole tool
          </span>
          <Input
            aria-label="Pattern"
            value={pattern}
            disabled={busy}
            onChange={(event) => setPattern(event.target.value)}
            className="font-mono"
            spellCheck={false}
            placeholder="Any use of the tool"
          />
        </div>
      </div>
      {conductor && (
        <div className="flex items-center gap-2 text-xs">
          <Switch
            size="sm"
            aria-label="Only for this conductor"
            checked={only}
            disabled={busy}
            onCheckedChange={setOnly}
          />
          <span aria-hidden="true">Only for this conductor</span>
        </div>
      )}
      {(problem || failure) && (
        <p role="alert" className="text-destructive text-xs leading-relaxed">
          {failure ?? problem}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 rounded-full px-4 text-[13px]"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="h-8 rounded-full px-5 text-[13px]"
          disabled={busy || problem !== null}
        >
          Save and allow
        </Button>
      </div>
    </form>
  );
}
