import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { channels, type ViewCommand } from "../../shared/desktop";
import { sendTerminalCommand } from "./terminal";

/** A View command for the window in front — or the only one, when none is. */
function sendViewCommand(command: ViewCommand): void {
  const window =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send(channels.viewCommand, command);
}

/**
 * The application menu: Electron's default, with the terminal in View.
 *
 * ⚠️ Every default role is kept. This app shipped on Electron's built-in menu
 * until now, and the Edit roles are what make ⌘C/⌘V/⌘Z work in every field —
 * a custom menu that dropped them would break copy-paste app-wide.
 *
 * ⚠️ The terminal shortcuts are MENU accelerators (FE-19/D6), not a renderer
 * key listener, so they still work while the terminal has focus — a key the
 * page does not claim goes on to the menu, and xterm claims neither of these.
 *
 * ⚠️ ⌘` toggles on macOS because that is the key people reach for; ⌃` — what
 * VS Code and Codex use, and what FE-19/D6 picked first — stays as a hidden
 * second binding rather than being taken away. ⌘` is also macOS's "Move focus
 * to next window", which an app menu item takes over only inside this app.
 * New Terminal is ⌘T, the key the panel's + menu shows, with ⌃⇧` kept the
 * same way.
 *
 * ⚠️ No ⌘W. Electron's File menu (macOS) and Window menu (elsewhere) bind it
 * to Close Window, and this app has ONE window: the key people press to shut
 * a tab — in a terminal, in a browser — took the whole app off the screen.
 * Close Window stays in File, without a key; the window's own close button
 * is untouched.
 *
 * ⚠️ Toggle Sidebar is ⌘B (FE-20/D5, as VS Code has it). Nothing in the app
 * claims it: the one editor, CodeMirror, binds no Mod-B, and a key the page
 * does handle never reaches the menu anyway.
 */
export function installMenu(): void {
  const mac = process.platform === "darwin";
  const toggle = () => sendTerminalCommand("toggle");
  const add = () => sendTerminalCommand("new");
  /** A second key for an item, working but not drawn in the menu (macOS). */
  const alias = (
    id: string,
    label: string,
    accelerator: string,
    click: () => void,
  ): MenuItemConstructorOptions[] =>
    mac
      ? [
          {
            id,
            label,
            accelerator,
            visible: false,
            acceleratorWorksWhenHidden: true,
            click,
          },
        ]
      : [];
  const closeWindow: MenuItemConstructorOptions = {
    id: "close-window",
    label: mac ? "Close Window" : "Close",
    click: (_item, window) => window?.close(),
  };
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" } as const] : []),
    {
      label: "File",
      submenu: mac
        ? [closeWindow]
        : [closeWindow, { type: "separator" }, { role: "quit" }],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          id: "sidebar-toggle",
          label: "Toggle Sidebar",
          accelerator: "CommandOrControl+B",
          click: () => sendViewCommand("toggle-sidebar"),
        },
        { type: "separator" },
        {
          id: "terminal-toggle",
          label: "Toggle Terminal",
          accelerator: "CommandOrControl+`",
          click: toggle,
        },
        ...alias("terminal-toggle-ctrl", "Toggle Terminal", "Ctrl+`", toggle),
        {
          id: "terminal-new",
          label: "New Terminal",
          accelerator: "CommandOrControl+T",
          click: add,
        },
        ...alias("terminal-new-ctrl", "New Terminal", "Ctrl+Shift+`", add),
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    // macOS's own Window menu has no Close in it; everyone else's does.
    mac
      ? { role: "windowMenu" }
      : { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
