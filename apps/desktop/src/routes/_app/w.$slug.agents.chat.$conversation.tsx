import { createFileRoute } from "@tanstack/react-router";
import { ConversationView } from "#/components/features/conversation/conversation-view";

// A Claude conversation as a chat (FE-62/D3): the rail opens Claude's here,
// and its Terminal button hands the conversation to a pty.
export const Route = createFileRoute("/_app/w/$slug/agents/chat/$conversation")(
  {
    component: ConversationView,
  },
);
