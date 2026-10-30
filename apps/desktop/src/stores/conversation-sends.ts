import { useCallback, useMemo, useState } from "react";
import { createStore, useStore } from "zustand";
import type { Attachment, OutgoingAttachment } from "#/../shared/conversation";
import { readDraft, writeDraft } from "#/lib/conversation-draft";

export interface SentMessage {
  key: string;
  text: string;
  attachments: Attachment[];
  /**
   * The last user turn when it went to the CLI (null: none yet). A long
   * transcript is read from its end only, so a count of all user turns
   * stops growing; turns after this one do not.
   */
  since: string | null;
  /** User turns after `since` at which the transcript has this message; null in queue. */
  expect: number | null;
}

/** User turns after `since`; all of them when it is null or read past. */
export function turnsSince<T extends { id: string }>(
  turns: T[],
  since: string | null,
): T[] {
  if (since === null) return turns;
  const at = turns.findIndex((turn) => turn.id === since);
  return at === -1 ? turns : turns.slice(at + 1);
}

export interface PendingAttachment {
  key: string;
  name: string;
  image: boolean;
  out: OutgoingAttachment;
}

interface SendState {
  sent: SentMessage[];
  error: string | null;
}

interface ComposerState {
  text: string;
  attachments: PendingAttachment[];
  sending: boolean;
  error: string | null;
}

const sends = new Map<string, ReturnType<typeof newSendStore>>();
const drafts = new Map<string, ReturnType<typeof newComposerStore>>();
const newSendStore = () =>
  createStore<SendState>(() => ({ sent: [], error: null }));
const newComposerStore = (draftKey?: string) =>
  createStore<ComposerState>(() => ({
    text: draftKey ? readDraft(draftKey) : "",
    attachments: [],
    sending: false,
    error: null,
  }));

function sendStore(key: string) {
  let store = sends.get(key);
  if (!store) {
    store = newSendStore();
    sends.set(key, store);
  }
  return store;
}

export function handSentMessage(key: string, message: SentMessage) {
  const store = sendStore(key);
  store.setState((state) => ({ sent: [...state.sent, message] }));
}

/** Async completions write to the originating chat, even after its view unmounts. */
export function useConversationSends(key: string) {
  const store = useMemo(() => sendStore(key), [key]);
  const state = useStore(store);
  const setSent = useCallback(
    (update: (previous: SentMessage[]) => SentMessage[]) => {
      store.setState((previous) => ({ sent: update(previous.sent) }));
    },
    [store],
  );
  const setError = useCallback(
    (error: string | null) => store.setState({ error }),
    [store],
  );
  return { ...state, setSent, setError };
}

/** In-memory attachments and in-flight state survive navigation, not app exit. */
export function useComposerDraft(project: string, draftKey?: string) {
  const [local] = useState(() => newComposerStore());
  const store = useMemo(() => {
    if (!draftKey) return local;
    const key = JSON.stringify([project, draftKey]);
    let found = drafts.get(key);
    if (!found) {
      found = newComposerStore(draftKey);
      drafts.set(key, found);
    }
    return found;
  }, [project, draftKey, local]);
  const state = useStore(store);
  const setters = useMemo(() => {
    const field =
      <K extends keyof ComposerState>(key: K) =>
      (
        value:
          | ComposerState[K]
          | ((previous: ComposerState[K]) => ComposerState[K]),
      ) => {
        store.setState((previous) => ({
          [key]: typeof value === "function" ? value(previous[key]) : value,
        }));
        // Write immediately: an old view's cleanup must never overwrite recovery.
        if (key === "text" && draftKey)
          writeDraft(draftKey, store.getState().text);
      };
    return {
      setText: field("text"),
      setAttachments: field("attachments"),
      setSending: field("sending"),
      setError: field("error"),
      isSending: () => store.getState().sending,
    };
  }, [store, draftKey]);
  return { ...state, ...setters };
}
