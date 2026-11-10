import { UpdatePrompt } from "./update-prompt";
import { WhatsNewDialog } from "./whats-new-dialog";

/**
 * The updater's two dialogs (INF-11), mounted once for the whole app beside
 * the auth gate, so they show on any screen, signed in or not.
 */
export function UpdaterDialogs() {
  return (
    <>
      <UpdatePrompt />
      <WhatsNewDialog />
    </>
  );
}
