import { Navigate, useParams } from "@tanstack/react-router";
import { useTeamLeads } from "#/components/shared/conversation/composer";
import { NewConversationPage } from "#/components/shared/conversation/new-conversation-view";
import { ConversationSkeleton } from "#/components/shared/loading/skeletons";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { conductorConversation } from "#/lib/conductors";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useNewChats } from "#/stores/new-chats";

const ROUTE = "/_app/w/$slug/conductors/$lead" as const;

/**
 * A conductor's row on the rail (FE-95): its own conversation in this
 * project, opened as any chat is; or, before it has one, the composer that
 * starts it.
 */
export function ConductorView() {
  const { slug, lead: id } = useParams({ from: ROUTE });
  const workspace = useWorkspaceKey(slug);
  const leads = useTeamLeads(workspace);
  const sessions = useAgentSessions((state) =>
    workspace ? state.byWorkspace[workspace] : undefined,
  );
  const started = useNewChats((state) => state.started);

  // The listing decides between the chat and the composer: wait for it, so
  // the composer never flashes before the chat it should have been.
  if (!workspace || !leads || !sessions)
    return <ConversationSkeleton label="Opening the conductor" />;
  const conductor = leads.leads.find((entry) => entry.id === id) ?? null;
  if (!conductor)
    return (
      <p className="text-muted-foreground m-auto max-w-sm text-center text-sm">
        This conductor is gone: it was removed, or this project does not have
        it.
      </p>
    );
  const conversation = conductorConversation(
    sessions,
    started,
    workspace,
    conductor.id,
  );
  if (conversation)
    return (
      <Navigate
        to="/w/$slug/agents/chat/$conversation"
        params={{ slug, conversation }}
        replace
      />
    );
  return (
    <NewConversationPage
      key={`${slug}:${conductor.id}`}
      slug={slug}
      conductor={conductor}
    />
  );
}
