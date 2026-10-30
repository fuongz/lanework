import {
  Copy01Icon,
  Loading03Icon,
  MultiplicationSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useHarnessAccounts } from "#/components/shared/agents/harness-account";
import { HARNESS_NAMES } from "#/components/shared/agents/harness-island";
import {
  SETTINGS_BUTTON,
  SettingsPage,
  type SettingsRowSpec,
  type SettingsSectionSpec,
  SettingsValue,
} from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { Switch } from "#/components/ui/switch";
import { useClock } from "#/hooks/use-clock";
import { useCopy } from "#/hooks/use-copy";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import {
  claudeView,
  codexView,
  opencodeView,
  type UsageView,
} from "#/lib/agent-usage";
import { ipcMessage } from "#/lib/ipc-error";
import { relativeTime } from "#/lib/relative-time";
import { cn } from "#/lib/utils";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useBoard } from "#/stores/board";
import { useHarness, useHarnessWatch } from "#/stores/harness";
import {
  cloudAgents,
  MCP_CLI,
  MCP_LOGIN_COMMAND,
  type McpAuthView,
  mcpEntry,
  useMcpAuth,
  useMcpAuthWatch,
} from "#/stores/mcp-auth";
import { useCloudFeatures, useIsLocalMode } from "#/stores/session";
import type {
  LaneworkMcpAgent,
  LaneworkMcpStatus,
} from "../../../../shared/auth";
import type {
  AgentHookStatus,
  HandoffStatus,
  HookAgent,
} from "../../../../shared/handoff";
import type { HarnessAgent } from "../../../../shared/harness";
import { HarnessCard } from "./harness-section.card";

const NAMES: Record<HookAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/**
 * Each CLI under both of its names.
 *
 * The harness store says `claude`; the hook and the MCP entry say
 * `claude-code`. Both spellings sit here so a card reads every store with the
 * right key rather than guessing.
 */
const CLIS = [
  { harness: "claude", agent: "claude-code" },
  { harness: "codex", agent: "codex" },
  { harness: "opencode", agent: "opencode" },
] as const satisfies readonly { harness: HarnessAgent; agent: HookAgent }[];

const NO_HOOK: AgentHookStatus = {
  installed: false,
  settingsUnreadable: false,
  settingsPath: "",
  removedElsewhere: false,
};

/** Every word of a card's rows, so search finds a `content` section by them. */
const rowWords = (rows: SettingsRowSpec[]) =>
  rows
    .flatMap((row) => [row.label, row.description ?? "", row.keywords ?? ""])
    .join(" ");

/**
 * Settings › Agents › Harness: the coding agent CLIs Lanework runs.
 *
 * One card each, with its version and usage limits, its Lanework MCP entry
 * and its checkpoint hook; then what all of them share.
 *
 * NOTE: A switch per CLI, and pushing code is a third, separate choice that
 * starts off (FE-28/D3). A checkpoint is text, redacted on this machine.
 * Pushing the working tree to GitHub is a different kind of act, and nobody
 * should learn their unfinished work left the machine from the small print
 * under a switch they flipped for something else.
 *
 * NOTE: Codex runs a hook only once the user approves it in Codex. This page
 * reports whether Codex holds that approval and says how to give it. It never
 * gives it (FE-29/D7).
 *
 * The cards are `content` sections, so search cannot narrow them row by row:
 * a card matches on every word of its rows ({@link rowWords}) and shows whole.
 */
export function HarnessSection() {
  const accounts = useHarnessAccounts();
  const [status, setStatus] = useState<HandoffStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useClock();
  const [copied, copy] = useCopy();
  // "Approve in Codex" opens Codex in the app's own terminal, in the project
  // last open, so its hook review is one keypress away rather than a trip to
  // another window. The approval itself is still Codex's (FE-29/D7).
  const project = useBoard((state) => state.active);
  const projectKey = useWorkspaceKey(project?.slug);
  const startAgent = useAgentTerminals((state) => state.start);
  const navigate = useNavigate();
  const { signedIn } = useCloudFeatures();
  // The hook also runs in local mode, writing checkpoints to the local store,
  // so its switches stay. Only the credential row is cloud-only (FE-52/D9).
  const local = useIsLocalMode();
  const handoff = signedIn || local;

  // Which version of each CLI runs here and which is out: the same facts the
  // update island works from, with a way to ask again now.
  useHarnessWatch();
  const harness = useHarness((state) => state.list);
  const harnessLoaded = useHarness((state) => state.loaded);
  const checking = useHarness((state) => state.checking);
  const harnessError = useHarness((state) => state.error);
  const check = useHarness((state) => state.check);
  const checkedAt = harness
    .map((info) => info.checkedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);

  // The same usage the terminal bar's strip shows. Claude's is asked of its
  // account once when the page opens. Codex's is only what its newest turn in
  // the open project reported, so it needs a project. OpenCode Go's limits
  // come with Codex's read (FE-104/D10).
  const claudeUsage = useAgentSessions((state) => state.claudeUsage);
  const codexQuota = useAgentSessions((state) => state.codexQuota);
  const opencodeUsage = useAgentSessions((state) => state.opencodeUsage);
  const refreshClaude = useAgentSessions((state) => state.refreshClaudeUsage);
  const loadCodexUsage = useAgentSessions((state) => state.loadCodexUsage);
  useEffect(() => {
    void refreshClaude();
  }, [refreshClaude]);
  useEffect(() => {
    if (projectKey) void loadCodexUsage(projectKey);
  }, [projectKey, loadCodexUsage]);
  const usage: Record<HarnessAgent, UsageView | null> = {
    claude: claudeView(claudeUsage),
    codex: codexView(codexQuota, now),
    opencode: opencodeView(opencodeUsage, now),
  };

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

  // The `lanework` MCP entry in each agent's own config, and whether each CLI
  // is signed in to the cloud server (FE-52/D8). The same store the shell's
  // sign-in island reads.
  //
  // NOTE: Settings is outside the app shell, so it runs the watch itself.
  useMcpAuthWatch();
  const mcpStatus = useMcpAuth((state) => state.status);
  const setMcpStatus = useMcpAuth((state) => state.setStatus);
  const mcpAuth = useMcpAuth((state) => state.view);
  const checkMcpAuth = useMcpAuth((state) => state.check);
  const loginTo = useMcpAuth((state) => state.login);
  const cancelMcpLogin = useMcpAuth((state) => state.cancelLogin);
  const cloud = cloudAgents(mcpStatus);

  async function loginMcp(agent: LaneworkMcpAgent) {
    const auth = await loginTo(agent);
    setError(
      auth === "needs-login" || auth === "unknown"
        ? `${NAMES[agent]} did not finish signing in. Try again, or run ${MCP_LOGIN_COMMAND[agent]} in a terminal.`
        : null,
    );
  }

  async function runMcp(
    action: () => Promise<LaneworkMcpStatus>,
    fallback: string,
  ) {
    setBusy(true);
    try {
      setMcpStatus(await action());
      setError(null);
    } catch (failure) {
      setError(ipcMessage(failure, fallback));
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<HandoffStatus>, fallback: string) {
    setBusy(true);
    try {
      setStatus(await action());
      setError(null);
    } catch (failure) {
      setError(ipcMessage(failure, fallback));
    } finally {
      setBusy(false);
    }
  }

  const surface = window.desktop?.handoff;
  const mcpSurface = window.desktop?.laneworkMcp;
  // Local mode needs no credential: the hook writes locally (FE-52/D9).
  const blocked = !status?.supported || (!status.signedIn && !local);
  const anyOn =
    !!status &&
    (status.claude.installed ||
      status.codex.installed ||
      status.opencode.installed);

  const why = (hook: AgentHookStatus, what: string): string =>
    !status
      ? "Checking…"
      : !status.supported
        ? "Available on macOS for now: the hook's credential lives in the Keychain."
        : !status.signedIn && !local
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
            description: `Another tool removed it from ${hook.settingsPath}. Turn the switch on to add it back.`,
          },
        ]
      : [];

  const authRow = (
    agent: LaneworkMcpAgent,
    auth: McpAuthView | undefined,
  ): SettingsRowSpec => {
    const cli = MCP_CLI[agent];
    const name = NAMES[agent];
    const waiting = !auth || auth === "checking" || auth === "login";
    const attention = auth === "needs-login" || auth === "failed";
    const DESCRIPTION: Partial<Record<McpAuthView, string>> = {
      login: "Finish signing in in your browser.",
      "needs-login": "Signed out or expired. Log in again.",
      failed: "Could not reach the server. Check again or log in again.",
      "no-cli": `${cli} is not on your PATH.`,
      unknown: `Unknown. Run ${cli} mcp list to check.`,
    };
    const LABEL: Record<McpAuthView, string> = {
      "signed-in": "Signed in",
      "needs-login": "Needs login",
      failed: "Could not connect",
      login: "Waiting for browser…",
      "no-cli": "Not installed",
      unknown: "Could not check",
      checking: "Checking…",
    };
    return {
      label: "Lanework MCP sign-in",
      description:
        (auth && DESCRIPTION[auth]) ?? `${name} signs in through your browser.`,
      keywords:
        "mcp login sign in oauth authenticate token expired claude codex opencode",
      control: (
        // A login waiting on the browser: hovering it (or tabbing to it)
        // swaps the spinner for Stop.
        <div className="group/mcp-login flex items-center gap-3">
          <span
            className={
              attention
                ? "text-[13px] text-amber-600 dark:text-amber-400"
                : "text-muted-foreground text-[13px]"
            }
          >
            {LABEL[auth ?? "checking"]}
          </span>
          {auth === "login" ? (
            <div className="grid place-items-center">
              <HugeiconsIcon
                icon={Loading03Icon}
                className="text-muted-foreground size-3.5 animate-spin [grid-area:1/1] group-focus-within/mcp-login:opacity-0 group-hover/mcp-login:opacity-0 motion-reduce:animate-none"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <Button
                size="lg"
                className={cn(
                  SETTINGS_BUTTON,
                  "border-0 opacity-0 [grid-area:1/1] group-hover/mcp-login:opacity-100 focus-visible:opacity-100",
                )}
                variant="destructive"
                aria-label={`Stop signing ${name} in`}
                onClick={() => cancelMcpLogin(agent)}
              >
                <HugeiconsIcon
                  icon={MultiplicationSignIcon}
                  className="size-4"
                  strokeWidth={2}
                  aria-hidden="true"
                />
                Stop
              </Button>
            </div>
          ) : waiting ? (
            <HugeiconsIcon
              icon={Loading03Icon}
              className="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
              strokeWidth={1.5}
              aria-hidden="true"
            />
          ) : (
            <>
              {auth !== "needs-login" && (
                <Button
                  size="lg"
                  className={SETTINGS_BUTTON}
                  variant="outline"
                  disabled={auth === "no-cli"}
                  onClick={() => void checkMcpAuth(agent)}
                >
                  Check again
                </Button>
              )}
              {attention && (
                <Button
                  size="lg"
                  className={SETTINGS_BUTTON}
                  variant="outline"
                  onClick={() => void loginMcp(agent)}
                >
                  Log in
                </Button>
              )}
            </>
          )}
        </div>
      ),
    };
  };

  const mcpRows = (agent: LaneworkMcpAgent): SettingsRowSpec[] => {
    const entry = mcpEntry(mcpStatus, agent);
    const board: SettingsRowSpec = {
      label: "Lanework MCP",
      description: !mcpStatus
        ? "Checking…"
        : entry?.unreadable
          ? `${entry.configPath} can't be read. Fix it and try again.`
          : entry?.installed && !entry.ours
            ? `${entry.configPath} already has another lanework server.`
            : mcpStatus.want === "local"
              ? `Gives ${NAMES[agent]} the board's tools, for your local projects.`
              : `Gives ${NAMES[agent]} the board's tools.`,
      keywords:
        "mcp server lanework board tools claude codex opencode stdio local",
      control: (
        <Switch
          aria-label={`Lanework MCP — ${NAMES[agent]}`}
          checked={!!entry?.installed && !!entry.ours}
          disabled={
            !mcpSurface ||
            busy ||
            !entry ||
            entry.unreadable ||
            (entry.installed && !entry.ours)
          }
          onCheckedChange={(checked) =>
            mcpSurface &&
            void runMcp(
              () =>
                checked ? mcpSurface.install(agent) : mcpSurface.remove(agent),
              checked ? "Could not add it." : "Could not remove it.",
            )
          }
        />
      ),
    };
    return cloud.includes(agent)
      ? [board, authRow(agent, mcpAuth[agent])]
      : [board];
  };

  const claudeRows: SettingsRowSpec[] = [
    {
      label: "Save progress for the next agent",
      description: why(
        status?.claude ?? NO_HOOK,
        "Leaves a checkpoint on the card after each turn, so another agent can continue.",
      ),
      keywords: "handoff checkpoint resume quota usage limit claude hook stop",
      control: switchFor("claude-code", status?.claude),
    },
    ...removed(status?.claude),
  ];

  const codex = status?.codex;
  const codexRows: SettingsRowSpec[] = [
    {
      label: "Save progress for the next agent",
      description: why(
        codex ?? NO_HOOK,
        "Leaves a checkpoint on the card after each turn, so another agent can continue.",
      ),
      keywords: "codex handoff checkpoint resume hook",
      control: switchFor("codex", codex),
    },
    ...removed(codex),
    ...(codex?.installed && !codex.hooksEnabled
      ? [
          {
            label: "Hooks are off in Codex",
            description: `${codex.configPath} turns hooks off. Replace that line with this one.`,
            control: (
              <Button
                size="lg"
                className={SETTINGS_BUTTON}
                variant="outline"
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
              ? "Codex approved the hook."
              : project
                ? `Opens Codex in ${project.name}. Choose "Trust all and continue" when asked.`
                : "Open a project first, or approve the hook when Codex asks.",
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
                  size="lg"
                  className={SETTINGS_BUTTON}
                  variant="outline"
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

  // OpenCode's hook is a plugin file in its config folder, which OpenCode loads
  // on its next start (FE-104).
  const opencode = status?.opencode;
  const opencodeRows: SettingsRowSpec[] = [
    {
      label: "Save progress for the next agent",
      description: why(
        opencode ?? NO_HOOK,
        "Leaves a checkpoint on the card after each turn, so another agent can continue. Added as a plugin OpenCode loads when it starts.",
      ),
      keywords: "opencode handoff checkpoint resume hook plugin",
      control: switchFor("opencode", opencode),
    },
    ...removed(opencode),
  ];
  const HOOK_ROWS: Record<HookAgent, SettingsRowSpec[]> = {
    "claude-code": claudeRows,
    codex: codexRows,
    opencode: opencodeRows,
  };

  // Signed out without "Skip for now", a checkpoint has nowhere to land. The
  // switches go rather than sit disabled under a reason that reads like a
  // fault. The version and usage stay: they are local.
  const cardSections: SettingsSectionSpec[] = CLIS.map(
    ({ harness: kind, agent }) => {
      const info = harness.find((entry) => entry.agent === kind);
      const rows = handoff ? [...mcpRows(agent), ...HOOK_ROWS[agent]] : [];
      return {
        title: HARNESS_NAMES[kind],
        hideTitle: true,
        keywords: `${HARNESS_NAMES[kind]} ${kind} harness cli version update latest installed ready usage limit plan 5h weekly account email org organization signed in ${info?.installMethod ?? ""} ${info?.path ?? ""} ${rowWords(rows)}`,
        content: (
          <HarnessCard
            kind={kind}
            info={harnessLoaded ? (info ?? null) : undefined}
            usage={usage[kind]}
            account={accounts[kind]}
            now={now}
            rows={rows}
          />
        ),
      };
    },
  );

  const sections: SettingsSectionSpec[] = [...cardSections];

  if (handoff)
    sections.push({
      title: "All agents",
      rows: [
        {
          label: "Also push unfinished code to GitHub",
          // Tracked changes only: new files can be keys or scratch notes that
          // were never meant to leave the machine (FE-78/D9). And the ref is
          // as readable as the remote, which the old copy did not say.
          description:
            "Pushes uncommitted changes to files git already tracks to refs/lanework/wip/<task id>. New files stay on this machine. Anyone who can read the remote can fetch that ref. Your branches are untouched.",
          keywords:
            "push wip ref uncommitted code git remote cloud tracked untracked new files fetch",
          control: (
            <Switch
              aria-label="Also push unfinished code to GitHub"
              checked={status?.pushWip ?? false}
              disabled={!surface || busy || !anyOn}
              onCheckedChange={(checked) =>
                surface &&
                void run(
                  // Main asks to confirm before turning this on (FE-78/D4),
                  // and the user may cancel. Read the state back rather than
                  // trusting the switch's new position.
                  async () => {
                    await surface.setPushWip(checked);
                    return surface.status();
                  },
                  "Could not change this.",
                )
              }
            />
          ),
        },
        {
          label: "Include new files",
          description:
            "Also pushes new files git does not ignore. A key or .env file that .gitignore misses would go too; the hook skips a push when it spots one.",
          keywords: "push wip untracked new files include secrets",
          control: (
            <Switch
              aria-label="Include new files in the pushed work"
              checked={status?.pushWipUntracked ?? false}
              disabled={!surface || busy || !status?.pushWip}
              onCheckedChange={(checked) =>
                surface &&
                void run(
                  // Main asks first (FE-78/D9); read the answer back.
                  async () => {
                    await surface.setPushWipUntracked(checked);
                    return surface.status();
                  },
                  "Could not change this.",
                )
              }
            />
          ),
        },
      ],
    });

  sections.push({
    title: "Updates",
    rows: [
      {
        label: "Check for updates",
        description: harnessError
          ? harnessError
          : checkedAt
            ? `Last checked ${relativeTime(checkedAt, now)}.`
            : "Lanework also checks on its own.",
        keywords:
          "check updates harness version latest claude codex opencode upgrade",
        control: (
          <Button
            size="lg"
            className={SETTINGS_BUTTON}
            variant="outline"
            disabled={checking || !window.desktop?.harness}
            aria-busy={checking}
            onClick={() => void check()}
          >
            {checking && (
              <HugeiconsIcon
                icon={Loading03Icon}
                className="size-3.5 animate-spin motion-reduce:animate-none"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            )}
            {checking ? "Checking…" : "Check for updates"}
          </Button>
        ),
      },
    ],
  });

  if (handoff && anyOn && status)
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
        ...(status.opencode.installed
          ? [
              {
                label: "OpenCode plugin",
                description: "Where OpenCode finds it.",
                control: (
                  <SettingsValue>{status.opencode.settingsPath}</SettingsValue>
                ),
              },
            ]
          : []),
        ...(local
          ? []
          : [
              {
                label: "Credential",
                description: status.credential
                  ? "Stored in the Keychain."
                  : "Missing. Turn a switch off and on again.",
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
            ]),
        {
          label: "Last checkpoint",
          description: "From the last turn that worked on a card.",
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

  if (handoff)
    sections.push({
      title: "Resuming",
      rows: [
        {
          label: "Hand a card to another agent",
          description: "Tell any connected agent: resume <task id>.",
          keywords: "resume codex claude opencode command",
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
      title="Harness"
      description={
        handoff
          ? "Coding agents, their versions, usage and handoff."
          : "Coding agents, their versions and usage."
      }
      sections={sections}
    />
  );
}
