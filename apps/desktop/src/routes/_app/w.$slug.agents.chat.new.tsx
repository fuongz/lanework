import { createFileRoute } from "@tanstack/react-router";
import { NewConversationView } from "#/components/shared/conversation/new-conversation-view";

/**
 * The page that starts a new conversation.
 *
 * NOTE: A static segment beside `$conversation`, which the router matches
 * first. A conversation id is a UUID or OpenCode's `ses_…`, never `new`.
 */
export const Route = createFileRoute("/_app/w/$slug/agents/chat/new")({
  component: NewConversationView,
});
