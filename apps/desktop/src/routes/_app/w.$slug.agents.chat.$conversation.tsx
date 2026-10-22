import { createFileRoute } from "@tanstack/react-router";
import { ConversationView } from "#/components/features/conversation/conversation-view";

/**
 * A Claude conversation as a chat (FE-62/D3).
 *
 * The rail opens Claude's conversations here, and the Terminal button hands
 * one to a pty.
 */
export const Route = createFileRoute("/_app/w/$slug/agents/chat/$conversation")(
  {
    component: ConversationView,
  },
);
