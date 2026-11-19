import {
  ArrowUp02Icon,
  CommandLineIcon,
  CubeIcon,
  EraserIcon,
  Folder01Icon,
  SlashIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
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
import { StopGlyph } from "#/components/shared/common/stop-glyph";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { BranchSwitcher } from "#/components/shared/repo/branch-switcher";
import { Kbd } from "#/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { rememberSent } from "#/lib/attachment-previews";
import { fileSize } from "#/lib/file-size";
import {
  LEAD_SOURCE_LABELS,
  leadIcon,
  readEnvelope,
  splitLead,
  visibleText,
} from "#/lib/orchestration-prompt";
import { type Quote, quoteBlock, quoteOf } from "#/lib/quote";
import { cn } from "#/lib/utils";
import {
  type PendingAttachment as Pending,
  useComposerDraft,
} from "#/stores/conversation-sends";
import { AttachmentTile } from "./composer.attachments";
import {
  DictationBar,
  DictationButton,
  useDictation,
} from "./composer.dictation";
import {
  ATTACHMENT_MARK,
  ChipEditor,
  type ChipEditorHandle,
  type ChipSpec,
} from "./composer.editor";
import { known, looked, remember } from "./composer.known";
import { AttachMenu, ModelMenu, PermissionMenu } from "./composer.menus";
import { QuotesTab } from "./composer.quotes";

/**
 * Send and Stop: glassy, the brand colour lit from above. A gradient from a
 * lighter to the full primary, a darker hairline border, a white inner
 * highlight on the top edge and a soft drop shadow.
 */
const GLASS =
  "text-primary-foreground flex size-8 items-center justify-center rounded-xl border border-[color-mix(in_oklch,var(--primary),black_18%)] bg-[linear-gradient(180deg,color-mix(in_oklch,var(--primary),white_24%),var(--primary)_70%)] shadow-[inset_0_1px_0_rgb(255_255_255/0.38),inset_0_-1px_0_rgb(0_0_0/0.08),0_1px_2px_rgb(0_0_0/0.14),0_4px_10px_-4px_color-mix(in_oklch,var(--primary),transparent_45%)] transition-[filter] duration-150 hover:brightness-[1.06] active:brightness-95";

export interface ComposerHandle {
  /** Put `text` in the composer and focus it. */
  insert: (text: string) => void;
  /**
   * Quote `text` in the next message: a whole message replied to (one at a
   * time) or a passage mentioned (as many as wanted). Shown in a tab above
   * the composer, sent as `> ` quotes ahead of what is typed.
   */
  quote: (text: string, kind: Quote["kind"]) => void;
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

/** An attachment's place in the text (see {@link ATTACHMENT_MARK}). */
const markOf = (key: string) => `${ATTACHMENT_MARK}${key}${ATTACHMENT_MARK}`;
/** Every attachment mark in a text, its key in group 1. */
const MARKS = /\uFFFC([^\uFFFC\s]+)\uFFFC/g;

/**
 * `text` as it is sent: each attachment's mark becomes its name in brackets,
 * `[image.png]`, beside the files and images that go with the message. A
 * mark whose attachment is gone goes with its space.
 */
function withoutMarks(text: string, files: readonly Pending[]): string {
  const names = new Map(files.map((file) => [file.key, `[${file.name}]`]));
  return replaceMarks(text, (key) => names.get(key) ?? false);
}

/**
 * Each attachment mark in `text` as `put` says: kept (`true`), written as a
 * string, or gone with the space after it (`false`).
 */
function replaceMarks(
  text: string,
  put: (key: string) => string | boolean,
): string {
  return text.replace(new RegExp(`${MARKS.source}( ?)`, "g"), (whole, key) => {
    const to = put(key);
    if (to === true) return whole;
    if (to === false) return "";
    return `${to}${whole.slice(markOf(key).length)}`;
  });
}

/** `files` with the ones placed in `text` first, in the order they are. */
function inTextOrder(text: string, files: readonly Pending[]): Pending[] {
  const order = [...text.matchAll(MARKS)].map((match) => match[1]);
  const rank = (file: Pending) => {
    const at = order.indexOf(file.key);
    return at === -1 ? order.length : at;
  };
  return [...files].sort((a, b) => rank(a) - rank(b));
}

/**
 * An attachment placed in the text as a chip: the image's own thumbnail or
 * its type's icon, its name, and its size when known.
 */
function attachmentChip(file: Pending, preview: string | undefined): ChipSpec {
  const path = file.out.kind === "path" ? file.out.path : file.name;
  return {
    value: markOf(file.key),
    label: file.name,
    detail: file.size === undefined ? undefined : fileSize(file.size),
    title: path,
    icon: preview ? (
      <img
        src={preview}
        alt=""
        draggable={false}
        className="ring-border size-full rounded-[3px] object-cover ring-1"
      />
    ) : file.folder ? (
      <HugeiconsIcon
        icon={Folder01Icon}
        className="size-3.5 shrink-0"
        strokeWidth={1.8}
        aria-hidden="true"
      />
    ) : (
      <FileTypeIcon path={file.name} className="size-3.5 shrink-0" />
    ),
    tone: "primary",
  };
}

/** `/orchestrate`, offered among the `/` commands when the page takes it. */
const ORCHESTRATE: Suggestion = {
  value: "/orchestrate",
  detail: "Plan workers for a request; nothing runs until you approve",
  label: "Orchestrate",
  kind: "command",
  source: "builtin",
};

/**
 * `/clear`, offered among the `/` commands when the page takes it: the page
 * asks first, then starts the conversation over. Caught here, never sent,
 * so a CLI's own `/clear` never runs behind the app's back.
 */
const CLEAR: Suggestion = {
  value: "/clear",
  detail: "Start this conversation over, after you confirm",
  label: "Clear",
  kind: "command",
  source: "builtin",
};

const SOURCE_LABELS: Record<CommandSource, string> = {
  project: "Project",
  personal: "Personal",
  builtin: "Built-in",
};

/** A `/` suggestion's icon: the team-lead one for `/orchestrate`. */
function commandIcon(item: Suggestion) {
  if (item.value === ORCHESTRATE.value) return UserGroupIcon;
  if (item.value === CLEAR.value) return EraserIcon;
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

/** A team lead named with `@` as a chip: its icon and name. */
function leadChip(lead: TeamLead): ChipSpec {
  return {
    value: `@${lead.id}`,
    label: lead.name,
    title: `@${lead.id}\n${lead.name}`,
    icon: (
      <HugeiconsIcon
        icon={leadIcon(lead.icon)}
        className="size-3.5 shrink-0"
        strokeWidth={1.8}
        aria-hidden="true"
      />
    ),
    tone: "teal",
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
 * The team leads `project` sees (FE-88), kept current; null until read.
 *
 * No leads surface, or a read that fails, is an empty list: `/orchestrate`
 * then runs without one, as in FE-87.
 */
export function useTeamLeads(
  project: string | null,
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
        .list(project)
        .then((next) => {
          if (!gone) setList(next);
        })
        .catch(() => {
          if (!gone) setList((current) => current ?? NO_LEADS);
        });
    void read();
    const off = surface.onChange((event) => {
      if (event.project === null || event.project === project) void read();
    });
    return () => {
      gone = true;
      off();
    };
  }, [project, enabled]);
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
    project: string;
    /**
     * The CLI the conversation is on, whose models alone are offered.
     *
     * Null on a new conversation, where the model picked picks the CLI.
     */
    agent?: ConversationAgent | null;
    settings: ComposerSettings;
    onSettings: (next: Partial<ComposerSettings>) => void;
    working: boolean;
    /**
     * Hidden behind a card that asks first (a permission, a question): its
     * menus close, or one left open would float at the window's corner with
     * nothing to anchor to.
     */
    suspended?: boolean;
    /** How many messages wait above: ↑ in an empty composer takes the last. */
    queued: number;
    onSend: (
      text: string,
      attachments: OutgoingAttachment[],
      names: { name: string; image: boolean; size?: number }[],
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
      names: { name: string; image: boolean; size?: number }[],
      teamLead: TeamLead | null,
    ) => Promise<boolean>;
    /**
     * `/clear`, sent alone: called instead of `onSend`, and the page asks
     * before it starts over. Absent: `/clear` is neither offered nor caught,
     * and goes as written.
     */
    onClear?: () => void;
  }
>(function Composer(
  {
    slug,
    draftKey,
    autoFocus,
    corner,
    project,
    agent = null,
    settings,
    onSettings,
    working,
    suspended = false,
    queued,
    onSend,
    onStop,
    onEditLastQueued,
    onOrchestrate,
    onClear,
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
  } = useComposerDraft(project, draftKey);
  const [dragging, setDragging] = useState(false);
  /** What the next message quotes, in order. */
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [suggest, setSuggest] = useState<{
    kind: Kind;
    start: number;
    query: string;
    items: Item[];
    index: number;
  } | null>(null);
  // Team leads, read only where `/orchestrate` is handled.
  const leads = useTeamLeads(project, Boolean(onOrchestrate));
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

  /**
   * The images attached in this sitting, by attachment key, to draw them as
   * thumbnails and open them large. An image restored with a draft has
   * none, and shows as a chip.
   */
  const [previews, setPreviews] = useState<Record<string, string>>({});
  // The `/command` that starts the message, each `@path` in it and each
  // attachment placed in it, drawn as chips (FE-92, FE-93). The text kept
  // stays the whole message; what is sent names the attachments.
  const [chipsVersion, learned] = useState(0);
  /** The lead an `@` names as `/orchestrate`'s first word (FE-88), if any. */
  const leadFor = (token: string): TeamLead | null => {
    if (!onOrchestrate || !token.startsWith("@")) return null;
    const named = /^\s*\/orchestrate[ \t]+(@\S+)/.exec(latest.current)?.[1];
    if (named !== token) return null;
    return (
      leadsRef.current?.leads.find((lead) => `@${lead.id}` === token) ?? null
    );
  };
  const chipFor = (token: string): ChipSpec | null => {
    if (token.startsWith(ATTACHMENT_MARK)) {
      const file = attachments.find((entry) => markOf(entry.key) === token);
      return file ? attachmentChip(file, previews[file.key]) : null;
    }
    const lead = leadFor(token);
    if (lead) return leadChip(lead);
    const item =
      token === ORCHESTRATE.value
        ? onOrchestrate
          ? ORCHESTRATE
          : null
        : token === CLEAR.value && onClear
          ? CLEAR
          : (known.get(token) ?? null);
    return item ? chipSpec(item) : null;
  };
  // Leads read after the text was drawn: drawn again, so `@lead` is a chip.
  useEffect(() => {
    if (leads) learned((n) => n + 1);
  }, [leads]);
  // The `/` list read ahead, so the first `/` opens it at once (FE-92).
  useEffect(() => {
    void window.desktop?.conversation
      ?.suggest(project, "command", "", agent)
      .then(remember)
      .catch(() => {});
  }, [project, agent]);
  // A restored draft's commands and paths nobody has listed yet: each asked
  // for once.
  const unknown = [
    // OpenCode names a command in a folder `/git/commit` (FE-105/D3).
    ...(/^\/[^\s]+(?=\s|$)/.exec(text) ?? []),
    ...(text.match(/(?<=^|\s)@\S+/g) ?? []),
  ].filter(
    (token) =>
      token !== ORCHESTRATE.value &&
      !(onClear && token === CLEAR.value) &&
      !leadFor(token) &&
      !known.has(token) &&
      !looked.has(token),
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
        .suggest(project, path ? "file" : "command", token.slice(1), agent)
        .then((listed) => {
          remember(listed.filter((item) => item.value === token));
          // Each answer redraws: the others may still be on their way.
          if (known.has(token)) learned((n) => n + 1);
        })
        .catch(() => {});
    }
  }, [unknownKey, project]);

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
  const dictatingRef = useRef(dictating);
  dictatingRef.current = dictating;
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

  // One line, or none: +, the words, then voice and send on one row. Two
  // lines or more: the words take the full width and the controls move to a
  // row under them. A wrapped line stacks it too; it unstacks once the text
  // is shorter than where it wrapped (or loses its line break), so the
  // widening it causes cannot flip it back and forth.
  const [stacked, setStacked] = useState(false);
  const wrappedAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (shown.includes("\n")) {
      wrappedAt.current = null;
      setStacked(true);
      return;
    }
    if (stacked) {
      if (wrappedAt.current === null || shown.length < wrappedAt.current) {
        wrappedAt.current = null;
        setStacked(false);
      }
      return;
    }
    const box = root.current?.querySelector<HTMLElement>('[role="textbox"]');
    // One line of 14px text at leading-relaxed, with its padding, is 36px.
    if (box && box.scrollHeight > 48) {
      wrappedAt.current = shown.length;
      setStacked(true);
    }
  }, [shown, stacked]);

  useImperativeHandle(ref, () => ({
    quote: (value, kind) => {
      const next = quoteOf(value, kind);
      if (!next) return;
      setQuotes((previous) => [
        ...previous.filter(
          (entry) => kind !== "reply" || entry.kind !== "reply",
        ),
        next,
      ]);
      caret.current = latest.current.length;
      field.current?.focus();
    },
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
    const query = found.query.toLowerCase();
    const own = [
      ...(onOrchestrate &&
      kind === "command" &&
      ORCHESTRATE.value.slice(1).startsWith(query)
        ? [ORCHESTRATE]
        : []),
      ...(onClear &&
      kind === "command" &&
      CLEAR.value.slice(1).startsWith(query)
        ? [CLEAR]
        : []),
    ];
    void surface
      .suggest(project, kind, found.query, agent)
      .catch(() => [] as Suggestion[])
      .then((listed) => {
        remember(listed);
        if (mine !== asked.current) return;
        const items = [
          ...own,
          // The app's own commands once, ahead of a CLI's of the same name.
          ...listed.filter(
            (item) =>
              item.value !== ORCHESTRATE.value &&
              !(onClear && item.value === CLEAR.value),
          ),
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

  /** Where the caret was when the field last had it. */
  const lastCaret = useRef<number | null>(null);
  /**
   * The attachments `added` placed in the text as chips, where the caret is
   * or was last, a space either side.
   */
  const placeInline = (added: readonly string[]) => {
    const current = latest.current;
    const at = Math.min(
      field.current?.selection()?.start ?? lastCaret.current ?? current.length,
      current.length,
    );
    const before = current.slice(0, at);
    const after = current.slice(at);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const marks = added.map(markOf).join(" ");
    const next = `${before}${lead}${marks}${after.startsWith(" ") ? "" : " "}${after}`;
    caret.current = before.length + lead.length + marks.length + 1;
    setText(next);
  };

  // The text and the attachments kept in step: a chip deleted from the text
  // takes its attachment with it, and an attachment removed by its × (or
  // lost with a reload, its mark kept in the draft) takes its chip.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run when either side changes.
  useEffect(() => {
    if (dictating) return;
    const placed = new Set([...text.matchAll(MARKS)].map((match) => match[1]));
    if (attachments.some((file) => file.inline && !placed.has(file.key)))
      setAttachments((previous) =>
        previous.filter((file) => !file.inline || placed.has(file.key)),
      );
    const held = new Set(attachments.map((file) => file.key));
    if ([...placed].some((key) => !held.has(key)))
      setText((current) => replaceMarks(current, (key) => held.has(key)));
  }, [text, attachments]);

  const addFiles = async (
    files: File[],
    pasted: boolean,
    folders: ReadonlySet<File> = new Set(),
  ) => {
    const surface = window.desktop?.conversation;
    if (!surface) return;
    const added: Pending[] = [];
    const seen: Record<string, string> = {};
    for (const file of files) {
      const image = file.type.startsWith("image/");
      let path = "";
      try {
        path = surface.pathForFile(file);
      } catch {
        path = "";
      }
      if (path) {
        const key = `a${++keys}`;
        if (image) seen[key] = URL.createObjectURL(file);
        const folder = folders.has(file);
        added.push({
          key,
          name: file.name,
          image,
          folder,
          ...(folder ? {} : { size: file.size }),
          inline: true,
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
        const key = `a${++keys}`;
        seen[key] = `data:${file.type};base64,${data}`;
        added.push({
          key,
          name: file.name || "image.png",
          image,
          size: file.size,
          inline: true,
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
    if (Object.keys(seen).length)
      setPreviews((previous) => ({ ...previous, ...seen }));
    if (!added.length) return;
    // While dictating the words heard go where the caret was: the chips
    // would move them. The attachments show above the field only.
    const placed = dictatingRef.current
      ? added.map((file) => ({ ...file, inline: false }))
      : added;
    setAttachments((previous) => [...previous, ...placed]);
    if (!dictatingRef.current) placeInline(added.map((file) => file.key));
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
        ? await surface.list(project).catch(() => NO_LEADS)
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
    // `/clear` alone is the page's, and asks first: the words go, nothing is
    // sent. With attachments it is a message, and goes as written.
    if (onClear && text.trim() === CLEAR.value && attachments.length === 0) {
      setText("");
      setSuggest(null);
      setError(null);
      onClear();
      return;
    }
    // What is sent names each attachment where its chip is; the draft kept
    // to restore on a failure keeps the chips.
    const plain = withoutMarks(text, attachments);
    const raw = onOrchestrate ? orchestrateRequest(plain) : null;
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
    // The reply goes with a plain message, ahead of it as a quote; an
    // `/orchestrate` plans what was typed, and the reply waits for the next.
    const quoted = request === null ? quoteBlock(quotes) : "";
    // In the order their chips are in the text, then the rest: the chat
    // matches the n-th image named in the text to the n-th image sent.
    const files = inTextOrder(text, attachments);
    rememberSent(
      files.map((file) => ({
        name: file.name,
        size: file.size,
        preview: previews[file.key],
      })),
    );
    setText("");
    setAttachments([]);
    setSuggest(null);
    let ok = false;
    try {
      const outgoing = files.map((file) => file.out);
      const names = files.map((file) => ({
        name: file.name,
        image: file.image,
        ...(file.size === undefined ? {} : { size: file.size }),
      }));
      ok =
        request !== null && onOrchestrate
          ? await onOrchestrate(request, outgoing, names, teamLead)
          : await onSend(`${quoted}${plain.trim()}`, outgoing, names);
    } catch {
      setError("Could not send. Your message has been restored.");
    }
    setSending(false);
    if (ok && quoted) setQuotes([]);
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
  /** Which control has the field's right-hand place. */
  const slot = dictating
    ? "dictating"
    : stopping
      ? "stop"
      : !empty
        ? "send"
        : "mic";
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <>
      <QuotesTab
        quotes={quotes}
        onRemove={(key) => {
          setQuotes((previous) =>
            previous.filter((entry) => entry.key !== key),
          );
          field.current?.focus();
        }}
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target for files; the + menu's Upload file is the keyboard's way to attach. */}
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
          // Only the drop's entries tell a folder from a file: a File does not.
          const files: File[] = [];
          const folders = new Set<File>();
          for (const item of event.dataTransfer.items) {
            const file = item.kind === "file" ? item.getAsFile() : null;
            if (!file) continue;
            files.push(file);
            if (item.webkitGetAsEntry()?.isDirectory) folders.add(file);
          }
          void addFiles(files, false, folders);
        }}
        className="flex min-w-0 flex-col gap-1.5"
      >
        {/* The field: attach, what is typed, send and voice, in one line
            while it is short. Where it runs, the model, the access and the
            context sit under it, out of the way of the words. */}
        <div
          className={cn(
            "bg-card border-border relative flex flex-col gap-1 rounded-2xl border px-2 py-1.5 shadow-[0_1px_2px_rgb(0_0_0/0.03),0_4px_12px_-4px_rgb(0_0_0/0.06)] transition-[color,background-color,border-color,box-shadow] focus-within:shadow-[0_1px_2px_rgb(0_0_0/0.04),0_6px_16px_-6px_rgb(0_0_0/0.09)]",
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

          <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 px-1.5 pt-1 text-[13px] empty:hidden">
            {attachments.length > 0 && (
              <div className="flex min-w-0 flex-wrap items-end gap-2 pt-1.5 pr-1.5">
                {attachments.map((file) => (
                  <AttachmentTile
                    key={file.key}
                    file={file}
                    preview={previews[file.key]}
                    onRemove={() =>
                      setAttachments((previous) =>
                        previous.filter((entry) => entry.key !== file.key),
                      )
                    }
                  />
                ))}
              </div>
            )}
          </div>

          <div
            className={cn(
              "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-x-1",
              stacked
                ? "[grid-template-areas:'field_field_field'_'plus_gap_actions']"
                : "[grid-template-areas:'plus_field_actions']",
            )}
          >
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
            {!suspended && (
              <span className="flex h-9 shrink-0 items-center [grid-area:plus]">
                <AttachMenu
                  onUpload={() => picker.current?.click()}
                  onSlash={() => {
                    // Typed as if by hand, at the caret: the field's own
                    // input handling opens the command list.
                    window.setTimeout(() => {
                      field.current?.focus();
                      document.execCommand("insertText", false, "/");
                    });
                  }}
                />
              </span>
            )}
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
                lastCaret.current = at;
                setText(next);
                lookup(next, at);
              }}
              onKeyDown={onKeyDown}
              onBlur={() => {
                lastCaret.current =
                  field.current?.selection()?.start ?? lastCaret.current;
                setSuggest(null);
              }}
              onPaste={(event) => {
                const files = [...event.clipboardData.files];
                if (!files.length) return;
                event.preventDefault();
                void addFiles(files, true);
              }}
              className={cn(
                "font-content max-h-60 min-h-9 min-w-0 overflow-y-auto py-1.5 text-[14px] leading-relaxed [grid-area:field]",
                stacked ? "px-1.5 pt-2" : "px-1",
                dictating && "text-muted-foreground italic",
              )}
            />
            <span className="flex h-9 shrink-0 items-center gap-1 [grid-area:actions]">
              {/* Mic, Send and Stop share one place: the one leaving shrinks
                  and fades as the next grows in, quick, so typing the first
                  letter turns the mic into Send without a jump. */}
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={slot}
                  className="flex items-center"
                  initial={
                    reduceMotion
                      ? { opacity: 0 }
                      : { opacity: 0, scale: 0.6, filter: "blur(2px)" }
                  }
                  animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                  exit={
                    reduceMotion
                      ? { opacity: 0 }
                      : { opacity: 0, scale: 0.6, filter: "blur(2px)" }
                  }
                  transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
                >
                  {dictating ? (
                    <DictationBar
                      status={dictation.status}
                      levels={dictation.levels}
                      onCancel={dictation.cancel}
                      onDone={dictation.finish}
                    />
                  ) : stopping ? (
                    <button
                      type="button"
                      aria-label="Stop"
                      onClick={onStop}
                      className={GLASS}
                    >
                      <StopGlyph className="size-3.5" />
                    </button>
                  ) : !empty ? (
                    // Something typed: the mic's place sends it (Return).
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label={working ? "Queue message" : "Send"}
                            disabled={sending}
                            onClick={() => void send()}
                            className={cn(GLASS, "disabled:opacity-50")}
                          />
                        }
                      >
                        <HugeiconsIcon
                          icon={ArrowUp02Icon}
                          className="size-4"
                          strokeWidth={2}
                        />
                      </TooltipTrigger>
                      <TooltipContent className="gap-3">
                        {working ? "Queue" : "Send"}
                        <Kbd>↵</Kbd>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    dictation.available && (
                      <DictationButton onStart={startDictation} />
                    )
                  )}
                </motion.span>
              </AnimatePresence>
            </span>
          </div>

          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
        </div>

        {/* Under the field: where it runs on the left; the model, the
            access and the context ring on the right. A turn at work is told by
            the header's mark, the tab's and Stop; no spinner here. */}
        {!suspended && (
          <div className="text-muted-foreground flex min-h-7 min-w-0 items-center gap-1.5 px-1.5 text-[13px]">
            <BranchSwitcher slug={slug} variant="composer" />
            <span className="ml-auto" />
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
            {!dictating && corner}
          </div>
        )}
      </div>
    </>
  );
});
