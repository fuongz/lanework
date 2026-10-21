import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { channels, type ViewCommand } from "../../shared/desktop";
import { sendTerminalCommand } from "./terminal";

/** Send a View command to the focused window, or else to the first one. */
function sendViewCommand(command: ViewCommand): void {
  const window =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send(channels.viewCommand, command);
}

/**
 * The application menu: Electron's default, with the terminal in View.
 *
 * - NOTE: Every default role is kept. The Edit roles make ⌘C/⌘V/⌘Z work in
 *   every field, so a menu that dropped them would break copy-paste across
 *   the app.
 * - The terminal shortcuts are menu accelerators (FE-19/D6), not a renderer
 *   key listener, so they work while the terminal has focus. A key the page
 *   does not claim goes on to the menu, and xterm claims neither of these.
 * - ⌘` toggles the terminal on macOS, because that is the key people reach
 *   for. ⌃`, which VS Code and Codex use and FE-19/D6 picked first, stays as
 *   a hidden second binding. ⌘` is also macOS's "Move focus to next window",
 *   which an app menu item takes over only inside this app. New Terminal is
 *   ⌘T, the key the panel's + menu shows, with ⌃⇧` kept the same way.
 * - NOTE: No ⌘W. Electron's File menu (macOS) and Window menu (elsewhere)
 *   bind it to Close Window, and this app has one window: the key people
 *   press to close a tab would take the whole app off the screen. Close
 *   Window stays in File without a key, and the window's own close button is
 *   untouched.
 * - Toggle Sidebar is ⌘B (FE-20/D5, as in VS Code). Nothing in the app claims
 *   it: CodeMirror, the one editor, binds no Mod-B, and a key the page
 *   handles never reaches the menu anyway.
 * - Settings is ⌘,, the key of every Mac app's Settings…. It sits in the app
 *   menu on macOS, where people look for it, and in File elsewhere.
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
  const settings: MenuItemConstructorOptions = {
    id: "open-settings",
    label: mac ? "Settings…" : "Settings",
    accelerator: "CommandOrControl+,",
    click: () => sendViewCommand("open-settings"),
  };
  const closeWindow: MenuItemConstructorOptions = {
    id: "close-window",
    label: mac ? "Close Window" : "Close",
    click: (_item, window) => window?.close(),
  };
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            role: "appMenu",
            submenu: [
              { role: "about" },
              { type: "separator" },
              settings,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } as const satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: mac
        ? [closeWindow]
        : [
            settings,
            { type: "separator" },
            closeWindow,
            { type: "separator" },
            { role: "quit" },
          ],
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
    // The Window role has no Close on macOS but does elsewhere, so other
    // platforms get a Window menu of their own, without Close.
    mac
      ? { role: "windowMenu" }
      : { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
