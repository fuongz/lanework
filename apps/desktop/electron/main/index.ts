import { join } from "node:path";
import {
  app,
  BrowserWindow,
  nativeTheme,
  protocol,
  session,
  shell,
} from "electron";
import { type AppInfo, channels, isThemeSource } from "../../shared/desktop";
import { registerAgentConfig } from "./agent-config";
import { registerAgentSetup } from "./agent-setup";
import { registerAuth } from "./auth";
import { pidFileBridge, registerConversation } from "./conversation";
import { registerDictation } from "./dictation";
import { readLinkedOpenPulls, registerGit } from "./git";
import { registerHandoff } from "./handoff";
import { registerHarness } from "./harness";
import { registerInstructions } from "./instructions";
import { broadcast, handle } from "./ipc";
import { registerMemory } from "./memory";
import { installMenu } from "./menu";
import { installMenuBar } from "./menu-bar";
import { registerNotifications } from "./notifications";
import { startPullWatcher } from "./notifications/pull-watcher";
import { registerAppProtocol } from "./protocol";
import { registerReadiness } from "./readiness";
import { appOrigin, isTrustedUrl } from "./security";
import { agentTerminalOn, killTerminal, registerTerminal } from "./terminal";
import { registerWorkspaces } from "./workspaces";

app.setName("Lanework");
app.setAboutPanelOptions({
  applicationName: "Lanework",
  applicationVersion: app.getVersion(),
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
if (devUrl && new URL(devUrl).origin !== "http://127.0.0.1:5175")
  throw new Error("Unexpected development origin");
if (!app.isPackaged && process.env.LANEWORK_TEST_USER_DATA)
  app.setPath("userData", process.env.LANEWORK_TEST_USER_DATA);
function createWindow() {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: "Lanework",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden",
          // NOTE: y 15 puts the centre of the (14pt) lights on the 22pt line
          // every header row sits on: the h-11 bars, the issues toolbar and
          // the sidebar button beside them. Codex uses the same line.
          trafficLightPosition: { x: 20, y: 15 },
          vibrancy: "under-window",
          visualEffectState: "active",
          backgroundColor: "#00000000",
        }
      : { backgroundColor: "#fafafa" }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Open GitHub, and a project's dev server on this machine, in the OS
    // browser. Every Electron popup is denied.
    let external = false;
    try {
      const destination = new URL(url);
      external =
        !destination.username &&
        !destination.password &&
        ((destination.protocol === "https:" &&
          destination.hostname === "github.com" &&
          !destination.port) ||
          (destination.protocol === "http:" &&
            destination.hostname === "localhost" &&
            destination.port !== ""));
    } catch {
      // A malformed destination stays denied.
    }
    if (external) {
      void shell.openExternal(url).catch((error: unknown) => {
        console.error("Unable to open link", error);
      });
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedUrl(url, devUrl)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedUrl(url, devUrl)) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  window.loadURL(devUrl ?? `${appOrigin}/`).catch((error: unknown) => {
    console.error("Unable to load renderer", error);
    app.quit();
  });
}
app
  .whenReady()
  .then(() => {
    // Everything is refused except writing text to the clipboard and listing
    // the installed fonts.
    //
    // - NOTE: `clipboard-sanitized-write` is what
    //   `navigator.clipboard.writeText` asks for. A blanket `false` here is
    //   not a no-op: it makes every Copy button in the app reject silently.
    // - NOTE: Sanitized write, and only that. It cannot read what is already
    //   on the clipboard (`clipboard-read` stays refused), so it only lets the
    //   app put text where the user asked for it. Camera, microphone,
    //   geolocation, notifications and the clipboard's contents stay denied.
    // - `local-fonts` is `queryLocalFonts()`, which fills the font pickers in
    //   Settings → Appearance. It names the fonts this Mac has, which a page
    //   could already probe one family at a time, and the window only loads
    //   the app's own origin.
    const allowed = (permission: string) =>
      permission === "clipboard-sanitized-write" ||
      permission === "local-fonts";
    session.defaultSession.setPermissionRequestHandler(
      (_contents, permission, callback) => callback(allowed(permission)),
    );
    session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
      allowed(permission),
    );
    registerAppProtocol(join(__dirname, "../../client"));
    handle(channels.appInfo, devUrl, (args): AppInfo => {
      if (args.length) throw new Error("This operation takes no arguments");
      return {
        name: "Lanework",
        version: app.getVersion(),
        platform: process.platform,
      };
    });
    // `nativeTheme`, not a class the renderer sets alone. It also drives the
    // native window chrome and the vibrancy, and it makes
    // `prefers-color-scheme` in the renderer report the effective theme. So
    // "system" needs no logic in the renderer to follow macOS.
    handle(channels.setTheme, devUrl, (args): boolean => {
      if (args.length !== 1)
        throw new Error("This operation takes one argument");
      const [source] = args;
      if (!isThemeSource(source))
        throw new Error('theme must be "system", "light" or "dark"');
      nativeTheme.themeSource = source;
      return nativeTheme.shouldUseDarkColors;
    });
    // The OS can change the theme under us, which no renderer can see itself.
    nativeTheme.on("updated", () =>
      broadcast(channels.themeChanged, nativeTheme.shouldUseDarkColors),
    );
    registerAuth(devUrl);
    registerWorkspaces(devUrl);
    registerGit(devUrl);
    registerTerminal(devUrl);
    // A Lanework tab is found and stopped by its id. A Claude in any other
    // terminal app is caught by its pid file.
    const pids = pidFileBridge();
    registerConversation(devUrl, {
      terminalOn: async (workspace, conversation, ours) =>
        (await agentTerminalOn(workspace, conversation)) ??
        pids.terminalOn(workspace, conversation, ours),
      kill: (id) => (id.startsWith("pid:") ? pids.kill(id) : killTerminal(id)),
    });
    registerHandoff(devUrl);
    registerReadiness(devUrl);
    registerMemory(devUrl);
    registerInstructions(devUrl);
    registerAgentSetup(devUrl);
    registerAgentConfig(devUrl);
    registerHarness(devUrl);
    registerDictation(devUrl);
    // The menu bar and a clicked notification bring the window back the same
    // way. A window made just now has no screen to navigate yet: it opens
    // where it always does.
    const showWindow = (): BrowserWindow | null => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        createWindow();
        return null;
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return window;
    };
    registerNotifications(devUrl, showWindow);
    startPullWatcher(readLinkedOpenPulls);
    installMenu();
    createWindow();
    installMenuBar(() => void showWindow());
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  })
  .catch((error: unknown) => {
    console.error(error);
    app.quit();
  });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
