import { join } from "node:path";
import { app, BrowserWindow, nativeTheme, protocol, session } from "electron";
import { type AppInfo, channels, isThemeSource } from "../../shared/desktop";
import { registerAuth } from "./auth";
import { broadcast, handle } from "./ipc";
import { registerAppProtocol } from "./protocol";
import { appOrigin, isTrustedUrl } from "./security";

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
          trafficLightPosition: { x: 20, y: 20 },
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
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
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
