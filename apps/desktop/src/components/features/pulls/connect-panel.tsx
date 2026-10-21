import {
  Copy01Icon,
  ExternalLinkIcon,
  Folder01Icon,
  GithubIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { usePulls } from "#/stores/pulls";

/** A shell command to copy into a terminal. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="bg-foreground/[0.05] rounded-md px-2 py-1 font-mono text-xs select-all">
        {text}
      </code>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Copy ${text}`}
        onClick={() => {
          void navigator.clipboard
            .writeText(text)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
      >
        <HugeiconsIcon icon={Copy01Icon} aria-hidden="true" />
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/**
 * What stands between this project and its pull requests: the GitHub CLI
 * (`gh`) and the project's folder.
 *
 * NOTE: The app only tells people what to run. It never installs `gh` and
 * never runs `gh auth login`: the login belongs to `gh`, and this app holds no
 * GitHub credential (FE-73). "Check again" asks `gh` once more.
 */
export function ConnectPanel() {
  const account = usePulls((state) => state.account);
  const repo = usePulls((state) => state.repo);
  const checking = usePulls((state) => state.checking);
  const check = usePulls((state) => state.check);
  const error = usePulls((state) => state.error);

  const step =
    account.kind === "missing"
      ? {
          title: "Install the GitHub CLI",
          body: "Pull requests are read through the GitHub CLI (gh), with your own login. Install it, then check again.",
          command: "brew install gh",
        }
      : account.kind === "unreachable"
        ? {
            title: "Can't reach GitHub",
            body: "gh is installed, but GitHub did not answer. Check your connection, then check again.",
            command: null,
          }
        : account.kind === "logged-out"
          ? {
              title: "Sign in to the GitHub CLI",
              body: "gh is installed but not signed in. Run this in a terminal and follow its prompts, then check again.",
              command: "gh auth login",
            }
          : repo?.kind === "no-folder"
            ? {
                title: "No folder for this project",
                body: "Pull requests are read from the GitHub repo in the project's folder. Link a folder on this machine in Settings › Project › General.",
                command: null,
              }
            : {
                title: "Not a GitHub repo",
                body: "This project's folder has no GitHub remote named origin. Add one, then check again.",
                command: null,
              };

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          icon={account.kind === "ok" ? Folder01Icon : GithubIcon}
          className="size-4"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <h2 className="text-[13px] font-medium">{step.title}</h2>
      </div>
      <p className="text-muted-foreground text-xs/relaxed">{step.body}</p>

      {step.command && <Command text={step.command} />}

      {account.kind === "missing" && (
        // A real link: the window's navigation guard sends external origins to
        // the OS browser.
        <a
          href="https://cli.github.com"
          target="_blank"
          rel="noreferrer"
          className="text-accent-brand inline-flex items-center gap-1.5 self-start text-xs underline-offset-2 hover:underline"
        >
          <HugeiconsIcon
            icon={ExternalLinkIcon}
            className="size-3.5"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          Other ways to install: cli.github.com
        </a>
      )}

      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={checking}
        onClick={() => void check()}
      >
        <HugeiconsIcon
          icon={Refresh01Icon}
          className={checking ? "animate-spin" : undefined}
          aria-hidden="true"
        />
        {checking ? "Checking…" : "Check again"}
      </Button>
      {error && <p className="text-destructive text-xs/relaxed">{error}</p>}
    </div>
  );
}
