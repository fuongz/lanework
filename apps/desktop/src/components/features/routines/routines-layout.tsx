import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { RoutinesList } from "#/components/shared/routines/routines-list";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#/components/ui/resizable";
import { usePersistedLayout } from "#/hooks/use-persisted-layout";
import { useRoutines } from "#/stores/routines";
import { RoutineForm } from "./routine-form";

/**
 * The Routines screen (FE-99): the list that stays, and one routine
 * beside it, as the pull request screen is laid out.
 *
 * Main pushes every change (`routines.onChanged`), so there is no poll;
 * focus reads again only to catch what happened while a window was asleep.
 */
export function RoutinesLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug/routines" });
  const navigate = useNavigate();
  const open = useRoutines((state) => state.open);
  const refresh = useRoutines((state) => state.refresh);
  const watch = useRoutines((state) => state.watch);
  const editor = useRoutines((state) => state.editor);
  const closeEditor = useRoutines((state) => state.closeEditor);
  const editing = useRoutines((state) =>
    editor?.kind === "edit"
      ? state.routines?.find((entry) => entry.id === editor.id)
      : undefined,
  );
  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:routines",
    ["list", "detail"],
  );

  useEffect(() => {
    void open(slug);
  }, [open, slug]);

  useEffect(() => watch(), [watch]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // The dialog is the screen's: leaving the screen closes it.
  useEffect(() => closeEditor, [closeEditor]);

  return (
    <>
      <ResizablePanelGroup
        id="lanework:routines"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel
          id="list"
          defaultSize="340px"
          minSize="18%"
          maxSize="45%"
          groupResizeBehavior="preserve-pixel-size"
        >
          <aside aria-label="Routines" className="flex h-full min-h-0 flex-col">
            <RoutinesList />
          </aside>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize routine list" />
        <ResizablePanel id="detail" minSize="40%">
          <Outlet />
        </ResizablePanel>
      </ResizablePanelGroup>
      {editor && (editor.kind === "new" || editing) && (
        <RoutineForm
          key={editor.kind === "new" ? "new" : editor.id}
          routine={editing}
          onClose={closeEditor}
          onSaved={(saved) => {
            closeEditor();
            void navigate({
              to: "/w/$slug/routines/$id",
              params: { slug, id: saved.id },
            });
          }}
        />
      )}
    </>
  );
}
