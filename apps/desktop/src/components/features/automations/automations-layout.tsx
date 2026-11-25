import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { AutomationsList } from "#/components/shared/automations/automations-list";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#/components/ui/resizable";
import { usePersistedLayout } from "#/hooks/use-persisted-layout";
import { useAutomations } from "#/stores/automations";
import { AutomationForm } from "./automation-form";

/**
 * The Automations screen (FE-99): the list that stays, and one automation
 * beside it, as the pull request screen is laid out.
 *
 * Main pushes every change (`automations.onChanged`), so there is no poll;
 * focus reads again only to catch what happened while a window was asleep.
 */
export function AutomationsLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug/automations" });
  const navigate = useNavigate();
  const open = useAutomations((state) => state.open);
  const refresh = useAutomations((state) => state.refresh);
  const watch = useAutomations((state) => state.watch);
  const editor = useAutomations((state) => state.editor);
  const closeEditor = useAutomations((state) => state.closeEditor);
  const editing = useAutomations((state) =>
    editor?.kind === "edit"
      ? state.automations?.find((entry) => entry.id === editor.id)
      : undefined,
  );
  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:automations",
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
        id="lanework:automations"
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
          <aside
            aria-label="Automations"
            className="flex h-full min-h-0 flex-col"
          >
            <AutomationsList />
          </aside>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize automation list" />
        <ResizablePanel id="detail" minSize="40%">
          <Outlet />
        </ResizablePanel>
      </ResizablePanelGroup>
      {editor && (editor.kind === "new" || editing) && (
        <AutomationForm
          key={editor.kind === "new" ? "new" : editor.id}
          automation={editing}
          onClose={closeEditor}
          onSaved={(saved) => {
            closeEditor();
            void navigate({
              to: "/w/$slug/automations/$id",
              params: { slug, id: saved.id },
            });
          }}
        />
      )}
    </>
  );
}
