import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { TerminalAgent } from "#/../shared/terminal";
import { HARNESS_NAMES } from "#/components/shared/agents/harness-island";
import { TextSkeleton } from "#/components/shared/loading/skeletons";
import {
  SETTINGS_BUTTON,
  type SettingsRowSpec,
  type SettingsSectionSpec,
} from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
  type AgentPull,
  type AgentPullEnd,
  pullCount,
  useAgentSessions,
} from "#/stores/agent-sessions";
import { useBoard } from "#/stores/board";
import { useTerminal } from "#/stores/terminal";

const KEYWORDS =
  "pull import sessions conversations transcripts history rail lanework all projects claude codex opencode";

const LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** "Claude Code and Codex": the CLIs, by their makers' names. */
const agentNames = (agents: TerminalAgent[]) =>
  LIST.format(agents.map((agent) => HARNESS_NAMES[agent]));

const conversations = (count: number) =>
  `${count} conversation${count === 1 ? "" : "s"}`;

/** What the last Pull of every project came to. */
function ended(end: AgentPullEnd): string {
  if (end.error) return end.error;
  if (end.cancelled)
    return `Cancelled after ${conversations(end.pulled)}. They stay in Lanework.`;
  const pulled =
    end.pulled === 0
      ? "Nothing new to pull."
      : `Pulled ${conversations(end.pulled)}.`;
  return end.failed.length > 0
    ? `${pulled} Could not read ${agentNames(end.failed)}’s.`
    : pulled;
}

/** How far one CLI's part of a Pull of every project has got. */
function agentProgress(pull: AgentPull, agent: TerminalAgent): string {
  if (!pull.agents.includes(agent)) return "Not in this pull.";
  const { done, total, scanning } = pullCount(pull, undefined, agent);
  if (total === 0 && scanning) return "Looking for its conversations.";
  return `${done} of ${conversations(total)} read.`;
}

/**
 * Settings › Agents › Harness's Sessions section (FE-112): Pull every
 * project's conversations in from the CLIs ticked, and how far it has got.
 *
 * Settings is outside the app shell, so the CLIs on this machine are asked
 * here; one a project's rail already asked stands.
 *
 * NOTE: The CLIs ticked are this page's choice, not a setting: every CLI here
 * starts ticked again the next time it opens.
 */
export function usePullAllSection(): SettingsSectionSpec {
  const agents = useTerminal((state) => state.agents);
  const asked = useTerminal((state) => state.agentsAsked);
  const loadAgents = useTerminal((state) => state.loadAgents);
  useEffect(() => {
    if (!asked) void loadAgents();
  }, [asked, loadAgents]);

  const pullAll = useAgentSessions((state) => state.pullAll);
  const cancel = useAgentSessions((state) => state.cancelPull);
  const pulling = useAgentSessions((state) => state.pulling);
  const lastPull = useAgentSessions((state) =>
    state.lastPull?.project === null ? state.lastPull : null,
  );
  const total = useAgentSessions(
    useShallow((state) =>
      state.pulling?.project === null ? pullCount(state.pulling) : null,
    ),
  );
  const projects = useBoard((state) => state.projects);
  /** The CLIs left out of the next Pull. */
  const [skipped, setSkipped] = useState<ReadonlySet<TerminalAgent>>(new Set());
  const chosen = agents.filter((agent) => !skipped.has(agent));
  const surface = window.desktop?.terminal;

  // A Pull of every project is running; one of a single project, started
  // from a rail, holds this one off until it ends.
  const mine = pulling?.project === null ? pulling : null;
  const other = pulling !== null && !mine;
  const readingName = (() => {
    if (!mine?.reading) return null;
    const found = projects.find(
      (project) => (project.id ?? project.slug) === mine.reading,
    );
    return found?.name ?? null;
  })();

  if (!asked)
    return {
      title: "Sessions",
      keywords: KEYWORDS,
      rows: [
        {
          label: "Pull all projects",
          description:
            "Brings the conversations your agent CLIs already had into Lanework.",
          keywords: KEYWORDS,
          control: <TextSkeleton label="Reading the CLIs on this machine" />,
        },
      ],
    };

  if (agents.length === 0)
    return {
      title: "Sessions",
      keywords: KEYWORDS,
      rows: [
        {
          label: "Pull all projects",
          description:
            "No agent CLI on this machine. Install Claude Code, Codex or OpenCode first.",
          keywords: KEYWORDS,
        },
      ],
    };

  const agentRows: SettingsRowSpec[] = agents.map((agent) => ({
    label: HARNESS_NAMES[agent],
    description: mine
      ? agentProgress(mine, agent)
      : "Its conversations, for every project with a folder here.",
    keywords: `${KEYWORDS} ${agent}`,
    control: (
      <Checkbox
        aria-label={`Pull from ${HARNESS_NAMES[agent]}`}
        checked={mine ? mine.agents.includes(agent) : !skipped.has(agent)}
        disabled={pulling !== null}
        onCheckedChange={(checked) =>
          setSkipped((before) => {
            const next = new Set(before);
            if (checked) next.delete(agent);
            else next.add(agent);
            return next;
          })
        }
      />
    ),
  }));

  const description = mine
    ? mine.cancelling
      ? "Cancelling. What it read stays in Lanework."
      : total && (total.total > 0 || !total.scanning)
        ? `${readingName ? `Reading ${readingName}, ` : ""}${total.done} of ${conversations(total.total)} so far.`
        : `${readingName ? `Reading ${readingName}. ` : ""}Looking for conversations.`
    : other
      ? "A pull of one project is running. Try again once it ends."
      : lastPull
        ? ended(lastPull)
        : chosen.length === 0
          ? "Tick a CLI above first."
          : `Brings ${agentNames(chosen)}’s conversations into Lanework, for every project with a folder here. Their own files stay as they are.`;

  return {
    title: "Sessions",
    keywords: KEYWORDS,
    rows: [
      ...agentRows,
      {
        label: "Pull all projects",
        description,
        keywords: KEYWORDS,
        control: mine ? (
          <Button
            size="lg"
            className={SETTINGS_BUTTON}
            variant="outline"
            disabled={mine.cancelling}
            onClick={() => void cancel()}
          >
            {mine.cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        ) : (
          <Button
            size="lg"
            className={SETTINGS_BUTTON}
            variant="outline"
            disabled={!surface || other || chosen.length === 0}
            onClick={() => void pullAll(chosen)}
          >
            Pull
          </Button>
        ),
      },
    ],
  };
}
