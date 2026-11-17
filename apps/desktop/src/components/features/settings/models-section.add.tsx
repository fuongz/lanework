import { useEffect, useState } from "react";
import {
  AGENT_LABELS,
  type ConversationAgent,
  isModelIdFor,
} from "#/../shared/conversation";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { usePreferences } from "#/stores/preferences";

/** What an id looks like for each CLI, as the field's hint. */
const EXAMPLE: Record<ConversationAgent, string> = {
  claude: "claude-opus-5-5",
  codex: "gpt-6.1-sol",
  opencode: "provider/model",
};

/**
 * Add a model the CLI does not list (FE-146): its id, given to the CLI as
 * typed, and a name for the picker. An id of the wrong shape for this CLI
 * is refused here, as main would refuse a turn on it.
 */
export function AddModelDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: ConversationAgent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const add = usePreferences((state) => state.addCustomModel);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  useEffect(() => {
    if (open) {
      setId("");
      setLabel("");
    }
  }, [open]);
  const trimmed = id.trim();
  const valid = isModelIdFor(agent, trimmed);

  const save = () => {
    if (!valid) return;
    add({ agent, id: trimmed, label: label.trim() });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a {AGENT_LABELS[agent]} model</DialogTitle>
          <DialogDescription>
            For a model {AGENT_LABELS[agent]} runs but does not list. Its id is
            given to the CLI as typed.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="flex flex-col gap-1.5 text-[13px]">
            <label htmlFor="custom-model-id">Model id</label>
            <Input
              id="custom-model-id"
              autoFocus
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder={EXAMPLE[agent]}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={trimmed !== "" && !valid}
              className="font-mono"
            />
            {trimmed !== "" && !valid && (
              <span className="text-destructive text-xs">
                Not a {AGENT_LABELS[agent]} model id
                {agent === "opencode" ? ": use provider/model." : "."}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1.5 text-[13px]">
            <label htmlFor="custom-model-name">Name</label>
            <Input
              id="custom-model-name"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={trimmed || "The id, if left empty"}
              maxLength={80}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              Add model
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
