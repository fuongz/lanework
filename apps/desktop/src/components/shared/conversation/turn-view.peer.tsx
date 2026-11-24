import { Link } from "@tanstack/react-router";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import { clock } from "#/lib/conversation-format";
import { cn } from "#/lib/utils";
import type { PeerTurn } from "../../../../shared/conversation";
import { chatLink } from "./turn-view.link-chip";

/**
 * Each sender's colour: an avatar, its name and a tinted bubble. Whole class
 * strings, so Tailwind sees them.
 */
const TONES = [
  {
    avatar: "bg-tone-violet/15 text-tone-violet",
    name: "text-tone-violet",
    bubble: "bg-tone-violet/[0.08] dark:bg-tone-violet/[0.12]",
  },
  {
    avatar: "bg-tone-sky/15 text-tone-sky",
    name: "text-tone-sky",
    bubble: "bg-tone-sky/[0.08] dark:bg-tone-sky/[0.12]",
  },
  {
    avatar: "bg-tone-emerald/15 text-tone-emerald",
    name: "text-tone-emerald",
    bubble: "bg-tone-emerald/[0.08] dark:bg-tone-emerald/[0.12]",
  },
  {
    avatar: "bg-tone-rose/15 text-tone-rose",
    name: "text-tone-rose",
    bubble: "bg-tone-rose/[0.08] dark:bg-tone-rose/[0.12]",
  },
  {
    avatar: "bg-tone-teal/15 text-tone-teal",
    name: "text-tone-teal",
    bubble: "bg-tone-teal/[0.08] dark:bg-tone-teal/[0.12]",
  },
  {
    avatar: "bg-tone-blue/15 text-tone-blue",
    name: "text-tone-blue",
    bubble: "bg-tone-blue/[0.08] dark:bg-tone-blue/[0.12]",
  },
] as const;

/** A sender's colour, the same for the same name every time. */
export function toneOf(key: string): (typeof TONES)[number] {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length] as (typeof TONES)[number];
}

/**
 * Two letters for an avatar: `send-b2` reads `B2`, `content-d6` `D6`,
 * `Web lead` `WL`.
 */
export function initials(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  const last = words.at(-1) ?? name;
  if (words.length > 1 && /\d/.test(last))
    return last.slice(0, 2).toUpperCase();
  if (words.length > 1)
    return `${words[0]?.[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/**
 * A message another Claude session on this machine sent into this
 * conversation (FE-169), drawn as a group chat's: the sender's avatar and
 * name, and a bubble in its colour on the left, across from the user's own
 * on the right. Never a bubble the user wrote. It links to the sender when
 * it is a Lanework conversation (D2), and says when the sender skips
 * permission prompts, since what it asks runs here on this session's own.
 */
export function PeerTurnView({ turn, slug }: { turn: PeerTurn; slug: string }) {
  const name =
    turn.sender?.title ??
    turn.name ??
    (turn.pid ? `process ${turn.pid}` : "Claude session");
  const tone = toneOf(turn.name ?? turn.from);
  const bypass = turn.mode === "bypass" || turn.mode === "bypassPermissions";
  const time = clock(turn.at);
  return (
    <section
      aria-label={`Message from another Claude session, ${name}`}
      className="flex items-start gap-2.5"
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
          tone.avatar,
        )}
      >
        {initials(name)}
      </span>
      <div className="flex max-w-[85%] min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2 text-[12px]">
          <span
            className={cn("min-w-0 truncate font-medium", tone.name)}
            title={`Another Claude session, ${turn.from}`}
          >
            {name}
          </span>
          {bypass && (
            <span
              className="bg-tone-amber/10 text-tone-amber shrink-0 rounded-md px-1.5 text-[11px]"
              title="The sending session runs without permission prompts"
            >
              Bypass permissions
            </span>
          )}
          {time && (
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {time}
            </span>
          )}
          {turn.sender && (
            <Link
              to="/w/$slug/agents/chat/$conversation"
              params={{ slug, conversation: turn.sender.conversation }}
              className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] shrink-0 rounded-md px-1.5 py-0.5 transition-colors"
            >
              Open
            </Link>
          )}
        </div>
        <div
          className={cn(
            "w-fit max-w-full min-w-0 rounded-2xl rounded-tl-md px-3.5 py-2.5 [overflow-wrap:anywhere]",
            tone.bubble,
          )}
        >
          <MarkdownBody
            source={turn.text}
            link={chatLink}
            variant="chat"
            empty=""
          />
        </div>
      </div>
    </section>
  );
}
