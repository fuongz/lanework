import { join } from "node:path";
import { app, BrowserWindow, ipcMain, protocol, session } from "electron";
import { type AppInfo, channels } from "../../shared/desktop";
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
    backgroundColor: "#fafafa",
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
    ipcMain.handle(channels.appInfo, (event, ...args: unknown[]): AppInfo => {
      const frame = event.senderFrame;
      if (
        !frame ||
        frame !== event.sender.mainFrame ||
        !BrowserWindow.fromWebContents(event.sender) ||
        !isTrustedUrl(frame.url, devUrl)
      )
        throw new Error("Untrusted IPC sender");
      if (args.length) throw new Error("This operation takes no arguments");
      return {
        name: "Lanework",
        version: app.getVersion(),
        platform: process.platform,
      };
    });
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
