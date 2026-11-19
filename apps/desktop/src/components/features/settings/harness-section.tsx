import {
  Copy01Icon,
  Loading03Icon,
  MultiplicationSignIcon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useHarnessAccounts } from "#/components/shared/agents/harness-account";
import { HARNESS_NAMES } from "#/components/shared/agents/harness-island";
import logo from "#/components/shared/common/lanework-logo.png";
import { PoweredBy } from "#/components/shared/settings/powered-by";
import {
  SETTINGS_BUTTON,
  SettingsPage,
  type SettingsRowSpec,
  type SettingsSectionSpec,
} from "#/components/shared/settings/settings-page";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Switch } from "#/components/ui/switch";
import { useClock } from "#/hooks/use-clock";
import { useCopy } from "#/hooks/use-copy";
import { useProjectKey } from "#/hooks/use-project-key";
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
import type { KitMcpStatus } from "../../../../shared/agent-setup";
import type {
  LaneworkMcpAgent,
  LaneworkMcpStatus,
  LaneworkMcpToolset,
} from "../../../../shared/auth";
import { PREVIEW_AGENT_SETUP_REFUSAL } from "../../../../shared/desktop";
import type {
  AgentHookStatus,
  HandoffStatus,
  HookAgent,
} from "../../../../shared/handoff";
import type { HarnessAgent } from "../../../../shared/harness";
import { HarnessCard } from "./harness-section.card";
import { HarnessList } from "./harness-section.list";
import { useIsPreview } from "./harness-section.preview";
import { usePullAllSection } from "./harness-section.pull";
import { HarnessModels } from "./models-section";

/** What each toolset is called in its select (FE-119/D1). */
const TOOLSET_LABELS: Record<LaneworkMcpToolset, string> = {
  full: "Full",
  worker: "Worker",
};

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

/** Each agent's key in {@link KitMcpStatus} (FE-152). */
const KIT_KEYS = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
} as const satisfies Record<LaneworkMcpAgent, keyof KitMcpStatus>;

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
 *
 * Sessions, under the cards, pulls every project's conversations in from the
 * CLIs ticked (FE-112).
 */
export function HarnessSection({ cli }: { cli?: HarnessAgent } = {}) {
  const accounts = useHarnessAccounts();
  const [status, setStatus] = useState<HandoffStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useClock();
  const [copied, copy] = useCopy();
  const pullSection = usePullAllSection(cli);
  // "Approve in Codex" opens Codex in the app's own terminal, in the project
  // last open, so its hook review is one keypress away rather than a trip to
  // another window. The approval itself is still Codex's (FE-29/D7).
  const project = useBoard((state) => state.active);
  const projectKey = useProjectKey(project?.slug);
  const startAgent = useAgentTerminals((state) => state.start);
  const navigate = useNavigate();
  const { signedIn } = useCloudFeatures();
  // The hook also runs in local mode, writing checkpoints to the local store,
  // so its switches stay. Only the credential row is cloud-only (FE-52/D9).
  const local = useIsLocalMode();
  const handoff = signedIn || local;
  // The Preview build reads the agents' setup but never changes it: the
  // release app owns the Lanework MCP entries and the hooks (`channel.ts`).
  const preview = useIsPreview();

  // Which version of each CLI runs here and which is out: the same facts the
  // update island works from, with a way to ask again now.
  useHarnessWatch();
  const harness = useHarness((state) => state.list);
  const harnessLoaded = useHarness((state) => state.loaded);
  const checking = useHarness((state) => state.checking);
  const harnessError = useHarness((state) => state.error);
  const check = useHarness((state) => state.check);
  const updateHarness = useHarness((state) => state.update);
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

  // The `lanework-kit` entry beside the board's (FE-152): no session needed,
  // so it is read on its own.
  const [kitStatus, setKitStatus] = useState<KitMcpStatus | null>(null);
  useEffect(() => {
    void window.desktop?.agentSetup
      ?.kitMcp()
      .then(setKitStatus)
      .catch((failure: unknown) =>
        setError(
          ipcMessage(failure, "Could not read the lanework-kit entries."),
        ),
      );
  }, []);

  async function runKit(agent: LaneworkMcpAgent, on: boolean) {
    const kit = window.desktop?.agentSetup;
    if (!kit) return;
    setBusy(true);
    try {
      setKitStatus(await kit.setKitMcp(agent, on));
      setError(null);
    } catch (failure) {
      setError(
        ipcMessage(failure, on ? "Could not add it." : "Could not remove it."),
      );
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
        preview ||
        !surface ||
        busy ||
        blocked ||
        (!hook?.installed && !!hook?.settingsUnreadable)
      }
      title={preview ? PREVIEW_AGENT_SETUP_REFUSAL : undefined}
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

  // The cloud entry's sign-in (FE-161: one row with the entry): its state
  // beside the row's label, what to do instead of the row's description
  // when it needs the user, and its buttons before the switch.
  const authParts = (
    agent: LaneworkMcpAgent,
    auth: McpAuthView | undefined,
  ): { status: ReactNode; note: string | null; actions: ReactNode } => {
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
      status: (
        <span
          className={cn(
            "inline-flex items-center gap-1 text-xs",
            attention
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground",
          )}
        >
          {auth === "signed-in" && (
            <HugeiconsIcon
              icon={Tick02Icon}
              className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
              strokeWidth={2}
              aria-hidden="true"
            />
          )}
          {LABEL[auth ?? "checking"]}
        </span>
      ),
      note: auth && auth !== "signed-in" ? (DESCRIPTION[auth] ?? null) : null,
      actions: (
        // A login waiting on the browser: hovering it (or tabbing to it)
        // swaps the spinner for Stop.
        <div className="group/mcp-login flex items-center gap-3">
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
                  disabled={preview}
                  title={preview ? PREVIEW_AGENT_SETUP_REFUSAL : undefined}
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
          : entry?.installed && !entry.ours && entry.otherApp
            ? `Set up by the installed Lanework app in ${entry.configPath}.`
            : entry?.installed && !entry.ours
              ? `${entry.configPath} already has another lanework server.`
              : mcpStatus.want === "local"
                ? `Gives ${NAMES[agent]} the board's tools, for your local projects.`
                : `Gives ${NAMES[agent]} the board's tools.`,
      keywords:
        "mcp server lanework board tools claude codex opencode stdio local login sign in oauth authenticate token expired",
      control: (
        <Switch
          aria-label={`Lanework MCP — ${NAMES[agent]}`}
          checked={!!entry?.installed && !!entry.ours}
          title={preview ? PREVIEW_AGENT_SETUP_REFUSAL : undefined}
          disabled={
            preview ||
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
    // A cloud entry of ours signs in through the browser: its state and
    // buttons join this row rather than a row of their own.
    if (cloud.includes(agent) && entry?.installed && entry.ours) {
      const auth = authParts(agent, mcpAuth[agent]);
      board.byline = auth.status;
      if (auth.note) board.description = auth.note;
      board.control = (
        <div className="flex items-center gap-3">
          {auth.actions}
          {board.control}
        </div>
      );
    }
    return [board, toolsetRow(agent)];
  };

  // The kit's search tools, a stdio entry of their own (FE-152).
  const kitRow = (agent: LaneworkMcpAgent): SettingsRowSpec => {
    const entry = kitStatus?.[KIT_KEYS[agent]];
    const refusal = kitStatus?.refusal ?? null;
    const on = !!entry?.installed && entry.ours;
    return {
      label: "Lanework Kit",
      byline: <PoweredBy />,
      description: !kitStatus
        ? "Checking…"
        : entry?.unreadable
          ? `${entry.configPath} can't be read. Fix it and try again.`
          : entry?.installed && !entry.ours && entry.otherApp
            ? `Set up by the installed Lanework app in ${entry.configPath}.`
            : entry?.installed && !entry.ours
              ? `${entry.configPath} already has another lanework-kit server.`
              : refusal && !on
                ? refusal
                : `Search, code and session tools for ${NAMES[agent]} in its project: faster, with less output than the shell.`,
      keywords:
        "lanework-kit lwk kit mcp fast project search files text code structural ast-grep ripgrep sessions find grep stdio claude codex opencode",
      control: (
        <Switch
          aria-label={`Lanework Kit — ${NAMES[agent]}`}
          checked={on}
          title={preview ? PREVIEW_AGENT_SETUP_REFUSAL : undefined}
          disabled={
            preview ||
            !window.desktop?.agentSetup ||
            busy ||
            !entry ||
            entry.unreadable ||
            (entry.installed && !entry.ours) ||
            (!on && !!refusal)
          }
          onCheckedChange={(checked) => void runKit(agent, checked)}
        />
      ),
    };
  };

  // Which of the cloud server's tools the entry asks for (FE-119/D1).
  const toolsetRow = (agent: LaneworkMcpAgent): SettingsRowSpec => {
    const entry = mcpEntry(mcpStatus, agent);
    const name = NAMES[agent];
    const chosen = mcpStatus?.toolsets[agent] ?? null;
    const canWork = mcpStatus?.workerAgents.includes(agent) ?? false;
    // Ours and in the cloud, at a URL the app did not write: the user's edit.
    const edited =
      !!entry?.ours && entry.mode === "cloud" && entry.toolset === null;
    return {
      label: "Lanework MCP tools",
      description: !mcpStatus
        ? "Checking…"
        : !canWork
          ? `${name} keeps every tool. It cannot sign in to the worker set yet.`
          : edited
            ? `${entry?.configPath} has a lanework URL Lanework did not write, so it stays as it is.`
            : chosen === "worker"
              ? `Only the five tools for working a card, so ${name} loads a smaller tool list. Changing it asks ${name} to log in again.`
              : `Every board tool. Changing it asks ${name} to log in again.`,
      keywords:
        "mcp tools toolset worker full tool list context size codex claude opencode",
      control: (
        <Select
          value={chosen}
          disabled={
            preview || !mcpSurface || busy || !chosen || !canWork || edited
          }
          onValueChange={(next) =>
            mcpSurface &&
            (next === "full" || next === "worker") &&
            void runMcp(
              () => mcpSurface.setToolset(agent, next),
              "Could not change the tools.",
            )
          }
        >
          <SelectTrigger aria-label={`Lanework MCP tools — ${name}`}>
            <SelectValue>
              {(current: LaneworkMcpToolset | null) =>
                current ? TOOLSET_LABELS[current] : ""
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(["full", "worker"] as const).map((toolset) => (
              <SelectItem key={toolset} value={toolset}>
                {TOOLSET_LABELS[toolset]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    };
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
  // Codex runs a new hook only once trusted: its approval sits beside the
  // row's label, and the button to give it only while it is missing.
  const codexApproval: Pick<SettingsRowSpec, "byline" | "description"> & {
    action: ReactNode;
  } = !codex?.installed
    ? { action: null }
    : codex.approved
      ? {
          byline: (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
              <HugeiconsIcon
                icon={Tick02Icon}
                className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                strokeWidth={2}
                aria-hidden="true"
              />
              Approved in Codex
            </span>
          ),
          action: null,
        }
      : {
          byline: (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              Waiting for approval in Codex
            </span>
          ),
          description: project
            ? `Opens Codex in ${project.name}. Choose "Trust all and continue" when asked.`
            : "Open a project first, or approve the hook when Codex asks.",
          action: (
            <Button
              size="lg"
              className={SETTINGS_BUTTON}
              variant="outline"
              disabled={preview || busy || !project || !projectKey}
              onClick={() => void approveInCodex()}
            >
              Approve in Codex
            </Button>
          ),
        };
  const codexRows: SettingsRowSpec[] = [
    {
      label: "Save progress for the next agent",
      byline: codexApproval.byline,
      description:
        codexApproval.description ??
        why(
          codex ?? NO_HOOK,
          "Leaves a checkpoint on the card after each turn, so another agent can continue.",
        ),
      keywords: "codex handoff checkpoint resume hook approve approved trust",
      control: codexApproval.action ? (
        <div className="flex items-center gap-3">
          {codexApproval.action}
          {switchFor("codex", codex)}
        </div>
      ) : (
        switchFor("codex", codex)
      ),
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
      const rows = handoff
        ? [...mcpRows(agent), kitRow(agent), ...HOOK_ROWS[agent]]
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
            // Its switches are the page's "Lanework" section, below the card.
            rows={[]}
            onUpdate={() => void updateHarness(kind)}
          />
        ),
      };
    },
  );

  const sections: SettingsSectionSpec[] = [
    ...(preview
      ? [
          {
            title: "Preview build",
            keywords: "preview dev build release mcp hooks",
            content: (
              <Alert>
                <AlertDescription>
                  The Lanework release app manages the agents’ Lanework MCP
                  entry, hooks and folder trust. This Preview build only reads
                  them.
                </AlertDescription>
              </Alert>
            ),
          },
        ]
      : []),
    {
      title: "Agents",
      hideTitle: true,
      keywords: cardSections.map((card) => card.keywords ?? "").join(" "),
      content: (
        <HarnessList
          rows={CLIS.map(({ harness: kind }) => ({
            kind,
            info: harnessLoaded
              ? (harness.find((entry) => entry.agent === kind) ?? null)
              : undefined,
          }))}
        />
      ),
    },
  ];

  // Lanework's switches for every agent, shown on each CLI's page.
  // What a checkpoint carries of the code (FE-78): nothing, the changes to
  // files git tracks, or those and new files too. One choice, since new files
  // only ever go with the changes. Main asks before each wider step
  // (FE-78/D4, D9); the state is read back rather than taken from the pick.
  type PushChoice = "off" | "tracked" | "untracked";
  const pushChoice: PushChoice = !status?.pushWip
    ? "off"
    : status.pushWipUntracked
      ? "untracked"
      : "tracked";
  const PUSH_LABELS: Record<PushChoice, string> = {
    off: "Off",
    tracked: "Changed files",
    untracked: "Changed and new files",
  };
  const PUSH_DESCRIPTIONS: Record<PushChoice, string> = {
    off: "Checkpoints carry notes only, so unfinished code stays on this machine. Push it to let an agent on another machine or in the cloud continue from it.",
    tracked:
      "Pushes uncommitted changes to files git tracks to refs/lanework/wip/<task id>, never to your branches. Anyone who can read the remote can fetch it.",
    untracked:
      "Also pushes new files git does not ignore. A key or .env file .gitignore misses would go too; the hook skips a push when it spots one.",
  };
  const setPush = (next: PushChoice) =>
    surface &&
    void run(async () => {
      if (next === "off") {
        if (status?.pushWipUntracked) await surface.setPushWipUntracked(false);
        await surface.setPushWip(false);
      } else {
        if (!status?.pushWip) await surface.setPushWip(true);
        if ((next === "untracked") !== !!status?.pushWipUntracked)
          await surface.setPushWipUntracked(next === "untracked");
      }
      return surface.status();
    }, "Could not change this.");
  const pushRows: SettingsRowSpec[] = handoff
    ? [
        {
          label: "Push unfinished code",
          description: PUSH_DESCRIPTIONS[pushChoice],
          keywords:
            "push wip ref uncommitted code git remote github cloud tracked untracked new files include secrets fetch another machine",
          control: (
            <Select
              value={pushChoice}
              disabled={preview || !surface || busy || !anyOn}
              onValueChange={(next) => setPush(next as PushChoice)}
            >
              <SelectTrigger aria-label="Push unfinished code">
                <SelectValue>
                  {(current: PushChoice | null) =>
                    current ? PUSH_LABELS[current] : ""
                  }
                </SelectValue>
              </SelectTrigger>
              {/* As wide as its longest choice, never narrower than the
                  trigger: "Changed and new files" outgrows "Off". */}
              <SelectContent className="w-auto min-w-(--anchor-width)">
                {(Object.keys(PUSH_LABELS) as PushChoice[]).map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {PUSH_LABELS[choice]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ),
        },
      ]
    : [];

  // The handoff's state for every CLI at once (FE-161): the last checkpoint
  // under the page's description, and the credential only when it is gone.
  const handoffNotice: ReactNode =
    handoff && anyOn && status ? (
      <>
        {status.last
          ? `Last checkpoint: ${status.last.taskId}, ${relativeTime(status.last.at, now)}.`
          : "No checkpoint yet."}
        {!local && !status.credential && (
          <span className="text-destructive">
            {" "}
            The checkpoint credential is missing from the Keychain: turn a
            switch off and on again.
          </span>
        )}
      </>
    ) : null;

  const problemSection: SettingsSectionSpec | null = error
    ? {
        title: "Problem",
        content: (
          <p role="alert" className="text-destructive text-[13px]">
            {error}
          </p>
        ),
      }
    : null;

  // One CLI's own page (FE-146): its card, what Lanework adds to it, its
  // models, then its sessions and its handoff's status. The list page keeps
  // a row per CLI, the update check and any problem.
  if (cli) {
    const at = CLIS.findIndex(({ harness: kind }) => kind === cli);
    const card = cardSections[at];
    // FE-161: bringing this CLI's sessions into Lanework sits with the rest
    // of what Lanework adds to it, not in a section of its own.
    const laneworkRows = [
      ...(handoff && at >= 0
        ? [
            ...mcpRows(CLIS[at].agent),
            kitRow(CLIS[at].agent),
            ...HOOK_ROWS[CLIS[at].agent],
            ...pushRows,
          ]
        : []),
      ...(pullSection.rows ?? []),
    ];
    const page: (SettingsSectionSpec | null | undefined)[] = [
      card,
      laneworkRows.length
        ? {
            title: "Lanework",
            icon: (
              <img
                src={logo}
                alt=""
                className="size-4 shrink-0 rounded-[4px]"
              />
            ),
            rows: laneworkRows,
          }
        : null,
      {
        title: "Models",
        keywords:
          "models model picker favourite favorite star order reorder hide show slug id",
        content: <HarnessModels agent={cli} />,
      },
      problemSection,
    ];
    return (
      <SettingsPage
        title={HARNESS_NAMES[cli]}
        description="Its version, usage and handoff, and the models the composer offers: star one to put it first, drag or step it to set the order."
        sections={page.filter((section): section is SettingsSectionSpec =>
          Boolean(section),
        )}
      />
    );
  }

  if (problemSection) sections.push(problemSection);

  // The CLIs' update check, as the page's one action (FE-146): when it last
  // ran on hover, an error under the title.
  const checkButton = (
    <Button
      size="sm"
      variant="outline"
      title={
        checkedAt
          ? `Last checked ${relativeTime(checkedAt, now)}`
          : "Lanework also checks on its own"
      }
      disabled={checking || !window.desktop?.harness}
      aria-busy={checking}
      onClick={() => void check()}
      className="h-8 shrink-0 gap-1.5 rounded-lg px-3 text-[13px]"
    >
      <HugeiconsIcon
        icon={checking ? Loading03Icon : RefreshIcon}
        className={cn(
          "size-3.5",
          checking && "animate-spin motion-reduce:animate-none",
        )}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      {checking ? "Checking…" : "Check for updates"}
    </Button>
  );
  if (harnessError)
    sections.push({
      title: "Updates",
      content: (
        <p role="alert" className="text-destructive text-[13px]">
          {harnessError}
        </p>
      ),
    });

  return (
    <SettingsPage
      actions={checkButton}
      notice={handoffNotice}
      title="Harness"
      description={
        handoff
          ? "Coding agents, their versions, usage, sessions and handoff."
          : "Coding agents, their versions, usage and sessions."
      }
      sections={sections}
    />
  );
}
