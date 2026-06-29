import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { RoboticIcon } from "@hugeicons/core-free-icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { createCard } from "@/server/reviews";
import { runAgentForCard } from "@/lib/agent-client";

/**
 * "Add a task" dialog (local mode). Collects a title + optional assignees, creates
 * a new To-Do card, then — if "Investigate" is on — dispatches a planning agent
 * that fills in the card's checklist and returns it to To-Do for review.
 */
export function CreateCardDialog({
  open,
  onOpenChange,
  owner,
  repo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner: string;
  repo: string;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [investigate, setInvestigate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle("");
    setAssignee("");
    setInvestigate(true);
    setError(null);
  };

  const close = (next: boolean) => {
    if (busy) return; // don't dismiss mid-create
    if (!next) reset();
    onOpenChange(next);
  };

  async function handleCreate() {
    const trimmed = title.trim();
    if (!trimmed) {
      setError("A title is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const assignees = assignee
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      const { path } = await createCard({ data: { owner, repo, title: trimmed, assignees, status: "todo" } });
      if (investigate) await runAgentForCard(path, "plan");
      await router.invalidate();
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create the task.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a task</DialogTitle>
          <DialogDescription>
            Creates a card in To-Do. With investigate on, an agent explores the repo and writes the
            task's checklist for you to review.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-1">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Title</span>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleCreate();
              }}
              placeholder="e.g. Add rate limiting to the public API"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Assignee <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <Input
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder="GitHub login(s), comma-separated"
            />
          </label>

          <label className="flex cursor-pointer items-center gap-2.5">
            <Checkbox checked={investigate} onCheckedChange={(v) => setInvestigate(!!v)} />
            <span className="inline-flex items-center gap-1.5 text-sm">
              <HugeiconsIcon icon={RoboticIcon} className="size-4 text-violet-500" />
              Investigate with an agent (writes the checklist)
            </span>
          </label>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={busy || !title.trim()}>
            {busy ? (investigate ? "Creating & dispatching…" : "Creating…") : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
