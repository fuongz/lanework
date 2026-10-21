var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// apps/desktop/electron/hook/lanework-checkpoint.ts
var exports_lanework_checkpoint = {};
__export(exports_lanework_checkpoint, {
  snapshot: () => snapshot,
  redact: () => redact,
  digestCodex: () => digestCodex,
  digest: () => digest,
  buildBody: () => buildBody
});
module.exports = __toCommonJS(exports_lanework_checkpoint);
var import_node_child_process3 = require("node:child_process");
var import_node_crypto3 = require("node:crypto");
var import_node_fs5 = require("node:fs");
var import_node_os6 = require("node:os");
var import_node_path6 = require("node:path");
// packages/protocol/src/auth.ts
var LOOPBACK_CALLBACK_PATH = "/oauth/callback";
// packages/protocol/src/boards.ts
var WORK_ITEM_TYPES = ["epic", "issue", "task"];
var PRIORITIES = ["low", "medium", "high"];
var CHECKLIST_SECTIONS = ["decisions", "verify"];
var STREAM_ROLES = ["research", "implement", "test"];
var STREAM_ISOLATIONS = ["worktree", "shared"];
// packages/protocol/src/checkpoints.ts
var CHECKPOINTS_KEPT = 5;
var CHECKPOINT_MAX_BYTES = 16 * 1024;
// packages/protocol/src/common.ts
var DEFAULT_API_ORIGIN = "https://api.lanework.dev";
var AGENT_HEADER = "x-lanework-agent";
var TOKEN_PREFIXES = {
  registration: "lw_reg_",
  machine: "lw_mch_",
  device: "lw_dev_",
  code: "lw_code_"
};
// packages/protocol/src/endpoints.ts
var seg = encodeURIComponent;
var paths = {
  health: () => "/v1/health",
  cliAuth: () => "/v1/cli/auth",
  cliToken: () => "/v1/cli/token",
  machinesRegister: () => "/v1/machines/register",
  machinesMe: () => "/v1/machines/me",
  machinesHeartbeat: () => "/v1/machines/heartbeat",
  syncState: () => "/v1/sync/state",
  syncWorkspace: () => "/v1/sync/state/workspace",
  syncWorkspaceById: (id) => `/v1/sync/state/workspace/${seg(id)}`,
  syncWorkspaceOrder: () => "/v1/sync/state/workspace-order",
  boardsForRepo: (remote) => `/v1/boards?repo=${seg(remote)}`,
  boardRepo: (workspaceId) => `/v1/boards/${seg(workspaceId)}/repo`,
  boardConfig: (workspaceId) => `/v1/boards/${seg(workspaceId)}/config`,
  boardIcon: (workspaceId) => `/v1/boards/${seg(workspaceId)}/icon`,
  boardPresence: (workspaceId) => `/v1/boards/${seg(workspaceId)}/presence`,
  boardStats: (workspaceId, query) => withQuery(`/v1/boards/${seg(workspaceId)}/stats`, query),
  boardChanges: (workspaceId, since, limit) => `/v1/boards/${seg(workspaceId)}/changes?since=${since}${limit === undefined ? "" : `&limit=${limit}`}`,
  boardLookup: (workspaceId, by) => `/v1/boards/${seg(workspaceId)}/lookup?${"taskId" in by ? `taskId=${seg(by.taskId)}` : `source=${seg(by.source)}`}`,
  boardImport: (workspaceId) => `/v1/boards/${seg(workspaceId)}/import`,
  boardMigrated: (workspaceId) => `/v1/boards/${seg(workspaceId)}/migrated`,
  boardPurge: (workspaceId) => `/v1/boards/${seg(workspaceId)}/purge`,
  items: (workspaceId, query) => withQuery(`/v1/boards/${seg(workspaceId)}/items`, query),
  item: (workspaceId, itemId) => `/v1/boards/${seg(workspaceId)}/items/${seg(itemId)}`,
  itemMove: (workspaceId, itemId) => `${paths.item(workspaceId, itemId)}/move`,
  itemRestore: (workspaceId, itemId) => `${paths.item(workspaceId, itemId)}/restore`,
  itemChecklist: (workspaceId, itemId) => `${paths.item(workspaceId, itemId)}/checklist`,
  itemChecklistItem: (workspaceId, itemId, key) => `${paths.item(workspaceId, itemId)}/checklist/${seg(key)}`,
  itemLinks: (workspaceId, itemId) => `${paths.item(workspaceId, itemId)}/links`,
  itemLink: (workspaceId, itemId, linkId) => `${paths.item(workspaceId, itemId)}/links/${seg(linkId)}`,
  itemComments: (workspaceId, itemId) => `${paths.item(workspaceId, itemId)}/comments`,
  itemComment: (workspaceId, itemId, commentId) => `${paths.item(workspaceId, itemId)}/comments/${seg(commentId)}`,
  itemSubscription: (workspaceId, itemId) => `${paths.item(workspaceId, itemId)}/subscription`,
  itemFavorite: (workspaceId, itemId) => `${paths.item(workspaceId, itemId)}/favorite`,
  itemAttachments: (workspaceId, itemId) => `${paths.item(workspaceId, itemId)}/attachments`,
  itemAttachment: (workspaceId, itemId, attachmentId) => `${paths.item(workspaceId, itemId)}/attachments/${seg(attachmentId)}`,
  itemAudit: (workspaceId, itemId) => `${paths.item(workspaceId, itemId)}/audit`,
  itemActivity: (workspaceId, itemId, query) => withQuery(`${paths.item(workspaceId, itemId)}/activity`, query),
  itemCheckpoints: (workspaceId, ref) => `/v1/boards/${seg(workspaceId)}/items/${seg(ref)}/checkpoints`
};
function withQuery(path, query) {
  const text = query === undefined ? "" : String(query);
  return text ? `${path}?${text}` : path;
}
// apps/desktop/electron/hook/cli.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs3 = require("node:fs");
var import_node_os5 = require("node:os");
var import_node_path5 = require("node:path");

// apps/desktop/electron/main/auth/client.ts
var import_node_os = require("node:os");

// apps/desktop/electron/main/auth/redirect.ts
var CALLBACK_PATH = LOOPBACK_CALLBACK_PATH;
function externalUrlOn(raw, origin) {
  if (typeof raw !== "string" || raw.length > 2048)
    return null;
  let url;
  let base;
  try {
    url = new URL(raw);
    base = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return null;
  if (url.username || url.password)
    return null;
  if (url.origin !== base.origin)
    return null;
  return url.toString();
}
var USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function looksLikeUserCode(value) {
  if (typeof value !== "string" || value.length !== 9)
    return false;
  if (value[4] !== "-")
    return false;
  return [...value.replace("-", "")].every((c) => USER_CODE_ALPHABET.includes(c));
}

// apps/desktop/electron/main/auth/client.ts
function machineFacts(name) {
  const host = import_node_os.hostname();
  return {
    name: (name || host || "desktop").slice(0, 120),
    hostname: host,
    os: process.platform,
    arch: process.arch
  };
}

class UnreachableError extends Error {
  constructor(api, cause) {
    super(`Could not reach the control plane at ${api} — check the network, or LANEWORK_API_URL. (${cause instanceof Error ? cause.message : String(cause)})`);
    this.name = "UnreachableError";
  }
}
function refused(api, status, detail) {
  if (status === 404)
    return new Error(`${api} has no CLI login endpoint (HTTP 404) — it is older than this app, or LANEWORK_API_URL points somewhere else.`);
  if (status === 429)
    return new Error(`${api} is rate limiting this machine (HTTP 429). Wait a minute and try again.`);
  if (status >= 500)
    return new Error(`${api} could not handle the request (HTTP ${status}). That is a fault on the control plane; nothing was changed here.`);
  return new Error(`${api} refused the request (HTTP ${status})${detail ? `: ${detail}` : ""}.`);
}
async function postJson(api, path, body, signal) {
  let res;
  try {
    res = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
    });
  } catch (cause) {
    if (signal?.aborted)
      throw cause;
    throw new UnreachableError(api, cause);
  }
  const data = await res.json().catch(() => ({}));
  return {
    status: res.status,
    ok: res.ok,
    data
  };
}
function str(value, max = 2048) {
  return typeof value === "string" && value && value.length <= max ? value : null;
}
async function startLoopback(api, input, signal) {
  const { status, ok, data } = await postJson(api, paths.cliAuth(), {
    mode: "loopback",
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    redirect_uri: input.redirectUri,
    state: input.state,
    ...input.facts
  }, signal);
  if (!ok)
    throw refused(api, status, str(data.error, 200) ?? "");
  const id = str(data.id, 64);
  const authorizeUrl = externalUrlOn(data.authorize_url, api);
  if (!id || !authorizeUrl)
    throw new Error(`${api} returned a login it did not describe (no id, or an authorize URL off its own origin).`);
  return { id, authorizeUrl };
}
async function startDevice(api, input, signal) {
  const { status, ok, data } = await postJson(api, paths.cliAuth(), {
    mode: "device",
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    ...input.facts
  }, signal);
  if (!ok)
    throw refused(api, status, str(data.error, 200) ?? "");
  const id = str(data.id, 64);
  const deviceCode = str(data.device_code, 200);
  const verificationUri = externalUrlOn(data.verification_uri, api);
  if (!id || !deviceCode || !verificationUri || !looksLikeUserCode(data.user_code))
    throw new Error(`${api} returned a device login it did not describe (missing code, or a verification URL off its own origin).`);
  const complete = externalUrlOn(data.verification_uri_complete, api) ?? verificationUri;
  const interval = Number(data.interval);
  return {
    id,
    deviceCode,
    userCode: data.user_code,
    verificationUri,
    verificationUriComplete: complete,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 5
  };
}
async function redeem(api, grant, verifier, signal) {
  const { status, ok, data } = await postJson(api, paths.cliToken(), {
    ...grant.code ? { code: grant.code } : {},
    ...grant.deviceCode ? { device_code: grant.deviceCode } : {},
    code_verifier: verifier
  }, signal);
  const machineId = str(data.machineId, 64);
  const secret = str(data.secret, 200);
  if (ok && machineId && secret)
    return { state: "issued", machineId, secret };
  switch (data.error) {
    case "authorization_pending":
      return { state: "pending" };
    case "slow_down":
      return { state: "slow_down" };
    case "access_denied":
      return { state: "denied" };
    case "expired_token":
      return { state: "expired" };
  }
  if (status === 401)
    throw new Error(`${api} rejected this sign-in — it expired, was already used, or was never approved. Try signing in again.`);
  throw refused(api, status, str(data.error, 200) ?? "");
}

// apps/desktop/electron/main/auth/loopback.ts
var import_node_http = require("node:http");
var PORT_FROM = 8976;
var PORT_TO = 8986;
var WAIT_MS = 10 * 60 * 1000;
function page(heading, body) {
  return `<!doctype html><meta charset="utf-8">
<title>${heading}</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;
color-scheme:light dark;display:grid;place-items:center;height:100vh;margin:0;text-align:center}
h1{font-size:1.2rem;margin:0 0 .3rem}p{margin:0;opacity:.65}</style>
<div><h1>${heading}</h1><p>${body}</p></div>`;
}
function bindFirstFree(server) {
  return (async () => {
    for (let port = PORT_FROM;port <= PORT_TO; port++) {
      const bound = await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener("listening", onListening);
          if (error.code === "EADDRINUSE")
            resolve(false);
          else
            reject(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve(true);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      if (bound)
        return port;
    }
    throw new Error(`No free port between ${PORT_FROM} and ${PORT_TO} to receive the sign-in. Close whatever is using them, or use device sign-in.`);
  })();
}
async function listenForCallback(input) {
  let resolveHit = () => {};
  let rejectHit = () => {};
  const hit = new Promise((resolve, reject) => {
    resolveHit = resolve;
    rejectHit = reject;
  });
  const sockets = new Set;
  const server = import_node_http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    if (url.searchParams.get("state") !== input.state) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("Ignored", "That callback did not come from this sign-in."));
      return;
    }
    const code = url.searchParams.get("code");
    res.writeHead(code ? 200 : 400, {
      "Content-Type": "text/html; charset=utf-8"
    }).end(code ? page("Signed in", "You can close this tab and return to the app.") : page("Something went wrong", "No authorization code was returned."));
    if (code)
      resolveHit(code);
    else
      rejectHit(new Error("The control plane returned no authorization code."));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await bindFirstFree(server);
  const timer = new AbortController;
  try {
    await input.onPort(port);
    const expiry = new Promise((_resolve, reject) => {
      const id = setTimeout(() => reject(new Error("Timed out waiting for the browser. Nothing was changed.")), WAIT_MS);
      timer.signal.addEventListener("abort", () => clearTimeout(id));
    });
    const cancelled = new Promise((_resolve, reject) => {
      if (!input.signal)
        return;
      if (input.signal.aborted)
        reject(new Error("Sign-in cancelled."));
      input.signal.addEventListener("abort", () => reject(new Error("Sign-in cancelled.")));
    });
    return await Promise.race([hit, expiry, cancelled]);
  } finally {
    timer.abort();
    for (const socket of sockets)
      socket.destroy();
    server.closeAllConnections?.();
    server.close();
  }
}

// apps/desktop/electron/main/auth/pkce.ts
var import_node_crypto = require("node:crypto");
function pkcePair() {
  const verifier = import_node_crypto.randomBytes(32).toString("base64url");
  const challenge = import_node_crypto.createHash("sha256").update(verifier).digest().toString("base64url");
  return { verifier, challenge };
}
function newState() {
  return import_node_crypto.randomBytes(16).toString("base64url");
}

// apps/desktop/electron/mcp-local/server.ts
var import_node_os3 = require("node:os");

// apps/desktop/electron/local-store/driver.ts
var import_node_module = require("node:module");
var import_node_path = require("node:path");
function sqliteDriverName() {
  return "Bun" in globalThis ? "bun:sqlite" : "node:sqlite";
}
function openRaw(path) {
  if (sqliteDriverName() === "bun:sqlite") {
    const load = import_node_module.createRequire(import_node_path.join(process.cwd(), "noop.js"));
    const { Database } = load("bun:sqlite");
    return new Database(path, { create: true });
  }
  const sqlite = process.getBuiltinModule("node:sqlite");
  if (!sqlite)
    throw new Error("node:sqlite is not available in this runtime (needs Node 22.5 or later)");
  return new sqlite.DatabaseSync(path);
}
function openDatabase(path) {
  const raw = openRaw(path);
  const cache = new Map;
  return {
    exec(sql) {
      raw.exec(sql);
    },
    prepare(sql) {
      const cached = cache.get(sql);
      if (cached)
        return cached;
      const statement = raw.prepare(sql);
      const wrapped = {
        run: (...params) => statement.run(...params),
        get: (...params) => statement.get(...params) ?? undefined,
        all: (...params) => statement.all(...params)
      };
      cache.set(sql, wrapped);
      return wrapped;
    },
    close() {
      cache.clear();
      raw.close();
    }
  };
}
// apps/desktop/electron/local-store/ids.ts
var import_node_crypto2 = require("node:crypto");
function uuidv7(now = Date.now()) {
  const bytes = import_node_crypto2.randomBytes(16);
  let ms = BigInt(now);
  for (let index = 5;index >= 0; index -= 1) {
    bytes[index] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  bytes[6] = bytes[6] & 15 | 112;
  bytes[8] = bytes[8] & 63 | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value) {
  return UUID.test(value);
}
var RANK_WIDTH = 16;
var RANK_STEP = 1e6;
function rankString(value) {
  return String(value).padStart(RANK_WIDTH, "0");
}
function rankValue(rank) {
  const value = Number(rank);
  return Number.isFinite(value) ? value : 0;
}
function slugify(name) {
  const slug = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "board";
}
function normalizeRepo(remote) {
  const value = remote.trim();
  if (!value)
    return null;
  let host;
  let path;
  const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    host = url.hostname;
    path = url.pathname;
  } else if (scp?.[1] && scp[2]) {
    host = scp[1];
    path = scp[2];
  } else {
    return null;
  }
  const parts = path.replace(/\.git\/?$/i, "").split("/").filter(Boolean);
  if (!host || parts.length < 2)
    return null;
  return [host.toLowerCase(), ...parts].join("/").toLowerCase();
}
function formatTaskId(category, seq) {
  return category.format.replace("{prefix}", category.prefix).replace("{seq}", String(seq).padStart(category.pad, "0"));
}
// apps/desktop/electron/local-store/schema.ts
var MIGRATIONS = [
  `
  CREATE TABLE workspace (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL,
    name        TEXT NOT NULL,
    repo_url    TEXT,
    config      TEXT NOT NULL DEFAULT '{}',
    task_heads  TEXT NOT NULL DEFAULT '{}',
    cloud_id    TEXT,
    synced_at   TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  );
  CREATE UNIQUE INDEX workspace_slug_live ON workspace(slug) WHERE deleted_at IS NULL;
  CREATE INDEX workspace_repo ON workspace(repo_url) WHERE deleted_at IS NULL;

  CREATE TABLE work_item (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspace(id),
    parent_id     TEXT REFERENCES work_item(id),
    task_id       TEXT,
    task_seq      INTEGER,
    category      TEXT,
    type          TEXT NOT NULL DEFAULT 'issue',
    title         TEXT NOT NULL,
    body          TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL,
    priority      TEXT,
    tags          TEXT NOT NULL DEFAULT '[]',
    checklist     TEXT NOT NULL DEFAULT '[]',
    streams       TEXT NOT NULL DEFAULT '[]',
    checkpoint    TEXT,
    sort_key      TEXT NOT NULL,
    revision      INTEGER NOT NULL DEFAULT 1,
    change_seq    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT,
    cloud_id      TEXT
  );
  CREATE UNIQUE INDEX work_item_task_id ON work_item(workspace_id, task_id) WHERE task_id IS NOT NULL;
  CREATE INDEX work_item_lane ON work_item(workspace_id, status, sort_key);
  CREATE INDEX work_item_changes ON work_item(workspace_id, change_seq);
  CREATE INDEX work_item_parent ON work_item(parent_id);

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  INSERT INTO meta(key, value) VALUES ('change_seq', '0');
  `
];
var SCHEMA_VERSION = MIGRATIONS.length;
function userVersion(db) {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? 0);
}
function migrate(db) {
  if (userVersion(db) === SCHEMA_VERSION)
    return SCHEMA_VERSION;
  db.exec("BEGIN IMMEDIATE");
  try {
    const from = userVersion(db);
    if (from > SCHEMA_VERSION)
      throw new Error(`local store is at schema ${from}, newer than this build (${SCHEMA_VERSION})`);
    for (let version = from;version < SCHEMA_VERSION; version += 1) {
      db.exec(MIGRATIONS[version]);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return SCHEMA_VERSION;
}
// apps/desktop/electron/local-store/store.ts
var import_node_fs = require("node:fs");
var import_node_path3 = require("node:path");

// apps/desktop/electron/main/paths.ts
var import_node_os2 = require("node:os");
var import_node_path2 = require("node:path");
var APP_HOME_NAME = ".lanew";
function appHomeDir() {
  return process.env.LANEWORK_HOME || import_node_path2.join(import_node_os2.homedir(), APP_HOME_NAME);
}

// apps/desktop/electron/main/workspaces/review-defaults.ts
var DEFAULT_COLUMNS = [
  {
    key: "backlog",
    name: "Backlog",
    role: "intake",
    icon: "idea",
    tone: "violet"
  },
  {
    key: "todo",
    name: "To-Do",
    role: "start",
    icon: "circle-dashed",
    tone: "amber"
  },
  {
    key: "processing",
    name: "In Progress",
    role: "active",
    icon: "progress",
    tone: "blue"
  },
  { key: "done", name: "Done", role: "done", icon: "check", tone: "emerald" },
  {
    key: "dropped",
    name: "Archived",
    role: "archive",
    icon: "archive",
    tone: "neutral"
  }
];
var TASK_ID_FORMAT = "{prefix}-{seq}";
var TASK_ID_PAD = 2;
var DEFAULT_CATEGORIES = [
  {
    key: "product-design",
    name: "Product Design",
    prefix: "PD",
    tone: "violet"
  },
  { key: "frontend", name: "Frontend", prefix: "FE", tone: "sky" },
  { key: "backend", name: "Backend", prefix: "BE", tone: "emerald" },
  {
    key: "infrastructure",
    name: "Infrastructure",
    prefix: "INF",
    tone: "amber"
  },
  { key: "documentation", name: "Documentation", prefix: "DOC", tone: "teal" }
].map((category) => ({
  ...category,
  format: TASK_ID_FORMAT,
  pad: TASK_ID_PAD
}));
var TAG_MAX = 3;

// apps/desktop/electron/local-store/types.ts
class LocalStoreError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "LocalStoreError";
    this.code = code;
  }
}

// apps/desktop/electron/local-store/cards.ts
function invalid(message) {
  throw new LocalStoreError("invalid", message);
}
function parseJson(value, fallback) {
  if (typeof value !== "string" || !value)
    return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function checkTitle(title) {
  const value = typeof title === "string" ? title.trim() : "";
  if (!value || value.length > 300)
    invalid("title must be 1-300 characters");
  return value;
}
function checkType(type) {
  if (!WORK_ITEM_TYPES.includes(type))
    invalid(`type must be one of ${WORK_ITEM_TYPES.join(", ")}`);
  return type;
}
function checkPriority(priority) {
  if (priority === null || priority === undefined)
    return null;
  if (!PRIORITIES.includes(priority))
    invalid(`priority must be one of ${PRIORITIES.join(", ")}`);
  return priority;
}
function checkCategory(config, key) {
  if (key === null || key === undefined || key === "")
    return null;
  if (!config.categories.some((category) => category.key === key))
    invalid(`unknown category "${key}"`);
  return key;
}
function checkColumn(config, key) {
  if (!config.columns.some((column) => column.key === key))
    invalid(`unknown column "${key}"`);
  return key;
}
function intakeColumn(config) {
  const column = config.columns.find((entry) => entry.role === "intake") ?? [...config.columns].sort((a, b) => a.position - b.position)[0];
  if (!column)
    invalid("the board has no columns");
  return column.key;
}
function isClosedColumn(config, key) {
  const role = config.columns.find((column) => column.key === key)?.role;
  return role === "done" || role === "archive";
}
function normalizeTags(config, tags) {
  if (tags === undefined || tags === null)
    return [];
  if (!Array.isArray(tags))
    invalid("tags must be a list");
  const out = [];
  for (const tag of tags) {
    if (typeof tag !== "string")
      invalid("a tag must be text");
    const key = tag.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40);
    if (key && !out.includes(key))
      out.push(key);
  }
  if (config.tags.max > 0 && out.length > config.tags.max)
    invalid(`a card carries at most ${config.tags.max} tags`);
  if (config.tags.allowed.length > 0) {
    const stray = out.filter((tag) => !config.tags.allowed.includes(tag));
    if (stray.length > 0)
      invalid(`tags not allowed here: ${stray.join(", ")}`);
  }
  return out;
}
function normalizeStreams(input) {
  if (input === undefined || input === null)
    return [];
  if (!Array.isArray(input))
    invalid("streams must be a list");
  const list = input;
  const taken = new Set(list.map((entry) => entry?.key).filter((key) => !!key));
  let next = 0;
  const mint = () => {
    while (taken.has(`W${next}`))
      next += 1;
    const key = `W${next}`;
    taken.add(key);
    return key;
  };
  const streams = list.map((entry, position) => {
    if (!entry || typeof entry !== "object")
      invalid("a stream must be an object");
    const key = entry.key || mint();
    if (!/^W\d{1,3}$/.test(key))
      invalid(`stream key "${key}" must be W0…W999`);
    if (!entry.title?.trim())
      invalid(`stream ${key} needs a title`);
    if (!entry.goal?.trim())
      invalid(`stream ${key} needs a goal`);
    if (!STREAM_ROLES.includes(entry.role))
      invalid(`stream ${key} role must be one of ${STREAM_ROLES.join(", ")}`);
    const isolation = entry.isolation ?? "worktree";
    if (!STREAM_ISOLATIONS.includes(isolation))
      invalid(`stream ${key} isolation must be worktree or shared`);
    if (!Array.isArray(entry.owns) || entry.owns.length === 0)
      invalid(`stream ${key} must own at least one path`);
    for (const path of entry.owns)
      if (typeof path !== "string" || !path || /[*?[\]]/.test(path))
        invalid(`stream ${key} owns "${path}": exact paths only, no globs`);
    return {
      key,
      title: entry.title.trim(),
      goal: entry.goal.trim(),
      role: entry.role,
      owns: [...entry.owns],
      reads: [...entry.reads ?? []],
      dependsOn: [...entry.depends_on ?? []],
      isolation,
      position
    };
  });
  const keys = streams.map((stream) => stream.key);
  if (new Set(keys).size !== keys.length)
    invalid("two streams share a key");
  const owner = new Map;
  for (const stream of streams) {
    for (const path of stream.owns) {
      const other = owner.get(path);
      if (other)
        invalid(`streams ${other} and ${stream.key} both own ${path}`);
      owner.set(path, stream.key);
    }
    for (const dep of stream.dependsOn)
      if (!keys.includes(dep) || dep === stream.key)
        invalid(`stream ${stream.key} depends on unknown stream ${dep}`);
  }
  streamWaves(streams);
  return streams;
}
function streamWaves(streams) {
  const done = new Set;
  const waves = [];
  const left = [...streams].sort((a, b) => a.position - b.position);
  while (left.length > 0) {
    const wave = left.filter((stream) => stream.dependsOn.every((dep) => done.has(dep)));
    if (wave.length === 0)
      invalid("stream dependencies form a cycle");
    for (const stream of wave) {
      done.add(stream.key);
      left.splice(left.indexOf(stream), 1);
    }
    waves.push(wave.map((stream) => stream.key));
  }
  return waves;
}
function list(paths2) {
  return paths2.length > 0 ? paths2.map((path) => `- \`${path}\``).join(`
`) : "- (none)";
}
function buildDispatch(card, streams, checklist) {
  if (streams.length === 0)
    return null;
  const name = card.taskId ? `${card.taskId} "${card.title}"` : `"${card.title}"`;
  const briefs = {};
  for (const stream of streams) {
    const verify = checklist.filter((item) => item.section === "verify" && item.stream === stream.key).map((item) => `- ${item.key}: ${item.text}`);
    briefs[stream.key] = [
      `You are sub-agent for stream **${stream.key} (${stream.title})** of card **${name}**.`,
      "",
      "## Goal",
      stream.goal,
      "",
      "## Where you work",
      stream.isolation === "shared" ? "In the shared checkout, read-only." : "In your own git worktree, which the lead created for this stream. Do not touch any other checkout.",
      "",
      "## You own",
      "Write ONLY inside these paths (a path ending in `/` is a directory):",
      list(stream.owns),
      "",
      "If another file must change, do not change it: say so in your report.",
      "",
      "## Read first",
      list(stream.reads),
      "",
      "## Done means",
      verify.length > 0 ? verify.join(`
`) : "- (no verify items tagged to this stream)",
      "",
      "## Rules",
      "- Do not commit, push, or rewrite git history; the lead merges.",
      "- Do not tick checklist boxes; report what you verified and how.",
      "- Do not call the Lanework MCP.",
      "",
      "## Report",
      "Files changed, commands run with pass/fail, and anything the next stream must know."
    ].join(`
`);
  }
  return { waves: streamWaves(streams), briefs };
}
var CHECKLIST_TEXT_MAX = 2000;
function normalizeChecklist(input, options) {
  if (input === undefined || input === null)
    return [];
  if (!Array.isArray(input))
    invalid("checklist must be a list");
  const rows = input;
  const before = new Map((options.previous ?? []).map((item) => [item.key, item]));
  const taken = new Set(rows.map((row) => row?.key).filter((key) => !!key));
  const seen = { decisions: 0, verify: 0 };
  const mint = (section) => {
    const prefix = section === "verify" ? "V" : "D";
    let key;
    do {
      seen[section] += 1;
      key = `${prefix}${seen[section]}`;
    } while (taken.has(key));
    taken.add(key);
    return key;
  };
  const streamKeys = new Set(options.streams.map((stream) => stream.key));
  const items = rows.map((row) => {
    if (!row || typeof row !== "object")
      invalid("a checklist item must be an object");
    const prev = row.key ? before.get(row.key) : undefined;
    const section = row.section ?? prev?.section ?? "decisions";
    if (!CHECKLIST_SECTIONS.includes(section))
      invalid(`section must be decisions or verify`);
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text || text.length > CHECKLIST_TEXT_MAX)
      invalid(`checklist text must be 1-${CHECKLIST_TEXT_MAX} characters`);
    const checked = row.checked ?? prev?.checked ?? false;
    const checkedAt = checked ? row.checkedAt ?? (prev?.checked ? prev.checkedAt : null) ?? options.now : null;
    const stream = row.stream === undefined ? prev?.stream ?? null : row.stream ?? null;
    if (stream !== null) {
      if (section !== "verify")
        invalid("only a verify item can carry a stream");
      if (!streamKeys.has(stream))
        invalid(`unknown stream ${stream}`);
    }
    return {
      key: row.key || mint(section),
      section,
      text,
      checked,
      checkedAt,
      note: row.note === undefined ? prev?.note ?? null : row.note ?? null,
      group: row.group === undefined ? prev?.group ?? null : row.group ?? null,
      stream
    };
  });
  const keys = items.map((item) => item.key);
  if (new Set(keys).size !== keys.length)
    invalid("two checklist items share a key");
  return items;
}
function checkChecklistStreams(checklist, streams) {
  const keys = new Set(streams.map((stream) => stream.key));
  for (const item of checklist)
    if (item.stream && !keys.has(item.stream))
      invalid(`checklist item ${item.key} names unknown stream ${item.stream}`);
}
function clip(value, max) {
  if (typeof value !== "string")
    return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}
function normalizeCheckpoint(request) {
  const summary = clip(request?.summary, 6000);
  if (!summary)
    invalid("a checkpoint needs a summary");
  const git = request.git ? {
    branch: clip(request.git.branch, 200),
    head: clip(request.git.head, 100),
    wipRef: clip(request.git.wipRef, 300),
    wipSha: clip(request.git.wipSha, 100),
    diffStat: clip(request.git.diffStat, 4000)
  } : null;
  const content = {
    request: clip(request.request, 2000),
    summary,
    nextStep: clip(request.nextStep, 1000),
    files: (request.files ?? []).filter((file) => typeof file === "string" && !!file).slice(-100),
    commands: (request.commands ?? []).filter((entry) => entry && typeof entry.command === "string").slice(-30).map((entry) => ({
      command: entry.command.slice(0, 500),
      ok: typeof entry.ok === "boolean" ? entry.ok : null
    })),
    host: clip(request.host, 200),
    session: clip(request.session, 200),
    git
  };
  if (Buffer.byteLength(JSON.stringify(content)) > CHECKPOINT_MAX_BYTES)
    invalid(`a checkpoint weighs at most ${CHECKPOINT_MAX_BYTES} bytes`);
  return content;
}
function keepCheckpoints(list2) {
  return list2.slice(0, CHECKPOINTS_KEPT);
}
function latestCheckpoint(list2) {
  const newest = list2[0];
  if (!newest)
    return null;
  if (newest.nextStep)
    return { ...newest, nextStepFrom: null };
  const older = list2.slice(1).find((entry) => entry.nextStep);
  if (!older)
    return { ...newest, nextStepFrom: null };
  return {
    ...newest,
    nextStep: older.nextStep,
    nextStepFrom: {
      id: older.id,
      agent: older.agent,
      createdAt: older.createdAt
    }
  };
}
function toCard(row) {
  const checklist = parseJson(row.checklist, []);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    seq: Number(row.change_seq),
    revision: Number(row.revision),
    type: row.type,
    parentId: row.parent_id,
    columnKey: row.status,
    rank: row.sort_key,
    title: row.title,
    body: row.body,
    priority: row.priority ?? null,
    estimate: null,
    categoryKey: row.category,
    taskId: row.task_id,
    tags: parseJson(row.tags, []),
    checklistProgress: {
      done: checklist.filter((item) => item.checked).length,
      total: checklist.length
    },
    streams: parseJson(row.streams, []),
    metadata: null,
    source: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: null,
    completedAt: null,
    dueAt: null,
    archivedAt: row.deleted_at
  };
}
function toCardDetail(row) {
  const card = toCard(row);
  const checklist = parseJson(row.checklist, []);
  return {
    ...card,
    checklist,
    dispatch: buildDispatch(card, card.streams, checklist),
    assignees: { users: [], agents: [] },
    links: [],
    attachments: [],
    subscribers: [],
    subscribed: false,
    favorite: false,
    commentCount: 0
  };
}

// apps/desktop/electron/local-store/store.ts
var DATA_FILE_NAME = "data.sqlite";
function localStorePath() {
  return import_node_path3.join(appHomeDir(), DATA_FILE_NAME);
}
function defaultBoardConfig() {
  return {
    columns: DEFAULT_COLUMNS.map((column, position) => ({
      ...column,
      position
    })),
    categories: DEFAULT_CATEGORIES.map((category, position) => ({
      ...category,
      position
    })),
    labels: [],
    tags: { max: TAG_MAX, allowed: [] }
  };
}
function toWorkspace(row) {
  const stored = parseJson(row.config, {});
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    repo: row.repo_url,
    config: { ...defaultBoardConfig(), ...stored },
    taskHeads: parseJson(row.task_heads, {}),
    cloudId: row.cloud_id,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}
function notFound(what) {
  throw new LocalStoreError("not_found", `${what} not found`);
}
function invalid2(message) {
  throw new LocalStoreError("invalid", message);
}

class LocalStore {
  path;
  #db;
  #depth = 0;
  #seq = 0;
  constructor(db, path) {
    this.#db = db;
    this.path = path;
  }
  get db() {
    if (!this.#db)
      throw new LocalStoreError("closed", "local store is closed");
    return this.#db;
  }
  close() {
    this.#db?.close();
    this.#db = null;
  }
  #get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }
  #all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }
  #run(sql, ...params) {
    return Number(this.db.prepare(sql).run(...params).changes);
  }
  #write(fn) {
    if (this.#depth > 0)
      return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.#depth += 1;
    try {
      const row = this.#get("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'change_seq' RETURNING value");
      this.#seq = Number(row?.value ?? 0);
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }
  dataVersion() {
    const row = this.#get("SELECT value FROM meta WHERE key = 'change_seq'");
    return Number(row?.value ?? 0);
  }
  #now() {
    return new Date().toISOString();
  }
  listWorkspaces(options = {}) {
    const rows = this.#all(options.includeDeleted ? "SELECT * FROM workspace ORDER BY created_at, id" : "SELECT * FROM workspace WHERE deleted_at IS NULL ORDER BY created_at, id");
    return rows.map(toWorkspace);
  }
  getWorkspace(ref) {
    const row = this.#get("SELECT * FROM workspace WHERE (id = ? OR slug = ?) AND deleted_at IS NULL", ref, ref);
    return row ? toWorkspace(row) : null;
  }
  #workspace(ref) {
    return this.getWorkspace(ref) ?? notFound(`workspace ${ref}`);
  }
  #uniqueSlug(base, except) {
    let slug = base;
    for (let n = 2;; n += 1) {
      const clash = this.#get("SELECT id FROM workspace WHERE slug = ? AND deleted_at IS NULL", slug);
      if (!clash || clash.id === except)
        return slug;
      slug = `${base}-${n}`;
    }
  }
  createWorkspace(input) {
    const name = input.name?.trim();
    if (!name)
      invalid2("a workspace needs a name");
    const repo = input.repo ? normalizeRepo(input.repo) : null;
    if (input.repo && !repo)
      invalid2(`not a git remote: ${input.repo}`);
    const config = { ...defaultBoardConfig(), ...input.config };
    checkConfig(config);
    return this.#write(() => {
      const id = uuidv7();
      const now = this.#now();
      const slug = this.#uniqueSlug(slugify(input.slug || name));
      if (repo)
        this.#releaseRepo(repo, now);
      this.#run(`INSERT INTO workspace (id, slug, name, repo_url, config, task_heads, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`, id, slug, name, repo, JSON.stringify(config), now, now);
      return this.#workspace(id);
    });
  }
  updateWorkspace(ref, input) {
    return this.#write(() => {
      const current = this.#workspace(ref);
      const name = input.name === undefined ? current.name : input.name.trim();
      if (!name)
        invalid2("a workspace needs a name");
      const slug = input.slug === undefined ? current.slug : this.#uniqueSlug(slugify(input.slug), current.id);
      const config = input.config ? { ...current.config, ...input.config } : current.config;
      checkConfig(config);
      this.#run(`UPDATE workspace SET name = ?, slug = ?, config = ?, cloud_id = ?, synced_at = ?, updated_at = ?
         WHERE id = ?`, name, slug, JSON.stringify(config), input.cloudId === undefined ? current.cloudId : input.cloudId, input.syncedAt === undefined ? current.syncedAt : input.syncedAt, this.#now(), current.id);
      return this.#workspace(current.id);
    });
  }
  deleteWorkspace(ref) {
    this.#write(() => {
      const current = this.#workspace(ref);
      const now = this.#now();
      this.#run("UPDATE workspace SET deleted_at = ?, updated_at = ? WHERE id = ?", now, now, current.id);
    });
  }
  #releaseRepo(repo, now) {
    this.#run("UPDATE workspace SET repo_url = NULL, updated_at = ? WHERE repo_url = ? AND deleted_at IS NULL", now, repo);
  }
  linkRepo(ref, remote) {
    const repo = remote === null ? null : normalizeRepo(remote);
    if (remote !== null && !repo)
      invalid2(`not a git remote: ${remote}`);
    return this.#write(() => {
      const current = this.#workspace(ref);
      const now = this.#now();
      if (repo)
        this.#releaseRepo(repo, now);
      this.#run("UPDATE workspace SET repo_url = ?, updated_at = ? WHERE id = ?", repo, now, current.id);
      return this.#workspace(current.id);
    });
  }
  findWorkspacesByRepo(remote) {
    const repo = normalizeRepo(remote);
    if (!repo)
      return [];
    return this.#all("SELECT * FROM workspace WHERE repo_url = ? AND deleted_at IS NULL ORDER BY created_at, id", repo).map(toWorkspace);
  }
  boardSummaries(remote) {
    const list2 = remote === undefined ? this.listWorkspaces() : this.findWorkspacesByRepo(remote);
    const head = this.dataVersion();
    return list2.map((workspace) => ({
      workspaceId: workspace.id,
      name: workspace.name,
      role: "owner",
      changeSeq: head,
      repo: workspace.repo
    }));
  }
  boardConfig(ref) {
    const workspace = this.#workspace(ref);
    return {
      workspaceId: workspace.id,
      role: "owner",
      changeSeq: this.dataVersion(),
      migratedAt: null,
      tags: workspace.config.tags,
      columns: workspace.config.columns,
      categories: workspace.config.categories,
      labels: workspace.config.labels,
      members: []
    };
  }
  #taskIdTaken(workspaceId, taskId) {
    return !!this.#get("SELECT 1 AS hit FROM work_item WHERE workspace_id = ? AND task_id = ?", workspaceId, taskId);
  }
  #setHead(workspace, category, seq) {
    const heads = { ...workspace.taskHeads };
    if ((heads[category] ?? 0) >= seq)
      return;
    heads[category] = seq;
    workspace.taskHeads = heads;
    this.#run("UPDATE workspace SET task_heads = ? WHERE id = ?", JSON.stringify(heads), workspace.id);
  }
  #mintTaskId(workspace, categoryKey) {
    const category = workspace.config.categories.find((entry) => entry.key === categoryKey);
    if (!category)
      invalid2(`unknown category "${categoryKey}"`);
    let seq = (workspace.taskHeads[categoryKey] ?? 0) + 1;
    while (this.#taskIdTaken(workspace.id, formatTaskId(category, seq)))
      seq += 1;
    this.#setHead(workspace, categoryKey, seq);
    return { taskId: formatTaskId(category, seq), taskSeq: seq };
  }
  #lane(workspaceId, status, except) {
    return this.#all(`SELECT * FROM work_item WHERE workspace_id = ? AND status = ? AND deleted_at IS NULL AND id != ?
       ORDER BY sort_key, id`, workspaceId, status, except ?? "");
  }
  #rankFor(workspaceId, status, placement, self) {
    for (let attempt = 0;attempt < 2; attempt += 1) {
      const lane = this.#lane(workspaceId, status, self);
      const values = lane.map((row) => rankValue(row.sort_key));
      let low;
      let high;
      const anchor = placement?.after ?? placement?.before ?? null;
      if (anchor) {
        const index = lane.findIndex((row) => row.id === anchor);
        if (index < 0)
          invalid2(`placement card ${anchor} is not in lane ${status}`);
        if (placement?.after) {
          low = values[index];
          high = values[index + 1] ?? null;
        } else {
          low = index > 0 ? values[index - 1] : null;
          high = values[index];
        }
      } else {
        low = values.at(-1) ?? null;
        high = null;
      }
      if (high === null)
        return rankString((low ?? 0) + RANK_STEP);
      const from = low ?? 0;
      if (high - from > 1)
        return rankString(Math.floor((from + high) / 2));
      lane.forEach((row, index) => {
        this.#run("UPDATE work_item SET sort_key = ?, change_seq = ? WHERE id = ?", rankString((index + 1) * RANK_STEP), this.#seq, row.id);
      });
    }
    return invalid2("could not place the card");
  }
  #row(id) {
    return this.#get("SELECT * FROM work_item WHERE id = ?", id);
  }
  #resolve(ref, options = {}) {
    let row;
    if (isUuid(ref))
      row = this.#row(ref);
    else {
      if (!options.workspace)
        invalid2(`task id ${ref} needs a workspace`);
      const workspace = this.#workspace(options.workspace);
      row = this.#get("SELECT * FROM work_item WHERE workspace_id = ? AND task_id = ?", workspace.id, ref.toUpperCase());
    }
    if (!row || row.deleted_at && !options.includeDeleted)
      return notFound(`card ${ref}`);
    if (options.workspace) {
      const workspace = this.#workspace(options.workspace);
      if (row.workspace_id !== workspace.id)
        return notFound(`card ${ref}`);
    } else if (!this.getWorkspace(row.workspace_id)) {
      return notFound(`card ${ref}`);
    }
    return row;
  }
  getWorkItem(ref, options = {}) {
    try {
      return toCardDetail(this.#resolve(ref, options));
    } catch (error) {
      if (error instanceof LocalStoreError && error.code === "not_found")
        return null;
      throw error;
    }
  }
  listWorkItems(workspaceRef, query = {}) {
    const workspace = this.#workspace(workspaceRef);
    const where = ["workspace_id = ?"];
    const params = [workspace.id];
    if (!query.includeDeleted)
      where.push("deleted_at IS NULL");
    if (query.column) {
      where.push("status = ?");
      params.push(query.column);
    }
    if (query.category === "none")
      where.push("category IS NULL");
    else if (query.category) {
      where.push("category = ?");
      params.push(query.category);
    }
    if (query.parent === "none")
      where.push("parent_id IS NULL");
    else if (query.parent) {
      where.push("parent_id = ?");
      params.push(query.parent);
    }
    if (query.priority === "none")
      where.push("priority IS NULL");
    else if (query.priority) {
      where.push("priority = ?");
      params.push(query.priority);
    }
    if (query.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)");
      params.push(query.tag.toLowerCase());
    }
    return this.#all(`SELECT * FROM work_item WHERE ${where.join(" AND ")} ORDER BY status, sort_key, id`, ...params).map(toCard);
  }
  listChanges(workspaceRef, since) {
    const workspace = this.#workspace(workspaceRef);
    const head = this.dataVersion();
    const items = this.#all("SELECT * FROM work_item WHERE workspace_id = ? AND change_seq > ? ORDER BY change_seq, id", workspace.id, since).map(toCard);
    return { head, items };
  }
  #checkParent(workspaceId, parentId, self) {
    if (!parentId)
      return null;
    let cursor = parentId;
    for (let depth = 0;cursor; depth += 1) {
      if (cursor === self || depth > 100)
        invalid2("a card cannot hang under itself");
      const row = this.#row(cursor);
      if (!row || row.deleted_at || row.workspace_id !== workspaceId)
        notFound(`parent card ${cursor}`);
      cursor = row.parent_id;
    }
    return parentId;
  }
  createWorkItem(workspaceRef, input) {
    return this.#write(() => {
      const workspace = this.#workspace(workspaceRef);
      const { config } = workspace;
      const now = this.#now();
      const title = checkTitle(input.title);
      const type = checkType(input.type ?? "issue");
      const priority = checkPriority(input.priority);
      const category = checkCategory(config, input.categoryKey);
      const status = input.columnKey ? checkColumn(config, input.columnKey) : intakeColumn(config);
      const tags = normalizeTags(config, input.tags);
      const streams = normalizeStreams(input.streams);
      const restore = input.restore ?? null;
      const checklist = normalizeChecklist(restore?.checklist ?? input.checklist, {
        now,
        streams
      });
      const parentId = this.#checkParent(workspace.id, input.parentId ?? null);
      let taskId = null;
      let taskSeq = null;
      if (restore && (restore.taskId || restore.taskSeq)) {
        if (!restore.taskId || !restore.taskSeq)
          invalid2("restore.taskId and restore.taskSeq come together");
        if (!category)
          invalid2("restoring a task id needs a category");
        if (!Number.isInteger(restore.taskSeq) || restore.taskSeq < 1)
          invalid2("restore.taskSeq must be a positive integer");
        taskId = restore.taskId.toUpperCase();
        taskSeq = restore.taskSeq;
        if (this.#taskIdTaken(workspace.id, taskId))
          throw new LocalStoreError("conflict", `task id ${taskId} is taken`);
        this.#setHead(workspace, category, taskSeq);
      } else if (category) {
        ({ taskId, taskSeq } = this.#mintTaskId(workspace, category));
      }
      const id = uuidv7();
      const rank = this.#rankFor(workspace.id, status, input.placement);
      this.#run(`INSERT INTO work_item (id, workspace_id, parent_id, task_id, task_seq, category, type, title, body,
           status, priority, tags, checklist, streams, checkpoint, sort_key, revision, change_seq,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?)`, id, workspace.id, parentId, taskId, taskSeq, category, type, title, input.body ?? "", status, priority, JSON.stringify(tags), JSON.stringify(checklist), JSON.stringify(streams), rank, this.#seq, restore?.createdAt ?? now, restore?.updatedAt ?? now);
      return toCardDetail(this.#row(id));
    });
  }
  #checkRevision(row, options) {
    if (options?.ifRevision !== undefined && options.ifRevision !== Number(row.revision))
      throw new LocalStoreError("conflict", `card is at revision ${row.revision}, not ${options.ifRevision}`);
  }
  #touch(id, sets, params) {
    this.#run(`UPDATE work_item SET ${[...sets, "revision = revision + 1", "change_seq = ?", "updated_at = ?"].join(", ")}
       WHERE id = ?`, ...params, this.#seq, this.#now(), id);
    return toCardDetail(this.#row(id));
  }
  updateWorkItem(ref, input, options = {}) {
    return this.#write(() => {
      const row = this.#resolve(ref, options);
      this.#checkRevision(row, options);
      const workspace = this.#workspace(row.workspace_id);
      const { config } = workspace;
      const sets = [];
      const params = [];
      const set = (column, value) => {
        sets.push(`${column} = ?`);
        params.push(value);
      };
      if (input.title !== undefined)
        set("title", checkTitle(input.title));
      if (input.type !== undefined)
        set("type", checkType(input.type));
      if (input.body !== undefined)
        set("body", input.body ?? "");
      if (input.priority !== undefined)
        set("priority", checkPriority(input.priority));
      if (input.tags !== undefined)
        set("tags", JSON.stringify(normalizeTags(config, input.tags)));
      if (input.parentId !== undefined)
        set("parent_id", this.#checkParent(workspace.id, input.parentId, row.id));
      if (input.cloudId !== undefined)
        set("cloud_id", input.cloudId);
      if (input.categoryKey !== undefined) {
        const category = checkCategory(config, input.categoryKey);
        set("category", category);
        if (category && !row.task_id) {
          const minted = this.#mintTaskId(workspace, category);
          set("task_id", minted.taskId);
          set("task_seq", minted.taskSeq);
        }
      }
      const streams = input.streams !== undefined ? normalizeStreams(input.streams) : parseJson(row.streams, []);
      if (input.streams !== undefined)
        set("streams", JSON.stringify(streams));
      const previous = parseJson(row.checklist, []);
      const checklist = input.checklist !== undefined ? normalizeChecklist(input.checklist, {
        now: this.#now(),
        previous,
        streams
      }) : previous;
      checkChecklistStreams(checklist, streams);
      if (input.checklist !== undefined)
        set("checklist", JSON.stringify(checklist));
      return this.#touch(row.id, sets, params);
    });
  }
  deleteWorkItem(ref, options = {}) {
    return this.#write(() => {
      const row = this.#resolve(ref, options);
      this.#checkRevision(row, options);
      return this.#touch(row.id, ["deleted_at = ?", "checkpoint = NULL"], [this.#now()]);
    });
  }
  restoreWorkItem(ref, options = {}) {
    return this.#write(() => {
      const row = this.#resolve(ref, { ...options, includeDeleted: true });
      if (!row.deleted_at)
        return toCardDetail(row);
      const rank = this.#rankFor(row.workspace_id, row.status, null, row.id);
      return this.#touch(row.id, ["deleted_at = NULL", "sort_key = ?"], [rank]);
    });
  }
  setStatus(ref, columnKey, options = {}) {
    return this.#write(() => {
      const row = this.#resolve(ref, options);
      this.#checkRevision(row, options);
      const { config } = this.#workspace(row.workspace_id);
      const status = columnKey ? checkColumn(config, columnKey) : row.status;
      if (status === row.status && !options.placement)
        return toCardDetail(row);
      const rank = this.#rankFor(row.workspace_id, status, options.placement, row.id);
      const sets = ["status = ?", "sort_key = ?"];
      if (isClosedColumn(config, status))
        sets.push("checkpoint = NULL");
      return this.#touch(row.id, sets, [status, rank]);
    });
  }
  toggleChecklistItem(ref, key, patch, options = {}) {
    return this.#write(() => {
      const row = this.#resolve(ref, options);
      this.#checkRevision(row, options);
      const checklist = parseJson(row.checklist, []);
      const item = checklist.find((entry) => entry.key === key);
      if (!item)
        notFound(`checklist item ${key}`);
      if (patch.checked !== undefined && patch.checked !== item.checked) {
        item.checked = patch.checked;
        item.checkedAt = patch.checked ? this.#now() : null;
      }
      if (patch.note !== undefined)
        item.note = patch.note || null;
      if (patch.text !== undefined) {
        const text = patch.text.trim();
        if (!text || text.length > CHECKLIST_TEXT_MAX)
          invalid2(`checklist text must be 1-${CHECKLIST_TEXT_MAX} characters`);
        item.text = text;
      }
      if (patch.stream !== undefined) {
        if (patch.stream !== null && item.section !== "verify")
          invalid2("only a verify item can carry a stream");
        item.stream = patch.stream;
        checkChecklistStreams(checklist, parseJson(row.streams, []));
      }
      return this.#touch(row.id, ["checklist = ?"], [JSON.stringify(checklist)]);
    });
  }
  addCheckpoint(ref, request, writer = {}) {
    const content = normalizeCheckpoint(request);
    return this.#write(() => {
      const row = this.#resolve(ref, { workspace: writer.workspace });
      const { config } = this.#workspace(row.workspace_id);
      if (isClosedColumn(config, row.status))
        throw new LocalStoreError("conflict", "a finished or archived card takes no checkpoints");
      const checkpoint = {
        ...content,
        id: uuidv7(),
        agent: writer.agent || "agent",
        userId: writer.userId || "local",
        machineId: writer.machineId ?? null,
        createdAt: this.#now()
      };
      const list2 = keepCheckpoints([
        checkpoint,
        ...parseJson(row.checkpoint, [])
      ]);
      this.#run("UPDATE work_item SET checkpoint = ?, change_seq = ? WHERE id = ?", JSON.stringify(list2), this.#seq, row.id);
      return checkpoint;
    });
  }
  listCheckpoints(ref, options = {}) {
    const row = this.#resolve(ref, options);
    const checkpoints2 = parseJson(row.checkpoint, []);
    return { checkpoints: checkpoints2, latest: latestCheckpoint(checkpoints2) };
  }
}
function checkConfig(config) {
  if (!Array.isArray(config.columns) || config.columns.length === 0)
    invalid2("a board needs at least one column");
  const columnKeys = config.columns.map((column) => column.key);
  if (new Set(columnKeys).size !== columnKeys.length)
    invalid2("two columns share a key");
  const categoryKeys = config.categories.map((category) => category.key);
  if (new Set(categoryKeys).size !== categoryKeys.length)
    invalid2("two categories share a key");
  const prefixes = config.categories.map((category) => category.prefix);
  if (new Set(prefixes).size !== prefixes.length)
    invalid2("two categories share a task-id prefix");
}
function openLocalStore(options = {}) {
  const path = options.path ?? localStorePath();
  if (path !== ":memory:")
    import_node_fs.mkdirSync(import_node_path3.dirname(path), { recursive: true });
  const db = openDatabase(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, options.busyTimeoutMs ?? 5000)}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return new LocalStore(db, path);
}
// apps/desktop/electron/mcp-local/schema.ts
function paramSchema(param) {
  const described = (schema) => param.description ? { ...schema, description: param.description } : schema;
  switch (param.type) {
    case "string":
      return described(param.enum ? { type: "string", enum: [...param.enum] } : { type: "string" });
    case "boolean":
      return described({ type: "boolean" });
    case "integer":
      return described({
        type: "integer",
        ...param.minimum !== undefined ? { minimum: param.minimum } : {},
        ...param.maximum !== undefined ? { maximum: param.maximum } : {}
      });
    case "string[]":
      return described({ type: "array", items: { type: "string" } });
    case "nullable-string":
      return described({ type: ["string", "null"] });
    case "string-map":
      return described({
        type: "object",
        additionalProperties: { type: ["string", "null"] }
      });
    case "object":
      return described(shapeSchema(param));
    case "object[]":
      return described({
        type: "array",
        items: shapeSchema(param),
        ...param.minItems ? { minItems: param.minItems } : {}
      });
  }
}
function shapeSchema(shape) {
  const properties = {};
  for (const [name, param] of Object.entries(shape.properties))
    properties[name] = paramSchema(param);
  return {
    type: "object",
    properties,
    ...shape.required?.length ? { required: [...shape.required] } : {},
    additionalProperties: false
  };
}

class InvalidParams extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidParams";
  }
}
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function checkParam(path, param, value) {
  const fail = (expected) => {
    throw new InvalidParams(`${path} must be ${expected}`);
  };
  switch (param.type) {
    case "string":
      if (typeof value !== "string")
        fail("a string");
      if (param.enum && !param.enum.includes(value))
        fail(`one of ${param.enum.join(", ")}`);
      return value;
    case "boolean":
      if (typeof value !== "boolean")
        fail("true or false");
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value))
        fail("an integer");
      if (param.minimum !== undefined && value < param.minimum)
        fail(`at least ${param.minimum}`);
      if (param.maximum !== undefined && value > param.maximum)
        fail(`at most ${param.maximum}`);
      return value;
    case "string[]":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
        fail("a list of strings");
      return value;
    case "nullable-string":
      if (value !== null && typeof value !== "string")
        fail("a string or null");
      return value;
    case "string-map":
      if (!isObject(value) || Object.values(value).some((v) => v !== null && typeof v !== "string"))
        fail("an object of strings (or null)");
      return value;
    case "object":
      if (!isObject(value))
        fail("an object");
      return checkShape(param, value, `${path}.`);
    case "object[]": {
      if (!Array.isArray(value))
        fail("a list");
      const list2 = value;
      if (param.minItems && list2.length < param.minItems)
        fail(`a list of at least ${param.minItems}`);
      return list2.map((entry, index) => {
        if (!isObject(entry))
          fail(`a list of objects (item ${index})`);
        return checkShape(param, entry, `${path}[${index}].`);
      });
    }
  }
}
function checkShape(shape, args, prefix = "") {
  const input = args === undefined || args === null ? {} : args;
  if (!isObject(input))
    throw new InvalidParams("arguments must be an object");
  const out = {};
  for (const name of shape.required ?? [])
    if (input[name] === undefined || input[name] === null)
      throw new InvalidParams(`${prefix}${name} is required`);
  for (const [name, param] of Object.entries(shape.properties)) {
    const value = input[name];
    if (value === undefined)
      continue;
    if (value === null && param.type !== "nullable-string")
      continue;
    out[name] = checkParam(`${prefix}${name}`, param, value);
  }
  return out;
}

// apps/desktop/electron/mcp-local/tools.ts
var BOARD_ID = {
  type: "string",
  description: "The board's id (the local workspace id) from list_boards. There is no default."
};
var CARD = {
  type: "string",
  description: "Card id or task id (e.g. BE-07)"
};
var REPO = {
  type: "string",
  description: "Output of `git remote get-url origin`, unmodified (ssh or https)"
};
var PRIORITY = {
  type: "string",
  enum: ["low", "medium", "high"]
};
var ASSIGNEES = {
  type: "object",
  description: "Agents assigned to the card. `users` is accepted and ignored: a local board has no accounts.",
  properties: {
    agents: { type: "string[]" },
    users: { type: "string[]" }
  }
};
var STREAMS = {
  type: "object[]",
  description: "Sub-agent streams (BE-19). Only for 2+ independent write areas. `owns`: exact paths or directories ending in `/`, no globs; two streams never own the same path. Shared files go in a W0 stream the others depend on. At most 4 streams per wave. Every stream needs at least one verify item tagged with its key.",
  properties: {
    key: { type: "string", description: "W0…W999; minted when absent" },
    title: { type: "string" },
    goal: { type: "string" },
    role: { type: "string", enum: ["research", "implement", "test"] },
    owns: { type: "string[]" },
    reads: { type: "string[]" },
    depends_on: { type: "string[]", description: "Stream keys" },
    isolation: {
      type: "string",
      enum: ["worktree", "shared"],
      description: "Default worktree"
    }
  },
  required: ["title", "goal", "role"]
};
var CHECKLIST = {
  type: "object[]",
  description: "Decisions (what the user approves) and verify items (how the work is proved). Boxes sharing a `group` are pick-ONE options.",
  properties: {
    section: { type: "string", enum: ["decisions", "verify"] },
    text: { type: "string" },
    checked: { type: "boolean" },
    group: { type: "string" },
    key: { type: "string", description: "D1, V3…; minted if omitted" },
    note: { type: "string" },
    stream: {
      type: "string",
      description: "Verify items only: the stream key this item proves"
    }
  },
  required: ["section", "text"]
};
function fail(code, message) {
  throw new LocalStoreError(code, message);
}
function boardOf(store, boardId) {
  const workspace = store.getWorkspace(String(boardId));
  if (!workspace)
    fail("not_found", `board ${String(boardId)} not found; call list_boards for its id`);
  return workspace;
}
function cardOf(store, board, card) {
  const detail = store.getWorkItem(String(card), { workspace: board.id });
  if (!detail)
    fail("not_found", `card ${String(card)} not found on this board`);
  return detail;
}
var str2 = (value) => typeof value === "string" ? value : undefined;
function startColumn(board) {
  return board.config.columns.find((column) => column.role === "start")?.key;
}
function columnOrder(board) {
  return new Map(board.config.columns.map((column) => [column.key, column]));
}
function checkStreamPlan(streams, checklist) {
  if (!streams || streams.length === 0)
    return;
  const normalized = normalizeStreams(streams);
  for (const wave of streamWaves(normalized))
    if (wave.length > 4)
      fail("invalid", `a wave runs at most 4 streams; ${wave.join(", ")} would run at once`);
  const proved = new Set(checklist.filter((item) => item.section === "verify" && item.stream).map((item) => item.stream));
  const unproved = normalized.map((stream) => stream.key).filter((key) => !proved.has(key));
  if (unproved.length > 0)
    fail("invalid", `every stream needs at least one verify item tagged with its key; untagged: ${unproved.join(", ")}`);
}
function asInput(checklist) {
  return checklist.map((item) => ({
    key: item.key,
    section: item.section,
    text: item.text,
    checked: item.checked,
    note: item.note,
    group: item.group,
    stream: item.stream
  }));
}
function decisionState(checklist) {
  const pending = [];
  const groups = new Map;
  for (const item of checklist) {
    if (item.section !== "decisions")
      continue;
    if (item.group) {
      const members = groups.get(item.group) ?? [];
      members.push(item);
      groups.set(item.group, members);
    } else if (!item.checked)
      pending.push(item.key);
  }
  for (const [group, members] of groups)
    if (members.filter((item) => item.checked).length !== 1)
      pending.push(`group:${group}`);
  return { ready: pending.length === 0, pending };
}
function brief(card) {
  return {
    id: card.id,
    taskId: card.taskId,
    title: card.title,
    column: card.columnKey,
    priority: card.priority,
    revision: card.revision
  };
}
var TOOLS = [
  {
    name: "list_boards",
    description: "Every board on this machine, with its board id and linked repo. Call this FIRST: every other tool needs a `board_id` and there is no default. Pass `repo` (your `git remote get-url origin`, as is) to get only the board(s) linked to the repo you are working in.",
    readOnly: true,
    properties: { repo: REPO },
    run(args, { store }) {
      const remote = str2(args.repo);
      if (remote === undefined) {
        const boards3 = store.boardSummaries();
        return {
          boards: boards3,
          next: boards3.length === 0 ? "No boards yet. Ask the user whether to create one for this repo (create_board)." : "Ask the user which board this repo belongs to; never pick one by its name."
        };
      }
      const repo = normalizeRepo(remote);
      if (!repo)
        fail("invalid", `not a git remote: ${remote}`);
      const boards2 = store.boardSummaries(remote);
      return {
        repo,
        boards: boards2,
        next: boards2.length === 1 ? "Use this board." : boards2.length === 0 ? "No board is linked to this repo. Call list_boards without repo and ask the user which board it belongs to, or whether to create a new one; then link_repo or create_board." : "Several boards are linked to this repo. Ask the user which one."
      };
    }
  },
  {
    name: "create_board",
    description: "Create a new board and link it to the git repo in one step. ONLY after the user chose to create a new board, never on your own initiative. Suggest `owner/name` from the remote as the name. Returns board_id for every other tool.",
    readOnly: false,
    properties: {
      name: {
        type: "string",
        description: "Board name the user agreed to, e.g. `hiip/headless-controller`"
      },
      repo: REPO,
      slug: {
        type: "string",
        description: "Lower-case hyphenated key; omitted = derived from the name."
      }
    },
    required: ["name", "repo"],
    run(args, { store }) {
      const workspace = store.createWorkspace({
        name: String(args.name),
        slug: str2(args.slug),
        repo: String(args.repo)
      });
      return {
        board_id: workspace.id,
        board: {
          workspaceId: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          repo: workspace.repo
        },
        next: "Use this board_id for every other tool. Read board_summary before creating a card."
      };
    }
  },
  {
    name: "link_repo",
    description: "Link a board to a git repo so list_boards({ repo }) finds it. Only after the USER confirmed which board the repo belongs to. A board links to ONE repo; refuses to replace a different linked repo unless `replace` is true. A repo another board held moves to this one.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      repo: REPO,
      replace: {
        type: "boolean",
        description: "Move the link from the repo it has now. Only when the user asked."
      }
    },
    required: ["board_id", "repo"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const repo = normalizeRepo(String(args.repo));
      if (!repo)
        fail("invalid", `not a git remote: ${String(args.repo)}`);
      if (board.repo && board.repo !== repo && args.replace !== true)
        fail("conflict", `board is linked to ${board.repo}; pass replace: true only if the user asked to move it`);
      const linked = store.linkRepo(board.id, String(args.repo));
      return {
        board: {
          workspaceId: linked.id,
          name: linked.name,
          repo: linked.repo
        },
        replaced: board.repo && board.repo !== repo ? board.repo : null
      };
    }
  },
  {
    name: "board_summary",
    description: "Lane-by-lane counts of live cards, plus the board's categories and tag policy. Read this before creating a card so its category and tags match what the board already uses.",
    readOnly: true,
    properties: { board_id: BOARD_ID },
    required: ["board_id"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const cards = store.listWorkItems(board.id);
      const counts = new Map;
      const tags = new Map;
      for (const card of cards) {
        counts.set(card.columnKey, (counts.get(card.columnKey) ?? 0) + 1);
        for (const tag of card.tags)
          tags.set(tag, (tags.get(tag) ?? 0) + 1);
      }
      const columns = [...board.config.columns].sort((a, b) => a.position - b.position);
      return {
        board: { workspaceId: board.id, name: board.name, repo: board.repo },
        total: cards.length,
        lanes: columns.map((column) => ({
          key: column.key,
          name: column.name,
          role: column.role,
          count: counts.get(column.key) ?? 0
        })),
        categories: board.config.categories.map((category) => ({
          key: category.key,
          name: category.name,
          prefix: category.prefix,
          next: (board.taskHeads[category.key] ?? 0) + 1
        })),
        tagPolicy: board.config.tags,
        tags: [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count })),
        labels: board.config.labels
      };
    }
  },
  {
    name: "list_reviews",
    description: "Cards on a board, in the order the board draws them. Filter by lane, category, tag or priority. Archived cards are excluded unless asked for.",
    readOnly: true,
    properties: {
      board_id: BOARD_ID,
      category: { type: "string", description: "Category key, e.g. backend" },
      column: {
        type: "string",
        description: "Lane key, e.g. todo | processing | done"
      },
      include_archived: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      priority: PRIORITY,
      tag: { type: "string" },
      task_id: {
        type: "string",
        description: "Exact task id such as BE-07, matched on the field, not the title"
      }
    },
    required: ["board_id"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const order = columnOrder(board);
      const taskId = str2(args.task_id)?.toUpperCase();
      const cards = store.listWorkItems(board.id, {
        column: str2(args.column),
        category: str2(args.category),
        priority: str2(args.priority),
        tag: str2(args.tag),
        includeDeleted: args.include_archived === true
      }).filter((card) => !taskId || card.taskId === taskId).sort((a, b) => (order.get(a.columnKey)?.position ?? 999) - (order.get(b.columnKey)?.position ?? 999) || a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id));
      const limit = typeof args.limit === "number" ? args.limit : 50;
      return {
        total: cards.length,
        items: cards.slice(0, limit),
        truncated: cards.length > limit
      };
    }
  },
  {
    name: "get_review",
    description: "One card with its checklist, tags and `streams`, plus the latest `checkpoint` another agent left on it (or null) and `dispatch`: the card's run plan, `{ waves, briefs }`, or null when it has no streams. `card` takes either the card's id or its task id (e.g. BE-07).",
    readOnly: true,
    properties: { board_id: BOARD_ID, card: CARD },
    required: ["board_id", "card"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const item = cardOf(store, board, args.card);
      const { latest } = store.listCheckpoints(item.id, {
        workspace: board.id
      });
      return { item, checkpoint: latest, dispatch: item.dispatch };
    }
  },
  {
    name: "create_review",
    description: "Open a new card on a board. Setting `category` also mints the card's permanent task id. Split into `streams` only for 2+ independent write areas. Shared files go in a W0 stream the others depend on. At most 4 streams per wave, no two streams in one wave own the same path, every stream needs at least one verify item tagged with its key. Isolation defaults to worktree.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      title: { type: "string" },
      body: { type: "string", description: "Markdown" },
      category: {
        type: "string",
        description: "Category key; mints the task id"
      },
      checklist: CHECKLIST,
      column: {
        type: "string",
        description: "Lane key; defaults to the board's start lane"
      },
      parent_id: { type: "string" },
      priority: PRIORITY,
      streams: STREAMS,
      tags: { type: "string[]" },
      type: { type: "string", enum: ["epic", "issue", "task"] },
      assignees: ASSIGNEES
    },
    required: ["board_id", "title"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const checklist = args.checklist ?? [];
      const streams = args.streams;
      checkStreamPlan(streams, checklist);
      let parentId = str2(args.parent_id);
      if (parentId)
        parentId = cardOf(store, board, parentId).id;
      const item = store.createWorkItem(board.id, {
        title: String(args.title),
        body: str2(args.body),
        categoryKey: str2(args.category),
        checklist,
        columnKey: str2(args.column) ?? startColumn(board),
        parentId,
        priority: str2(args.priority),
        streams,
        tags: args.tags,
        type: str2(args.type)
      });
      return {
        item,
        next: "Offer to review the new card with the user here (review_card)."
      };
    }
  },
  {
    name: "update_review",
    description: "Patch a card's title, body, priority, tags, assignees, category or streams. Omitted fields are left alone; `tags`, `assignees` and `streams` replace what is there (`streams: []` clears the plan). Streams are checked against the checklist: each needs a verify item tagged with its key (tag them in the same call with `checklist_streams`). Use set_status to move between lanes.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      card: CARD,
      title: { type: "string" },
      body: { type: "string" },
      category: {
        type: "string",
        description: "Setting this on a card with no task id yet mints one"
      },
      priority: PRIORITY,
      tags: { type: "string[]", description: "Replaces the card's tags" },
      assignees: ASSIGNEES,
      streams: STREAMS,
      checklist_streams: {
        type: "string-map",
        description: 'Verify item key → stream key (null removes the tag), e.g. { "V3": "W1", "V4": null }'
      },
      expected_revision: {
        type: "integer",
        description: "Refuse unless the card is still at this revision"
      }
    },
    required: ["board_id", "card"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const current = cardOf(store, board, args.card);
      if (typeof args.expected_revision === "number" && args.expected_revision !== current.revision)
        fail("conflict", `card is at revision ${current.revision}, not ${args.expected_revision}`);
      const retag = args.checklist_streams;
      let checklist;
      if (retag && Object.keys(retag).length > 0) {
        const keys = new Set(current.checklist.map((item2) => item2.key));
        const unknown = Object.keys(retag).filter((key) => !keys.has(key));
        if (unknown.length > 0)
          fail("not_found", `checklist item ${unknown.join(", ")} not found`);
        checklist = asInput(current.checklist).map((item2) => item2.key && (item2.key in retag) ? { ...item2, stream: retag[item2.key] ?? null } : item2);
      }
      const streams = args.streams;
      if (streams)
        checkStreamPlan(streams, checklist ?? asInput(current.checklist));
      const item = store.updateWorkItem(current.id, {
        title: str2(args.title),
        body: str2(args.body),
        categoryKey: str2(args.category),
        priority: str2(args.priority),
        tags: args.tags,
        streams,
        checklist
      }, { workspace: board.id, ifRevision: current.revision });
      return { item };
    }
  },
  {
    name: "toggle_item",
    description: "Tick or untick one checklist box on a card, and optionally leave a note under it, or tag a verify item with the stream it proves. `key` is the item's stable id, e.g. D1 or V3.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      card: CARD,
      key: { type: "string", description: "Checklist item key, e.g. D1 or V3" },
      checked: {
        type: "boolean",
        description: "Omit to leave the tick alone"
      },
      note: { type: "string", description: "Empty string clears it" },
      stream: {
        type: "nullable-string",
        description: "Verify items only; null removes the tag"
      },
      text: {
        type: "string",
        description: "Reword the item, keeping its key and tick"
      }
    },
    required: ["board_id", "card", "key"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const patch = {};
      if (typeof args.checked === "boolean")
        patch.checked = args.checked;
      if (typeof args.note === "string")
        patch.note = args.note;
      if (typeof args.text === "string")
        patch.text = args.text;
      if (args.stream !== undefined)
        patch.stream = args.stream;
      const item = store.toggleChecklistItem(String(args.card), String(args.key), patch, { workspace: board.id });
      return { item, ...decisionState(item.checklist) };
    }
  },
  {
    name: "review_card",
    description: "Write the user's review of a card's checklist in one call. ONLY with picks the user just made. Ticking one option of a pick-ONE group unticks the others; boxes not named are left as they are. Free text goes in `note`. Returns `ready: true` once every decision is settled; it does not move the card.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      card: CARD,
      picks: {
        type: "object[]",
        minItems: 1,
        properties: {
          key: { type: "string" },
          checked: { type: "boolean" },
          note: { type: "string" }
        },
        required: ["key", "checked"]
      },
      revision: {
        type: "integer",
        description: "Refused if the card's revision changed since"
      }
    },
    required: ["board_id", "card", "picks"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const current = cardOf(store, board, args.card);
      const picks = args.picks;
      const items = asInput(current.checklist);
      const byKey = new Map(items.map((item2) => [item2.key, item2]));
      const missing = picks.filter((pick) => !byKey.has(pick.key));
      if (missing.length > 0)
        fail("not_found", `checklist item ${missing.map((pick) => pick.key).join(", ")} not found`);
      const tickedGroups = new Map;
      for (const pick of picks) {
        const item2 = byKey.get(pick.key);
        item2.checked = pick.checked;
        if (pick.note !== undefined)
          item2.note = pick.note || null;
        if (pick.checked && item2.group) {
          const other = tickedGroups.get(item2.group);
          if (other)
            fail("invalid", `${other} and ${pick.key} are options of the same pick-ONE group "${item2.group}"; pick one`);
          tickedGroups.set(item2.group, pick.key);
        }
      }
      for (const [group, key] of tickedGroups)
        for (const item2 of items)
          if (item2.group === group && item2.key !== key)
            item2.checked = false;
      const item = store.updateWorkItem(current.id, { checklist: items }, {
        workspace: board.id,
        ifRevision: typeof args.revision === "number" ? args.revision : current.revision
      });
      const state = decisionState(item.checklist);
      return {
        ...state,
        revision: item.revision,
        checklist: item.checklist,
        next: state.ready ? "Every decision is settled. Move the card with set_status when work starts." : "Some decisions are still open; work does not start until ready is true."
      };
    }
  },
  {
    name: "set_status",
    description: "Move a card to another lane, the board's status columns. Moving it to a done or archive lane clears its checkpoints.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      card: CARD,
      status: {
        type: "string",
        description: "Lane key, e.g. todo | processing | done | dropped"
      }
    },
    required: ["board_id", "card", "status"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const item = store.setStatus(String(args.card), String(args.status), {
        workspace: board.id
      });
      return { item: brief(item) };
    }
  },
  {
    name: "delete_review",
    description: "Take a card off the board. This ARCHIVES it: the card and its history stay in the database and can be restored. Nothing here deletes rows.",
    readOnly: false,
    properties: { board_id: BOARD_ID, card: CARD },
    required: ["board_id", "card"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const item = store.deleteWorkItem(String(args.card), {
        workspace: board.id
      });
      return { archived: item.id, item: brief(item) };
    }
  },
  {
    name: "checkpoint",
    description: "Record where you stopped on a card so another agent can resume it. Call after each checklist item you finish, and before you stop mid-task. `get_review` returns the latest checkpoint. Summarise; never paste transcripts, secrets, tokens or .env values. Refused on a finished or archived card.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      card: CARD,
      summary: { type: "string" },
      request: { type: "string" },
      next_step: { type: "string" },
      files: { type: "string[]" },
      commands: {
        type: "object[]",
        properties: {
          command: { type: "string" },
          ok: { type: "boolean" }
        },
        required: ["command"]
      },
      git: {
        type: "object",
        properties: {
          branch: { type: "string" },
          head: { type: "string" },
          wip_ref: { type: "string" },
          wip_sha: { type: "string" }
        }
      }
    },
    required: ["board_id", "card", "summary"],
    run(args, { store, agent, host }) {
      const board = boardOf(store, args.board_id);
      const git = args.git;
      const request = {
        summary: String(args.summary),
        request: str2(args.request) ?? null,
        nextStep: str2(args.next_step) ?? null,
        files: args.files,
        commands: args.commands,
        host,
        git: git ? {
          branch: git.branch ?? null,
          head: git.head ?? null,
          wipRef: git.wip_ref ?? null,
          wipSha: git.wip_sha ?? null
        } : null
      };
      const checkpoint = store.addCheckpoint(String(args.card), request, {
        workspace: board.id,
        agent
      });
      return { checkpoint };
    }
  },
  {
    name: "lifecycle_status",
    description: "What the board is waiting on: cards whose decisions are not all ticked (waiting), cards cleared to start (ready), and cards being worked (in flight).",
    readOnly: true,
    properties: { board_id: BOARD_ID },
    required: ["board_id"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const order = columnOrder(board);
      const waiting = [];
      const ready = [];
      const inFlight = [];
      for (const card of store.listWorkItems(board.id)) {
        const role = order.get(card.columnKey)?.role ?? null;
        if (role === "done" || role === "archive")
          continue;
        const detail = store.getWorkItem(card.id);
        const state = decisionState(detail.checklist);
        if (role === "active") {
          const verify = detail.checklist.filter((item) => item.section === "verify");
          inFlight.push({
            ...brief(detail),
            verified: `${verify.filter((item) => item.checked).length}/${verify.length}`
          });
        } else if (state.ready)
          ready.push(brief(detail));
        else
          waiting.push({ ...brief(detail), pending: state.pending });
      }
      return { waiting, ready, inFlight };
    }
  }
];

// apps/desktop/electron/mcp-local/server.ts
var SERVER_NAME = "lanework";
var SERVER_VERSION = "0.1.0";
var LATEST_PROTOCOL_VERSION = "2025-06-18";
var KNOWN_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25"
];
var INSTRUCTIONS = [
  "lanework is a Kanban board for AI-driven development. A card is a review checklist: decisions to approve, then verify steps to prove. This server is the OFFLINE board: it lives in a SQLite file on this machine, has no accounts, and the Lanework app shows what you write here.",
  "Every tool needs a board_id and there is no default. To find it, run `git remote get-url origin` and call list_boards({ repo }) with the output as is. Exactly one board: use it. None: call list_boards without repo and ask the user which board this repo belongs to — the boards you can see, PLUS an option to create a new board for this repo (suggest `owner/name` from the remote as its name). Then link_repo the one they picked, or create_board if they chose a new one; never create a board they did not ask for. A board links to ONE repo: linking a board that already has another repo MOVES it (replace), it never adds a second. Several: ask the user. No git remote: ask the user. Never pick a board by its name.",
  "Before creating a card, read board_summary so its category and tags match the vocabulary the board already uses; the category is also what mints the card's permanent task id. After create_review, offer to review the new card right here.",
  "While working a card, call checkpoint after each checklist item you finish and before you stop mid-task. Asked to resume a card: get_review it and read its checkpoint. If checkpoint.git.wipRef is set AND you are not in the checkout it came from (checkpoint.host is another machine, or this is a fresh clone), check out checkpoint.git.head, then `git fetch origin <wipRef> && git cherry-pick --no-commit FETCH_HEAD && git reset` to restore the uncommitted work; in the same checkout that work is already on disk, so skip it. Re-run every check it claims passed, then continue from nextStep (or the summary).",
  "A card with streams comes back from get_review with `dispatch: { waves, briefs }`, and you are its lead. Run it wave by wave: spawn every stream of a wave at once, one sub-agent per stream, each in its own git worktree from the current HEAD (in the shared checkout when its isolation is shared), and hand each one `dispatch.briefs[key]` verbatim. No sub-agents? Run the streams yourself, one by one, in wave order. Sub-agents never call Lanework and never commit. After each wave, merge each worktree into the main checkout, revert anything outside the stream's `owns`, re-run the stream's checks, tick its verify items, and call checkpoint once for the wave. After the last wave, run the untagged verify items. On resume, re-dispatch only the streams whose verify items are not all ticked. A card without streams (dispatch: null) works as before: one agent, end to end.",
  "To review a card with the user in the CLI: get_review it, then ask the user with your option picker (AskUserQuestion) if you have one. Each pick-ONE group (boxes sharing a `group`) is one single-select question, its options the group's boxes, the one marked (Recommended) first. Gather the ungrouped decisions into multi-select questions of up to 4 boxes each. At most 4 questions per turn — ask again for the rest. A group with more than 4 options cannot fit: say so and send the user to the app for that group. Then call review_card ONCE with exactly what the user picked: a picked box checked: true, an offered but unpicked ungrouped box checked: false, and anything they typed under Other as that box's note. Never tick a decision the user did not pick; only a plain instruction in chat (e.g. 'tick the recommended ones') stands in for the picker. review_card does not move the card, and work starts only once it answers ready: true."
].join(`

`);
var PARSE_ERROR = -32700;
var INVALID_REQUEST = -32600;
var METHOD_NOT_FOUND = -32601;
var INVALID_PARAMS = -32602;
function agentSlug(clientName) {
  const name = typeof clientName === "string" ? clientName.toLowerCase() : "";
  if (name.includes("codex"))
    return "codex";
  if (name.includes("claude"))
    return "claude-code";
  const slug = name.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 40) || "agent";
}
function toolList() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: shapeSchema(tool),
    annotations: {
      readOnlyHint: tool.readOnly,
      destructiveHint: tool.name === "delete_review",
      openWorldHint: false
    }
  }));
}
function text(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...isError ? { isError: true } : {}
  };
}

class LocalMcpSession {
  store;
  #agent = "agent";
  #host = import_node_os3.hostname();
  constructor(store) {
    this.store = store;
  }
  handle(message) {
    if (typeof message !== "object" || message === null || Array.isArray(message))
      return this.#error(null, INVALID_REQUEST, "not a JSON-RPC request");
    const { id, method, params } = message;
    const isNotification = id === undefined;
    if (typeof method !== "string")
      return isNotification ? null : this.#error(id ?? null, INVALID_REQUEST, "missing method");
    if (isNotification)
      return null;
    try {
      return { jsonrpc: "2.0", id, result: this.#dispatch(method, params) };
    } catch (error) {
      if (error instanceof RpcError)
        return this.#error(id, error.code, error.message);
      throw error;
    }
  }
  #error(id, code, message) {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }
  #dispatch(method, params) {
    const args = params ?? {};
    switch (method) {
      case "initialize": {
        const asked = typeof args.protocolVersion === "string" ? args.protocolVersion : "";
        const client = args.clientInfo;
        this.#agent = agentSlug(client?.name);
        return {
          protocolVersion: KNOWN_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: toolList() };
      case "tools/call":
        return this.#call(args);
      case "resources/list":
        return { resources: [] };
      case "prompts/list":
        return { prompts: [] };
      default:
        throw new RpcError(METHOD_NOT_FOUND, `unknown method ${method}`);
    }
  }
  #call(params) {
    const tool = TOOLS.find((entry) => entry.name === params.name);
    if (!tool)
      throw new RpcError(INVALID_PARAMS, `unknown tool ${String(params.name)}`);
    const ctx = {
      store: this.store,
      agent: this.#agent,
      host: this.#host
    };
    try {
      return text(tool.run(checkShape(tool, params.arguments), ctx));
    } catch (error) {
      if (error instanceof LocalStoreError)
        return text({ error: error.code, message: error.message }, true);
      if (error instanceof InvalidParams)
        return text({ error: "invalid", message: error.message }, true);
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`lanework mcp: ${tool.name} failed: ${message}
`);
      return text({ error: "internal", message }, true);
    }
  }
}

class RpcError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function handleLine(session, line) {
  if (!line.trim())
    return [];
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: PARSE_ERROR, message: "parse error" }
      })
    ];
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((message) => session.handle(message)).filter((answer2) => answer2 !== null);
    return answers.length > 0 ? [JSON.stringify(answers)] : [];
  }
  const answer = session.handle(parsed);
  return answer ? [JSON.stringify(answer)] : [];
}
function runLocalMcpServer(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  return new Promise((resolve) => {
    const store = openLocalStore({
      path: options.path,
      busyTimeoutMs: options.busyTimeoutMs
    });
    const session = new LocalMcpSession(store);
    let buffer = "";
    const flush = (final) => {
      let index = buffer.indexOf(`
`);
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        respond(line);
        index = buffer.indexOf(`
`);
      }
      if (final && buffer.trim()) {
        respond(buffer);
        buffer = "";
      }
    };
    const respond = (line) => {
      try {
        for (const out of handleLine(session, line))
          output.write(`${out}
`);
      } catch (error) {
        process.stderr.write(`lanework mcp: ${error instanceof Error ? error.stack : String(error)}
`);
      }
    };
    let done = false;
    const finish = () => {
      if (done)
        return;
      done = true;
      flush(true);
      store.close();
      resolve();
    };
    input.setEncoding?.("utf8");
    input.on("data", (chunk) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      flush(false);
    });
    input.once("end", finish);
    input.once("close", finish);
  });
}
// apps/desktop/electron/hook/credential.ts
var import_node_child_process = require("node:child_process");
var import_node_fs2 = require("node:fs");
var import_node_os4 = require("node:os");
var import_node_path4 = require("node:path");
var KEYCHAIN_SERVICE = "dev.lanework.checkpoint-hook";
function configDir() {
  return import_node_path4.join(process.env.XDG_CONFIG_HOME || import_node_path4.join(import_node_os4.homedir(), ".config"), "lanework");
}
function secretFile() {
  if (process.env.LANEWORK_HOOK_SECRET_FILE)
    return process.env.LANEWORK_HOOK_SECRET_FILE;
  return process.platform === "darwin" ? null : import_node_path4.join(configDir(), "credential");
}
function credentialLocation() {
  return secretFile() ?? `macOS Keychain (${KEYCHAIN_SERVICE})`;
}
function readSecret(api) {
  const file = secretFile();
  if (file) {
    try {
      return import_node_fs2.readFileSync(file, "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  try {
    return import_node_child_process.execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", api, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
function writeSecret(api, secret) {
  const file = secretFile();
  if (file) {
    import_node_fs2.mkdirSync(import_node_path4.dirname(file), { recursive: true, mode: 448 });
    import_node_fs2.writeFileSync(file, `${secret}
`, { mode: 384 });
    import_node_fs2.chmodSync(file, 384);
    return;
  }
  import_node_child_process.execFileSync("security", ["-i"], {
    input: `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${api}" -w "${secret}"
`,
    stdio: ["pipe", "ignore", "inherit"]
  });
}
function deleteSecret(api) {
  const file = secretFile();
  if (file) {
    import_node_fs2.rmSync(file, { force: true });
    return;
  }
  try {
    import_node_child_process.execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", api], { stdio: "ignore" });
  } catch {}
}

// apps/desktop/electron/hook/cli.ts
var pluginConfigPath = () => import_node_path5.join(configDir(), "hook.json");
function readConfig() {
  try {
    return JSON.parse(import_node_fs3.readFileSync(pluginConfigPath(), "utf8"));
  } catch {
    return {};
  }
}
function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!opener)
    return false;
  try {
    import_node_child_process2.spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}
var headless = () => process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
async function loginLoopback(api) {
  const { verifier, challenge } = pkcePair();
  const state = newState();
  const code = await listenForCallback({
    state,
    onPort: async (port) => {
      const started = await startLoopback(api, {
        challenge,
        state,
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        facts: machineFacts()
      });
      const opened = openBrowser(started.authorizeUrl);
      console.log(opened ? "Opened your browser — approve this machine there." : `Open this link and approve this machine:
  ${started.authorizeUrl}`);
    }
  });
  const outcome = await redeem(api, { code }, verifier);
  if (outcome.state !== "issued")
    throw new Error(`Sign-in was not completed (${outcome.state}).`);
  return outcome;
}
var DEVICE_TTL_MS = 10 * 60 * 1000;
function outcome() {
  return desktopHookInstalled() ? "The desktop app's hook is the one that runs on this machine, so this plugin's hook stays quiet and keeps not using this credential." : process.env.LANEWORK_HOOK_SECRET_FILE ? "The hook uses this credential only if LANEWORK_HOOK_SECRET_FILE is also set where Claude Code runs; otherwise it keeps using its usual one." : "Claude Code will now leave a checkpoint on the card after every turn.";
}
function save(api, issued) {
  writeSecret(api, issued.secret);
  if (readSecret(api) !== issued.secret)
    throw new Error("Signed in, but the credential could not be read back.");
  return `Signed in as machine ${issued.machineId}. Saved to ${credentialLocation()}.
${outcome()}`;
}
async function startDeviceLogin(api, stateDir) {
  const { verifier, challenge } = pkcePair();
  const started = await startDevice(api, { challenge, facts: machineFacts() });
  import_node_fs3.mkdirSync(stateDir, { recursive: true, mode: 448 });
  const file = import_node_path5.join(stateDir, `device-${process.pid}-${Date.now()}.json`);
  const pending = {
    api,
    deviceCode: started.deviceCode,
    verifier,
    interval: started.interval,
    deadline: Date.now() + DEVICE_TTL_MS
  };
  import_node_fs3.writeFileSync(file, JSON.stringify(pending), { mode: 384 });
  import_node_child_process2.spawn(process.execPath, [process.argv[1] ?? "", "--plugin", "login-wait", file], { detached: true, stdio: "ignore" }).unref();
  console.log([
    `On any device, open ${started.verificationUri} and enter the code:`,
    "",
    `    ${started.userCode}`,
    "",
    "Signing in finishes by itself once you approve (the code lasts 10 minutes).",
    "Then check with: lanework status"
  ].join(`
`));
}
async function waitForDeviceLogin(file, stateDir) {
  const note = (line) => {
    try {
      import_node_fs3.mkdirSync(stateDir, { recursive: true, mode: 448 });
      import_node_fs3.appendFileSync(import_node_path5.join(stateDir, "hook.log"), `${new Date().toISOString()} device sign-in: ${line}
`);
    } catch {}
  };
  let pending;
  try {
    pending = JSON.parse(import_node_fs3.readFileSync(file, "utf8"));
  } finally {
    import_node_fs3.rmSync(file, { force: true });
  }
  let interval = pending.interval;
  while (Date.now() < pending.deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    const result = await redeem(pending.api, { deviceCode: pending.deviceCode }, pending.verifier).catch((error) => {
      note(`failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (!result)
      return;
    if (result.state === "issued") {
      note(save(pending.api, result).split(`
`)[0] ?? "signed in");
      return;
    }
    if (result.state === "slow_down")
      interval += 5;
    else if (result.state === "denied")
      return note("denied");
    else if (result.state === "expired")
      return note("the code expired");
  }
  note("the code expired before it was approved");
}
async function login(api, device, force, stateDir) {
  if (!force && desktopHookInstalled()) {
    console.log("The Lanework desktop app already signed this machine in and runs the hook (Settings → Harness). Nothing to do.\nUse `lanework login --force` to sign in separately anyway.");
    return;
  }
  if (device || headless())
    return startDeviceLogin(api, stateDir);
  console.log(save(api, await loginLoopback(api)));
}
async function logout(api) {
  const secret = readSecret(api);
  if (!secret) {
    console.log("Not signed in.");
    return;
  }
  const revoked = await fetch(`${api}${paths.machinesMe()}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(5000)
  }).then((res) => res.ok).catch(() => false);
  deleteSecret(api);
  console.log(revoked ? "Signed out and revoked this machine." : `Signed out here. The control plane could not be reached — revoke this machine at ${api}/setup.`);
}
async function status(api, stateDir, desktopHook) {
  const secret = readSecret(api);
  let signedIn = "no — run `lanework login`";
  if (secret) {
    const res = await fetch(`${api}${paths.machinesMe()}`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5000)
    }).catch(() => null);
    signedIn = !res ? "yes (control plane unreachable, not verified)" : res.ok ? "yes" : res.status === 401 ? "no — this machine was revoked; run `lanework login`" : `unknown (HTTP ${res.status})`;
  }
  let last = "none yet";
  try {
    let best = null;
    for (const name of import_node_fs3.readdirSync(stateDir)) {
      if (!name.startsWith("session-"))
        continue;
      const s = JSON.parse(import_node_fs3.readFileSync(import_node_path5.join(stateDir, name), "utf8"));
      if (typeof s.at === "number" && s.taskId && (!best || s.at > best.at))
        best = { at: s.at, taskId: s.taskId };
    }
    if (best)
      last = `${best.taskId} at ${new Date(best.at).toLocaleString()}`;
  } catch {}
  console.log([
    `API:              ${api}`,
    `Signed in:        ${signedIn}`,
    `Credential:       ${credentialLocation()}`,
    `Push unfinished:  ${readConfig().pushWip ? "on" : "off"} (lanework config push-wip on|off)`,
    `Last checkpoint:  ${last}`,
    ...desktopHook ? [
      "Desktop app:      its hook is installed, so this plugin's hook stays quiet (one checkpoint per turn)"
    ] : [],
    `Log:              ${import_node_path5.join(stateDir, "hook.log")}`
  ].join(`
`));
}
function config(key, value) {
  if (key !== "push-wip" || value !== "on" && value !== "off") {
    console.error("usage: lanework config push-wip on|off");
    process.exitCode = 1;
    return;
  }
  const next = { ...readConfig(), pushWip: value === "on" };
  import_node_fs3.mkdirSync(configDir(), { recursive: true, mode: 448 });
  import_node_fs3.writeFileSync(pluginConfigPath(), `${JSON.stringify(next, null, 2)}
`, {
    mode: 384
  });
  console.log(value === "on" ? "The hook will also push uncommitted work to refs/lanework/wip/<task id>." : "The hook will not push code.");
}
function desktopHookInstalled() {
  const settings = import_node_path5.join(process.env.CLAUDE_CONFIG_DIR || import_node_path5.join(import_node_os5.homedir(), ".claude"), "settings.json");
  if (!import_node_fs3.existsSync(settings))
    return false;
  try {
    return import_node_fs3.readFileSync(settings, "utf8").includes("lanework-checkpoint");
  } catch {
    return false;
  }
}
function mcp() {
  return runLocalMcpServer();
}

// apps/desktop/electron/hook/local-board.ts
var import_node_fs4 = require("node:fs");
function localBoardFor(remote, path = localStorePath()) {
  if (!import_node_fs4.existsSync(path))
    return null;
  const store = openLocalStore({ path });
  try {
    const boards2 = store.findWorkspacesByRepo(remote).filter((workspace) => !workspace.cloudId);
    const board = boards2.length === 1 ? boards2[0] : undefined;
    if (!board) {
      store.close();
      return null;
    }
    return { store, workspaceId: board.id };
  } catch (error) {
    store.close();
    throw error;
  }
}
function writeLocalCheckpoint(board, taskId, body, agent) {
  return board.store.addCheckpoint(taskId, body, {
    workspace: board.workspaceId,
    agent
  }).id;
}

// apps/desktop/electron/hook/lanework-checkpoint.ts
function parseArgs(argv) {
  const flags = new Map;
  const positional = [];
  for (let i = 0;i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
    } else if (arg === "--api" || arg === "--agent") {
      flags.set(arg.slice(2), argv[++i] ?? "");
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return { flags, positional };
}
var ARGS = parseArgs(process.argv.slice(2));
var API = ((typeof ARGS.flags.get("api") === "string" ? ARGS.flags.get("api") : "") || process.env.LANEWORK_API_URL || DEFAULT_API_ORIGIN).replace(/\/$/, "");
function hookConfig() {
  const file = process.env.LANEWORK_HOOK_CONFIG || (ARGS.flags.has("plugin") ? pluginConfigPath() : null);
  if (!file)
    return {};
  try {
    return JSON.parse(import_node_fs5.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
var PUSH_WIP = ARGS.flags.has("push-wip") || hookConfig().pushWip === true;
var AGENT = ARGS.flags.get("agent") === "codex" ? "codex" : "claude-code";
var AGENT_NAME = AGENT === "codex" ? "Codex" : "Claude Code";
var STATE_DIR = import_node_path6.join(import_node_os6.homedir(), ".cache", "lanework", "checkpoint");
var LOG = import_node_path6.join(STATE_DIR, "hook.log");
var THIN_MS = 60000;
var PUSH_TIMEOUT_MS = 30000;
var HTTP_TIMEOUT_MS = 1e4;
function log(message) {
  try {
    import_node_fs5.mkdirSync(STATE_DIR, { recursive: true, mode: 448 });
    if (import_node_fs5.existsSync(LOG) && import_node_fs5.statSync(LOG).size > 512 * 1024)
      import_node_fs5.rmSync(LOG);
    import_node_fs5.appendFileSync(LOG, `${new Date().toISOString()} ${message}
`);
  } catch {}
}
function git(cwd, args, env) {
  return import_node_child_process3.execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PUSH_TIMEOUT_MS
  }).trim();
}
function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}
var sha256 = (s) => import_node_crypto3.createHash("sha256").update(s).digest("hex");
function clip2(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
function readJson(file, fallback) {
  try {
    return JSON.parse(import_node_fs5.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  import_node_fs5.mkdirSync(STATE_DIR, { recursive: true, mode: 448 });
  import_node_fs5.writeFileSync(file, JSON.stringify(value), { mode: 384 });
}
function redact(input) {
  return input.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED private key]").replace(/\blw_(?:reg|mch|dev|code)_[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, "[REDACTED]").replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[REDACTED]").replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]").replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED]").replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]").replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "[REDACTED]").replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED jwt]").replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]").replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@").replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|secret|passw(?:or)?d|token|credential|private[_-]?key)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1$2[REDACTED]");
}
function humanText(content) {
  const raw = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join(`
`) : "";
  const text2 = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text2 || text2.startsWith("<"))
    return null;
  return text2;
}
function resultText(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    return content.map((b) => typeof b?.text === "string" ? b.text : "").join(`
`);
  }
  return "";
}
var TASK_ID = /\b[A-Z]{2,5}-\d{1,5}\b/g;
var NOT_TASK_ID = /^(?:UTF|SHA|ISO|RFC|HTTP|TLS|CVE|MD|AES|RSA|ES|ECMA)-/;
function digest(transcript, root) {
  const lines = [];
  for (const raw of transcript.split(`
`)) {
    if (!raw.trim())
      continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {}
  }
  let mcpTaskId = null;
  let typedTaskId = null;
  let request = null;
  let replies = [];
  let previousReplies = [];
  const uses = new Map;
  const failed = new Map;
  const files = [];
  const commandIds = [];
  for (const line of lines) {
    if (line.isSidechain)
      continue;
    const content = line.message?.content;
    if (line.type === "user") {
      const typed = humanText(content);
      if (typed) {
        request = typed;
        if (replies.length)
          previousReplies = replies;
        replies = [];
        for (const m of typed.match(TASK_ID) ?? []) {
          if (!NOT_TASK_ID.test(m))
            typedTaskId = m;
        }
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type !== "tool_result" || !b.tool_use_id)
            continue;
          failed.set(b.tool_use_id, b.is_error === true);
          const use = uses.get(b.tool_use_id);
          if (use?.name.startsWith("mcp__lanework__")) {
            const minted = /"taskId":\s*"([^"]+)"/.exec(resultText(b.content));
            if (minted?.[1] && use.name.endsWith("create_review")) {
              mcpTaskId = minted[1];
            }
          }
        }
      }
    } else if (line.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "text" && b.text?.trim())
          replies.push(b.text.trim());
        if (b.type !== "tool_use" || !b.id || !b.name)
          continue;
        const input = b.input ?? {};
        uses.set(b.id, { name: b.name, input });
        if (b.name.startsWith("mcp__lanework__") && typeof input.card === "string") {
          mcpTaskId = input.card;
        }
        if (["Edit", "Write", "NotebookEdit"].includes(b.name)) {
          const path = input.file_path ?? input.notebook_path;
          if (typeof path === "string") {
            const rel = path.startsWith(root) ? import_node_path6.relative(root, path) : path;
            if (!rel.startsWith("..")) {
              const at = files.indexOf(rel);
              if (at !== -1)
                files.splice(at, 1);
              files.push(rel);
            }
          }
        }
        if (b.name === "Bash" && typeof input.command === "string") {
          commandIds.push(b.id);
        }
      }
    }
  }
  const commands = commandIds.slice(-15).map((id) => ({
    command: clip2(String(uses.get(id)?.input.command ?? "").split(`
`)[0] ?? "", 300),
    ok: failed.has(id) ? !failed.get(id) : null
  }));
  return {
    taskId: mcpTaskId ?? typedTaskId,
    request,
    lastReply: (replies.length ? replies : previousReplies).join(`

`) || null,
    replyIsPrevious: !replies.length && previousReplies.length > 0,
    files: files.slice(-100),
    commands
  };
}
var JS_STRING = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/.source;
var CARD_ARG = new RegExp(/["']?\bcard["']?\s*:\s*/.source + JS_STRING, "g");
var EXEC_CMD = new RegExp(/exec_command\(\s*\{\s*["']?cmd["']?\s*:\s*/.source + JS_STRING, "g");
var PATCH_FILE = /\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/g;
var LANEWORK_CALL = /lanework|\b(?:get_review|toggle_item|update_review|set_status|review_card|create_review|list_reviews)\b/;
function unquote(literal) {
  if (literal.startsWith('"')) {
    try {
      return JSON.parse(literal);
    } catch {
      return literal.slice(1, -1);
    }
  }
  return literal.slice(1, -1).replace(/\\(.)/g, "$1");
}
function findCodexRollout(sessionId) {
  if (!sessionId)
    return null;
  const base = import_node_path6.join(process.env.CODEX_HOME || import_node_path6.join(import_node_os6.homedir(), ".codex"), "sessions");
  const ls = (dir) => {
    try {
      return import_node_fs5.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  let days = 0;
  for (const year of ls(base))
    for (const month of ls(import_node_path6.join(base, year)))
      for (const day of ls(import_node_path6.join(base, year, month))) {
        if (++days > 3)
          return null;
        const dir = import_node_path6.join(base, year, month, day);
        const hit = ls(dir).find((name) => name.endsWith(`${sessionId}.jsonl`));
        if (hit)
          return import_node_path6.join(dir, hit);
      }
  return null;
}
var texts = (content) => (Array.isArray(content) ? content : []).map((part) => typeof part?.text === "string" ? part.text : "").join(`
`).trim();
function digestCodex(transcript, root, lastMessage) {
  let mcpTaskId = null;
  let typedTaskId = null;
  let request = null;
  let replies = [];
  let previousReplies = [];
  let structured = false;
  const files = [];
  const commands = [];
  let scriptTaskId = null;
  const scriptFiles = [];
  const scriptCommands = [];
  const calls = new Map;
  const touch = (list2, path) => {
    const trimmed = path.trim().replace(/^file:\/\//, "");
    const rel = trimmed.startsWith(root) ? import_node_path6.relative(root, trimmed) : trimmed;
    if (!rel || rel.startsWith(".."))
      return;
    const at = list2.indexOf(rel);
    if (at !== -1)
      list2.splice(at, 1);
    list2.push(rel);
  };
  const typed = (text2) => {
    if (!text2 || text2.startsWith("<") || text2.startsWith("# AGENTS.md"))
      return;
    request = text2;
    if (replies.length)
      previousReplies = replies;
    replies = [];
    for (const m of text2.match(TASK_ID) ?? [])
      if (!NOT_TASK_ID.test(m))
        typedTaskId = m;
  };
  for (const raw of transcript.split(`
`)) {
    if (!raw.trim())
      continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const p = line.payload ?? {};
    const item = p.type === "item_completed" ? p.item : undefined;
    if (item) {
      structured = true;
      if (item.type === "UserMessage")
        typed(texts(item.content));
      else if (item.type === "AgentMessage") {
        const text2 = texts(item.content);
        if (text2)
          replies.push(text2);
      } else if (item.type === "CommandExecution") {
        const argv = Array.isArray(item.command) ? item.command : [];
        const script = String(argv[argv.length - 1] ?? "");
        commands.push({
          command: clip2(script.split(`
`)[0] ?? "", 300),
          ok: typeof item.exit_code === "number" ? item.exit_code === 0 : null
        });
      } else if (item.type === "FileChange" && item.changes) {
        for (const path of Object.keys(item.changes))
          touch(files, path);
      } else if (item.type === "McpToolCall" && typeof item.server === "string" && item.server.includes("lanework")) {
        const args = item.arguments ?? {};
        if (typeof args.card === "string")
          mcpTaskId = args.card;
        if (item.tool === "create_review") {
          const minted = /\\?"taskId\\?"\s*:\s*\\?"([^"\\]+)/.exec(JSON.stringify(item.result ?? ""));
          if (minted?.[1])
            mcpTaskId = minted[1];
        }
      }
      continue;
    }
    if (line.type !== "response_item")
      continue;
    if (p.type === "message" && p.role === "user") {
      if (!structured)
        typed(texts(p.content));
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const source = typeof p.input === "string" ? p.input : typeof p.arguments === "string" ? p.arguments : "";
      const blob = `${p.name ?? ""}
${source}`;
      if (p.call_id)
        calls.set(p.call_id, blob);
      if (LANEWORK_CALL.test(blob))
        for (const m of blob.matchAll(CARD_ARG))
          scriptTaskId = unquote(m[1] ?? "");
      for (const m of blob.matchAll(PATCH_FILE))
        touch(scriptFiles, m[1] ?? "");
      for (const m of blob.matchAll(EXEC_CMD))
        scriptCommands.push({
          command: clip2(unquote(m[1] ?? "").split(`
`)[0] ?? "", 300),
          ok: null
        });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const call = p.call_id && calls.get(p.call_id) || "";
      if (!call.includes("create_review"))
        continue;
      const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
      const minted = /\\?"taskId\\?"\s*:\s*\\?"([^"\\]+)/.exec(out);
      if (minted?.[1])
        scriptTaskId = minted[1];
    }
  }
  const fromStdin = lastMessage?.trim() || null;
  const turn = replies.length ? replies : previousReplies;
  return {
    taskId: (structured ? mcpTaskId : scriptTaskId) ?? typedTaskId,
    request,
    lastReply: fromStdin ?? (turn.join(`

`) || null),
    replyIsPrevious: !fromStdin && !replies.length && previousReplies.length > 0,
    files: (structured ? files : scriptFiles).slice(-100),
    commands: (structured ? commands : scriptCommands).slice(-15)
  };
}
var readSecret2 = () => readSecret(API);
async function http(path, init = {}) {
  const { secret, ...rest } = init;
  return fetch(`${API}${path}`, {
    ...rest,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      [AGENT_HEADER]: AGENT,
      ...secret ? { Authorization: `Bearer ${secret}` } : {},
      ...rest.headers
    }
  });
}
async function boardFor(remote, secret) {
  const cacheFile = import_node_path6.join(STATE_DIR, "boards.json");
  const cache = readJson(cacheFile, {});
  if (cache[remote])
    return cache[remote];
  const res = await http(paths.boardsForRepo(remote), { secret });
  if (!res.ok) {
    log(`board lookup ${res.status} for ${remote}`);
    return null;
  }
  const { boards: boards2 } = await res.json();
  if (boards2.length !== 1) {
    log(`${boards2.length} boards linked to ${remote}; not guessing`);
    return null;
  }
  const id = boards2[0]?.workspaceId ?? null;
  if (id)
    writeJson(cacheFile, { ...cache, [remote]: id });
  return id;
}
function snapshot(root, taskId) {
  const index = import_node_path6.join(import_node_os6.tmpdir(), `lanework-wip-${process.pid}.index`);
  try {
    const env = { GIT_INDEX_FILE: index };
    git(root, ["read-tree", "HEAD"], env);
    git(root, ["add", "-A"], env);
    const tree = git(root, ["write-tree"], env);
    if (tree === git(root, ["rev-parse", "HEAD^{tree}"])) {
      return { wipRef: null, wipSha: null };
    }
    const sha = git(root, ["commit-tree", tree, "-p", "HEAD", "-m", `lanework wip ${taskId}`], {
      GIT_AUTHOR_NAME: "lanework checkpoint",
      GIT_AUTHOR_EMAIL: "checkpoint@lanework.dev",
      GIT_COMMITTER_NAME: "lanework checkpoint",
      GIT_COMMITTER_EMAIL: "checkpoint@lanework.dev"
    });
    const ref = `refs/lanework/wip/${taskId}`;
    try {
      git(root, [
        "push",
        "--quiet",
        "--force",
        "--no-verify",
        "origin",
        `${sha}:${ref}`
      ]);
      return { wipRef: ref, wipSha: sha };
    } catch (error) {
      log(`push of ${ref} failed: ${String(error)}`);
      return { wipRef: null, wipSha: sha };
    }
  } finally {
    import_node_fs5.rmSync(index, { force: true });
  }
}
function buildBody(d, extra) {
  const heading = d.replyIsPrevious ? `${AGENT_NAME}'s last message, from the turn BEFORE the request below (it stopped before replying to that one):` : `${AGENT_NAME}'s last message before it stopped:`;
  const summary = d.lastReply ? `${heading}

${clip2(redact(d.lastReply), 5000)}` : `${AGENT_NAME} stopped before writing any reply in this session.`;
  return {
    summary,
    request: d.request ? clip2(redact(d.request), 2000) : null,
    nextStep: null,
    files: d.files,
    commands: d.commands.map((c) => ({ ...c, command: redact(c.command) })),
    host: extra.host,
    session: extra.session,
    git: extra.git
  };
}
async function work(inputFile) {
  const input = readJson(inputFile, {});
  import_node_fs5.rmSync(inputFile, { force: true });
  if (!input.cwd)
    return;
  const transcriptPath = input.transcript_path || (AGENT === "codex" ? findCodexRollout(input.session_id) : null);
  if (!transcriptPath)
    return;
  const root = tryGit(input.cwd, ["rev-parse", "--show-toplevel"]);
  const remote = root && tryGit(root, ["remote", "get-url", "origin"]);
  if (!root || !remote)
    return;
  const transcript = import_node_fs5.readFileSync(transcriptPath, "utf8");
  const d = AGENT === "codex" ? digestCodex(transcript, root, input.last_assistant_message ?? null) : digest(transcript, root);
  if (!d.taskId) {
    log(`session ${input.session_id}: no card in the transcript; nothing sent`);
    return;
  }
  let local = null;
  try {
    local = localBoardFor(remote);
  } catch (error) {
    log(`local board unavailable: ${String(error)}`);
  }
  try {
    await checkpointTo(local, { ...d, taskId: d.taskId }, input, root, remote);
  } finally {
    local?.store.close();
  }
}
async function checkpointTo(local, d, input, root, remote) {
  const secret = local ? null : readSecret2();
  if (!local && !secret) {
    log("no credential; turn the hook on in the Lanework app (Settings → Harness)");
    return;
  }
  const head = tryGit(root, ["rev-parse", "HEAD"]);
  const status2 = tryGit(root, ["status", "--porcelain"]) ?? "";
  const diff = tryGit(root, ["diff", "HEAD"]) ?? "";
  const code = sha256([d.taskId, head, status2, sha256(diff)].join("\x00"));
  const stateFile = import_node_path6.join(STATE_DIR, `session-${sha256(input.session_id ?? "")}.json`);
  const last = readJson(stateFile, null);
  if (last && last.code === code && Date.now() - last.at < THIN_MS)
    return;
  const boardId = local ? null : await boardFor(remote, secret);
  if (!local && !boardId)
    return;
  const pushed = last?.pushedCode === code ? last.wip : null;
  const wip = PUSH_WIP ? pushed ?? snapshot(root, d.taskId) : { wipRef: null, wipSha: null };
  const body = buildBody(d, {
    host: import_node_os6.hostname(),
    session: input.session_id ?? null,
    git: {
      branch: tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      head,
      wipRef: wip.wipRef,
      wipSha: wip.wipSha,
      diffStat: clip2(tryGit(root, ["diff", "HEAD", "--stat"]) ?? "", 3000) || null
    }
  });
  if (local) {
    try {
      writeLocalCheckpoint(local, d.taskId, body, AGENT);
    } catch (error) {
      log(`local checkpoint for ${d.taskId}: ${String(error)}`);
      return;
    }
  } else {
    const res = await http(paths.itemCheckpoints(boardId, d.taskId), {
      method: "POST",
      secret,
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      log(`checkpoint for ${d.taskId}: ${res.status} ${clip2(await res.text(), 300)}`);
      return;
    }
  }
  const state = {
    at: Date.now(),
    code,
    pushedCode: wip.wipRef || !wip.wipSha ? code : null,
    wip,
    taskId: d.taskId
  };
  writeJson(stateFile, state);
}
async function setup(token) {
  if (!token?.startsWith(TOKEN_PREFIXES.registration)) {
    console.error(`usage: bun apps/desktop/electron/hook/lanework-checkpoint.ts setup <lw_reg_…>
` + `Mint the token at ${API}/setup ("Create registration token").`);
    process.exit(1);
  }
  const res = await http(paths.machinesRegister(), {
    method: "POST",
    body: JSON.stringify({
      token,
      name: `${import_node_os6.hostname()} · checkpoint hook`,
      hostname: import_node_os6.hostname(),
      os: import_node_os6.platform(),
      arch: import_node_os6.arch()
    })
  });
  if (!res.ok) {
    console.error(`registration failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const { machineId, secret } = await res.json();
  writeSecret(API, secret);
  if (readSecret2() !== secret) {
    console.error("the credential could not be read back");
    process.exit(1);
  }
  console.log(`enrolled as machine ${machineId}; credential saved to ${credentialLocation()}. Revoke it at ${API}/setup.`);
}
var SELF = process.argv[1] ?? "";
async function main() {
  const [mode, arg, value] = ARGS.positional;
  if (mode === "setup")
    return setup(arg);
  if (mode === "mcp") {
    try {
      await mcp();
    } catch (error) {
      process.stderr.write(`lanework mcp: ${error instanceof Error ? error.message : String(error)}
`);
      process.exitCode = 1;
    }
    return;
  }
  try {
    if (mode === "login")
      return await login(API, ARGS.flags.has("device"), ARGS.flags.has("force"), STATE_DIR);
    if (mode === "login-wait" && arg)
      return await waitForDeviceLogin(arg, STATE_DIR);
    if (mode === "logout")
      return await logout(API);
    if (mode === "status")
      return await status(API, STATE_DIR, desktopHookInstalled());
    if (mode === "config")
      return config(arg, value);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (mode === "worker" && arg) {
    try {
      await work(arg);
    } catch (error) {
      log(`worker failed: ${String(error)}`);
    }
    return;
  }
  if (ARGS.flags.has("plugin") && desktopHookInstalled())
    return;
  try {
    const stdin = import_node_fs5.readFileSync(0, "utf8");
    import_node_fs5.mkdirSync(STATE_DIR, { recursive: true, mode: 448 });
    const file = import_node_path6.join(STATE_DIR, `input-${process.pid}-${Date.now()}.json`);
    import_node_fs5.writeFileSync(file, stdin, { mode: 384 });
    const flags = process.argv.slice(2).filter((a) => !ARGS.positional.includes(a));
    import_node_child_process3.spawn(process.execPath, [SELF, ...flags, "worker", file], {
      detached: true,
      stdio: "ignore"
    }).unref();
  } catch (error) {
    log(`hook failed: ${String(error)}`);
  }
}
if (import_node_path6.basename(SELF).startsWith("lanework-checkpoint"))
  main();
