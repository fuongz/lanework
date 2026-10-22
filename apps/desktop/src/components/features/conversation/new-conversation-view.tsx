import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  agentOfModel,
  type ComposerSettings,
  DEFAULT_SETTINGS,
  type OutgoingAttachment,
} from "#/../shared/conversation";
import { setChatAgent } from "#/components/shared/conversation/chat-agent";
import { Composer } from "#/components/shared/conversation/composer";
import { handFirstMessage } from "#/components/shared/conversation/first-message";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { ipcMessage } from "#/lib/ipc-error";
import { useBoard } from "#/stores/board";
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
  const workspace = useWorkspaceKey(slug);
  const navigate = useNavigate();
  // The checkout's folder name, as the person knows the project on disk.
  const name = useBoard((state) => {
    const found = state.workspaces.find((entry) => entry.slug === slug);
    if (!found) return slug;
    return found.path?.split(/[\\/]/).filter(Boolean).at(-1) ?? found.name;
  });
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
        if (!gone) setSettings((current) => current ?? last);
      });
    return () => {
      gone = true;
    };
  }, []);

  const send = async (
    text: string,
    attachments: OutgoingAttachment[],
    names: { name: string; image: boolean }[],
  ): Promise<boolean> => {
    const surface = window.desktop?.conversation;
    if (!workspace || !surface || !settings) return false;
    setError(null);
    const { begin, end } = useNewChats.getState();
    // The rail's row for it, from Enter on: the CLI takes a while to answer
    // with an id, and longer to write a transcript the rail can list.
    begin({ workspace, agent: agentOfModel(settings.model), text });
    try {
      const { conversation } = await surface.start({
        workspace,
        text,
        attachments,
        settings,
      });
      end(workspace, conversation);
      handFirstMessage(conversation, {
        text,
        attachments: names.map((entry) => ({
          name: entry.name,
          mediaType: entry.image ? "image/*" : "text/plain",
          path: null,
        })),
      });
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

  return (
    <section
      aria-label="New conversation"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    >
      <WindowTitlebar className="gap-2.5">
        <h1 className={WINDOW_TITLE}>New conversation</h1>
      </WindowTitlebar>

      {/* A little under the middle, where the eye lands on an empty page. */}
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-8 pt-[30vh] pb-10">
        <div className="flex w-full max-w-[760px] min-w-0 flex-col gap-4">
          <h2 className="px-1 text-[22px] font-medium tracking-tight text-balance">
            What should we work on in {name}?
          </h2>
          {error && (
            <p role="alert" className="text-destructive px-1 text-xs">
              {error}
            </p>
          )}
          {workspace && settings && (
            <Composer
              slug={slug}
              draftKey={`new:${slug}`}
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
              onStop={() => {}}
            />
          )}
        </div>
      </div>
    </section>
  );
}
