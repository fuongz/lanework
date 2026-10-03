import { join } from "node:path";
import { app, BrowserWindow, nativeTheme, protocol, session } from "electron";
import { type AppInfo, channels, isThemeSource } from "../../shared/desktop";
import { registerAgentSetup } from "./agent-setup";
import { registerAuth } from "./auth";
import { registerGit } from "./git";
import { registerHandoff } from "./handoff";
import { registerInstructions } from "./instructions";
import { broadcast, handle } from "./ipc";
import { registerMemory } from "./memory";
import { installMenu } from "./menu";
import { registerAppProtocol } from "./protocol";
import { registerReadiness } from "./readiness";
import { appOrigin, isTrustedUrl } from "./security";
import { registerTerminal } from "./terminal";
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
          // ⚠️ y 15 puts the (14pt) lights' centre on the 22pt line every
          // header row sits on — the h-11 bars, the issues toolbar and the
          // sidebar button beside them (FE-20) — the line Codex uses too.
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
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
    /**
     * Everything is refused except writing text to the clipboard and listing
     * the installed fonts.
     *
     * ⚠️ `clipboard-sanitized-write` is what `navigator.clipboard.writeText`
     * asks for, and a blanket `false` here is not a no-op: it makes every Copy
     * button in the app REJECT SILENTLY. That is how the device-code copy on
     * the GitHub connect panel shipped doing nothing at all.
     *
     * ⚠️ Sanitized WRITE, and only that. It cannot read what is already on the
     * clipboard — `clipboard-read` stays refused with the rest — so this hands
     * out the ability to put a filename somewhere the user asked for it, and
     * nothing else. Camera, microphone, geolocation, notifications and the
     * clipboard's contents are all still denied.
     *
     * `local-fonts` is `queryLocalFonts()`, which Settings → Appearance lists
     * the font pickers from (FE-21). It names the fonts this Mac has — nothing
     * a page could not already probe one family at a time — and the window
     * only ever loads the app's own origin.
     */
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
    // ⚠️ `nativeTheme` rather than a class the renderer sets alone. This also
    // drives the native window chrome and the vibrancy, and it makes
    // `prefers-color-scheme` in the renderer report the EFFECTIVE theme — so
    // "system" needs no logic on the other side to stay in step with macOS.
    handle(channels.setTheme, devUrl, (args): boolean => {
      if (args.length !== 1)
        throw new Error("This operation takes one argument");
      const [source] = args;
      if (!isThemeSource(source))
        throw new Error('theme must be "system", "light" or "dark"');
      nativeTheme.themeSource = source;
      return nativeTheme.shouldUseDarkColors;
    });
    // Covers the OS changing under us, which no renderer can see for itself.
    nativeTheme.on("updated", () =>
      broadcast(channels.themeChanged, nativeTheme.shouldUseDarkColors),
    );
    registerAuth(devUrl);
    registerWorkspaces(devUrl);
    registerGit(devUrl);
    registerTerminal(devUrl);
    registerHandoff(devUrl);
    registerReadiness(devUrl);
    registerMemory(devUrl);
    registerInstructions(devUrl);
    registerAgentSetup(devUrl);
    installMenu();
    createWindow();
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
