import { contextBridge, ipcRenderer } from "electron";
import { channels, type DesktopApi } from "../../shared/desktop";

const desktop: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(channels.appInfo),
};
contextBridge.exposeInMainWorld("desktop", desktop);
