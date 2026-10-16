import { createFileRoute } from "@tanstack/react-router";
import { NewConversationView } from "#/components/features/conversation/new-conversation-view";

// ⚠️ A static segment beside `$conversation`, and the router matches it first
// — a conversation id is always a UUID, never `new`.
export const Route = createFileRoute("/_app/w/$slug/agents/chat/new")({
  component: NewConversationView,
});
