import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useCopy } from "#/components/shared/common/use-copy";
import {
  SettingsPage,
  type SettingsRowSpec,
  type SettingsSectionSpec,
  SettingsValue,
} from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { Switch } from "#/components/ui/switch";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { relativeTime } from "#/lib/board-view";
import { ipcMessage } from "#/lib/ipc-error";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useBoard } from "#/stores/board";
import type {
  AgentHookStatus,
  HandoffStatus,
  HookAgent,
} from "../../../../shared/handoff";

const NAMES: Record<HookAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * Handing a card from one agent to the next (FE-28, FE-29).
 *
 * ⚠️ A switch per CLI, and pushing code as a third, separate choice that
 * starts off (FE-28/D3). A checkpoint is text, redacted on this machine;
 * pushing the working tree to GitHub is a different kind of act, and nobody
 * should learn their unfinished work left the machine by reading the small
 * print under a switch they flipped for something else.
 *
 * ⚠️ Codex runs a hook only once the user approves it in Codex. This page
 * reports whether Codex holds that approval and says how to give it — it
 * never gives it (FE-29/D7).
 */
export function AgentsSection() {
  const [status, setStatus] = useState<HandoffStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, copy] = useCopy();
  // "Approve in Codex" opens Codex in the app's own terminal, in the project
  // last open, so its hook review is one keypress away rather than a trip to
  // another window (FE-29). The approval itself is still Codex's (D7).
  const project = useBoard((state) => state.active);
  const projectKey = useWorkspaceKey(project?.slug);
  const startAgent = useAgentTerminals((state) => state.start);
  const navigate = useNavigate();

  async function approveInCodex() {
    if (!project || !projectKey) return;
    setBusy(true);
    try {
      const session = await startAgent(projectKey, "codex");
      if (!session) {
        setError(
          useAgentTerminals.getState().error ??
            "Could not start Codex in this project.",
        );
        return;
      }
      void navigate({
        to: "/w/$slug/agents/$terminalId",
        params: { slug: project.slug, terminalId: session.id },
      });
    } finally {
      setBusy(false);
    }
  }

  const refresh = useCallback(async () => {
    const surface = window.desktop?.handoff;
    if (!surface) return;
    setStatus(await surface.status());
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void refresh().catch((failure: unknown) =>
      setError(ipcMessage(failure, "Could not read the hooks' state.")),
    );
    // Approving the hook happens in Codex, so look again when the user
    // comes back to this window.
    const again = () => void refresh().catch(() => undefined);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
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
  const blocked = !status?.supported || !status.signedIn;
  const anyOn = !!status && (status.claude.installed || status.codex.installed);

  const why = (hook: AgentHookStatus, what: string): string =>
    !status
      ? "Checking…"
      : !status.supported
        ? "Available on macOS for now: the hook's credential lives in the Keychain."
        : !status.signedIn
          ? "Sign in first — the hook uses this machine's credential."
          : hook.settingsUnreadable
            ? `${hook.settingsPath} is not valid JSON. Fix or remove it and Lanework can add the hook; it will not overwrite the file.`
            : what;

  const switchFor = (agent: HookAgent, hook: AgentHookStatus | undefined) => (
    <Switch
      aria-label={`Save progress for the next agent — ${NAMES[agent]}`}
      checked={hook?.installed ?? false}
      disabled={
        !surface ||
        busy ||
        blocked ||
        (!hook?.installed && !!hook?.settingsUnreadable)
      }
      onCheckedChange={(checked) =>
        surface &&
        void run(
          () => (checked ? surface.enable(agent) : surface.disable(agent)),
          checked ? "Could not turn this on." : "Could not turn this off.",
        )
      }
    />
  );

  const removed = (hook: AgentHookStatus | undefined): SettingsRowSpec[] =>
    hook?.removedElsewhere
      ? [
          {
            label: "Removed by another tool",
            description: `Something rewrote ${hook.settingsPath} and our hook is no longer in it. Lanework will not put it back on its own — turn the switch on again if you want it.`,
          },
        ]
      : [];

  const codex = status?.codex;
  const codexRows: SettingsRowSpec[] = [
    {
      label: "Save progress for the next agent",
      description: why(
        codex ?? {
          installed: false,
          settingsUnreadable: false,
          settingsPath: "",
          removedElsewhere: false,
        },
        "After every turn, Codex leaves a checkpoint on the card it is working on, so Claude Code — or Codex on another machine — can pick up from there.",
      ),
      keywords: "codex handoff checkpoint resume hook",
      control: switchFor("codex", codex),
    },
    ...removed(codex),
    ...(codex?.installed && !codex.hooksEnabled
      ? [
          {
            label: "Hooks are off in Codex",
            description: `${codex.configPath} turns hooks off, so Codex runs no hook. Change that line to this one; Lanework does not edit that file.`,
            control: (
              <Button
                variant="outline"
                size="sm"
                onClick={() => copy("feature", status?.codexFeatureLine ?? "")}
              >
                <HugeiconsIcon
                  icon={copied === "feature" ? Tick02Icon : Copy01Icon}
                  className="size-3.5"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
                {copied === "feature" ? "Copied" : "Copy the line"}
              </Button>
            ),
          },
        ]
      : []),
    ...(codex?.installed
      ? [
          {
            label: "Approved in Codex",
            description: codex.approved
              ? "Codex has approved this hook. Updating Lanework keeps the approval."
              : project
                ? `Codex runs a new hook only after you approve it. This opens Codex in ${project.name}; when it asks about hooks, choose "Trust all and continue" — or "Review hooks" to approve only Lanework's.`
                : "Codex runs a new hook only after you approve it. Open a project first, then come back here — or start Codex yourself and approve Lanework's hook when it asks.",
            control: codex.approved ? (
              <span className="text-muted-foreground text-[13px]">
                Approved
              </span>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-[13px] text-amber-600 dark:text-amber-400">
                  Waiting for approval
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !project || !projectKey}
                  onClick={() => void approveInCodex()}
                >
                  Approve in Codex
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  const sections: SettingsSectionSpec[] = [
    {
      title: "Claude Code",
      rows: [
        {
          label: "Save progress for the next agent",
          description: why(
            status?.claude ?? {
              installed: false,
              settingsUnreadable: false,
              settingsPath: "",
              removedElsewhere: false,
            },
            "After every turn, Claude Code leaves a checkpoint on the card it is working on. If it stops — out of usage, or you switch to Codex — the next agent picks up from there. Costs no usage, and secrets are removed on this machine first.",
          ),
          keywords:
            "handoff checkpoint resume quota usage limit claude hook stop",
          control: switchFor("claude-code", status?.claude),
        },
        ...removed(status?.claude),
      ],
    },
    { title: "Codex", rows: codexRows },
    {
      title: "Both agents",
      rows: [
        {
          label: "Also push unfinished code to GitHub",
          description:
            "Pushes the uncommitted work — including new files that are not ignored — to refs/lanework/wip/<task id> on the repo's remote, so an agent on another machine or in the cloud gets the code too. No branch or commit of yours is touched.",
          keywords: "push wip ref uncommitted code git remote cloud",
          control: (
            <Switch
              aria-label="Also push unfinished code to GitHub"
              checked={status?.pushWip ?? false}
              disabled={!surface || busy || !anyOn}
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
  ];

  if (anyOn && status)
    sections.push({
      title: "Status",
      rows: [
        ...(status.claude.installed
          ? [
              {
                label: "Claude Code hook",
                description: "Where Claude Code finds it.",
                control: (
                  <SettingsValue>{status.claude.settingsPath}</SettingsValue>
                ),
              },
            ]
          : []),
        ...(status.codex.installed
          ? [
              {
                label: "Codex hook",
                description: "Where Codex finds it.",
                control: (
                  <SettingsValue>{status.codex.settingsPath}</SettingsValue>
                ),
              },
            ]
          : []),
        {
          label: "Credential",
          description: status.credential
            ? "This machine's credential, in the Keychain. Revoking the machine revokes the hook."
            : "Missing or out of date. Turn a switch off and on again.",
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
                ? `${status.last.taskId}, ${relativeTime(status.last.at, now)}`
                : "None yet"}
            </span>
          ),
        },
      ],
    });

  sections.push({
    title: "Resuming",
    rows: [
      {
        label: "Hand a card to another agent",
        description:
          "Open the card and copy its resume command, or tell any agent connected to Lanework: resume <task id>.",
        keywords: "resume codex claude command",
      },
    ],
  });

  if (error)
    sections.push({
      title: "Problem",
      content: (
        <p role="alert" className="text-destructive text-[13px]">
          {error}
        </p>
      ),
    });

  return (
    <SettingsPage
      title="Agents"
      description="Let one coding agent pick up where another stopped."
      sections={sections}
    />
  );
}
