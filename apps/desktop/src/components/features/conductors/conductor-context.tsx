// The Context page of the conductor dialog (FE-96): files and folders in the
// project the conductor reads before it answers or plans. Only their paths
// are sent; main's chooser picks them and says which still exist.

import {
  Add01Icon,
  AlertCircleIcon,
  Cancel01Icon,
  File01Icon,
  Folder01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
  type ContextEntry,
  LEAD_CONTEXT_FILES_MAX,
} from "#/../shared/orchestration";
import { TextSkeleton } from "#/components/shared/loading/skeletons";
import { Button } from "#/components/ui/button";
import { ipcMessage } from "#/lib/ipc-error";
import { cn } from "#/lib/utils";

const KIND_ICONS = {
  file: File01Icon,
  folder: Folder01Icon,
  missing: AlertCircleIcon,
} as const;

/** What each path is in the checkout now, by path; absent while it is read. */
function useContextKinds(
  workspace: string,
  paths: readonly string[],
): Map<string, ContextEntry["kind"]> {
  const [kinds, setKinds] = useState(
    () => new Map<string, ContextEntry["kind"]>(),
  );
  const key = paths.join("\n");
  useEffect(() => {
    const surface = window.desktop?.leads;
    const wanted = key ? key.split("\n") : [];
    if (!surface || !wanted.length) return;
    let gone = false;
    void surface
      .inspectContext(workspace, wanted)
      .then((entries) => {
        if (!gone)
          setKinds(new Map(entries.map((entry) => [entry.path, entry.kind])));
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [workspace, key]);
  return kinds;
}

export function ConductorContext({
  workspace,
  paths,
  onChange,
}: {
  workspace: string;
  paths: string[];
  onChange: (paths: string[]) => void;
}) {
  const kinds = useContextKinds(workspace, paths);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const full = paths.length >= LEAD_CONTEXT_FILES_MAX;

  const add = async () => {
    const surface = window.desktop?.leads;
    if (!surface) return;
    setBusy(true);
    try {
      const { paths: picked, outside } = await surface.pickContext(workspace);
      const fresh = picked.filter((path) => !paths.includes(path));
      const room = LEAD_CONTEXT_FILES_MAX - paths.length;
      if (fresh.length) onChange([...paths, ...fresh.slice(0, room)]);
      const left = fresh.length - room;
      setNotice(
        outside
          ? `${outside === 1 ? "One pick was" : `${outside} picks were`} outside this project, so ${outside === 1 ? "it was" : "they were"} not added.`
          : left > 0
            ? `A conductor keeps at most ${LEAD_CONTEXT_FILES_MAX} context files; ${left} not added.`
            : null,
      );
    } catch (failure) {
      setNotice(ipcMessage(failure, "Could not open the file chooser."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b py-2.5 pr-12 pl-5">
        <h2 className="text-sm font-medium">Context</h2>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          Read before it answers or plans.
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || full}
          onClick={() => void add()}
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={1.5} aria-hidden />
          Add files…
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {paths.length ? (
          <ul aria-label="Context files" className="flex flex-col">
            {paths.map((path) => {
              const kind = kinds.get(path);
              return (
                <li
                  key={path}
                  className="hover:bg-foreground/[0.03] group flex h-8 items-center gap-2.5 rounded-md px-2"
                >
                  {kind ? (
                    <HugeiconsIcon
                      icon={KIND_ICONS[kind]}
                      className={cn(
                        "size-3.5 shrink-0",
                        kind === "missing"
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                  ) : (
                    <TextSkeleton
                      label={`Checking ${path}`}
                      className="size-3.5 shrink-0 rounded"
                    />
                  )}
                  <span
                    title={path}
                    className={cn(
                      "min-w-0 flex-1 truncate font-mono text-xs",
                      kind === "missing" && "text-muted-foreground",
                    )}
                  >
                    {path}
                    {kind === "folder" ? "/" : ""}
                  </span>
                  {kind === "missing" ? (
                    <span className="text-destructive shrink-0 text-xs">
                      Not found
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`Remove ${path}`}
                    title="Remove"
                    onClick={() =>
                      onChange(paths.filter((entry) => entry !== path))
                    }
                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/30 grid size-6 shrink-0 place-items-center rounded-md opacity-0 transition-opacity outline-none group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2"
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      className="size-3.5"
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="text-muted-foreground mx-auto flex h-full max-w-xs flex-col items-center justify-center gap-1 text-center text-xs leading-relaxed">
            <span className="text-foreground text-[13px] font-medium">
              No context files
            </span>
            Add what it should know about this project, like AGENTS.md or an
            architecture note. Only the paths are sent; it reads the latest
            version each time.
          </div>
        )}
      </div>
      {notice ? (
        <p role="alert" className="text-destructive border-t px-5 py-2 text-xs">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
