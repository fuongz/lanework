import { SecurityCheckIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import type { AutomationAgent } from "#/../shared/automations";
import { Button } from "#/components/ui/button";
import { ipcMessage } from "#/lib/ipc-error";

/** What trusting loads, in the words the chat's own notice uses. */
const LOADS: Record<AutomationAgent, string> = {
  claude: "the project’s .claude settings",
  codex: "the project’s .codex config and AGENTS.md",
};

const NAMES: Record<AutomationAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * Says when the automation's agent does not trust the project's folder
 * (FE-173/D4), with a button to trust it. Nothing while trusted, or while
 * the read is pending or failed.
 *
 * NOTE: A run nobody watches starts Supervised in an untrusted folder
 * (FE-173/D3), so it may wait on a permission until its timeout. Trusting
 * writes the CLI's own record (FE-101), the one its trust screen writes.
 */
export function AutomationTrust({
  slug,
  agent,
}: {
  slug: string | null;
  agent: AutomationAgent;
}) {
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    setTrusted(null);
    setError(null);
    const setup = window.desktop?.agentSetup;
    if (!slug || !setup) return;
    void setup
      .trust(slug)
      .then((found) => {
        // A project with no folder here has nothing to trust.
        if (!gone) setTrusted(found.folder ? found[agent].trusted : null);
      })
      .catch(() => {
        if (!gone) setTrusted(null);
      });
    return () => {
      gone = true;
    };
  }, [slug, agent]);

  if (trusted !== false || !slug) return null;
  const name = NAMES[agent];

  const trust = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await window.desktop?.agentSetup.setTrust(
        slug,
        agent,
        true,
      );
      setTrusted(found ? found[agent].trusted : true);
    } catch (caught) {
      setError(ipcMessage(caught, "Could not trust this folder."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="border-border flex items-start gap-3 rounded-lg border px-3.5 py-3"
    >
      <HugeiconsIcon
        icon={SecurityCheckIcon}
        className="text-muted-foreground mt-0.5 size-4 shrink-0"
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-[13px] font-medium">
          {name} doesn’t trust this project’s folder
        </p>
        <p className="text-muted-foreground text-xs/relaxed">
          Runs start in Supervised mode without {LOADS[agent]}, so a run may
          wait on a permission nobody answers until its timeout. Trust the
          folder to run with the permission set here.
        </p>
        {error && (
          <p role="alert" className="text-destructive text-xs/relaxed">
            {error}
          </p>
        )}
      </div>
      <Button
        size="sm"
        variant="outline"
        className="self-center"
        disabled={busy}
        onClick={() => void trust()}
      >
        {busy ? "Trusting…" : "Trust this folder"}
      </Button>
    </div>
  );
}
