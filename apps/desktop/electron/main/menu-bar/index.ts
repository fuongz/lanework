import { app, Menu, type MenuItemConstructorOptions, Tray } from "electron";
import {
  onRunningChanged,
  runningProjects,
  sendTerminalCommand,
} from "../terminal";
import { menuBarIcon } from "./icon";

/** A single macOS tray, owned by main and kept alive across window closes. */
export function installMenuBar(showWindow: () => void): void {
  if (process.platform !== "darwin") return;
  const tray = new Tray(menuBarIcon());
  let stopped = false;
  let refreshing = false;
  let generation = 0;
  let lastSnapshot = "";
  const open: MenuItemConstructorOptions = {
    label: "Open Lanework",
    click: showWindow,
  };
  const quit: MenuItemConstructorOptions = {
    label: "Quit Lanework",
    role: "quit",
  };
  tray.setToolTip("Lanework");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      open,
      { label: "Loading processes…", enabled: false },
      { type: "separator" },
      quit,
    ]),
  );

  const refresh = async () => {
    if (refreshing || stopped) return;
    refreshing = true;
    const current = ++generation;
    try {
      const projects = await runningProjects();
      if (stopped || current !== generation) return;
      const snapshot = JSON.stringify(projects);
      if (snapshot === lastSnapshot) return;
      const count = projects.reduce(
        (sum, project) => sum + project.items.length,
        0,
      );
      const items: MenuItemConstructorOptions[] = [open, { type: "separator" }];
      for (const project of projects) {
        items.push({
          label: project.name,
          submenu: project.items.map((item) => ({
            label: item.label.replace(/[\r\n\t]+/g, " ").slice(0, 160),
            click: () => {
              showWindow();
              sendTerminalCommand({
                type: "focus",
                workspace: project.workspace,
                slug: project.slug,
                href: item.href,
                shellId: item.shellId,
              });
            },
          })),
        });
      }
      if (!count) items.push({ label: "No running processes", enabled: false });
      items.push({ type: "separator" }, quit);
      tray.setContextMenu(Menu.buildFromTemplate(items));
      lastSnapshot = snapshot;
      tray.setToolTip(
        `Lanework — ${count} running process${count === 1 ? "" : "es"}`,
      );
    } catch {
      if (!stopped) {
        lastSnapshot = "";
        tray.setContextMenu(
          Menu.buildFromTemplate([
            open,
            { label: "Processes unavailable — open Lanework", enabled: false },
            { type: "separator" },
            quit,
          ]),
        );
        tray.setToolTip("Lanework — processes unavailable");
      }
    } finally {
      refreshing = false;
    }
  };
  // Includes transcript/background changes in projects that have no active watcher.
  const timer = setInterval(() => void refresh(), 5_000);
  const unsubscribe = onRunningChanged(() => void refresh());
  timer.unref();
  tray.on("click", () => void refresh());
  void refresh();
  app.once("will-quit", () => {
    stopped = true;
    generation++;
    clearInterval(timer);
    unsubscribe();
    tray.destroy();
  });
}
