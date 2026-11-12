import { WhatsNewDialog } from "./whats-new-dialog";

/**
 * The updater's dialog (INF-11), mounted once for the whole app beside the
 * auth gate, so it shows on any screen, signed in or not. An update itself is
 * offered on the island (`UpdateIsland`) and in Settings → About, not here.
 */
export function UpdaterDialogs() {
  return <WhatsNewDialog />;
}
