import {
  Clock01Icon,
  Copy01Icon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { HARNESS_NAMES } from "#/components/shared/agents/harness-island";
import { useCopy } from "#/components/shared/common/use-copy";
import {
  SETTINGS_BUTTON,
  SettingsCard,
  SettingsPage,
  type SettingsRowSpec,
  type SettingsSectionSpec,
  SettingsValue,
} from "#/components/shared/settings/settings-page";
import {
  barTone,
  clamp,
  claudeView,
  codexView,
  NEARLY_SPENT,
  resetDuration,
  type UsageView,
  type UsageWindow,
  updatedText,
  useClock,
} from "#/components/shared/terminal/agent-usage-strip";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { Button } from "#/components/ui/button";
import { Switch } from "#/components/ui/switch";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { relativeTime } from "#/lib/board-view";
import { ipcMessage } from "#/lib/ipc-error";
import { cn } from "#/lib/utils";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useBoard } from "#/stores/board";
import { useHarness, useHarnessWatch } from "#/stores/harness";
import {
  cloudAgents,
  type McpAuthView,
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
import {
  compareVersions,
  type HarnessAccount,
  type HarnessAgent,
  type HarnessInfo,
  type InstallMethod,
} from "../../../../shared/harness";

const NAMES: Record<HookAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * Each CLI under both of its names: the harness store's (`claude`) and the
 * hook's and MCP entry's (`claude-code`). ⚠️ Two spellings of one agent, so a
 * card reads every store with the right key rather than guessing.
 */
const CLIS = [
  { harness: "claude", agent: "claude-code" },
  { harness: "codex", agent: "codex" },
] as const satisfies readonly { harness: HarnessAgent; agent: HookAgent }[];

/** How the CLI got here, after the version: "via Homebrew". */
const INSTALLED_WITH: Record<InstallMethod, string> = {
  native: "via the native installer",
  "brew-cask": "via a Homebrew cask",
  "brew-formula": "via Homebrew",
  npm: "via npm",
  unknown: "Install method unknown",
};

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
 * Settings › Agents › Harness: the coding agent CLIs Lanework runs, one card
 * each — its version and usage limits, its Lanework MCP entry and its
 * checkpoint hook — then what both share (FE-28, FE-29, FE-52, FE-61).
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
 *
 * ⚠️ The cards are `content` sections, so search cannot narrow them row by
 * row: a card matches on every word of its rows (`rowWords`) and shows whole.
 */
/**
 * Who each CLI is signed in as (`HarnessAccount`), read on opening the page
 * and again on coming back to the window — signing in happens in a terminal.
 */
function useAccounts(): Partial<Record<HarnessAgent, HarnessAccount>> {
  const [accounts, setAccounts] = useState<
    Partial<Record<HarnessAgent, HarnessAccount>>
  >({});
  useEffect(() => {
    const surface = window.desktop?.harness;
    if (!surface?.accounts) return;
    let live = true;
    const read = () =>
      void surface.accounts().then(
        (list) =>
          live &&
          setAccounts(
            Object.fromEntries(list.map((account) => [account.agent, account])),
          ),
        () => undefined,
      );
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, []);
  return accounts;
}

export function HarnessSection() {
  const accounts = useAccounts();
  const [status, setStatus] = useState<HandoffStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useClock();
  const [copied, copy] = useCopy();
  // "Approve in Codex" opens Codex in the app's own terminal, in the project
  // last open, so its hook review is one keypress away rather than a trip to
  // another window (FE-29). The approval itself is still Codex's (D7).
  const project = useBoard((state) => state.active);
  const projectKey = useWorkspaceKey(project?.slug);
  const startAgent = useAgentTerminals((state) => state.start);
  const navigate = useNavigate();
  const { signedIn } = useCloudFeatures();
  // FE-52/D9: the hook also runs in local mode, writing checkpoints to the
  // local store, so its switches stay. Only the credential row is cloud-only.
  const local = useIsLocalMode();
  const handoff = signedIn || local;

  // FE-61: which version of each CLI runs here and which is out — the same
  // facts the update island works from, with a way to ask again now.
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

  // FE-53, FE-41: the same usage the terminal bar's strip shows. Claude's is
  // asked of its account once when the page opens; Codex's is only what its
  // newest turn in the open project reported, so it needs a project.
  const claudeUsage = useAgentSessions((state) => state.claudeUsage);
  const codexQuota = useAgentSessions((state) => state.codexQuota);
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

  // FE-52/D8: the `lanework` MCP entry in each agent's own config, and
  // whether each CLI is signed in to the cloud server — the same store the
  // shell's sign-in island reads. ⚠️ Settings is outside the app shell, so
  // it runs the watch itself.
  useMcpAuthWatch();
  const mcpStatus = useMcpAuth((state) => state.status);
  const setMcpStatus = useMcpAuth((state) => state.setStatus);
  const mcpAuth = useMcpAuth((state) => state.view);
  const checkMcpAuth = useMcpAuth((state) => state.check);
  const loginTo = useMcpAuth((state) => state.login);
  const cloud = cloudAgents(mcpStatus);

  async function loginMcp(agent: LaneworkMcpAgent) {
    const auth = await loginTo(agent);
    setError(
      auth === "needs-login" || auth === "unknown"
        ? `${NAMES[agent]} did not finish signing in. Try again, or run ${agent === "codex" ? "codex" : "claude"} mcp login lanework in a terminal.`
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
  // FE-52/D9: local mode needs no credential — the hook writes locally.
  const blocked = !status?.supported || (!status.signedIn && !local);
  const anyOn = !!status && (status.claude.installed || status.codex.installed);

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
    const cli = agent === "codex" ? "codex" : "claude";
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
        "mcp login sign in oauth authenticate token expired claude codex",
      control: (
        <div className="flex items-center gap-3">
          <span
            className={
              attention
                ? "text-[13px] text-amber-600 dark:text-amber-400"
                : "text-muted-foreground text-[13px]"
            }
          >
            {LABEL[auth ?? "checking"]}
          </span>
          {waiting ? (
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
    const entry =
      agent === "claude-code" ? mcpStatus?.claude : mcpStatus?.codex;
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
      keywords: "mcp server lanework board tools claude codex stdio local",
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

  // FE-52: signed out without "Skip for now" there is nowhere for a checkpoint
  // to land, so the switches go rather than sitting disabled under a reason
  // that reads like a fault. The version and usage stay: they are local.
  const cardSections: SettingsSectionSpec[] = CLIS.map(
    ({ harness: kind, agent }) => {
      const info = harness.find((entry) => entry.agent === kind);
      const rows = handoff
        ? [...mcpRows(agent), ...(agent === "codex" ? codexRows : claudeRows)]
        : [];
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
      title: "Both agents",
      rows: [
        {
          label: "Also push unfinished code to GitHub",
          description:
            "Pushes uncommitted work to refs/lanework/wip/<task id>. Your branches are untouched.",
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
        keywords: "check updates harness version latest claude codex upgrade",
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

const titleCase = (word: string) =>
  `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/**
 * An email drawn blurred, the way a screenshot-safe settings page shows one:
 * hover or focus it to read it, click to keep it shown.
 *
 * ⚠️ The blur is for the screen, not for safety — the text is in the DOM and
 * a screen reader reads it. That is the point: it is the user's own email.
 */
function BlurredEmail({ email }: { email: string }) {
  const [shown, setShown] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={shown}
      title={shown ? "Hide email" : "Show email"}
      onClick={() => setShown((value) => !value)}
      className={cn(
        "min-w-0 truncate rounded-sm text-left transition-[filter] duration-150 outline-none select-none hover:blur-none focus-visible:blur-none",
        !shown && "blur-[5px]",
      )}
    >
      {email}
    </button>
  );
}

/**
 * One CLI's card, as a provider list draws one: its mark, name and how many
 * accounts it has, its version on the right; then the account — its
 * organization, whether it is ready, the plan and the email, blurred — its
 * usage limits, and its rows, drawn as `SettingsPage` draws a section's.
 */
function HarnessCard({
  kind,
  info,
  usage,
  account,
  now,
  rows,
}: {
  kind: HarnessAgent;
  /** `undefined` while the first check runs; null when it said nothing. */
  info: HarnessInfo | null | undefined;
  usage: UsageView | null;
  /** `undefined` until read. */
  account: HarnessAccount | undefined;
  now: number;
  rows: SettingsRowSpec[];
}) {
  const name = HARNESS_NAMES[kind];
  const installed = !!info && (info.version !== null || info.path !== null);
  const newer =
    !!info?.version &&
    info.latest !== null &&
    compareVersions(info.latest, info.version) > 0;
  const signedIn = !!account?.signedIn;

  return (
    <SettingsCard>
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-lg">
          <TerminalKindIcon kind={kind} className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="text-sm font-medium">{name}</h3>
          <span className="text-muted-foreground text-[13px]">
            {info === undefined
              ? "Checking…"
              : !installed
                ? "Not installed"
                : account === undefined
                  ? "Reading the account…"
                  : signedIn
                    ? "1 account"
                    : "Not signed in"}
          </span>
        </div>
        {info && installed && (
          <div
            className="text-muted-foreground flex shrink-0 items-center gap-2 text-[13px]"
            title={INSTALLED_WITH[info.installMethod]}
          >
            {info.version && info.latest && !newer && (
              <span className="flex items-center gap-1">
                <HugeiconsIcon
                  icon={Tick02Icon}
                  className="text-tone-emerald size-3.5"
                  strokeWidth={2}
                  aria-hidden="true"
                />
                Up to date
              </span>
            )}
            <span
              data-testid={`harness-version-${kind}`}
              className="bg-foreground/[0.05] text-foreground/80 rounded-md px-1.5 font-mono text-[12px] tabular-nums"
            >
              {!info.version ? (
                "Version unknown"
              ) : newer ? (
                <>
                  {info.version} →{" "}
                  <span className="text-foreground">{info.latest}</span>
                </>
              ) : (
                info.version
              )}
            </span>
          </div>
        )}
      </div>
      {info && !installed && (
        <p className="text-muted-foreground px-4 py-3 text-[13px] leading-relaxed">
          {name} is not installed, or its version could not be read.
        </p>
      )}
      {newer && !info?.updateCommand && (
        <p className="text-muted-foreground px-4 py-3 text-[13px] leading-relaxed">
          Update it the way you installed it.
        </p>
      )}
      {installed && signedIn && account && (
        // One row, aligned with the card's other rows: the account and its
        // organization on the left, its state on the right.
        <div className="flex items-center justify-between gap-6 px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-sm font-medium">
              Default account
            </span>
            {account.org && (
              <span
                data-testid={`harness-org-${kind}`}
                className="bg-muted text-muted-foreground truncate rounded-md px-1.5 py-0.5 text-[11px] leading-4"
              >
                {account.org}
              </span>
            )}
          </div>
          <div className="text-muted-foreground flex min-w-0 items-center gap-2.5 text-[13px]">
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                className="bg-tone-emerald size-1.5 rounded-full"
                aria-hidden="true"
              />
              Ready
            </span>
            {account.plan && (
              <span data-testid={`harness-plan-${kind}`} className="shrink-0">
                {titleCase(account.plan)}
              </span>
            )}
            {account.email && <BlurredEmail email={account.email} />}
          </div>
        </div>
      )}
      {usage && <UsageRow view={usage} now={now} />}
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-center justify-between gap-8 px-4 py-3.5"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm font-medium">{row.label}</span>
            {row.description ? (
              <span className="text-muted-foreground text-[13px] leading-relaxed">
                {row.description}
              </span>
            ) : null}
          </div>
          {row.control ? (
            <div className="flex shrink-0 items-center">{row.control}</div>
          ) : null}
        </div>
      ))}
    </SettingsCard>
  );
}

/**
 * The 5-hour and weekly limits side by side, as the terminal bar's popover
 * has them (FE-53, FE-41). ⚠️ Nothing at all when there are no numbers and no
 * error: a row of dashes would say "0% used" to anyone skimming.
 */
function UsageRow({ view, now }: { view: UsageView; now: number }) {
  const windows = (
    [
      ["5h", view.fiveHour],
      ["Weekly", view.weekly],
    ] as const
  ).flatMap(([label, window]) => (window ? [{ label, window }] : []));
  if (windows.length === 0 && !view.error) return null;
  return (
    <div
      className="flex flex-col gap-2.5 px-4 py-3.5"
      data-testid={`harness-usage-${view.agent}`}
    >
      {windows.length > 0 && (
        <div className="grid grid-cols-2 gap-6">
          {windows.map(({ label, window }) => (
            <UsageBar
              key={label}
              name={view.name}
              label={label}
              window={window}
              now={now}
            />
          ))}
        </div>
      )}
      <p className="text-muted-foreground text-[11px] leading-4">
        {view.error ? (
          <span role="alert" className="text-tone-amber">
            {view.error}
            {windows.length ? " Showing the last known usage." : ""}
          </span>
        ) : (
          `${updatedText(view.at, now)}${view.stale ? " (last known)" : ""}`
        )}
      </p>
    </div>
  );
}

function UsageBar({
  name,
  label,
  window,
  now,
}: {
  name: string;
  label: string;
  window: UsageWindow;
  now: number;
}) {
  const used = clamp(window.usedPercent);
  const reset =
    window.resetsAt === null ? null : resetDuration(window.resetsAt - now);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span
          className="text-muted-foreground flex min-w-0 items-center gap-2 tabular-nums"
          title={
            window.resetsAt === null
              ? undefined
              : `Resets ${new Date(window.resetsAt).toLocaleString()}`
          }
        >
          <span className="text-foreground/80 shrink-0">{label}</span>
          {reset !== null && (
            <span className="flex min-w-0 items-center gap-1">
              <HugeiconsIcon
                icon={Clock01Icon}
                className="size-3 shrink-0"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <span className="truncate">
                {reset === "now" ? "Resets now" : `Resets in ${reset}`}
              </span>
            </span>
          )}
        </span>
        <span
          className={cn(
            "shrink-0 font-medium tabular-nums",
            used >= NEARLY_SPENT && "text-tone-amber",
          )}
        >
          {Math.round(used)}%
        </span>
      </div>
      <div
        className="bg-foreground/10 h-1 overflow-hidden rounded-full"
        role="progressbar"
        aria-label={`${name} ${label.toLowerCase()} usage limit used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
      >
        <span
          className={cn("block h-full rounded-full", barTone(used))}
          style={{ width: `${used}%` }}
        />
      </div>
    </div>
  );
}
