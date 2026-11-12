import { app, Menu, Tray } from "electron";
import { APP_DISPLAY_NAME } from "../channel";
import { menuBarIcon } from "./icon";

/** One thing that needs the person, listed above Open (FE-136/D6). */
export interface MenuBarItem {
  label: string;
  open: () => void;
}

let tray: Tray | null = null;
let openWindow: () => void = () => {};
let items: MenuBarItem[] = [];

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    ...(items.length
      ? [
          { label: "Needs you", enabled: false },
          ...items.map((item) => ({ label: item.label, click: item.open })),
          { type: "separator" as const },
        ]
      : []),
    { label: "Open Lanework", click: openWindow },
    { type: "separator" },
    { label: "Quit Lanework", role: "quit" },
  ]);
}

/** Replace the list of what needs the person. */
export function setAttentionItems(next: MenuBarItem[]): void {
  items = next;
  tray?.setContextMenu(buildMenu());
}

/**
 * Install the macOS menu-bar tray: what needs the person, then Open and Quit
 * (FE-111/D1, FE-136/D6).
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
  openWindow = showWindow;
  const own = new Tray(menuBarIcon());
  tray = own;
  own.setToolTip(APP_DISPLAY_NAME);
  own.setContextMenu(buildMenu());
  app.once("will-quit", () => {
    own.destroy();
    tray = null;
  });
}
