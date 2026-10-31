import { app, Menu, Tray } from "electron";
import { menuBarIcon } from "./icon";

/**
 * Install the macOS menu-bar tray: Open and Quit, nothing else (FE-111/D1).
 *
 * One tray, owned by main and kept alive when windows close. Nothing on other
 * platforms.
 *
 * NOTE: It used to list what ran in every project, polled every 5s. That
 * read every Claude transcript of every project for its background tasks,
 * which kept main at a full core.
 */
export function installMenuBar(showWindow: () => void): void {
  if (process.platform !== "darwin") return;
  const tray = new Tray(menuBarIcon());
  tray.setToolTip("Lanework");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Lanework", click: showWindow },
      { type: "separator" },
      { label: "Quit Lanework", role: "quit" },
    ]),
  );
  app.once("will-quit", () => tray.destroy());
}
