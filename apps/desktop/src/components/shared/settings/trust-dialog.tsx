import type { SetupAgent } from "#/../shared/agent-setup";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";

const NAME: Record<SetupAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** What trusting the folder lets the repository run, per CLI. */
const LOADS: Record<SetupAgent, React.ReactNode> = {
  claude: (
    <>
      its <code>.claude</code> settings, so their hooks, <code>env</code> and{" "}
      <code>apiKeyHelper</code>
    </>
  ),
  codex: (
    <>
      its <code>.codex</code> config, hooks and rules, and its{" "}
      <code>AGENTS.md</code>, so what they set up
    </>
  ),
};

/** The request the dialog asks about; null keeps it closed. */
export interface TrustAsk {
  agent: SetupAgent;
  on: boolean;
}

/**
 * Confirm a change to a CLI's trust in a project's folder (FE-101).
 *
 * Trusting is never one click: the repository's own config then runs as the
 * user, with no prompt from the CLI, so the dialog says what that means.
 */
export function TrustDialog({
  ask,
  folder,
  onConfirm,
  onClose,
}: {
  ask: TrustAsk | null;
  /** The project's folder, home shortened. */
  folder: string | null;
  onConfirm: (ask: TrustAsk) => void;
  onClose: () => void;
}) {
  const name = ask ? NAME[ask.agent] : "";
  return (
    <AlertDialog
      open={ask !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {ask?.on
              ? `Trust this folder for ${name}?`
              : `Stop trusting this folder for ${name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {ask?.on ? (
              <>
                {name} will load this repository’s own config in{" "}
                <span className="font-mono">{folder}</span>: {LOADS[ask.agent]}{" "}
                run as you, with no prompt. Trust only a repository you know.
              </>
            ) : ask ? (
              <>
                {name} stops loading this repository’s own config in{" "}
                <span className="font-mono">{folder}</span>. Your own settings
                still load.
              </>
            ) : null}{" "}
            Open chats in this project restart on their next message.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={ask?.on ? "default" : "destructive"}
            className={ask?.on ? undefined : "border-0"}
            onClick={() => ask && onConfirm(ask)}
          >
            {ask?.on ? "Trust folder" : "Untrust"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
