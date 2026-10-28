import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  agentOfModel,
  allModels,
  type ComposerSettings,
  DEFAULT_SETTINGS,
  type OutgoingAttachment,
} from "#/../shared/conversation";
import type { TeamLead } from "#/../shared/orchestration";
import { setChatAgent } from "#/components/shared/conversation/chat-agent";
import { Composer } from "#/components/shared/conversation/composer";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { ipcMessage } from "#/lib/ipc-error";
import {
  conductorTurn,
  leadIcon,
  visibleText as orchestrationText,
  planningPrompt,
  proposalId,
  readEnvelope,
} from "#/lib/orchestration-prompt";
import { useBoard } from "#/stores/board";
import { withLiveContext } from "#/stores/conductor-context";
import { handSentMessage } from "#/stores/conversation-sends";
import { useNewChats } from "#/stores/new-chats";

const ROUTE = "/_app/w/$slug/agents/chat/new" as const;

/**
 * The new-conversation page: the composer alone, under a question.
 *
 * The model picked picks the CLI — Claude Code or Codex — so the page names
 * no agent until then. Sending starts the user's own `claude` or `codex` on a
 * new conversation and opens it as a chat.
 */
export function NewConversationView() {
  const { slug } = useParams({ from: ROUTE });
  return <NewConversationPage key={slug} slug={slug} />;
}

/**
 * The page, for a project and, on a conductor's row (FE-95), that conductor:
 * then its title, its model, effort and permission, every message wrapped as
 * a conductor turn, and the conversation started as the conductor's own.
 */
export function NewConversationPage({
  slug,
  conductor = null,
}: {
  slug: string;
  conductor?: TeamLead | null;
}) {
  const workspace = useWorkspaceKey(slug);
  const navigate = useNavigate();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The checkout's folder name, as the person knows the project on disk.
  const name = useBoard((state) => {
    const found = state.workspaces.find((entry) => entry.slug === slug);
    if (!found) return slug;
    return found.path?.split(/[\\/]/).filter(Boolean).at(-1) ?? found.name;
  });
  // Named in a planning prompt so the lead writes project-relative scopes.
  const cwd = useBoard(
    (state) =>
      state.workspaces.find((entry) => entry.slug === slug)?.path ?? null,
  );
  const [settings, setSettings] = useState<ComposerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The usage strip follows the model picked: its CLI's quota.
  const model = settings?.model ?? null;
  useEffect(() => {
    setChatAgent(model ? agentOfModel(model) : null);
    return () => setChatAgent(null);
  }, [model]);

  useEffect(() => {
    let gone = false;
    const surface = window.desktop?.conversation;
    void (surface ? surface.lastSettings() : Promise.resolve(DEFAULT_SETTINGS))
      .catch(() => DEFAULT_SETTINGS)
      .then((last) => {
        if (!gone)
          setSettings(
            (current) => current ?? conductorSettings(last, conductor),
          );
      });
    return () => {
      gone = true;
    };
  }, [conductor]);

  const send = async (
    text: string,
    attachments: OutgoingAttachment[],
    names: { name: string; image: boolean }[],
    /** The settings it starts on, when not the ones picked. */
    override?: ComposerSettings,
  ): Promise<boolean> => {
    const surface = window.desktop?.conversation;
    const chosen = override ?? settings;
    if (!workspace || !surface || !chosen) return false;
    setError(null);
    // A conductor's message carries who it is; a planning prompt already
    // names it.
    const outgoing =
      conductor && !readEnvelope(text)
        ? conductorTurn(
            text,
            await withLiveContext(workspace, conductor),
            agentOfModel(chosen.model),
            cwd,
            null,
          )
        : text;
    const { begin, end } = useNewChats.getState();
    // The rail's row for it, from Enter on: the CLI takes a while to answer
    // with an id, and longer to write a transcript the rail can list.
    begin({
      workspace,
      agent: agentOfModel(chosen.model),
      text: orchestrationText(outgoing),
      ...(conductor ? { conductor: conductor.id } : {}),
    });
    try {
      const { conversation } = await surface.start({
        workspace,
        text: outgoing,
        attachments,
        settings: chosen,
        ...(conductor ? { conductor: conductor.id } : {}),
      });
      end(workspace, conversation);
      handSentMessage(JSON.stringify([slug, conversation]), {
        key: "first",
        expect: 1,
        after: 0,
        text: outgoing,
        attachments: names.map((entry) => ({
          name: entry.name,
          mediaType: entry.image ? "image/*" : "text/plain",
          path: null,
        })),
      });
      if (mounted.current)
        void navigate({
          to: "/w/$slug/agents/chat/$conversation",
          params: { slug, conversation },
          replace: true,
        });
      return true;
    } catch (caught) {
      end(workspace, null);
      setError(ipcMessage(caught, "Could not start the conversation."));
      return false;
    }
  };

  // `/orchestrate` as the first message (FE-87): the new conversation is the
  // lead, and its first turn is the planning prompt. The chat it opens draws
  // the proposal card once the lead answers. Under a team lead (FE-88) the
  // conversation starts on the lead's own model and effort, when the app
  // offers that model; else on the one picked.
  const orchestrate = async (
    request: string,
    attachments: OutgoingAttachment[],
    names: { name: string; image: boolean }[],
    picked: TeamLead | null,
  ): Promise<boolean> => {
    if (!settings || !request.trim()) return false;
    // In a conductor's conversation, `/orchestrate` plans as that conductor,
    // with its context files as they stand now (FE-96).
    const chosenLead = picked ?? conductor;
    const teamLead =
      chosenLead && workspace
        ? await withLiveContext(workspace, chosenLead)
        : chosenLead;
    const own = teamLead?.lead;
    const started: ComposerSettings =
      own && allModels().some((entry) => entry.id === own.model)
        ? {
            ...settings,
            model: own.model,
            effort: own.effort ?? settings.effort,
          }
        : settings;
    return send(
      planningPrompt(
        proposalId(),
        request.trim(),
        agentOfModel(started.model),
        cwd,
        teamLead,
      ),
      attachments,
      names,
      started,
    );
  };

  return (
    <section
      aria-label={conductor ? conductor.name : "New conversation"}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    >
      <WindowTitlebar className="gap-2.5">
        {conductor && (
          <HugeiconsIcon
            icon={leadIcon(conductor.icon)}
            className="text-muted-foreground size-4 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        )}
        <h1 className={WINDOW_TITLE}>
          {conductor ? conductor.name : "New conversation"}
        </h1>
      </WindowTitlebar>

      {/* A little under the middle, where the eye lands on an empty page. */}
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-8 pt-[30vh] pb-10">
        <div className="flex w-full max-w-[760px] min-w-0 flex-col gap-4">
          <h2 className="px-1 text-[22px] font-medium tracking-tight text-balance">
            {conductor
              ? `What should ${conductor.name} take on in ${name}?`
              : `What should we work on in ${name}?`}
          </h2>
          {error && (
            <p role="alert" className="text-destructive px-1 text-xs">
              {error}
            </p>
          )}
          {workspace && settings && (
            <Composer
              slug={slug}
              draftKey={
                conductor ? `conductor:${slug}:${conductor.id}` : `new:${slug}`
              }
              autoFocus
              workspace={workspace}
              settings={settings}
              onSettings={(next) =>
                setSettings((previous) =>
                  previous ? { ...previous, ...next } : previous,
                )
              }
              working={false}
              queued={0}
              onSend={send}
              onOrchestrate={orchestrate}
              onStop={() => {}}
            />
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * The settings a conductor's conversation starts on: its own model and
 * effort when the app offers that model, and its permission; the rest as
 * last picked.
 */
function conductorSettings(
  last: ComposerSettings,
  conductor: TeamLead | null,
): ComposerSettings {
  if (!conductor) return last;
  const own = conductor.lead;
  const offered = allModels().some((entry) => entry.id === own.model);
  return {
    ...last,
    ...(offered ? { model: own.model, effort: own.effort ?? last.effort } : {}),
    permission: conductor.permission ?? last.permission,
  };
}
