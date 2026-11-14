import {
  Alert02Icon,
  Copy01Icon,
  MultiplicationSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { HarnessIcon } from "#/components/shared/agents/harness-island";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { useBoard } from "#/stores/board";
import {
  CLAUDE_LOGIN_COMMAND,
  useClaudeAuth,
  useClaudeAuthFailure,
} from "#/stores/claude-auth";
import {
  announceIsland,
  ISLAND_PRIORITY,
  setIslandOpen,
  useIslandContent,
  useIslandFoldOutside,
  useIslandShowing,
} from "#/stores/island";

const CLAUDE_AUTH_ISLAND_ID = "claudeAuth";
const SAID = "Claude needs to sign in again.";

const PILL_BUTTON =
  "h-7 rounded-full px-3 text-[12px] focus-visible:ring-white/40 disabled:opacity-100";

/**
 * Claude's own sign-in ran out, on the island (FE-139).
 *
 * It comes up when the CLI refuses a chat turn and says to run
 * `claude auth login`. It arrives open, since a turn the user sent just
 * failed, and offers to run the login in Terminal. The next Claude turn that
 * goes through takes it away; dismissing hides this failure only.
 *
 * Draws nothing itself: `<IslandHost/>` in the shell does.
 */
export function ClaudeAuthIsland() {
  const failure = useClaudeAuthFailure();
  const showing = useIslandShowing(CLAUDE_AUTH_ISLAND_ID);
  useIslandFoldOutside(CLAUDE_AUTH_ISLAND_ID, { escapeAnywhere: true });

  // Gone means folded: the next time it shows, it starts as a pill.
  useEffect(() => {
    if (!showing) setIslandOpen(CLAUDE_AUTH_ISLAND_ID, false);
  }, [showing]);

  const said = showing ? SAID : "";
  useEffect(() => {
    if (said) announceIsland(said, "assertive");
  }, [said]);

  useIslandContent(
    failure
      ? {
          id: CLAUDE_AUTH_ISLAND_ID,
          priority: ISLAND_PRIORITY.claudeAuth,
          tone: "warning",
          label: "Claude sign-in",
          open: true,
          attributes: { "data-testid": "claude-auth-island" },
          pill: (context) => (
            <button
              type="button"
              onClick={() => context.setOpen(true, true)}
              aria-expanded={false}
              aria-label={`${SAID} Show sign-in.`}
              className="flex h-7 items-center gap-1.5 rounded-[inherit] pr-2.5 pl-2 text-[12px] font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              <HugeiconsIcon
                icon={Alert02Icon}
                className="size-3.5 text-amber-400"
                strokeWidth={2.2}
                aria-hidden="true"
              />
              <span>Sign in to Claude again</span>
            </button>
          ),
          panel: (context) => (
            <Panel
              project={failure.project}
              conversation={failure.conversation}
              message={failure.message}
              onClose={() => context.setOpen(false)}
            />
          ),
        }
      : null,
  );
  return null;
}

/** The open island: what happened, and the way back in. */
function Panel({
  project,
  conversation,
  message,
  onClose,
}: {
  project: string;
  conversation: string;
  message: string | null;
  onClose: () => void;
}) {
  const signIn = useClaudeAuth((state) => state.signIn);
  const dismiss = useClaudeAuth((state) => state.dismiss);
  const opened = useClaudeAuth((state) => state.openedAt !== null);
  const slug = useBoard(
    (state) =>
      state.projects.find((item) => (item.id ?? item.slug) === project)?.slug,
  );
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section
      aria-label="Claude sign-in"
      className="flex w-[min(380px,calc(100vw-32px))] flex-col gap-3 p-4 pt-3.5"
    >
      <header className="flex items-start gap-2.5">
        <HarnessIcon agent="claude" className="mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-[13px] font-semibold tracking-tight">
            Claude needs to sign in again
          </h2>
          <p className="text-[12px] text-white/60">
            {opened
              ? "Finish in Terminal and your browser, then send your message again."
              : "Its sign-in ran out, so the last message did not go through."}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Dismiss"
          title="Not now"
          className="-mt-1 -mr-1.5 rounded-full text-white/60 hover:bg-white/10 hover:text-white dark:hover:bg-white/10"
          onClick={() => {
            dismiss();
            onClose();
          }}
        >
          <HugeiconsIcon
            icon={MultiplicationSignIcon}
            className="size-3.5"
            strokeWidth={2}
            aria-hidden="true"
          />
        </Button>
      </header>
      {message && (
        <p className="line-clamp-3 rounded-md bg-white/[0.06] px-2.5 py-1.5 font-mono text-[11px] text-white/70">
          {message}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          onClick={() => {
            setError(null);
            void signIn().catch((reason: unknown) =>
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Could not open Terminal.",
              ),
            );
          }}
          className={cn(PILL_BUTTON, "bg-white text-black hover:bg-white/85")}
        >
          {opened ? "Open Terminal again" : "Sign in"}
        </Button>
        <Button
          aria-label={`Copy ${CLAUDE_LOGIN_COMMAND}`}
          onClick={() => {
            void navigator.clipboard
              .writeText(CLAUDE_LOGIN_COMMAND)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
          className={cn(
            PILL_BUTTON,
            "bg-white/[0.14] text-white hover:bg-white/[0.22]",
          )}
        >
          <HugeiconsIcon
            icon={copied ? Tick02Icon : Copy01Icon}
            className="size-3.5"
            strokeWidth={2}
            aria-hidden="true"
          />
          {copied ? "Copied" : "Copy command"}
        </Button>
        {slug && (
          <Button
            variant="ghost"
            onClick={() => {
              onClose();
              void navigate({
                to: "/w/$slug/agents/chat/$conversation",
                params: { slug, conversation },
              });
            }}
            className={cn(
              PILL_BUTTON,
              "ml-auto text-white/70 hover:bg-white/10 hover:text-white dark:hover:bg-white/10",
            )}
          >
            Open chat
          </Button>
        )}
      </div>
      {error && (
        <p className="line-clamp-3 text-[12px] text-red-300">{error}</p>
      )}
    </section>
  );
}
