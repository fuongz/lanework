import { useCallback, useEffect, useState } from "react";
import {
  SettingsPage,
  SettingsValue,
} from "#/components/shared/settings/settings-page";
import { Switch } from "#/components/ui/switch";
import { relativeTime } from "#/lib/board-view";
import { ipcMessage } from "#/lib/ipc-error";
import type { HandoffStatus } from "../../../../shared/handoff";

/**
 * Handing a card from one agent to the next (FE-28).
 *
 * ⚠️ Two switches, deliberately. The first keeps a checkpoint on the card —
 * text, redacted on this machine. The second PUSHES CODE to GitHub, which is a
 * different kind of act, so it is its own choice and starts off (FE-28/D3):
 * nobody should learn their unfinished work left the machine by reading a
 * description under a switch they flipped for something else.
 */
export function AgentsSection() {
  const [status, setStatus] = useState<HandoffStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const surface = window.desktop?.handoff;
    if (!surface) return;
    setStatus(await surface.status());
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void refresh().catch((failure: unknown) =>
      setError(ipcMessage(failure, "Could not read the hook's state.")),
    );
  }, [refresh]);

  async function run(action: () => Promise<HandoffStatus>, fallback: string) {
    setBusy(true);
    try {
      setStatus(await action());
      setError(null);
    } catch (failure) {
      setError(ipcMessage(failure, fallback));
    } finally {
      setBusy(false);
      setNow(Date.now());
    }
  }

  const surface = window.desktop?.handoff;
  const on = status?.installed ?? false;
  const blocked = !status?.supported || !status.signedIn;

  const mainDescription = !status
    ? "Checking…"
    : !status.supported
      ? "Available on macOS for now: the hook's credential lives in the Keychain."
      : !status.signedIn
        ? "Sign in first — the hook uses this machine's credential."
        : status.settingsUnreadable
          ? `${status.settingsPath} is not valid JSON. Fix or remove it and Lanework can add the hook; it will not overwrite the file.`
          : "After every turn, Claude Code leaves a checkpoint on the card it is working on. If it stops — out of usage, or you switch to Codex — the next agent picks up from there. Costs no usage, and secrets are removed on this machine first.";

  return (
    <SettingsPage
      title="Agents"
      description="Let one coding agent pick up where another stopped."
      sections={[
        {
          title: "Claude Code",
          rows: [
            {
              label: "Save progress for the next agent",
              description: mainDescription,
              keywords:
                "handoff checkpoint resume quota usage limit codex claude hook stop",
              control: (
                <Switch
                  aria-label="Save progress for the next agent"
                  checked={on}
                  disabled={
                    !surface ||
                    busy ||
                    blocked ||
                    (!on && !!status?.settingsUnreadable)
                  }
                  onCheckedChange={(checked) =>
                    surface &&
                    void run(
                      checked ? surface.enable : surface.disable,
                      checked
                        ? "Could not turn this on."
                        : "Could not turn this off.",
                    )
                  }
                />
              ),
            },
            {
              label: "Also push unfinished code to GitHub",
              description:
                "Pushes the uncommitted work — including new files that are not ignored — to refs/lanework/wip/<task id> on the repo's remote, so an agent on another machine or in the cloud gets the code too. No branch or commit of yours is touched.",
              keywords: "push wip ref uncommitted code git remote cloud",
              control: (
                <Switch
                  aria-label="Also push unfinished code to GitHub"
                  checked={status?.pushWip ?? false}
                  disabled={!surface || busy || !on}
                  onCheckedChange={(checked) =>
                    surface &&
                    void run(
                      () => surface.setPushWip(checked),
                      "Could not change this.",
                    )
                  }
                />
              ),
            },
          ],
        },
        ...(on && status
          ? [
              {
                title: "Status",
                rows: [
                  {
                    label: "Hook",
                    description: "Where Claude Code finds it.",
                    control: (
                      <SettingsValue>{status.settingsPath}</SettingsValue>
                    ),
                  },
                  {
                    label: "Credential",
                    description: status.credential
                      ? "This machine's credential, in the Keychain. Revoking the machine revokes the hook."
                      : "Missing or out of date. Turn the switch off and on again.",
                    control: (
                      <span
                        className={
                          status.credential
                            ? "text-muted-foreground text-[13px]"
                            : "text-destructive text-[13px]"
                        }
                      >
                        {status.credential ? "In the Keychain" : "Missing"}
                      </span>
                    ),
                  },
                  {
                    label: "Last checkpoint",
                    description:
                      "Only turns about a card count — the hook finds the card from the task id the agent worked on.",
                    control: (
                      <span className="text-muted-foreground text-[13px]">
                        {status.last
                          ? `${status.last.taskId} · ${relativeTime(status.last.at, now)}`
                          : "None yet"}
                      </span>
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          title: "Resuming",
          rows: [
            {
              label: "Hand a card to another agent",
              description:
                "Open the card and copy its resume command, or tell any agent connected to Lanework: resume <task id>.",
              keywords: "resume codex claude command",
            },
          ],
        },
        ...(error
          ? [
              {
                title: "Problem",
                content: (
                  <p role="alert" className="text-destructive text-[13px]">
                    {error}
                  </p>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
