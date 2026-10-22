import type { Attachment } from "#/../shared/conversation";

/**
 * The first message of a conversation started from the new-conversation page.
 *
 * Handed to its chat page so the bubble is there from the first frame; the
 * CLI writes it down a moment later.
 */
interface FirstMessage {
  text: string;
  attachments: Attachment[];
}

const firsts = new Map<string, FirstMessage>();

export function handFirstMessage(conversation: string, message: FirstMessage) {
  firsts.set(conversation, message);
}

/** Takes the handed message, once: a later visit reads the transcript. */
export function takeFirstMessage(conversation: string): FirstMessage | null {
  const message = firsts.get(conversation) ?? null;
  firsts.delete(conversation);
  return message;
}
