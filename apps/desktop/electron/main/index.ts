import { join } from "node:path";
import {
  app,
  BrowserWindow,
  nativeTheme,
  protocol,
  session,
  shell,
} from "electron";
import {
  type ConductorStopRun,
  conductorChannels,
  MEMORY_NOTES_MAX,
} from "../../shared/conductor-sessions";
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
  leadRef,
  leadsChannels,
  type OrchestrationMainHandlers,
  type OrchestrationProposal,
  orchestrationChannels,
  parseJevConfig,
  parseJevKey,
  parseJudgeRequest,
  parseProposal,
  parseTeamLead,
  type TeamLead,
} from "../../shared/orchestration";
import { installControlCli } from "../control/install";
import { isWithin, realRoots } from "../kit";
import { registerAgentConfig } from "./agent-config";
import { registerAgentSetup } from "./agent-setup";
import { installLwk } from "./agent-setup/lwk-install";
import { ensureControlMcpShim } from "./agent-setup/mcp-entry";
import { registerAuth } from "./auth";
import { registerAutonomy } from "./autonomy";
import {
  APP_CHANNEL,
  APP_DISPLAY_NAME,
  APP_DISPLAY_VERSION,
  applyChannel,
} from "./channel";
import { registerConnectors } from "./connectors";
import {
  conductorEngines,
  conductorMemory,
  conductorSessionsControl,
  pendingPermission,
  pidFileBridge,
  registerConversation,
} from "./conversation";
import {
  type ConductorStopDeps,
  previewConductorStop,
  stopConductor,
} from "./conversation/conductor-stop";
import { savedLwkMode } from "./conversation/power";
import { registerDictation } from "./dictation";
import { registerFileFinder } from "./file-finder";
import { readLinkedOpenPulls, registerGit } from "./git";
import { loginPath } from "./git/login-path";
import { registerHandoff } from "./handoff";
import { registerHarness } from "./harness";
import { registerInstructions } from "./instructions";
import { broadcast, handle } from "./ipc";
import { jevMain } from "./jev";
import { type KitSocket, startKitSocket } from "./kit-socket";
import { lwkServe, shutdownLwkServe } from "./lwk-serve";
import { registerMemory } from "./memory";
import { installMenu } from "./menu";
import { installMenuBar } from "./menu-bar";
import { registerMetrics } from "./metrics";
import { registerNotifications } from "./notifications";
import { registerAttention } from "./notifications/attention";
import { startPullWatcher } from "./notifications/pull-watcher";
import { orchestrationMain, setJev, startControlServer } from "./orchestration";
import type { SessionsControl } from "./orchestration/control-server";
import {
  isRepoOverlayInput,
  leadsMain,
  moveConductors,
} from "./orchestration/leads";
import { moveLegacyProjectsDir } from "./paths";
import { flushPermissions, registerPermissions } from "./permissions";
import {
  adoptMovedProjects,
  onProjectMoved,
  registerProjects,
} from "./projects";
import { migrateProjectsLayout } from "./projects/layout-migration";
import {
  authorizedRecord,
  inLocalMode,
  LOCAL_RECORD,
} from "./projects/session";
import { readFolders } from "./projects/store";
import { registerAppProtocol } from "./protocol";
import { registerReadiness } from "./readiness";
import { registerRepoSearch } from "./repo-search";
import { registerRoutines, stopRoutines } from "./routines";
import { appOrigin, isTrustedUrl } from "./security";
import { registerStorage } from "./storage";
import { registerStructuralSearch } from "./structural-search";
import {
  agentTerminalOn,
  killTerminal,
  moveProjectSessions,
  onRunningChanged,
  registerTerminal,
  terminalActivity,
} from "./terminal";
import { registerSessionSearch } from "./transcripts/search";
import { registerUpdater } from "./updater";
import { countActiveRuns } from "./updater/live-work";

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
    throw new Error("project must be a slug");
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
    // FE-166: a project's conductor takes only its connectors. The store
    // checks that save field by field (`parseRepoOverlay`), refuses the rest
    // and never writes the repo file.
    return leads.savePersonal(
      ipcSlug(args[0]),
      isRepoOverlayInput(args[1])
        ? (args[1] as TeamLead)
        : parseTeamLead(args[1], "personal"),
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
  // A conductor's memory (FE-128): through the one store its own
  // `memory.*` calls use, so the page's edit and the conductor's never
  // overwrite each other.
  handle(leadsChannels.memory, devUrl, (args) => {
    arity(args, 2);
    return conductorMemory.read(ipcSlug(args[0]), leadRef(args[1]));
  });
  handle(leadsChannels.saveMemoryNotes, devUrl, (args) => {
    arity(args, 3);
    const notes = args[2];
    if (typeof notes !== "string" || notes.length > MEMORY_NOTES_MAX)
      throw new Error(
        `notes must be a string of at most ${MEMORY_NOTES_MAX} characters`,
      );
    return conductorMemory.writeNotes(
      ipcSlug(args[0]),
      leadRef(args[1]),
      notes,
    );
  });
}

// ─── A conductor's Stop ─────────────────────────────────────────────────────

/**
 * The runs `lead` leads in `project` that its Stop ends: active or paused,
 * and driven here (another instance's refuses a stop), newest first. Its
 * runs are those approved under it, as its rail dot counts them.
 */
async function conductorRuns(
  project: string,
  lead: string,
): Promise<ConductorStopRun[]> {
  const runs = (await orchestrationMain.runs(project)).filter(
    (run) =>
      run.teamLead === lead &&
      (run.status === "active" || run.status === "paused") &&
      !run.drivenBy,
  );
  return Promise.all(
    runs.map(async (run) => ({
      id: run.id,
      title: await orchestrationMain.title(project, run.id),
      workers: run.tasks.filter((task) => task.status === "running").length,
    })),
  );
}

/**
 * Register `conductors.*`: Stop on a conductor's row, and what it would
 * end. A run stops through `orchestration.stop`, as its panel's Stop does.
 */
function registerConductors(devUrl: string | undefined): void {
  const deps: ConductorStopDeps = {
    ...conductorEngines,
    runsOf: conductorRuns,
    stopRun: (project, runId) => orchestrationMain.stop(project, runId),
  };
  handle(conductorChannels.stopPreview, devUrl, (args) => {
    arity(args, 2);
    return previewConductorStop(deps, ipcSlug(args[0]), leadRef(args[1]));
  });
  handle(conductorChannels.stopAll, devUrl, (args) => {
    arity(args, 2);
    return stopConductor(deps, ipcSlug(args[0]), leadRef(args[1]));
  });
}

let controlServer: ControlServer | null = null;
let kitSocket: KitSocket | null = null;

/**
 * FE-152: the linked folders of the project `cwd` is in (the local boards'
 * and, signed in, the account's), for the kit socket's scope. None when
 * `cwd` is in no linked folder.
 */
async function linkedRootsFor(cwd: string): Promise<string[]> {
  const [real] = await realRoots([cwd]);
  if (!real) return [];
  const records = [LOCAL_RECORD];
  if (!(await inLocalMode())) {
    const record = await authorizedRecord().catch(() => null);
    if (record) records.push(record);
  }
  for (const record of records) {
    const linked = await readFolders(record).catch(() => ({}));
    for (const folders of Object.values(linked))
      for (const root of await realRoots(folders))
        if (isWithin(root, real)) return folders;
  }
  return [];
}

// The release, or "Lanework (Preview)" with its own userData and app home:
// first, before anything reads either (`channel.ts`).
applyChannel();
app.setAboutPanelOptions({
  applicationName: APP_DISPLAY_NAME,
  applicationVersion: APP_DISPLAY_VERSION,
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
// A spec's userData, or `mise run dev`'s own (`scripts/dev.mjs`). Only the
// first makes this a test run; the dev one moves the data and nothing else.
{
  const userData = app.isPackaged
    ? undefined
    : process.env.LANEWORK_TEST_USER_DATA || process.env.LANEWORK_DEV_USER_DATA;
  if (userData) app.setPath("userData", userData);
}
// Before anything reads the project state: it lived in `workspaces/` until
// FE-107, and in one flat folder until FE-108.
moveLegacyProjectsDir();
migrateProjectsLayout();
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
    // `blob:` for the composer's thumbnails of dropped images (an object URL
    // of the file the user gave), as in production (protocol.ts).
    "img-src 'self' data: blob:",
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
    title: APP_DISPLAY_NAME,
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
    // Ask the login shell for its PATH now, while the window loads, so the
    // first `git` status does not wait on the user's profile.
    void loginPath();
    if (devUrl) applyDevCsp(devUrl);
    handle(channels.appInfo, devUrl, (args): AppInfo => {
      if (args.length) throw new Error("This operation takes no arguments");
      return {
        name: APP_DISPLAY_NAME,
        version: APP_DISPLAY_VERSION,
        platform: process.platform,
        channel: APP_CHANNEL,
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
    // FE-166: `connectors.inventory` and `connectors.refresh`. Registering
    // reads nothing; a project is scanned on the first ask.
    registerConnectors(devUrl);
    registerProjects(devUrl);
    registerGit(devUrl);
    registerTerminal(devUrl);
    // A Lanework tab is found and stopped by its id. A Claude in any other
    // terminal app is caught by its pid file.
    const pids = pidFileBridge();
    registerConversation(devUrl, {
      terminalOn: async (project, conversation, ours) =>
        (await agentTerminalOn(project, conversation)) ??
        pids.terminalOn(project, conversation, ours),
      kill: (id) => (id.startsWith("pid:") ? pids.kill(id) : killTerminal(id)),
      onRunningChanged,
    });
    // FE-99: after the conversation view, whose engines a run starts on.
    registerRoutines(devUrl);
    // FE-165: no work until a project's first permission request.
    registerPermissions(devUrl, { pendingPermission });
    // PD-08: no work until a project's first get.
    registerAutonomy(devUrl);
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
    registerConductors(devUrl);
    // FE-149: ⌘⇧F in a project's folder, and across the transcripts.
    registerRepoSearch(devUrl);
    registerSessionSearch(devUrl);
    // FE-151: fuzzy file finding (fff) and structural search (ast-grep).
    registerFileFinder(devUrl);
    registerStructuralSearch(devUrl);
    // FE-152: the kit's tools for `lwk` and the lanework-kit MCP server, on
    // a 0600 unix socket in the app home, with the warm fff index above.
    // FE-158: the socket's `shadow` and `lwk` backends (LANEWORK_KIT_BACKEND
    // or `kit.json`) go through the app's lwk client, which runs as Settings
    // → Power saver says: the saved mode now, a change when it is saved
    // (`conversation/index.ts`).
    void savedLwkMode()
      .then((mode) => lwkServe().setMode(mode))
      .catch((error: unknown) =>
        console.warn("Unable to apply the lwk mode", error),
      );
    startKitSocket({ rootsFor: linkedRootsFor, lwk: lwkServe() })
      .then((socket) => {
        kitSocket = socket;
      })
      .catch((error: unknown) => {
        console.warn("Unable to start the kit socket", error);
      });
    // A board synced to the cloud takes its conversations and conductors
    // along (FE-142); boards synced before this get theirs now.
    onProjectMoved(async (from, to) => {
      moveProjectSessions(from, to);
      await moveConductors(from, to);
    });
    void adoptMovedProjects();
    // Rewritten on every launch, like the Stop hook, so it always matches
    // this app's Node and bundle.
    void installControlCli().catch((error: unknown) =>
      console.warn("Unable to install lanework-control", error),
    );
    // `~/.lanew/bin/lwk` (FE-152): a link to this build's binary, refreshed
    // on every launch so it follows the app when it moves or updates.
    void installLwk().catch((error: unknown) =>
      console.warn("Unable to install lwk", error),
    );
    // `~/.lanew/bin/lanework-control-mcp` (FE-155): the control MCP server a
    // conductor's or lead's process is started with. Rewritten every launch.
    void ensureControlMcpShim().catch((error: unknown) =>
      console.warn("Unable to install lanework-control-mcp", error),
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
    registerAttention(devUrl);
    registerMetrics(devUrl);
    registerStorage(devUrl);
    // INF-11: what a restart to install an update would stop.
    registerUpdater(devUrl, {
      liveWork: async () => ({
        terminals: (await terminalActivity()).terminals,
        runs: await countActiveRuns(
          join(app.getPath("userData"), "orchestration", "runs"),
          async (project, runId) =>
            (await orchestrationMain.run(project, runId))?.status ?? null,
        ),
      }),
    });
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
  stopRoutines();
  void flushPermissions();
  void controlServer?.close();
  controlServer = null;
  void kitSocket?.close();
  kitSocket = null;
  void shutdownLwkServe();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
