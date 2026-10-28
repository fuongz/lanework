import {
  ArrowUp02Icon,
  Cancel01Icon,
  CommandLineIcon,
  CubeIcon,
  File01Icon,
  Folder01Icon,
  Image01Icon,
  Loading03Icon,
  SlashIcon,
  StopIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type CommandSource,
  type ComposerSettings,
  type ConversationAgent,
  type OutgoingAttachment,
  PASTE_MAX,
  type Suggestion,
  type SuggestionKind,
} from "#/../shared/conversation";
import { insertDictation } from "#/../shared/dictation";
import type { LeadsList, TeamLead } from "#/../shared/orchestration";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { BranchSwitcher } from "#/components/shared/repo/branch-switcher";
import {
  LEAD_SOURCE_LABELS,
  leadIcon,
  readEnvelope,
  splitLead,
  visibleText,
} from "#/lib/orchestration-prompt";
import { cn } from "#/lib/utils";
import {
  type PendingAttachment as Pending,
  useComposerDraft,
} from "#/stores/conversation-sends";
import {
  DictationBar,
  DictationButton,
  useDictation,
} from "./composer.dictation";
import {
  ChipEditor,
  type ChipEditorHandle,
  type ChipSpec,
} from "./composer.editor";
import { AttachMenu, ModelMenu, PermissionMenu } from "./composer.menus";

export interface ComposerHandle {
  /** Put `text` in the composer — a reply's quote — and focus it. */
  insert: (text: string) => void;
  /** Put a queued message back in the composer to be edited. */
  restore: (taken: Unqueued) => void;
}

/** A queued message, taken back to be edited. */
export interface Unqueued {
  text: string;
  attachments: { name: string; image: boolean; out: OutgoingAttachment }[];
}

/** What a suggestion list offers: the CLI's, or the app's team leads. */
type Kind = SuggestionKind | "lead";

/** One row of the list; a team lead's carries the lead. */
type Item = Suggestion & { lead?: TeamLead };

/**
 * A `/` at a line's start, or an `@` after a space: what the caret is in.
 *
 * With `leads`, an `@` as `/orchestrate`'s first word asks for a team lead
 * (FE-88), not a file.
 */
function trigger(
  text: string,
  caret: number,
  leads: boolean,
): { kind: Kind; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const lead = leads ? /^\s*\/orchestrate[ \t]+@([^\s@]*)$/.exec(before) : null;
  if (lead)
    return {
      kind: "lead",
      query: lead[1] ?? "",
      start: caret - (lead[1]?.length ?? 0) - 1,
    };
  const command = /(^|\n)\/([^\s/]*)$/.exec(before);
  if (command)
    return {
      kind: "command",
      query: command[2] ?? "",
      start: caret - (command[2]?.length ?? 0) - 1,
    };
  const file = /(^|\s)@([^\s@]*)$/.exec(before);
  if (file)
    return {
      kind: "file",
      query: file[2] ?? "",
      start: caret - (file[2]?.length ?? 0) - 1,
    };
  return null;
}

let keys = 0;

/** `/orchestrate`, offered among the `/` commands when the page takes it. */
const ORCHESTRATE: Suggestion = {
  value: "/orchestrate",
  detail: "Plan workers for a request; nothing runs until you approve",
  label: "Orchestrate",
  kind: "command",
  source: "builtin",
};

const SOURCE_LABELS: Record<CommandSource, string> = {
  project: "Project",
  personal: "Personal",
  builtin: "Built-in",
};

/**
 * The `/` commands and `@` paths seen in a list, by value: what the message
 * shows as chips (FE-92, FE-93). Filled as lists arrive; a draft's token
 * nobody has listed yet is asked for once.
 */
const known = new Map<string, Suggestion>();

/** The draft tokens already asked for, found or not. */
const looked = new Set<string>();

function remember(items: Suggestion[]) {
  for (const item of items) if (item.kind) known.set(item.value, item);
}

/** A `/` suggestion's icon: the team-lead one for `/orchestrate`. */
function commandIcon(item: Suggestion) {
  if (item.value === ORCHESTRATE.value) return UserGroupIcon;
  if (item.kind === "skill") return CubeIcon;
  if (item.kind === "builtin") return CommandLineIcon;
  return SlashIcon;
}

/** A suggestion's icon in the list: the file's type, a folder, a command's. */
function SuggestionIcon({
  item,
  tinted,
}: {
  item: Suggestion;
  tinted: boolean;
}) {
  if (item.kind === "file")
    return (
      <FileTypeIcon
        path={item.value.slice(1)}
        inherit={!tinted}
        className="size-3.5 shrink-0"
      />
    );
  return (
    <HugeiconsIcon
      icon={item.kind === "folder" ? Folder01Icon : commandIcon(item)}
      className={cn("size-3.5 shrink-0", tinted && "text-muted-foreground")}
      strokeWidth={1.8}
      aria-hidden="true"
    />
  );
}

/** How `item` shows as a chip in the message (FE-93/D3). */
function chipSpec(item: Suggestion): ChipSpec {
  const path = item.kind === "file" || item.kind === "folder";
  return {
    value: item.value,
    label: item.label ?? item.value,
    title: path
      ? item.value.slice(1)
      : item.detail
        ? `${item.value}\n${item.detail}`
        : item.value,
    icon: <SuggestionIcon item={item} tinted={false} />,
    tone:
      item.value === ORCHESTRATE.value
        ? "violet"
        : path || item.kind === "skill"
          ? "primary"
          : "muted",
  };
}

/** `label` with the part `query` matches in weight, as the list shows it. */
function Matched({ label, query }: { label: string; query: string }) {
  const needle = query
    .replace(/[-_:]+/g, " ")
    .trim()
    .toLowerCase();
  const at = needle ? label.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, at)}
      <span className="font-semibold">
        {label.slice(at, at + needle.length)}
      </span>
      {label.slice(at + needle.length)}
    </>
  );
}

/**
 * `/orchestrate <request>`: the request, or "" when none was written. Null
 * for any other message.
 */
function orchestrateRequest(text: string): string | null {
  const match = /^\/orchestrate(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? (match[1] ?? "").trim() : null;
}

const NO_LEADS: LeadsList = { leads: [], defaultId: null, errors: [] };

/**
 * The team leads `workspace` sees (FE-88), kept current; null until read.
 *
 * No leads surface, or a read that fails, is an empty list: `/orchestrate`
 * then runs without one, as in FE-87.
 */
export function useTeamLeads(
  workspace: string | null,
  enabled = true,
): LeadsList | null {
  const [list, setList] = useState<LeadsList | null>(null);
  useEffect(() => {
    setList(null);
    if (!enabled) return;
    const surface = window.desktop?.leads;
    if (!surface) {
      setList(NO_LEADS);
      return;
    }
    let gone = false;
    const read = () =>
      surface
        .list(workspace)
        .then((next) => {
          if (!gone) setList(next);
        })
        .catch(() => {
          if (!gone) setList((current) => current ?? NO_LEADS);
        });
    void read();
    const off = surface.onChange((event) => {
      if (event.workspace === null || event.workspace === workspace)
        void read();
    });
    return () => {
      gone = true;
      off();
    };
  }, [workspace, enabled]);
  return list;
}

/** The rows `query` finds among the leads: by id first, then by name. */
function leadItems(leads: TeamLead[], query: string): Item[] {
  const q = query.toLowerCase();
  const byId = leads.filter((lead) => lead.id.startsWith(q));
  const byName = leads.filter(
    (lead) => !byId.includes(lead) && lead.name.toLowerCase().includes(q),
  );
  return [...byId, ...byName]
    .slice(0, 12)
    .map((lead) => ({ value: `@${lead.id}`, detail: lead.name, lead }));
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * The composer, where the next turn is written and sent.
 *
 * A turn sent while one runs is queued behind it. The composer carries
 * attachments, `/` and `@` suggestions, and the settings it is sent with.
 */
export const Composer = forwardRef<
  ComposerHandle,
  {
    /** The project, for its branch switcher. */
    slug: string;
    /**
     * Where the unsent text is kept in `./draft`.
     *
     * The conversation's id, or `new:<slug>` on the new-conversation page.
     */
    draftKey?: string;
    /** Take the caret on mount — the new-conversation page has nothing else. */
    autoFocus?: boolean;
    /** The top row's right corner: the conversation's context ring. */
    corner?: ReactNode;
    workspace: string;
    /**
     * The CLI the conversation is on, whose models alone are offered.
     *
     * Null on a new conversation, where the model picked picks the CLI.
     */
    agent?: ConversationAgent | null;
    settings: ComposerSettings;
    onSettings: (next: Partial<ComposerSettings>) => void;
    working: boolean;
    /** How many messages wait above: ↑ in an empty composer takes the last. */
    queued: number;
    onSend: (
      text: string,
      attachments: OutgoingAttachment[],
      names: { name: string; image: boolean }[],
    ) => Promise<boolean>;
    onStop: () => void;
    /** ↑ in an empty composer: the last queued message, back to edit. */
    onEditLastQueued?: () => void;
    /**
     * `/orchestrate [@lead] <request>` (FE-87, FE-88): sent here instead of
     * `onSend`, which the lead's planning turn then goes through. `teamLead`
     * is the `@` one, else the default one, else null. Absent: `/orchestrate`
     * is neither offered nor caught, and goes as written.
     */
    onOrchestrate?: (
      request: string,
      attachments: OutgoingAttachment[],
      names: { name: string; image: boolean }[],
      teamLead: TeamLead | null,
    ) => Promise<boolean>;
  }
>(function Composer(
  {
    slug,
    draftKey,
    autoFocus,
    corner,
    workspace,
    agent = null,
    settings,
    onSettings,
    working,
    queued,
    onSend,
    onStop,
    onEditLastQueued,
    onOrchestrate,
  },
  ref,
) {
  const {
    text,
    setText,
    attachments,
    setAttachments,
    error,
    setError,
    sending,
    setSending,
    isSending,
  } = useComposerDraft(workspace, draftKey);
  const [dragging, setDragging] = useState(false);
  const [suggest, setSuggest] = useState<{
    kind: Kind;
    start: number;
    query: string;
    items: Item[];
    index: number;
  } | null>(null);
  // Team leads, read only where `/orchestrate` is handled.
  const leads = useTeamLeads(workspace, Boolean(onOrchestrate));
  const leadsRef = useRef(leads);
  leadsRef.current = leads;
  const field = useRef<ChipEditorHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const asked = useRef(0);
  /**
   * Where the caret goes once the next value is drawn.
   *
   * Placed in a layout effect, never a frame later: keys typed in between
   * would land before it.
   */
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null || !field.current) return;
    field.current.select(caret.current);
    caret.current = null;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount only.
  useEffect(() => {
    // A restored draft: the caret at its end, where typing left off.
    if (autoFocus) field.current?.select(latest.current.length);
  }, []);

  const latest = useRef(text);
  latest.current = text;

  // The `/command` that starts the message and each `@path` in it, drawn as
  // chips (FE-92, FE-93). The text kept and sent stays the whole message.
  const [chipsVersion, learned] = useState(0);
  const chipFor = (token: string): ChipSpec | null => {
    const item =
      token === ORCHESTRATE.value
        ? onOrchestrate
          ? ORCHESTRATE
          : null
        : (known.get(token) ?? null);
    return item ? chipSpec(item) : null;
  };
  // The `/` list read ahead, so the first `/` opens it at once (FE-92).
  useEffect(() => {
    void window.desktop?.conversation
      ?.suggest(workspace, "command", "")
      .then(remember)
      .catch(() => {});
  }, [workspace]);
  // A restored draft's commands and paths nobody has listed yet: each asked
  // for once.
  const unknown = [
    ...(/^\/[^\s/]+(?=\s|$)/.exec(text) ?? []),
    ...(text.match(/(?<=^|\s)@\S+/g) ?? []),
  ].filter(
    (token) =>
      token !== ORCHESTRATE.value && !known.has(token) && !looked.has(token),
  );
  const unknownKey = unknown.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again only when the unknown tokens change.
  useEffect(() => {
    const surface = window.desktop?.conversation;
    if (!unknown.length || !surface) return;
    for (const token of unknown.slice(0, 20)) {
      looked.add(token);
      const path = token.startsWith("@");
      void surface
        .suggest(workspace, path ? "file" : "command", token.slice(1))
        .then((listed) => {
          remember(listed.filter((item) => item.value === token));
          // Each answer redraws: the others may still be on their way.
          if (known.has(token)) learned((n) => n + 1);
        })
        .catch(() => {});
    }
  }, [unknownKey, workspace]);

  // Dictation: the words heard go in where the caret was when the microphone
  // opened, replacing what was selected — shown live, kept on ✓.
  const anchor = useRef({ start: 0, end: 0 });
  const dictation = useDictation({
    onDone: (words) => {
      const next = insertDictation(latest.current, words, anchor.current);
      caret.current = next.cursor;
      setText(next.text);
    },
    onError: setError,
  });
  const dictating = dictation.status !== "idle";
  const startDictation = () => {
    anchor.current = field.current?.selection() ?? {
      start: text.length,
      end: text.length,
    };
    setSuggest(null);
    setError(null);
    field.current?.focus();
    void dictation.start();
  };
  const toggleDictation = useRef(() => {});
  toggleDictation.current = () => {
    if (!dictation.available) return;
    if (dictation.status === "listening") dictation.finish();
    else if (!dictating) startDictation();
  };
  // ⌘⇧M: from the field, or from nowhere in particular — never while another
  // field has the caret.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "m" ||
        !event.metaKey ||
        !event.shiftKey ||
        event.altKey ||
        event.ctrlKey
      )
        return;
      const focused = document.activeElement;
      if (
        focused &&
        focused !== document.body &&
        !root.current?.contains(focused)
      )
        return;
      event.preventDefault();
      toggleDictation.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const shown = dictating
    ? insertDictation(text, dictation.heard, anchor.current).text
    : text;

  useImperativeHandle(ref, () => ({
    insert: (value) => {
      const next = text.trim()
        ? `${text.replace(/\s*$/, "")}\n\n${value}`
        : value;
      caret.current = next.length;
      setText(next);
    },
    restore: (taken) => {
      // A queued `/orchestrate` comes back as it was typed, never as the
      // planning prompt it became (FE-91/U1); sending it again plans anew. A
      // repair has nothing typed to give back.
      const queued =
        readEnvelope(taken.text)?.kind === "repair"
          ? ""
          : visibleText(taken.text);
      // Typed meanwhile: kept, after what was queued before it.
      const current = latest.current;
      const next = current.trim() ? `${queued}\n\n${current}`.trim() : queued;
      caret.current = next.length;
      setText(next);
      setAttachments((previous) => [
        ...previous,
        ...taken.attachments.map((file) => ({ key: `a${++keys}`, ...file })),
      ]);
    },
  }));

  // What `/` or `@` offers, asked again as the query changes.
  const lookup = (value: string, caret: number) => {
    const found = trigger(value, caret, Boolean(onOrchestrate));
    if (!found) {
      setSuggest(null);
      return;
    }
    const mine = ++asked.current;
    const kind = found.kind;
    if (kind === "lead") {
      // Still being read: the list draws a skeleton until they are.
      const listed = leadsRef.current;
      const items = listed ? leadItems(listed.leads, found.query) : [];
      setSuggest(
        items.length || !listed ? { ...found, items, index: 0 } : null,
      );
      return;
    }
    const surface = window.desktop?.conversation;
    if (!surface) return;
    // The app's own command, ahead of the CLI's: only where it is handled.
    const own =
      onOrchestrate &&
      kind === "command" &&
      ORCHESTRATE.value.slice(1).startsWith(found.query.toLowerCase())
        ? [ORCHESTRATE]
        : [];
    void surface
      .suggest(workspace, kind, found.query)
      .catch(() => [] as Suggestion[])
      .then((listed) => {
        remember(listed);
        if (mine !== asked.current) return;
        const items = [
          ...own,
          ...listed.filter((item) => item.value !== ORCHESTRATE.value),
        ];
        setSuggest(
          items.length
            ? { ...found, items: items.slice(0, 12), index: 0 }
            : null,
        );
      })
      .catch(() => {
        if (mine === asked.current) setSuggest(null);
      });
  };

  // The row ↑↓ moved to stays in view.
  const list = useRef<HTMLDivElement>(null);
  const active = suggest ? suggest.index : -1;
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const activeId = suggest?.items[suggest.index]
    ? optionId(suggest.index)
    : null;
  // The field and its list, tied for a screen reader (FE-91/U6): it hears
  // that the list is open and the row ↑↓ moved to, while the caret stays put.
  // NOTE: Set on the field's node: ChipEditor draws it and takes no ARIA
  // props.
  useLayoutEffect(() => {
    const node = root.current?.querySelector<HTMLElement>('[role="textbox"]');
    if (!node) return;
    const open = Boolean(suggest);
    node.setAttribute("aria-autocomplete", "list");
    node.setAttribute("aria-expanded", String(open));
    if (open) node.setAttribute("aria-controls", listId);
    else node.removeAttribute("aria-controls");
    if (activeId) node.setAttribute("aria-activedescendant", activeId);
    else node.removeAttribute("aria-activedescendant");
  }, [suggest, listId, activeId]);
  useLayoutEffect(() => {
    if (active < 0) return;
    list.current
      ?.querySelectorAll('[role="option"]')
      [active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // The leads arrived, or changed, while their list is open: drawn again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the leads change.
  useEffect(() => {
    if (suggest?.kind !== "lead" || !leads) return;
    const items = leadItems(leads.leads, suggest.query);
    setSuggest(items.length ? { ...suggest, items, index: 0 } : null);
  }, [leads]);

  const choose = (item: Item) => {
    if (!suggest) return;
    if (suggest.kind !== "lead") remember([item]);
    const end = field.current?.selection()?.start ?? text.length;
    const next = `${text.slice(0, suggest.start)}${item.value} ${text.slice(end)}`;
    caret.current = suggest.start + item.value.length + 1;
    setText(next);
    setSuggest(null);
    asked.current++;
  };

  const addFiles = async (files: File[], pasted: boolean) => {
    const surface = window.desktop?.conversation;
    if (!surface) return;
    const added: Pending[] = [];
    for (const file of files) {
      const image = file.type.startsWith("image/");
      let path = "";
      try {
        path = surface.pathForFile(file);
      } catch {
        path = "";
      }
      if (path) {
        added.push({
          key: `a${++keys}`,
          name: file.name,
          image,
          out: { kind: "path", path },
        });
        continue;
      }
      // A pasted screenshot has no path: its bytes go, if small enough.
      if (pasted && image) {
        if (file.size > PASTE_MAX) {
          setError(
            `${file.name || "This image"} is larger than ${PASTE_MAX / 1024 / 1024} MB.`,
          );
          continue;
        }
        const data = await readBase64(file);
        added.push({
          key: `a${++keys}`,
          name: file.name || "image.png",
          image,
          out: {
            kind: "data",
            name: file.name || "image.png",
            mediaType: file.type,
            data,
          },
        });
        continue;
      }
      setError(`Could not attach ${file.name}.`);
    }
    if (added.length) setAttachments((previous) => [...previous, ...added]);
  };

  const empty = !text.trim() && attachments.length === 0;

  /**
   * The team lead `/orchestrate` runs under: the one named with `@`, else the
   * default one, else none.
   *
   * @returns null when an `@` names no lead: the error is said, nothing goes.
   */
  const resolveLead = async (
    named: string | null,
  ): Promise<{ lead: TeamLead | null } | null> => {
    let list = leadsRef.current;
    if (!list) {
      const surface = window.desktop?.leads;
      list = surface
        ? await surface.list(workspace).catch(() => NO_LEADS)
        : NO_LEADS;
    }
    if (named) {
      const found = list.leads.find((lead) => lead.id === named);
      if (!found) {
        setError(
          `No conductor is called @${named}. Type @ after /orchestrate to pick one.`,
        );
        return null;
      }
      return { lead: found };
    }
    return {
      lead: list.leads.find((lead) => lead.id === list.defaultId) ?? null,
    };
  };

  const send = async () => {
    if (empty || isSending()) return;
    const raw = onOrchestrate ? orchestrateRequest(text) : null;
    const split = raw === null ? null : splitLead(raw);
    if (split && !split.request) {
      setError(
        split.lead
          ? `Write what to orchestrate after /orchestrate @${split.lead}.`
          : "Write what to orchestrate after /orchestrate.",
      );
      return;
    }
    // Marked as sending before the first await: an Enter repeated while the
    // team leads are read finds it so, and does not plan twice (FE-91/U14).
    setSending(true);
    setError(null);
    let teamLead: TeamLead | null = null;
    if (split) {
      const resolved = await resolveLead(split.lead).catch(() => null);
      if (!resolved) {
        setSending(false);
        return;
      }
      teamLead = resolved.lead;
    }
    const request = split?.request ?? null;
    const sent = text;
    const files = attachments;
    setText("");
    setAttachments([]);
    setSuggest(null);
    let ok = false;
    try {
      const outgoing = files.map((file) => file.out);
      const names = files.map((file) => ({
        name: file.name,
        image: file.image,
      }));
      ok =
        request !== null && onOrchestrate
          ? await onOrchestrate(request, outgoing, names, teamLead)
          : await onSend(sent.trim(), outgoing, names);
    } catch {
      setError("Could not send. Your message has been restored.");
    }
    setSending(false);
    if (!ok) {
      // Nothing was sent: the words come back, not lost.
      setError("Could not send. Your message has been restored.");
      setText((current) => (current ? `${sent}\n\n${current}` : sent));
      setAttachments((current) => [...files, ...current]);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // While dictating the field is read-only: Esc is ✕ and Enter is ✓. Enter
    // never sends a message nobody has read yet.
    if (dictating) {
      if (event.key === "Escape") {
        event.preventDefault();
        dictation.cancel();
      } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (dictation.status === "listening") dictation.finish();
      }
      return;
    }
    // ⌘U, a terminal's ^U: what is before the caret on its line goes — at a
    // line's start, the line break, so pressing again keeps going.
    if (
      event.key.toLowerCase() === "u" &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      const picked = field.current?.selection();
      if (!picked) return;
      const { start, end } = picked;
      if (start === end) {
        if (start === 0) return;
        const line = text.lastIndexOf("\n", start - 1) + 1;
        field.current?.select(line < start ? line : start - 1, start);
      }
      // NOTE: execCommand, not setText: the cut lands on the field's undo
      // stack, so ⌘Z brings it back, and it fires the input onChange reads.
      document.execCommand("delete");
      return;
    }
    if (suggest) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSuggest({
          ...suggest,
          index:
            (suggest.index + step + suggest.items.length) %
            suggest.items.length,
        });
        return;
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        const item = suggest.items[suggest.index];
        if (item) {
          event.preventDefault();
          choose(item);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuggest(null);
        return;
      }
    }
    // ↑ in an empty composer: the last queued message comes back to be
    // edited, as a terminal's history would.
    if (
      event.key === "ArrowUp" &&
      empty &&
      queued > 0 &&
      onEditLastQueued &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      onEditLastQueued();
      return;
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      // A held Enter sends once, not once per repeat.
      if (!event.repeat) void send();
    }
  };

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error, setError]);

  const stopping = working && empty;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for files; the + menu's Upload file is the keyboard's way to attach.
    <div
      ref={root}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragging(false);
        void addFiles([...event.dataTransfer.files], false);
      }}
      className={cn(
        "bg-card border-border relative flex flex-col gap-1 rounded-xl border px-3 pt-2.5 pb-2 shadow-xs transition-colors",
        dragging && "border-ring",
      )}
    >
      {suggest && (
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label={
            suggest.kind === "command"
              ? "Commands"
              : suggest.kind === "lead"
                ? "Conductors"
                : "Files"
          }
          className="bg-popover text-popover-foreground ring-foreground/10 absolute right-0 bottom-full left-0 z-20 mb-1.5 max-h-56 overflow-y-auto rounded-xl p-1 shadow-lg ring-1"
        >
          {suggest.kind === "lead" && !leads && (
            <ListSkeleton label="Reading the conductors" rows={2} />
          )}
          {suggest.items.map((item, index) =>
            item.lead ? (
              <button
                key={item.value}
                type="button"
                id={optionId(index)}
                role="option"
                aria-selected={index === suggest.index}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(item)}
                onPointerEnter={() => setSuggest({ ...suggest, index })}
                className="aria-selected:bg-foreground/[0.08] flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left"
              >
                <HugeiconsIcon
                  icon={leadIcon(item.lead.icon)}
                  className="text-muted-foreground size-3.5 shrink-0"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate text-[13px]">
                  {item.lead.name}
                </span>
                <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                  {item.value}
                </span>
                <span className="text-muted-foreground ml-auto shrink-0 text-[11px]">
                  {leads?.defaultId === item.lead.id
                    ? `Default, ${LEAD_SOURCE_LABELS[item.lead.source].toLowerCase()}`
                    : LEAD_SOURCE_LABELS[item.lead.source]}
                </span>
              </button>
            ) : item.kind ? (
              <button
                key={item.value}
                type="button"
                id={optionId(index)}
                role="option"
                aria-selected={index === suggest.index}
                title={item.value}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(item)}
                onPointerEnter={() => setSuggest({ ...suggest, index })}
                className="aria-selected:bg-foreground/[0.08] flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1 text-left"
              >
                <SuggestionIcon item={item} tinted />
                <span className="shrink-0 text-[13px]">
                  <Matched
                    label={item.label ?? item.value}
                    query={suggest.query}
                  />
                </span>
                {item.detail && (
                  <span className="text-muted-foreground min-w-0 truncate text-[13px]">
                    {item.detail}
                  </span>
                )}
                {item.source && (
                  <span className="text-muted-foreground ml-auto shrink-0 ps-2 text-[11px]">
                    {SOURCE_LABELS[item.source]}
                  </span>
                )}
              </button>
            ) : (
              <button
                key={item.value}
                type="button"
                id={optionId(index)}
                role="option"
                aria-selected={index === suggest.index}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(item)}
                onPointerEnter={() => setSuggest({ ...suggest, index })}
                className="aria-selected:bg-foreground/[0.08] flex w-full min-w-0 items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left"
              >
                <span className="shrink-0 font-mono text-[12px]">
                  {item.value}
                </span>
                {item.detail && (
                  <span className="text-muted-foreground min-w-0 truncate text-xs">
                    {item.detail}
                  </span>
                )}
              </button>
            ),
          )}
        </div>
      )}

      <div className="text-muted-foreground flex min-h-6 min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
        {/* The checkout's branch — where the next turn runs — and the way to
            another one. Attached files follow it on the same line. */}
        <BranchSwitcher slug={slug} variant="composer" />
        {attachments.length > 0 && (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {attachments.map((file) => (
              <span
                key={file.key}
                className="bg-foreground/[0.06] text-foreground flex h-6 max-w-60 items-center gap-1.5 rounded-md ps-2 pe-1 text-xs"
              >
                <HugeiconsIcon
                  icon={file.image ? Image01Icon : File01Icon}
                  className={cn(
                    "size-3.5 shrink-0",
                    file.image ? "text-tone-teal" : "text-muted-foreground",
                  )}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() =>
                    setAttachments((previous) =>
                      previous.filter((entry) => entry.key !== file.key),
                    )
                  }
                  className="text-muted-foreground hover:text-foreground flex size-4 items-center justify-center rounded transition-colors"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    className="size-3"
                    strokeWidth={2}
                  />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <ChipEditor
        ref={field}
        value={shown}
        chipFor={chipFor}
        chipsVersion={chipsVersion}
        readOnly={dictating}
        label="Message Claude"
        placeholder={
          dictation.status === "preparing"
            ? "Downloading the speech model…"
            : dictating
              ? "Listening…"
              : "Ask, build, / for commands, @ for references…"
        }
        onChange={(next, at) => {
          setText(next);
          lookup(next, at);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setSuggest(null)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (!files.length) return;
          event.preventDefault();
          void addFiles(files, true);
        }}
        className={cn(
          "font-content max-h-60 min-h-11 w-full overflow-y-auto py-2 text-[14px] leading-relaxed",
          dictating && "text-muted-foreground italic",
        )}
      />

      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}

      <div className="flex min-w-0 items-center gap-1.5">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            void addFiles(files, false);
          }}
        />
        <AttachMenu onUpload={() => picker.current?.click()} />
        {!dictating && (
          <>
            <ModelMenu
              settings={settings}
              agent={agent}
              onChange={onSettings}
            />
            <PermissionMenu
              permission={settings.permission}
              onChange={(permission) => onSettings({ permission })}
            />
          </>
        )}
        <span className="ml-auto" />
        {/* Working, and the context ring, beside the voice button. */}
        {working && !dictating && (
          <span role="status" aria-label="Working" className="flex">
            <HugeiconsIcon
              icon={Loading03Icon}
              className="size-4 animate-spin motion-reduce:animate-none"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </span>
        )}
        {!dictating && corner}
        {dictating ? (
          <DictationBar
            status={dictation.status}
            levels={dictation.levels}
            onCancel={dictation.cancel}
            onDone={dictation.finish}
          />
        ) : (
          dictation.available && <DictationButton onStart={startDictation} />
        )}
        {dictating ? null : stopping ? (
          <button
            type="button"
            aria-label="Stop"
            onClick={onStop}
            className="bg-primary text-primary-foreground hover:bg-primary/85 flex size-7 items-center justify-center rounded-lg transition-colors"
          >
            <HugeiconsIcon
              icon={StopIcon}
              className="size-3.5"
              strokeWidth={2}
            />
          </button>
        ) : (
          <button
            type="button"
            aria-label={working ? "Queue message" : "Send"}
            disabled={empty || sending}
            onClick={() => void send()}
            className="bg-primary text-primary-foreground hover:bg-primary/85 disabled:bg-foreground/10 disabled:text-muted-foreground flex size-7 items-center justify-center rounded-lg transition-colors"
          >
            <HugeiconsIcon
              icon={ArrowUp02Icon}
              className="size-4"
              strokeWidth={2}
            />
          </button>
        )}
      </div>
    </div>
  );
});
