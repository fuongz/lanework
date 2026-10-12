import {
  Copy01Icon,
  ExternalLinkIcon,
  GithubIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { RepoPicker } from "#/components/shared/pulls/repo-picker";
import { Button } from "#/components/ui/button";
import { usePulls } from "#/stores/pulls";

/**
 * The two steps before there is anything to list: connect GitHub, then say
 * which repo this project is.
 *
 * ⚠️ A panel in the empty pane rather than a modal. Both steps are the FIRST
 * thing anyone sees on this screen, and a dialog over an empty pane is a box
 * covering nothing — while a panel can stay put and explain itself while a
 * device code is pending.
 */
export function ConnectPanel() {
  const account = usePulls((state) => state.account);
  const repo = usePulls((state) => state.repo);
  const connecting = usePulls((state) => state.connecting);
  const progress = usePulls((state) => state.progress);
  const connect = usePulls((state) => state.connect);
  const cancelConnect = usePulls((state) => state.cancelConnect);

  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const suggestion = repo?.kind === "none" ? repo.suggestion : null;

  if (account.kind !== "connected")
    return (
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={GithubIcon}
            className="size-4"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <h2 className="text-[13px] font-medium">
            {account.kind === "expired" ? "Reconnect GitHub" : "Connect GitHub"}
          </h2>
        </div>
        <p className="text-muted-foreground text-xs/relaxed">
          {account.kind === "expired"
            ? `GitHub stopped accepting the connection${account.login ? ` for @${account.login}` : ""}. Connect again to keep reading pull requests.`
            : "Pull requests are read with your own GitHub account. Nothing is written to your repository."}
        </p>

        {progress ? (
          <div className="border-border/60 flex flex-col gap-2 rounded-lg border p-3">
            <p className="text-muted-foreground text-xs">
              Enter this code on GitHub to finish connecting.
            </p>
            <div className="flex items-center gap-2">
              <code className="bg-foreground/[0.05] rounded-md px-2 py-1 font-mono text-sm tracking-[0.2em]">
                {progress.userCode}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(progress.userCode)
                    .then(() => setCopied(true))
                    .catch(() => {});
                }}
              >
                <HugeiconsIcon icon={Copy01Icon} aria-hidden="true" />
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {/* ⚠️ A real link, not a button that shells out. The window's own
                navigation guard sends external origins to the OS browser, which
                is where a GitHub sign-in belongs — never inside this app. */}
            <a
              href={progress.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="text-accent-brand inline-flex items-center gap-1.5 text-xs underline-offset-2 hover:underline"
            >
              <HugeiconsIcon
                icon={ExternalLinkIcon}
                className="size-3.5"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              {progress.verificationUri}
            </a>
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => void cancelConnect()}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            className="self-start"
            disabled={connecting}
            onClick={() => {
              setError(null);
              void connect().then((result) => setError(result.error ?? null));
            }}
          >
            <HugeiconsIcon icon={GithubIcon} aria-hidden="true" />
            {connecting ? "Connecting…" : "Connect GitHub"}
          </Button>
        )}
        {error && <p className="text-destructive text-xs/relaxed">{error}</p>}
      </div>
    );

  return (
    <div className="flex min-h-0 flex-col gap-3 p-4">
      <h2 className="text-[13px] font-medium">Connect a repository</h2>
      <p className="text-muted-foreground text-xs/relaxed">
        One repository per project. Connected as @{account.login}.
      </p>
      {/* ⚠️ The folder's `origin` travels in as a SUGGESTION and nothing more —
          it sorts to the top of the list and is labelled, but a person still
          picks it. A project that attached itself to whatever remote a folder
          happened to carry would eventually show somebody another team's work. */}
      <RepoPicker suggestion={suggestion} />
    </div>
  );
}
