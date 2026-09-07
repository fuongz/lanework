import type { DesktopAuthApi } from "./auth";

export const channels = { appInfo: "app:get-info" } as const;
export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}
export interface DesktopApi {
  getAppInfo: () => Promise<AppInfo>;
  auth: DesktopAuthApi;
}
