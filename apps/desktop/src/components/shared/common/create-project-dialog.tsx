import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { PickedFolder } from "#/../shared/workspaces";
import {
  PrimaryFolderHint,
  SourceFolders,
} from "#/components/shared/common/source-folders";
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
import { InputGroup, InputGroupAddon } from "#/components/ui/input-group";
import { useBoard } from "#/stores/board";

/**
 * Name a project into existence, and say which folders it is built from.
 *
 * ⚠️ ONE implementation, two doors: the switcher — where you go to change
 * projects — and the empty account, where creating one is the only thing to do.
 * Two copies would be two places to keep a refusal message, a disabled state
 * and the folder list in step.
 *
 * ⚠️ It asks for a NAME, not a slug. The service refuses to derive one, so main
 * does it (`slug.ts`); asking a person for `du-an-cua-toi` is asking them to do
 * a computer's job in a field where a typo is permanent.
 *
 * ⚠️ The folders are carried as IDS the chooser minted, never as paths. The
 * path is here to be READ — a list of folders that showed only basenames cannot
 * tell two checkouts of the same repo apart — and main resolves the ids against
 * folders it opened itself, so this window cannot name a folder nobody picked.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<PickedFolder[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const busy = useBoard((state) => state.busy);
  const createProject = useBoard((state) => state.createProject);
  const working = busy === "project";

  function close(next: boolean) {
    onOpenChange(next);
    // ⚠️ Cleared on the way OUT, not on the way in. A dialog that reset while
    // it was still fading away would show the user their own name and folders
    // being wiped, which reads as the create having failed.
    if (!next) {
      setName("");
      setFolders([]);
      setFailed(null);
    }
  }

  function submit() {
    const typed = name.trim();
    if (!typed) return;
    setFailed(null);
    void createProject(
      typed,
      folders.map((folder) => folder.id),
    ).then((result) => {
      // ⚠️ Everything typed is KEPT when creation fails. "That key is taken" is
      // an invitation to edit the name; a dialog that emptied itself would make
      // somebody pick three folders again to find out what was wrong with one
      // word.
      if ("error" in result) {
        setFailed(result.error);
        return;
      }
      close(false);
      if (result.workspace) onCreated(result.workspace.slug);
    });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            Name it, and add the folders on this machine it is built from.
          </DialogDescription>
        </DialogHeader>

        <form
          // ⚠️ `min-w-0`, because the dialog is a GRID and a grid item defaults
          // to `min-width: auto` — a folder path with no spaces in it then
          // stretches the form past the popup it is drawn inside, and the rows
          // paint outside the white card. Truncation cannot start until
          // something is allowed to be narrower than its content.
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <InputGroup className="h-9">
            <InputGroupAddon>
              <HugeiconsIcon
                icon={Folder01Icon}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </InputGroupAddon>
            <Input
              // ⚠️ The same accessible name the one-field form had. It is what
              // every test — and anybody who has used this app — reaches for.
              aria-label="New project name"
              data-slot="input-group-control"
              placeholder="Project name"
              value={name}
              maxLength={200}
              disabled={working}
              autoFocus
              className="h-9 border-0 bg-transparent text-[13px] focus-visible:border-0 focus-visible:ring-0 md:text-[13px]"
              onChange={(event) => setName(event.target.value)}
            />
          </InputGroup>

          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-[13px] font-medium">Source folders</h3>
            <SourceFolders
              folders={folders}
              onChange={setFolders}
              onError={setFailed}
              disabled={working}
            />
            <PrimaryFolderHint folders={folders} />
          </div>

          {failed && (
            <p role="alert" className="text-destructive text-xs">
              {failed}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              disabled={working}
              onClick={() => close(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="lg" disabled={!name.trim() || working}>
              {working ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
