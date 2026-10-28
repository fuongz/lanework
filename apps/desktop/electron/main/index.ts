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
import {
  type ControlServer,
  contextPath,
  ID_PATTERN,
  type JevMainHandlers,
  jevChannels,
  LEAD_CONTEXT_FILES_MAX,
  type LeadsMainHandlers,
  leadId,
  leadsChannels,
  type OrchestrationMainHandlers,
  type OrchestrationProposal,
  orchestrationChannels,
  parseJevConfig,
  parseJevKey,
  parseJudgeRequest,
  parseProposal,
  parseTeamLead,
} from "../../shared/orchestration";
import { installControlCli } from "../control/install";
import { registerAgentConfig } from "./agent-config";
import { registerAgentSetup } from "./agent-setup";
import { registerAuth } from "./auth";
import {
  conductorSessionsControl,
  pidFileBridge,
  registerConversation,
} from "./conversation";
import { registerDictation } from "./dictation";
import { readLinkedOpenPulls, registerGit } from "./git";
import { registerHandoff } from "./handoff";
import { registerHarness } from "./harness";
import { registerInstructions } from "./instructions";
import { broadcast, handle } from "./ipc";
import { jevMain } from "./jev";
import { registerMemory } from "./memory";
import { installMenu } from "./menu";
import { installMenuBar } from "./menu-bar";
import { registerNotifications } from "./notifications";
import { startPullWatcher } from "./notifications/pull-watcher";
import { orchestrationMain, setJev, startControlServer } from "./orchestration";
import type { SessionsControl } from "./orchestration/control-server";
import { leadsMain } from "./orchestration/leads";
import { registerAppProtocol } from "./protocol";
import { registerReadiness } from "./readiness";
import { appOrigin, isTrustedUrl } from "./security";
import {
  agentTerminalOn,
  killTerminal,
  onRunningChanged,
  registerTerminal,
} from "./terminal";
import { registerWorkspaces } from "./workspaces";

// ─── Orchestration and Jev (FE-87) ─────────────────────────────────────────
//
// The run engine asks Jev its bounded questions; with no provider set, Jev
// answers `off` and the lead decides everything.
setJev(jevMain);

/** A slug or id from the page, checked before any handler sees it. */
function ipcId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value))
    throw new Error(`${label} must be an id`);
  return value;
}
function ipcSlug(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128)
    throw new Error("workspace must be a slug");
  return value;
}
function arity(args: unknown[], count: number): void {
  if (args.length !== count)
    throw new Error(
      `This operation takes ${count} argument${count === 1 ? "" : "s"}`,
    );
}

/**
 * Register `orchestration.*` and `jev.*`, checking every argument here, so a
 * handler only ever sees shapes `shared/orchestration.ts` allows.
 */
function registerOrchestration(
  devUrl: string | undefined,
  runs: OrchestrationMainHandlers,
  jev: JevMainHandlers,
): void {
  handle(orchestrationChannels.runs, devUrl, (args) => {
    arity(args, 1);
    return runs.runs(ipcSlug(args[0]));
  });
  handle(orchestrationChannels.run, devUrl, (args) => {
    arity(args, 2);
    return runs.run(ipcSlug(args[0]), ipcId(args[1], "runId"));
  });
  handle(orchestrationChannels.approve, devUrl, (args) => {
    arity(args, 1);
    const proposal: OrchestrationProposal = parseProposal(args[0]);
    return runs.approve(proposal);
  });
  for (const action of ["pause", "resume", "stop", "cleanUp"] as const)
    handle(orchestrationChannels[action], devUrl, (args) => {
      arity(args, 2);
      return runs[action](ipcSlug(args[0]), ipcId(args[1], "runId"));
    });
  // What a stopped run left behind, for the clean-up dialog (FE-100/D4).
  handle(orchestrationChannels.leftovers, devUrl, (args) => {
    arity(args, 2);
    return runs.leftovers(ipcSlug(args[0]), ipcId(args[1], "runId"));
  });
  handle(orchestrationChannels.cancelTask, devUrl, (args) => {
    arity(args, 3);
    return runs.cancelTask(
      ipcSlug(args[0]),
      ipcId(args[1], "runId"),
      ipcId(args[2], "taskId"),
    );
  });
  handle(orchestrationChannels.approveScope, devUrl, (args) => {
    arity(args, 3);
    return runs.approveScope(
      ipcSlug(args[0]),
      ipcId(args[1], "runId"),
      ipcId(args[2], "taskId"),
    );
  });
  handle(jevChannels.get, devUrl, (args) => {
    arity(args, 0);
    return jev.get();
  });
  handle(jevChannels.set, devUrl, (args) => {
    arity(args, 1);
    return jev.set(parseJevConfig(args[0]));
  });
  handle(jevChannels.setKey, devUrl, (args) => {
    arity(args, 1);
    return jev.setKey(parseJevKey(args[0]));
  });
  handle(jevChannels.test, devUrl, (args) => {
    arity(args, 1);
    return jev.ask(parseJudgeRequest(args[0]));
  });
  handle(jevChannels.log, devUrl, (args) => {
    arity(args, 0);
    return jev.log();
  });
}

// ─── Team leads (FE-88) ────────────────────────────────────────────────────

/**
 * Register `leads.*`, checking every argument here: a saved lead goes through
 * `parseTeamLead` as `personal`, whatever `source` the page sent.
 */
function registerLeads(
  devUrl: string | undefined,
  leads: LeadsMainHandlers,
): void {
  handle(leadsChannels.list, devUrl, (args) => {
    arity(args, 1);
    return leads.list(args[0] === null ? null : ipcSlug(args[0]));
  });
  // A conductor is a project's own (FE-95): every write names the project.
  handle(leadsChannels.savePersonal, devUrl, (args) => {
    arity(args, 2);
    return leads.savePersonal(
      ipcSlug(args[0]),
      parseTeamLead(args[1], "personal"),
    );
  });
  handle(leadsChannels.removePersonal, devUrl, (args) => {
    arity(args, 2);
    return leads.removePersonal(ipcSlug(args[0]), leadId(args[1]));
  });
  handle(leadsChannels.setDefault, devUrl, (args) => {
    arity(args, 2);
    return leads.setDefault(
      ipcSlug(args[0]),
      args[1] === null ? null : leadId(args[1]),
    );
  });
  // Context files (FE-96): the chooser is main's, and a path the page sends
  // back is checked as project-relative before it is looked at.
  handle(leadsChannels.pickContext, devUrl, (args) => {
    arity(args, 1);
    return leads.pickContext(ipcSlug(args[0]));
  });
  handle(leadsChannels.inspectContext, devUrl, (args) => {
    arity(args, 2);
    const paths = args[1];
    if (!Array.isArray(paths) || paths.length > LEAD_CONTEXT_FILES_MAX)
      throw new Error(
        `paths must list at most ${LEAD_CONTEXT_FILES_MAX} context files`,
      );
    return leads.inspectContext(
      ipcSlug(args[0]),
      paths.map((path) => contextPath(path)),
    );
  });
}

let controlServer: ControlServer | null = null;

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
/**
 * INF-05 (SR-07/SW-04): the production CSP (`protocol.ts`) on the Vite dev
 * origin too, so dev renders the same hostile content (PR bodies,
 * transcripts, comments) behind the same barrier. Dev only: a packaged app
 * has no `devUrl` and is served from `app:`, where `protocol.ts` sets it.
 *
 * What it adds for Vite and React Refresh, and nothing more:
 * - `'unsafe-inline'` scripts: the Refresh preamble and the TanStack Start
 *   shell are inline, and their bytes change with every edit, so production's
 *   per-script hashes cannot be computed here.
 * - The HMR websocket on the dev origin in `connect-src`.
 */
function applyDevCsp(devUrl: string): void {
  const origin = new URL(devUrl);
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ws://${origin.host}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [`${origin.origin}/*`] },
    (details, callback) => {
      if (
        details.resourceType !== "mainFrame" &&
        details.resourceType !== "subFrame"
      ) {
        callback({});
        return;
      }
      const headers = { ...details.responseHeaders };
      for (const name of Object.keys(headers))
        if (name.toLowerCase() === "content-security-policy")
          delete headers[name];
      headers["Content-Security-Policy"] = [policy];
      callback({ responseHeaders: headers });
    },
  );
}
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
    if (devUrl) applyDevCsp(devUrl);
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
      onRunningChanged,
    });
    registerHandoff(devUrl);
    registerReadiness(devUrl);
    registerMemory(devUrl);
    registerInstructions(devUrl);
    registerAgentSetup(devUrl);
    registerAgentConfig(devUrl);
    registerHarness(devUrl);
    registerDictation(devUrl);
    registerOrchestration(devUrl, orchestrationMain, jevMain);
    registerLeads(devUrl, leadsMain);
    // Rewritten on every launch, like the Stop hook, so it always matches
    // this app's Node and bundle.
    void installControlCli().catch((error: unknown) =>
      console.warn("Unable to install lanework-control", error),
    );
    // The lead's CLI reaches runs through this; it listens on loopback only.
    startControlServer(
      orchestrationMain.control,
      conductorSessionsControl as SessionsControl,
    )
      .then((server) => {
        controlServer = server;
      })
      .catch((error: unknown) => {
        console.error(
          "Unable to start the orchestration control server",
          error,
        );
      });
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
app.on("will-quit", () => {
  void controlServer?.close();
  controlServer = null;
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
