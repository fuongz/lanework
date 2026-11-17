var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
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
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
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
var __esm = (fn, res, err) => () => {
  if (fn)
    try {
      res = fn(fn = 0);
    } catch (e) {
      err = [e];
    }
  if (err)
    throw err[0];
  return res;
};
// packages/protocol/src/auth.ts
var LOOPBACK_CALLBACK_PATH = "/oauth/callback";

// packages/protocol/src/boards.ts
var WORK_ITEM_TYPES, PRIORITIES, CHECKLIST_SECTIONS, STREAM_ROLES, STREAM_ISOLATIONS;
var init_boards = __esm(() => {
  WORK_ITEM_TYPES = ["epic", "issue", "task"];
  PRIORITIES = ["low", "medium", "high"];
  CHECKLIST_SECTIONS = ["decisions", "verify"];
  STREAM_ROLES = ["research", "implement", "test"];
  STREAM_ISOLATIONS = ["worktree", "shared"];
});

// packages/protocol/src/checkpoints.ts
var CHECKPOINTS_KEPT = 5, CHECKPOINT_MAX_BYTES;
var init_checkpoints = __esm(() => {
  CHECKPOINT_MAX_BYTES = 16 * 1024;
});

// packages/protocol/src/common.ts
function isMachineSecret(value) {
  return typeof value === "string" && MACHINE_SECRET_PATTERN.test(value);
}
function stripUserinfo(remote) {
  const value = remote.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
    return value;
  try {
    const url = new URL(value);
    if (!url.username && !url.password)
      return value;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1");
  }
}
var DEFAULT_API_ORIGIN = "https://api.lanework.dev", AGENT_HEADER = "x-lanework-agent", TOKEN_PREFIXES, MACHINE_SECRET_PATTERN;
var init_common = __esm(() => {
  TOKEN_PREFIXES = {
    registration: "lw_reg_",
    machine: "lw_mch_",
    device: "lw_dev_",
    code: "lw_code_"
  };
  MACHINE_SECRET_PATTERN = new RegExp(`^${TOKEN_PREFIXES.machine}[A-Za-z0-9_-]{16,190}$`);
});

// packages/protocol/src/endpoints.ts
function seg(value) {
  if (value === "" || value === "." || value === "..")
    throw new Error(`Refusing the path segment ${JSON.stringify(value)}.`);
  return encodeURIComponent(value);
}
function withQuery(path, query) {
  const text = query === undefined ? "" : String(query);
  return text ? `${path}?${text}` : path;
}
var paths;
var init_endpoints = __esm(() => {
  init_common();
  paths = {
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
    boardsForRepo: (remote) => `/v1/boards?repo=${seg(stripUserinfo(remote))}`,
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
});
// packages/protocol/src/index.ts
var init_src = __esm(() => {
  init_boards();
  init_checkpoints();
  init_common();
  init_endpoints();
});

// apps/desktop/shared/conversation.ts
function mentionsAsNames(text) {
  return text.replace(MENTION, (whole, quoted, bare) => {
    const path = quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : bare;
    if (!path || !/[./]/.test(path))
      return whole;
    return path.replace(/\/+$/, "").split("/").pop() || path;
  });
}
var CLAUDE_MODELS, CODEX_MODELS, OPENCODE_MODELS, claudeList, codexList, opencodeList, everyModel, listeners, TOOL_TEXT_MAX, CONVERSATION_READ_MAX, PASTE_MAX, ACRONYMS, PREVIEW_HOSTS, MENTION;
var init_conversation = __esm(() => {
  CLAUDE_MODELS = [
    { id: "claude-opus-5-5", label: "Opus 5.5", agent: "claude" },
    { id: "claude-fable-5-2", label: "Fable 5.2", agent: "claude" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5", agent: "claude" },
    { id: "claude-haiku-5-5", label: "Haiku 5.5", agent: "claude" },
    { id: "claude-fable-5-1", label: "Fable 5.1", agent: "claude", legacy: true },
    { id: "claude-haiku-4-5", label: "Haiku 4.5", agent: "claude", legacy: true },
    { id: "claude-sonnet-5", label: "Sonnet 5", agent: "claude", legacy: true },
    { id: "claude-opus-5", label: "Opus 5", agent: "claude", legacy: true },
    { id: "claude-fable-5", label: "Fable 5", agent: "claude", legacy: true },
    { id: "claude-opus-4-8", label: "Opus 4.8", agent: "claude", legacy: true },
    { id: "claude-opus-4-7", label: "Opus 4.7", agent: "claude", legacy: true },
    { id: "claude-opus-4-6", label: "Opus 4.6", agent: "claude", legacy: true },
    {
      id: "claude-sonnet-4-6",
      label: "Sonnet 4.6",
      agent: "claude",
      legacy: true
    }
  ];
  CODEX_MODELS = [
    { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", agent: "codex" },
    { id: "gpt-6-astra", label: "GPT-6-Astra", agent: "codex" },
    { id: "gpt-6-sol", label: "GPT-6-Sol", agent: "codex" },
    { id: "gpt-6-luna", label: "GPT-6-Luna", agent: "codex" },
    { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", agent: "codex", legacy: true },
    { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", agent: "codex", legacy: true },
    { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", agent: "codex", legacy: true }
  ];
  OPENCODE_MODELS = [];
  claudeList = CLAUDE_MODELS;
  codexList = CODEX_MODELS;
  opencodeList = OPENCODE_MODELS;
  everyModel = [
    ...claudeList,
    ...codexList,
    ...opencodeList
  ];
  listeners = new Set;
  TOOL_TEXT_MAX = 16 * 1024;
  CONVERSATION_READ_MAX = 32 * 1024 * 1024;
  PASTE_MAX = 5 * 1024 * 1024;
  ACRONYMS = new Set([
    "ai",
    "api",
    "ci",
    "cli",
    "css",
    "html",
    "json",
    "mcp",
    "pr",
    "sdk",
    "ui",
    "url",
    "ux"
  ]);
  PREVIEW_HOSTS = new Set([
    "github.com",
    "www.github.com",
    "gist.github.com"
  ]);
  MENTION = /(?<=^|\s)@(?:"((?:[^"\\]|\\.)*)"|(\S+))/g;
});

// apps/desktop/shared/orchestration.ts
var CONTROL_INPUT_MAX, LOOPBACK_HOSTS;
var init_orchestration = __esm(() => {
  init_conversation();
  CONTROL_INPUT_MAX = 256 * 1024;
  LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
});

// apps/desktop/electron/main/paths.ts
function appHomeDir() {
  return process.env.LANEWORK_HOME || import_node_path.join(import_node_os.homedir(), homeName);
}
var import_node_os, import_node_path, APP_HOME_NAME = ".lanew", homeName;
var init_paths = __esm(() => {
  init_orchestration();
  import_node_os = require("node:os");
  import_node_path = require("node:path");
  homeName = APP_HOME_NAME;
});

// apps/desktop/electron/main/http-body.ts
async function readCappedBytes(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(maxBytes);
  }
  if (!response.body)
    return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;; ) {
    const { done, value } = await reader.read();
    if (done)
      break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
async function readCapped(response, maxBytes) {
  return new TextDecoder().decode(await readCappedBytes(response, maxBytes));
}
async function readCappedJson(response, maxBytes = JSON_BODY_CAP) {
  return JSON.parse(await readCapped(response, maxBytes));
}
var JSON_BODY_CAP, ICON_BODY_CAP, AUTH_BODY_CAP, PROBE_BODY_CAP, BodyTooLargeError;
var init_http_body = __esm(() => {
  JSON_BODY_CAP = 8 * 1024 * 1024;
  ICON_BODY_CAP = 1024 * 1024;
  AUTH_BODY_CAP = 64 * 1024;
  PROBE_BODY_CAP = 64 * 1024;
  BodyTooLargeError = class BodyTooLargeError extends Error {
    maxBytes;
    constructor(maxBytes) {
      super(`The response was larger than ${maxBytes} bytes.`);
      this.maxBytes = maxBytes;
      this.name = "BodyTooLargeError";
    }
  };
});

// apps/desktop/electron/main/auth/redirect.ts
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
function looksLikeUserCode(value) {
  if (typeof value !== "string" || value.length !== 9)
    return false;
  if (value[4] !== "-")
    return false;
  return [...value.replace("-", "")].every((c) => USER_CODE_ALPHABET.includes(c));
}
var CALLBACK_PATH, USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
var init_redirect = __esm(() => {
  init_src();
  CALLBACK_PATH = LOOPBACK_CALLBACK_PATH;
});

// apps/desktop/electron/main/auth/client.ts
function machineFacts(name) {
  const host = import_node_os2.hostname();
  return {
    name: (name || host || "desktop").slice(0, 120),
    hostname: host,
    os: process.platform,
    arch: process.arch
  };
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
  const data = await readCappedJson(res, AUTH_BODY_CAP).catch(() => ({}));
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
  const secret = isMachineSecret(data.secret) ? data.secret : null;
  if (ok && machineId && secret)
    return { state: "issued", machineId, secret };
  if (ok && machineId && data.secret !== undefined && !secret)
    throw new Error(`${api} issued a credential this app does not recognise. Nothing was stored; try signing in again.`);
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
var import_node_os2, LOOPBACK_HOSTS2, refusedApis, UnreachableError;
var init_client = __esm(() => {
  init_src();
  init_http_body();
  init_redirect();
  import_node_os2 = require("node:os");
  LOOPBACK_HOSTS2 = new Set(["127.0.0.1", "[::1]", "localhost"]);
  refusedApis = new Set;
  UnreachableError = class UnreachableError extends Error {
    constructor(api, cause) {
      super(`Could not reach the control plane at ${api} — check the network, or LANEWORK_API_URL. (${cause instanceof Error ? cause.message : String(cause)})`);
      this.name = "UnreachableError";
    }
  };
});

// apps/desktop/electron/main/auth/loopback.ts
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
var import_node_http, PORT_FROM = 8976, PORT_TO = 8986, WAIT_MS;
var init_loopback = __esm(() => {
  init_redirect();
  import_node_http = require("node:http");
  WAIT_MS = 10 * 60 * 1000;
});

// apps/desktop/electron/main/auth/pkce.ts
function pkcePair() {
  const verifier = import_node_crypto.randomBytes(32).toString("base64url");
  const challenge = import_node_crypto.createHash("sha256").update(verifier).digest().toString("base64url");
  return { verifier, challenge };
}
function newState() {
  return import_node_crypto.randomBytes(16).toString("base64url");
}
var import_node_crypto;
var init_pkce = __esm(() => {
  import_node_crypto = require("node:crypto");
});

// apps/desktop/electron/local-store/driver.ts
function sqliteDriverName() {
  return "Bun" in globalThis ? "bun:sqlite" : "node:sqlite";
}
function openRaw(path) {
  if (sqliteDriverName() === "bun:sqlite") {
    const load = import_node_module.createRequire(import_node_path4.join(process.cwd(), "noop.js"));
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
var import_node_module, import_node_path4;
var init_driver = __esm(() => {
  import_node_module = require("node:module");
  import_node_path4 = require("node:path");
});

// apps/desktop/electron/local-store/ids.ts
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
function isUuid(value) {
  return UUID.test(value);
}
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
var import_node_crypto2, UUID, RANK_WIDTH = 16, RANK_STEP = 1e6;
var init_ids = __esm(() => {
  import_node_crypto2 = require("node:crypto");
  UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
});

// apps/desktop/electron/local-store/schema.ts
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
var MIGRATIONS, SCHEMA_VERSION;
var init_schema = __esm(() => {
  MIGRATIONS = [
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
  `,
    `
  ALTER TABLE workspace RENAME TO projects;
  ALTER TABLE work_item RENAME TO project_issues;
  ALTER TABLE project_issues RENAME COLUMN workspace_id TO project_id;

  DROP INDEX workspace_slug_live;
  DROP INDEX workspace_repo;
  CREATE UNIQUE INDEX projects_slug_live ON projects(slug) WHERE deleted_at IS NULL;
  CREATE INDEX projects_repo ON projects(repo_url) WHERE deleted_at IS NULL;

  DROP INDEX work_item_task_id;
  DROP INDEX work_item_lane;
  DROP INDEX work_item_changes;
  DROP INDEX work_item_parent;
  CREATE UNIQUE INDEX project_issues_task_id ON project_issues(project_id, task_id) WHERE task_id IS NOT NULL;
  CREATE INDEX project_issues_lane ON project_issues(project_id, status, sort_key);
  CREATE INDEX project_issues_changes ON project_issues(project_id, change_seq);
  CREATE INDEX project_issues_parent ON project_issues(parent_id);
  `
  ];
  SCHEMA_VERSION = MIGRATIONS.length;
});

// apps/desktop/electron/main/projects/review-defaults.ts
var DEFAULT_COLUMNS, TASK_ID_FORMAT = "{prefix}-{seq}", TASK_ID_PAD = 2, DEFAULT_CATEGORIES, TAG_MAX = 3;
var init_review_defaults = __esm(() => {
  DEFAULT_COLUMNS = [
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
    {
      key: "review",
      name: "Review",
      role: "review",
      icon: "progress",
      tone: "teal"
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
  DEFAULT_CATEGORIES = [
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
});

// apps/desktop/electron/local-store/types.ts
var LocalStoreError;
var init_types = __esm(() => {
  LocalStoreError = class LocalStoreError extends Error {
    code;
    constructor(code, message) {
      super(message);
      this.name = "LocalStoreError";
      this.code = code;
    }
  };
});

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
function list(paths) {
  return paths.length > 0 ? paths.map((path) => `- \`${path}\``).join(`
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
function keepCheckpoints(list) {
  return list.slice(0, CHECKPOINTS_KEPT);
}
function latestCheckpoint(list) {
  const newest = list[0];
  if (!newest)
    return null;
  if (newest.nextStep)
    return { ...newest, nextStepFrom: null };
  const older = list.slice(1).find((entry) => entry.nextStep);
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
    workspaceId: row.project_id,
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
var CHECKLIST_TEXT_MAX = 2000;
var init_cards = __esm(() => {
  init_src();
  init_types();
});

// apps/desktop/electron/local-store/store.ts
function localStorePath() {
  return import_node_path5.join(appHomeDir(), DATA_FILE_NAME);
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
function toProject(row) {
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
  transaction(fn) {
    return this.#write(fn);
  }
  dataVersion() {
    const row = this.#get("SELECT value FROM meta WHERE key = 'change_seq'");
    return Number(row?.value ?? 0);
  }
  #now() {
    return new Date().toISOString();
  }
  listProjects(options = {}) {
    const rows = this.#all(options.includeDeleted ? "SELECT * FROM projects ORDER BY created_at, id" : "SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY created_at, id");
    return rows.map(toProject);
  }
  getProject(ref) {
    const row = this.#get("SELECT * FROM projects WHERE (id = ? OR slug = ?) AND deleted_at IS NULL", ref, ref);
    return row ? toProject(row) : null;
  }
  #project(ref) {
    return this.getProject(ref) ?? notFound(`project ${ref}`);
  }
  #uniqueSlug(base, except) {
    let slug = base;
    for (let n = 2;; n += 1) {
      const clash = this.#get("SELECT id FROM projects WHERE slug = ? AND deleted_at IS NULL", slug);
      if (!clash || clash.id === except)
        return slug;
      slug = `${base}-${n}`;
    }
  }
  createProject(input) {
    const name = input.name?.trim();
    if (!name)
      invalid2("a project needs a name");
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
      this.#run(`INSERT INTO projects (id, slug, name, repo_url, config, task_heads, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`, id, slug, name, repo, JSON.stringify(config), now, now);
      return this.#project(id);
    });
  }
  updateProject(ref, input) {
    return this.#write(() => {
      const current = this.#project(ref);
      const name = input.name === undefined ? current.name : input.name.trim();
      if (!name)
        invalid2("a project needs a name");
      const slug = input.slug === undefined ? current.slug : this.#uniqueSlug(slugify(input.slug), current.id);
      const config = input.config ? { ...current.config, ...input.config } : current.config;
      checkConfig(config);
      this.#run(`UPDATE projects SET name = ?, slug = ?, config = ?, cloud_id = ?, synced_at = ?, updated_at = ?
         WHERE id = ?`, name, slug, JSON.stringify(config), input.cloudId === undefined ? current.cloudId : input.cloudId, input.syncedAt === undefined ? current.syncedAt : input.syncedAt, this.#now(), current.id);
      return this.#project(current.id);
    });
  }
  deleteProject(ref) {
    this.#write(() => {
      const current = this.#project(ref);
      const now = this.#now();
      this.#run("UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?", now, now, current.id);
    });
  }
  #releaseRepo(repo, now) {
    this.#run("UPDATE projects SET repo_url = NULL, updated_at = ? WHERE repo_url = ? AND deleted_at IS NULL", now, repo);
  }
  linkRepo(ref, remote) {
    const repo = remote === null ? null : normalizeRepo(remote);
    if (remote !== null && !repo)
      invalid2(`not a git remote: ${remote}`);
    return this.#write(() => {
      const current = this.#project(ref);
      const now = this.#now();
      if (repo)
        this.#releaseRepo(repo, now);
      this.#run("UPDATE projects SET repo_url = ?, updated_at = ? WHERE id = ?", repo, now, current.id);
      return this.#project(current.id);
    });
  }
  findProjectsByRepo(remote) {
    const repo = normalizeRepo(remote);
    if (!repo)
      return [];
    return this.#all("SELECT * FROM projects WHERE repo_url = ? AND deleted_at IS NULL ORDER BY created_at, id", repo).map(toProject);
  }
  boardSummaries(remote) {
    const list = remote === undefined ? this.listProjects() : this.findProjectsByRepo(remote);
    const head = this.dataVersion();
    return list.map((project) => ({
      workspaceId: project.id,
      name: project.name,
      role: "owner",
      changeSeq: head,
      repo: project.repo
    }));
  }
  boardConfig(ref) {
    const project = this.#project(ref);
    return {
      workspaceId: project.id,
      role: "owner",
      changeSeq: this.dataVersion(),
      migratedAt: null,
      tags: project.config.tags,
      columns: project.config.columns,
      categories: project.config.categories,
      labels: project.config.labels,
      members: []
    };
  }
  #taskIdTaken(projectId, taskId) {
    return !!this.#get("SELECT 1 AS hit FROM project_issues WHERE project_id = ? AND task_id = ?", projectId, taskId);
  }
  #setHead(project, category, seq) {
    const heads = { ...project.taskHeads };
    if ((heads[category] ?? 0) >= seq)
      return;
    heads[category] = seq;
    project.taskHeads = heads;
    this.#run("UPDATE projects SET task_heads = ? WHERE id = ?", JSON.stringify(heads), project.id);
  }
  #mintTaskId(project, categoryKey) {
    const category = project.config.categories.find((entry) => entry.key === categoryKey);
    if (!category)
      invalid2(`unknown category "${categoryKey}"`);
    let seq = (project.taskHeads[categoryKey] ?? 0) + 1;
    while (this.#taskIdTaken(project.id, formatTaskId(category, seq)))
      seq += 1;
    this.#setHead(project, categoryKey, seq);
    return { taskId: formatTaskId(category, seq), taskSeq: seq };
  }
  #lane(projectId, status, except) {
    return this.#all(`SELECT * FROM project_issues WHERE project_id = ? AND status = ? AND deleted_at IS NULL AND id != ?
       ORDER BY sort_key, id`, projectId, status, except ?? "");
  }
  #rankFor(projectId, status, placement, self) {
    for (let attempt = 0;attempt < 2; attempt += 1) {
      const lane = this.#lane(projectId, status, self);
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
        this.#run("UPDATE project_issues SET sort_key = ?, change_seq = ? WHERE id = ?", rankString((index + 1) * RANK_STEP), this.#seq, row.id);
      });
    }
    return invalid2("could not place the card");
  }
  #row(id) {
    return this.#get("SELECT * FROM project_issues WHERE id = ?", id);
  }
  #resolve(ref, options = {}) {
    let row;
    if (isUuid(ref))
      row = this.#row(ref);
    else {
      if (!options.project)
        invalid2(`task id ${ref} needs a project`);
      const project = this.#project(options.project);
      row = this.#get("SELECT * FROM project_issues WHERE project_id = ? AND task_id = ?", project.id, ref.toUpperCase());
    }
    if (!row || row.deleted_at && !options.includeDeleted)
      return notFound(`card ${ref}`);
    if (options.project) {
      const project = this.#project(options.project);
      if (row.project_id !== project.id)
        return notFound(`card ${ref}`);
    } else if (!this.getProject(row.project_id)) {
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
  listWorkItems(projectRef, query = {}) {
    const project = this.#project(projectRef);
    const where = ["project_id = ?"];
    const params = [project.id];
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
    return this.#all(`SELECT * FROM project_issues WHERE ${where.join(" AND ")} ORDER BY status, sort_key, id`, ...params).map(toCard);
  }
  listChanges(projectRef, since) {
    const project = this.#project(projectRef);
    const head = this.dataVersion();
    const items = this.#all("SELECT * FROM project_issues WHERE project_id = ? AND change_seq > ? ORDER BY change_seq, id", project.id, since).map(toCard);
    return { head, items };
  }
  #checkParent(projectId, parentId, self) {
    if (!parentId)
      return null;
    let cursor = parentId;
    for (let depth = 0;cursor; depth += 1) {
      if (cursor === self || depth > 100)
        invalid2("a card cannot hang under itself");
      const row = this.#row(cursor);
      if (!row || row.deleted_at || row.project_id !== projectId)
        notFound(`parent card ${cursor}`);
      cursor = row.parent_id;
    }
    return parentId;
  }
  createWorkItem(projectRef, input) {
    return this.#write(() => {
      const project = this.#project(projectRef);
      const { config } = project;
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
      const parentId = this.#checkParent(project.id, input.parentId ?? null);
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
        if (this.#taskIdTaken(project.id, taskId))
          throw new LocalStoreError("conflict", `task id ${taskId} is taken`);
        this.#setHead(project, category, taskSeq);
      } else if (category) {
        ({ taskId, taskSeq } = this.#mintTaskId(project, category));
      }
      const id = uuidv7();
      const rank = this.#rankFor(project.id, status, input.placement);
      this.#run(`INSERT INTO project_issues (id, project_id, parent_id, task_id, task_seq, category, type, title, body,
           status, priority, tags, checklist, streams, checkpoint, sort_key, revision, change_seq,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?)`, id, project.id, parentId, taskId, taskSeq, category, type, title, input.body ?? "", status, priority, JSON.stringify(tags), JSON.stringify(checklist), JSON.stringify(streams), rank, this.#seq, restore?.createdAt ?? now, restore?.updatedAt ?? now);
      return toCardDetail(this.#row(id));
    });
  }
  #checkRevision(row, options) {
    if (options?.ifRevision !== undefined && options.ifRevision !== Number(row.revision))
      throw new LocalStoreError("conflict", `card is at revision ${row.revision}, not ${options.ifRevision}`);
  }
  #touch(id, sets, params) {
    this.#run(`UPDATE project_issues SET ${[...sets, "revision = revision + 1", "change_seq = ?", "updated_at = ?"].join(", ")}
       WHERE id = ?`, ...params, this.#seq, this.#now(), id);
    return toCardDetail(this.#row(id));
  }
  updateWorkItem(ref, input, options = {}) {
    return this.#write(() => {
      const row = this.#resolve(ref, options);
      this.#checkRevision(row, options);
      const project = this.#project(row.project_id);
      const { config } = project;
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
        set("parent_id", this.#checkParent(project.id, input.parentId, row.id));
      if (input.cloudId !== undefined)
        set("cloud_id", input.cloudId);
      if (input.categoryKey !== undefined) {
        const category = checkCategory(config, input.categoryKey);
        set("category", category);
        if (category && !row.task_id) {
          const minted = this.#mintTaskId(project, category);
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
      const rank = this.#rankFor(row.project_id, row.status, null, row.id);
      return this.#touch(row.id, ["deleted_at = NULL", "sort_key = ?"], [rank]);
    });
  }
  setStatus(ref, columnKey, options = {}) {
    return this.#write(() => {
      const row = this.#resolve(ref, options);
      this.#checkRevision(row, options);
      const { config } = this.#project(row.project_id);
      const status = columnKey ? checkColumn(config, columnKey) : row.status;
      if (status === row.status && !options.placement)
        return toCardDetail(row);
      const rank = this.#rankFor(row.project_id, status, options.placement, row.id);
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
      const row = this.#resolve(ref, { project: writer.project });
      const { config } = this.#project(row.project_id);
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
      const list = keepCheckpoints([
        checkpoint,
        ...parseJson(row.checkpoint, [])
      ]);
      this.#run("UPDATE project_issues SET checkpoint = ?, change_seq = ? WHERE id = ?", JSON.stringify(list), this.#seq, row.id);
      return checkpoint;
    });
  }
  listCheckpoints(ref, options = {}) {
    const row = this.#resolve(ref, options);
    const checkpoints = parseJson(row.checkpoint, []);
    return { checkpoints, latest: latestCheckpoint(checkpoints) };
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
  if (path !== ":memory:") {
    import_node_fs.mkdirSync(import_node_path5.dirname(path), { recursive: true, mode: 448 });
    if (!import_node_fs.existsSync(path))
      import_node_fs.closeSync(import_node_fs.openSync(path, "a", 384));
  }
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
var import_node_fs, import_node_path5, DATA_FILE_NAME = "data.sqlite";
var init_store = __esm(() => {
  init_paths();
  init_review_defaults();
  init_cards();
  init_driver();
  init_ids();
  init_schema();
  init_types();
  import_node_fs = require("node:fs");
  import_node_path5 = require("node:path");
});

// apps/desktop/electron/local-store/index.ts
var init_local_store = __esm(() => {
  init_driver();
  init_ids();
  init_schema();
  init_store();
  init_types();
});

// apps/desktop/electron/main/agent-home.ts
function codexHome(home = import_node_os3.homedir()) {
  return process.env.CODEX_HOME || import_node_path6.join(home, ".codex");
}
async function readText(path, max = CONFIG_MAX_BYTES) {
  try {
    const info = await import_promises3.stat(path);
    if (!info.isFile() || info.size > max)
      return null;
    return await import_promises3.readFile(path, "utf8");
  } catch {
    return null;
  }
}
var import_promises3, import_node_os3, import_node_path6, claudeDir = (home = import_node_os3.homedir()) => process.env.CLAUDE_CONFIG_DIR || import_node_path6.join(home, ".claude"), CONFIG_MAX_BYTES;
var init_agent_home = __esm(() => {
  import_promises3 = require("node:fs/promises");
  import_node_os3 = require("node:os");
  import_node_path6 = require("node:path");
  CONFIG_MAX_BYTES = 512 * 1024;
});

// node_modules/.bun/picomatch@4.0.7/node_modules/picomatch/lib/constants.js
var require_constants = __commonJS(function(exports2, module2) {
  var WIN_SLASH = "\\\\/";
  var WIN_NO_SLASH = `[^${WIN_SLASH}]`;
  var DEFAULT_MAX_EXTGLOB_RECURSION = 0;
  var DOT_LITERAL = "\\.";
  var PLUS_LITERAL = "\\+";
  var QMARK_LITERAL = "\\?";
  var SLASH_LITERAL = "\\/";
  var ONE_CHAR = "(?=.)";
  var QMARK = "[^/]";
  var END_ANCHOR = `(?:${SLASH_LITERAL}|$)`;
  var START_ANCHOR = `(?:^|${SLASH_LITERAL})`;
  var DOTS_SLASH = `${DOT_LITERAL}{1,2}${END_ANCHOR}`;
  var NO_DOT = `(?!${DOT_LITERAL})`;
  var NO_DOTS = `(?!${START_ANCHOR}${DOTS_SLASH})`;
  var NO_DOT_SLASH = `(?!${DOT_LITERAL}{0,1}${END_ANCHOR})`;
  var NO_DOTS_SLASH = `(?!${DOTS_SLASH})`;
  var QMARK_NO_DOT = `[^.${SLASH_LITERAL}]`;
  var STAR = `${QMARK}*?`;
  var SEP = "/";
  var POSIX_CHARS = {
    DOT_LITERAL,
    PLUS_LITERAL,
    QMARK_LITERAL,
    SLASH_LITERAL,
    ONE_CHAR,
    QMARK,
    END_ANCHOR,
    DOTS_SLASH,
    NO_DOT,
    NO_DOTS,
    NO_DOT_SLASH,
    NO_DOTS_SLASH,
    QMARK_NO_DOT,
    STAR,
    START_ANCHOR,
    SEP
  };
  var WINDOWS_CHARS = {
    ...POSIX_CHARS,
    SLASH_LITERAL: `[${WIN_SLASH}]`,
    QMARK: WIN_NO_SLASH,
    STAR: `${WIN_NO_SLASH}*?`,
    DOTS_SLASH: `${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$)`,
    NO_DOT: `(?!${DOT_LITERAL})`,
    NO_DOTS: `(?!(?:^|[${WIN_SLASH}])${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$))`,
    NO_DOT_SLASH: `(?!${DOT_LITERAL}{0,1}(?:[${WIN_SLASH}]|$))`,
    NO_DOTS_SLASH: `(?!${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$))`,
    QMARK_NO_DOT: `[^.${WIN_SLASH}]`,
    START_ANCHOR: `(?:^|[${WIN_SLASH}])`,
    END_ANCHOR: `(?:[${WIN_SLASH}]|$)`,
    SEP: "\\"
  };
  var POSIX_REGEX_SOURCE = {
    __proto__: null,
    alnum: "a-zA-Z0-9",
    alpha: "a-zA-Z",
    ascii: "\\x00-\\x7F",
    blank: " \\t",
    cntrl: "\\x00-\\x1F\\x7F",
    digit: "0-9",
    graph: "\\x21-\\x7E",
    lower: "a-z",
    print: "\\x20-\\x7E ",
    punct: "\\-!\"#$%&'()\\*+,./:;<=>?@[\\]^_`{|}~",
    space: " \\t\\r\\n\\v\\f",
    upper: "A-Z",
    word: "A-Za-z0-9_",
    xdigit: "A-Fa-f0-9"
  };
  module2.exports = {
    DEFAULT_MAX_EXTGLOB_RECURSION,
    MAX_LENGTH: 1024 * 64,
    POSIX_REGEX_SOURCE,
    REGEX_BACKSLASH: /\\(?![*+?^${}(|)[\]])/g,
    REGEX_NON_SPECIAL_CHARS: /^[^@![\].,$*+?^{}()|\\/]+/,
    REGEX_SPECIAL_CHARS: /[-*+?.^${}(|)[\]]/,
    REGEX_SPECIAL_CHARS_BACKREF: /(\\?)((\W)(\3*))/g,
    REGEX_SPECIAL_CHARS_GLOBAL: /([-*+?.^${}(|)[\]])/g,
    REGEX_REMOVE_BACKSLASH: /(?:\[.*?[^\\]\]|\\(?=.))/g,
    REPLACEMENTS: {
      __proto__: null,
      "***": "*",
      "**/**": "**",
      "**/**/**": "**"
    },
    CHAR_0: 48,
    CHAR_9: 57,
    CHAR_UPPERCASE_A: 65,
    CHAR_LOWERCASE_A: 97,
    CHAR_UPPERCASE_Z: 90,
    CHAR_LOWERCASE_Z: 122,
    CHAR_LEFT_PARENTHESES: 40,
    CHAR_RIGHT_PARENTHESES: 41,
    CHAR_ASTERISK: 42,
    CHAR_AMPERSAND: 38,
    CHAR_AT: 64,
    CHAR_BACKWARD_SLASH: 92,
    CHAR_CARRIAGE_RETURN: 13,
    CHAR_CIRCUMFLEX_ACCENT: 94,
    CHAR_COLON: 58,
    CHAR_COMMA: 44,
    CHAR_DOT: 46,
    CHAR_DOUBLE_QUOTE: 34,
    CHAR_EQUAL: 61,
    CHAR_EXCLAMATION_MARK: 33,
    CHAR_FORM_FEED: 12,
    CHAR_FORWARD_SLASH: 47,
    CHAR_GRAVE_ACCENT: 96,
    CHAR_HASH: 35,
    CHAR_HYPHEN_MINUS: 45,
    CHAR_LEFT_ANGLE_BRACKET: 60,
    CHAR_LEFT_CURLY_BRACE: 123,
    CHAR_LEFT_SQUARE_BRACKET: 91,
    CHAR_LINE_FEED: 10,
    CHAR_NO_BREAK_SPACE: 160,
    CHAR_PERCENT: 37,
    CHAR_PLUS: 43,
    CHAR_QUESTION_MARK: 63,
    CHAR_RIGHT_ANGLE_BRACKET: 62,
    CHAR_RIGHT_CURLY_BRACE: 125,
    CHAR_RIGHT_SQUARE_BRACKET: 93,
    CHAR_SEMICOLON: 59,
    CHAR_SINGLE_QUOTE: 39,
    CHAR_SPACE: 32,
    CHAR_TAB: 9,
    CHAR_UNDERSCORE: 95,
    CHAR_VERTICAL_LINE: 124,
    CHAR_ZERO_WIDTH_NOBREAK_SPACE: 65279,
    extglobChars(chars) {
      return {
        "!": { type: "negate", open: "(?:(?!(?:", close: `))${chars.STAR})` },
        "?": { type: "qmark", open: "(?:", close: ")?" },
        "+": { type: "plus", open: "(?:", close: ")+" },
        "*": { type: "star", open: "(?:", close: ")*" },
        "@": { type: "at", open: "(?:", close: ")" }
      };
    },
    globChars(win32) {
      return win32 === true ? WINDOWS_CHARS : POSIX_CHARS;
    }
  };
});

// node_modules/.bun/picomatch@4.0.7/node_modules/picomatch/lib/utils.js
var require_utils = __commonJS(function(exports2) {
  var {
    REGEX_BACKSLASH,
    REGEX_REMOVE_BACKSLASH,
    REGEX_SPECIAL_CHARS,
    REGEX_SPECIAL_CHARS_GLOBAL
  } = require_constants();
  exports2.isObject = (val) => val !== null && typeof val === "object" && !Array.isArray(val);
  exports2.hasRegexChars = (str) => REGEX_SPECIAL_CHARS.test(str);
  exports2.isRegexChar = (str) => str.length === 1 && exports2.hasRegexChars(str);
  exports2.escapeRegex = (str) => str.replace(REGEX_SPECIAL_CHARS_GLOBAL, "\\$1");
  exports2.toPosixSlashes = (str) => str.replace(REGEX_BACKSLASH, "/");
  exports2.isWindows = () => {
    if (typeof navigator !== "undefined" && navigator.platform) {
      const platform = navigator.platform.toLowerCase();
      return platform === "win32" || platform === "windows";
    }
    if (typeof process !== "undefined" && process.platform) {
      return process.platform === "win32";
    }
    return false;
  };
  exports2.removeBackslashes = (str) => {
    return str.replace(REGEX_REMOVE_BACKSLASH, (match) => {
      return match === "\\" ? "" : match;
    });
  };
  exports2.escapeLast = (input, char, lastIdx) => {
    const idx = input.lastIndexOf(char, lastIdx);
    if (idx === -1)
      return input;
    if (input[idx - 1] === "\\")
      return exports2.escapeLast(input, char, idx - 1);
    return `${input.slice(0, idx)}\\${input.slice(idx)}`;
  };
  exports2.removePrefix = (input, state = {}) => {
    let output = input;
    if (output.startsWith("./")) {
      output = output.slice(2);
      state.prefix = "./";
    }
    return output;
  };
  exports2.wrapOutput = (input, state = {}, options = {}) => {
    const prepend = options.contains ? "" : "^";
    const append = options.contains ? "" : "$";
    let output = `${prepend}(?:${input})${append}`;
    if (state.negated === true) {
      output = `(?:^(?!${output}).*$)`;
    }
    return output;
  };
  exports2.basename = (path, { windows } = {}) => {
    const segs = path.split(windows ? /[\\/]/ : "/");
    const last = segs[segs.length - 1];
    if (last === "") {
      return segs[segs.length - 2];
    }
    return last;
  };
});

// node_modules/.bun/picomatch@4.0.7/node_modules/picomatch/lib/scan.js
var require_scan = __commonJS(function(exports2, module2) {
  var utils = require_utils();
  var {
    CHAR_ASTERISK,
    CHAR_AT,
    CHAR_BACKWARD_SLASH,
    CHAR_COMMA,
    CHAR_DOT,
    CHAR_EXCLAMATION_MARK,
    CHAR_FORWARD_SLASH,
    CHAR_LEFT_CURLY_BRACE,
    CHAR_LEFT_PARENTHESES,
    CHAR_LEFT_SQUARE_BRACKET,
    CHAR_PLUS,
    CHAR_QUESTION_MARK,
    CHAR_RIGHT_CURLY_BRACE,
    CHAR_RIGHT_PARENTHESES,
    CHAR_RIGHT_SQUARE_BRACKET
  } = require_constants();
  var isPathSeparator = (code) => {
    return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
  };
  var depth = (token) => {
    if (token.isPrefix !== true) {
      token.depth = token.isGlobstar ? Infinity : 1;
    }
  };
  var scan = (input, options) => {
    const opts = options || {};
    const length = input.length - 1;
    const scanToEnd = opts.parts === true || opts.tokens === true || opts.scanToEnd === true;
    const slashes = [];
    const tokens = [];
    const parts = [];
    let str = input;
    let index = -1;
    let start = 0;
    let lastIndex = 0;
    let isBrace = false;
    let isBracket = false;
    let isGlob = false;
    let isExtglob = false;
    let isGlobstar = false;
    let braceEscaped = false;
    let backslashes = false;
    let negated = false;
    let negatedExtglob = false;
    let finished = false;
    let braces = 0;
    let prev;
    let code;
    let token = { value: "", depth: 0, isGlob: false };
    const eos = () => index >= length;
    const peek = () => str.charCodeAt(index + 1);
    const advance = () => {
      prev = code;
      return str.charCodeAt(++index);
    };
    while (index < length) {
      code = advance();
      let next;
      if (code === CHAR_BACKWARD_SLASH) {
        backslashes = token.backslashes = true;
        code = advance();
        if (code === CHAR_LEFT_CURLY_BRACE) {
          braceEscaped = true;
        }
        continue;
      }
      if (braceEscaped === true || code === CHAR_LEFT_CURLY_BRACE) {
        braces++;
        while (eos() !== true && (code = advance())) {
          if (code === CHAR_BACKWARD_SLASH) {
            backslashes = token.backslashes = true;
            advance();
            continue;
          }
          if (code === CHAR_LEFT_CURLY_BRACE) {
            braces++;
            continue;
          }
          if (braceEscaped !== true && code === CHAR_DOT && (code = advance()) === CHAR_DOT) {
            isBrace = token.isBrace = true;
            isGlob = token.isGlob = true;
            finished = true;
            if (scanToEnd === true) {
              continue;
            }
            break;
          }
          if (braceEscaped !== true && code === CHAR_COMMA) {
            isBrace = token.isBrace = true;
            isGlob = token.isGlob = true;
            finished = true;
            if (scanToEnd === true) {
              continue;
            }
            break;
          }
          if (code === CHAR_RIGHT_CURLY_BRACE) {
            braces--;
            if (braces === 0) {
              braceEscaped = false;
              isBrace = token.isBrace = true;
              finished = true;
              break;
            }
          }
        }
        if (scanToEnd === true) {
          continue;
        }
        break;
      }
      if (code === CHAR_FORWARD_SLASH) {
        slashes.push(index);
        tokens.push(token);
        token = { value: "", depth: 0, isGlob: false };
        if (finished === true)
          continue;
        if (prev === CHAR_DOT && index === start + 1) {
          start += 2;
          continue;
        }
        lastIndex = index + 1;
        continue;
      }
      if (opts.noext !== true) {
        const isExtglobChar = code === CHAR_PLUS || code === CHAR_AT || code === CHAR_ASTERISK || code === CHAR_QUESTION_MARK || code === CHAR_EXCLAMATION_MARK;
        if (isExtglobChar === true && peek() === CHAR_LEFT_PARENTHESES) {
          isGlob = token.isGlob = true;
          isExtglob = token.isExtglob = true;
          finished = true;
          if (code === CHAR_EXCLAMATION_MARK && index === start) {
            negatedExtglob = true;
          }
          if (scanToEnd === true) {
            let parens = 0;
            while (eos() !== true && (code = advance())) {
              if (code === CHAR_BACKWARD_SLASH) {
                backslashes = token.backslashes = true;
                advance();
                continue;
              }
              if (code === CHAR_LEFT_PARENTHESES) {
                parens++;
                continue;
              }
              if (code === CHAR_RIGHT_PARENTHESES && --parens === 0) {
                finished = true;
                break;
              }
            }
            continue;
          }
          break;
        }
      }
      if (code === CHAR_ASTERISK) {
        if (prev === CHAR_ASTERISK)
          isGlobstar = token.isGlobstar = true;
        isGlob = token.isGlob = true;
        finished = true;
        if (scanToEnd === true) {
          continue;
        }
        break;
      }
      if (code === CHAR_QUESTION_MARK) {
        isGlob = token.isGlob = true;
        finished = true;
        if (scanToEnd === true) {
          continue;
        }
        break;
      }
      if (code === CHAR_LEFT_SQUARE_BRACKET) {
        while (eos() !== true && (next = advance())) {
          if (next === CHAR_BACKWARD_SLASH) {
            backslashes = token.backslashes = true;
            advance();
            continue;
          }
          if (next === CHAR_RIGHT_SQUARE_BRACKET) {
            isBracket = token.isBracket = true;
            isGlob = token.isGlob = true;
            finished = true;
            break;
          }
        }
        if (scanToEnd === true) {
          continue;
        }
        break;
      }
      if (opts.nonegate !== true && code === CHAR_EXCLAMATION_MARK && index === start) {
        negated = token.negated = true;
        start++;
        continue;
      }
      if (opts.noparen !== true && code === CHAR_LEFT_PARENTHESES) {
        isGlob = token.isGlob = true;
        if (scanToEnd === true) {
          let parens = 1;
          while (eos() !== true && (code = advance())) {
            if (code === CHAR_BACKWARD_SLASH) {
              backslashes = token.backslashes = true;
              advance();
              continue;
            }
            if (code === CHAR_LEFT_PARENTHESES) {
              parens++;
              continue;
            }
            if (code === CHAR_RIGHT_PARENTHESES && --parens === 0) {
              finished = true;
              break;
            }
          }
          continue;
        }
        break;
      }
      if (isGlob === true) {
        finished = true;
        if (scanToEnd === true) {
          continue;
        }
        break;
      }
    }
    if (opts.noext === true) {
      isExtglob = false;
      isGlob = false;
    }
    let base = str;
    let prefix = "";
    let glob = "";
    if (start > 0) {
      prefix = str.slice(0, start);
      str = str.slice(start);
      lastIndex -= start;
    }
    if (base && isGlob === true && lastIndex > 0) {
      base = str.slice(0, lastIndex);
      glob = str.slice(lastIndex);
    } else if (isGlob === true) {
      base = "";
      glob = str;
    } else {
      base = str;
    }
    if (base && base !== "" && base !== "/" && base !== str) {
      if (isPathSeparator(base.charCodeAt(base.length - 1))) {
        base = base.slice(0, -1);
      }
    }
    if (opts.unescape === true) {
      if (glob)
        glob = utils.removeBackslashes(glob);
      if (base && backslashes === true) {
        base = utils.removeBackslashes(base);
      }
    }
    const state = {
      prefix,
      input,
      start,
      base,
      glob,
      isBrace,
      isBracket,
      isGlob,
      isExtglob,
      isGlobstar,
      negated,
      negatedExtglob
    };
    if (opts.tokens === true) {
      state.maxDepth = 0;
      if (!isPathSeparator(code)) {
        tokens.push(token);
      }
      state.tokens = tokens;
    }
    if (opts.parts === true || opts.tokens === true) {
      let prevIndex;
      for (let idx = 0;idx < slashes.length; idx++) {
        const n = prevIndex !== undefined ? prevIndex + 1 : start;
        const i = slashes[idx];
        const value = input.slice(n, i);
        if (opts.tokens) {
          if (idx === 0 && start !== 0) {
            tokens[idx].isPrefix = true;
            tokens[idx].value = prefix;
          } else {
            tokens[idx].value = value;
          }
          depth(tokens[idx]);
          state.maxDepth += tokens[idx].depth;
        }
        if (i >= start) {
          parts.push(value);
          prevIndex = i;
        }
      }
      const n = prevIndex !== undefined ? prevIndex + 1 : start;
      const value = input.slice(n);
      parts.push(value);
      if (opts.tokens && prevIndex && prevIndex + 1 < input.length) {
        tokens[tokens.length - 1].value = value;
        depth(tokens[tokens.length - 1]);
        state.maxDepth += tokens[tokens.length - 1].depth;
      }
      state.slashes = slashes;
      state.parts = parts;
    }
    return state;
  };
  module2.exports = scan;
});

// node_modules/.bun/picomatch@4.0.7/node_modules/picomatch/lib/parse.js
var require_parse = __commonJS(function(exports2, module2) {
  var constants = require_constants();
  var utils = require_utils();
  var {
    MAX_LENGTH,
    POSIX_REGEX_SOURCE,
    REGEX_NON_SPECIAL_CHARS,
    REGEX_SPECIAL_CHARS_BACKREF,
    REPLACEMENTS
  } = constants;
  var expandRange = (args, options) => {
    if (typeof options.expandRange === "function") {
      return options.expandRange(...args, options);
    }
    args.sort();
    const value = `[${args.join("-")}]`;
    try {
      new RegExp(value);
    } catch (ex) {
      return args.map((v) => utils.escapeRegex(v)).join("..");
    }
    return value;
  };
  var syntaxError = (type, char) => {
    return `Missing ${type}: "${char}" - use "\\\\${char}" to match literal characters`;
  };
  var splitTopLevel = (input) => {
    const parts = [];
    let bracket = 0;
    let paren = 0;
    let quote = 0;
    let value = "";
    let escaped = false;
    for (const ch of input) {
      if (escaped === true) {
        value += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        value += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        quote = quote === 1 ? 0 : 1;
        value += ch;
        continue;
      }
      if (quote === 0) {
        if (ch === "[") {
          bracket++;
        } else if (ch === "]" && bracket > 0) {
          bracket--;
        } else if (bracket === 0) {
          if (ch === "(") {
            paren++;
          } else if (ch === ")" && paren > 0) {
            paren--;
          } else if (ch === "|" && paren === 0) {
            parts.push(value);
            value = "";
            continue;
          }
        }
      }
      value += ch;
    }
    parts.push(value);
    return parts;
  };
  var isPlainBranch = (branch) => {
    let escaped = false;
    for (const ch of branch) {
      if (escaped === true) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (/[?*+@!()[\]{}]/.test(ch)) {
        return false;
      }
    }
    return true;
  };
  var normalizeSimpleBranch = (branch) => {
    let value = branch.trim();
    let changed = true;
    while (changed === true) {
      changed = false;
      if (/^@\([^\\()[\]{}|]+\)$/.test(value)) {
        value = value.slice(2, -1);
        changed = true;
      }
    }
    if (!isPlainBranch(value)) {
      return;
    }
    return value.replace(/\\(.)/g, "$1");
  };
  var hasRepeatedCharPrefixOverlap = (branches) => {
    const values = branches.map(normalizeSimpleBranch).filter(Boolean);
    for (let i = 0;i < values.length; i++) {
      for (let j = i + 1;j < values.length; j++) {
        const a = values[i];
        const b = values[j];
        const char = a[0];
        if (!char || a !== char.repeat(a.length) || b !== char.repeat(b.length)) {
          continue;
        }
        if (a === b || a.startsWith(b) || b.startsWith(a)) {
          return true;
        }
      }
    }
    return false;
  };
  var parseRepeatedExtglob = (pattern, requireEnd = true) => {
    if (pattern[0] !== "+" && pattern[0] !== "*" || pattern[1] !== "(") {
      return;
    }
    let bracket = 0;
    let paren = 0;
    let quote = 0;
    let escaped = false;
    for (let i = 1;i < pattern.length; i++) {
      const ch = pattern[i];
      if (escaped === true) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        quote = quote === 1 ? 0 : 1;
        continue;
      }
      if (quote === 1) {
        continue;
      }
      if (ch === "[") {
        bracket++;
        continue;
      }
      if (ch === "]" && bracket > 0) {
        bracket--;
        continue;
      }
      if (bracket > 0) {
        continue;
      }
      if (ch === "(") {
        paren++;
        continue;
      }
      if (ch === ")") {
        paren--;
        if (paren === 0) {
          if (requireEnd === true && i !== pattern.length - 1) {
            return;
          }
          return {
            type: pattern[0],
            body: pattern.slice(2, i),
            end: i
          };
        }
      }
    }
  };
  var buildCharClassStar = (chars) => {
    const source = chars.length === 1 ? utils.escapeRegex(chars[0]) : `[${chars.map((ch) => utils.escapeRegex(ch)).join("")}]`;
    return `${source}*`;
  };
  var getStarExtglobSequenceChars = (pattern) => {
    let index = 0;
    const chars = [];
    while (index < pattern.length) {
      const match = parseRepeatedExtglob(pattern.slice(index), false);
      if (!match || match.type !== "*") {
        return;
      }
      const branches = splitTopLevel(match.body).map((branch) => branch.trim());
      if (branches.length !== 1) {
        return;
      }
      const branch = normalizeSimpleBranch(branches[0]);
      if (!branch || branch.length !== 1) {
        return;
      }
      chars.push(branch);
      index += match.end + 1;
    }
    if (chars.length < 1) {
      return;
    }
    return chars;
  };
  var repeatedExtglobRecursion = (pattern) => {
    let depth = 0;
    let value = pattern.trim();
    let match = parseRepeatedExtglob(value);
    while (match) {
      depth++;
      value = match.body.trim();
      match = parseRepeatedExtglob(value);
    }
    return depth;
  };
  var analyzeRepeatedExtglob = (body, options) => {
    if (options.maxExtglobRecursion === false) {
      return { risky: false };
    }
    const max = typeof options.maxExtglobRecursion === "number" ? options.maxExtglobRecursion : constants.DEFAULT_MAX_EXTGLOB_RECURSION;
    const branches = splitTopLevel(body).map((branch) => branch.trim());
    if (branches.length > 1) {
      if (branches.some((branch) => branch === "") || branches.some((branch) => /^[*?]+$/.test(branch)) || hasRepeatedCharPrefixOverlap(branches)) {
        return { risky: true };
      }
    }
    const safeChars = [];
    let sawStarSequence = false;
    let combinable = true;
    for (const branch of branches) {
      const chars = getStarExtglobSequenceChars(branch);
      if (chars) {
        sawStarSequence = true;
        safeChars.push(...chars);
        continue;
      }
      const literal = normalizeSimpleBranch(branch);
      if (literal && literal.length === 1) {
        safeChars.push(literal);
        continue;
      }
      combinable = false;
      if (repeatedExtglobRecursion(branch) > max) {
        return { risky: true };
      }
    }
    if (sawStarSequence) {
      return combinable ? { risky: true, safeOutput: buildCharClassStar([...new Set(safeChars)]) } : { risky: true };
    }
    return { risky: false };
  };
  var parse = (input, options) => {
    if (typeof input !== "string") {
      throw new TypeError("Expected a string");
    }
    input = REPLACEMENTS[input] || input;
    const opts = { ...options };
    const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
    let len = input.length;
    if (len > max) {
      throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
    }
    const bos = { type: "bos", value: "", output: opts.prepend || "" };
    const tokens = [bos];
    const capture = opts.capture ? "" : "?:";
    const PLATFORM_CHARS = constants.globChars(opts.windows);
    const EXTGLOB_CHARS = constants.extglobChars(PLATFORM_CHARS);
    const {
      DOT_LITERAL,
      PLUS_LITERAL,
      SLASH_LITERAL,
      ONE_CHAR,
      DOTS_SLASH,
      NO_DOT,
      NO_DOT_SLASH,
      NO_DOTS_SLASH,
      QMARK,
      QMARK_NO_DOT,
      STAR,
      START_ANCHOR
    } = PLATFORM_CHARS;
    const globstar = (opts) => {
      return `(${capture}(?:(?!${START_ANCHOR}${opts.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
    };
    const nodot = opts.dot ? "" : NO_DOT;
    const qmarkNoDot = opts.dot ? QMARK : QMARK_NO_DOT;
    let star = opts.bash === true ? globstar(opts) : STAR;
    if (opts.capture) {
      star = `(${star})`;
    }
    if (typeof opts.noext === "boolean") {
      opts.noextglob = opts.noext;
    }
    const state = {
      input,
      index: -1,
      start: 0,
      dot: opts.dot === true,
      consumed: "",
      output: "",
      prefix: "",
      backtrack: false,
      negated: false,
      brackets: 0,
      braces: 0,
      parens: 0,
      quotes: 0,
      globstar: false,
      tokens
    };
    input = utils.removePrefix(input, state);
    len = input.length;
    const extglobs = [];
    const braces = [];
    const stack = [];
    let prev = bos;
    let value;
    const eos = () => state.index === len - 1;
    const peek = state.peek = (n = 1) => input[state.index + n];
    const advance = state.advance = () => input[++state.index] || "";
    const remaining = () => input.slice(state.index + 1);
    const consume = (value = "", num = 0) => {
      state.consumed += value;
      state.index += num;
    };
    const append = (token) => {
      state.output += token.output != null ? token.output : token.value;
      consume(token.value);
    };
    const negate = () => {
      let count = 1;
      while (peek() === "!" && (peek(2) !== "(" || peek(3) === "?")) {
        advance();
        state.start++;
        count++;
      }
      if (count % 2 === 0) {
        return false;
      }
      state.negated = true;
      state.start++;
      return true;
    };
    const increment = (type) => {
      state[type]++;
      stack.push(type);
    };
    const decrement = (type) => {
      state[type]--;
      stack.pop();
    };
    const push = (tok) => {
      if (prev.type === "globstar") {
        const isBrace = state.braces > 0 && (tok.type === "comma" || tok.type === "brace");
        const isExtglob = tok.extglob === true || extglobs.length && (tok.type === "pipe" || tok.type === "paren");
        if (tok.type !== "slash" && tok.type !== "paren" && !isBrace && !isExtglob) {
          state.output = state.output.slice(0, -prev.output.length);
          prev.type = "star";
          prev.value = "*";
          prev.output = star;
          state.output += prev.output;
        }
      }
      if (extglobs.length && tok.type !== "paren") {
        extglobs[extglobs.length - 1].inner += tok.value;
      }
      if (tok.value || tok.output)
        append(tok);
      if (prev && prev.type === "text" && tok.type === "text") {
        prev.output = (prev.output || prev.value) + tok.value;
        prev.value += tok.value;
        return;
      }
      tok.prev = prev;
      tokens.push(tok);
      prev = tok;
    };
    const extglobOpen = (type, value) => {
      const token = { ...EXTGLOB_CHARS[value], conditions: 1, inner: "" };
      token.prev = prev;
      token.parens = state.parens;
      token.output = state.output;
      token.startIndex = state.index;
      token.tokensIndex = tokens.length;
      const output = (opts.capture ? "(" : "") + token.open;
      increment("parens");
      push({ type, value, output: state.output ? "" : ONE_CHAR });
      push({ type: "paren", extglob: true, value: advance(), output });
      extglobs.push(token);
    };
    const extglobClose = (token) => {
      const literal = input.slice(token.startIndex, state.index + 1);
      const body = input.slice(token.startIndex + 2, state.index);
      const analysis = analyzeRepeatedExtglob(body, opts);
      if ((token.type === "plus" || token.type === "star") && analysis.risky) {
        const safeOutput = analysis.safeOutput ? (token.output ? "" : ONE_CHAR) + (opts.capture ? `(${analysis.safeOutput})` : analysis.safeOutput) : undefined;
        const open = tokens[token.tokensIndex];
        open.type = "text";
        open.value = literal;
        open.output = safeOutput || utils.escapeRegex(literal);
        for (let i = token.tokensIndex + 1;i < tokens.length; i++) {
          tokens[i].value = "";
          tokens[i].output = "";
          delete tokens[i].suffix;
        }
        state.output = token.output + open.output;
        state.backtrack = true;
        push({ type: "paren", extglob: true, value, output: "" });
        decrement("parens");
        return;
      }
      let output = token.close + (opts.capture ? ")" : "");
      let rest;
      if (token.type === "negate") {
        let extglobStar = star;
        if (token.inner && token.inner.length > 1 && token.inner.includes("/")) {
          extglobStar = globstar(opts);
        }
        if (extglobStar !== star || eos() || /^\)+$/.test(remaining())) {
          output = token.close = `)$))${extglobStar}`;
        }
        if (token.inner.includes("*") && (rest = remaining()) && /^\.[^\\/.]+$/.test(rest)) {
          const expression = parse(rest, { ...options, fastpaths: false }).output;
          output = token.close = `)${expression})${extglobStar})`;
        }
        if (token.prev.type === "bos") {
          state.negatedExtglob = true;
        }
      }
      push({ type: "paren", extglob: true, value, output });
      decrement("parens");
    };
    if (opts.fastpaths !== false && !/(^[*!]|[/()[\]{}"])/.test(input)) {
      let backslashes = false;
      let output = input.replace(REGEX_SPECIAL_CHARS_BACKREF, (m, esc, chars, first, rest, index) => {
        if (first === "\\") {
          backslashes = true;
          return m;
        }
        if (first === "?") {
          if (esc) {
            return esc + first + (rest ? QMARK.repeat(rest.length) : "");
          }
          if (index === 0) {
            return qmarkNoDot + (rest ? QMARK.repeat(rest.length) : "");
          }
          return QMARK.repeat(chars.length);
        }
        if (first === ".") {
          return DOT_LITERAL.repeat(chars.length);
        }
        if (first === "*") {
          if (esc) {
            return esc + first + (rest ? star : "");
          }
          return star;
        }
        return esc ? m : `\\${m}`;
      });
      if (backslashes === true) {
        if (opts.unescape === true) {
          output = output.replace(/\\/g, "");
        } else {
          output = output.replace(/\\+/g, (m) => {
            return m.length % 2 === 0 ? "\\\\" : m ? "\\" : "";
          });
        }
      }
      if (output === input && opts.contains === true) {
        state.output = input;
        return state;
      }
      state.output = utils.wrapOutput(output, state, options);
      return state;
    }
    while (!eos()) {
      value = advance();
      if (value === "\x00") {
        continue;
      }
      if (value === "\\") {
        const next = peek();
        if (next === "/" && opts.bash !== true) {
          continue;
        }
        if (next === "." || next === ";") {
          continue;
        }
        if (!next) {
          value += "\\";
          push({ type: "text", value });
          continue;
        }
        const match = /^\\+/.exec(remaining());
        let slashes = 0;
        if (match && match[0].length > 2) {
          slashes = match[0].length;
          state.index += slashes;
          if (slashes % 2 !== 0) {
            value += "\\";
          }
        }
        if (opts.unescape === true) {
          value = advance();
        } else {
          value += advance();
        }
        if (state.brackets === 0) {
          push({ type: "text", value });
          continue;
        }
      }
      if (state.brackets > 0 && (value !== "]" || prev.value === "[" || prev.value === "[^")) {
        if (opts.posix !== false && value === ":") {
          const inner = prev.value.slice(1);
          if (inner.includes("[")) {
            prev.posix = true;
            if (inner.includes(":")) {
              const idx = prev.value.lastIndexOf("[");
              const pre = prev.value.slice(0, idx);
              const rest = prev.value.slice(idx + 2);
              const posix = POSIX_REGEX_SOURCE[rest];
              if (posix) {
                prev.value = pre + posix;
                state.backtrack = true;
                advance();
                if (!bos.output && tokens.indexOf(prev) === 1) {
                  bos.output = ONE_CHAR;
                }
                continue;
              }
            }
          }
        }
        if (value === "[" && peek() !== ":" || value === "-" && peek() === "]") {
          value = `\\${value}`;
        }
        if (value === "]" && (prev.value === "[" || prev.value === "[^")) {
          value = `\\${value}`;
        }
        if (opts.posix === true && value === "!" && prev.value === "[") {
          value = "^";
        }
        prev.value += value;
        append({ value });
        continue;
      }
      if (state.quotes === 1 && value !== '"') {
        value = utils.escapeRegex(value);
        prev.value += value;
        append({ value });
        continue;
      }
      if (value === '"') {
        state.quotes = state.quotes === 1 ? 0 : 1;
        if (opts.keepQuotes === true) {
          push({ type: "text", value });
        }
        continue;
      }
      if (value === "(") {
        increment("parens");
        push({ type: "paren", value });
        continue;
      }
      if (value === ")") {
        if (state.parens === 0 && opts.strictBrackets === true) {
          throw new SyntaxError(syntaxError("opening", "("));
        }
        const extglob = extglobs[extglobs.length - 1];
        if (extglob && state.parens === extglob.parens + 1) {
          extglobClose(extglobs.pop());
          continue;
        }
        push({ type: "paren", value, output: state.parens ? ")" : "\\)" });
        decrement("parens");
        continue;
      }
      if (value === "[") {
        if (opts.nobracket === true || !remaining().includes("]")) {
          if (opts.nobracket !== true && opts.strictBrackets === true) {
            throw new SyntaxError(syntaxError("closing", "]"));
          }
          value = `\\${value}`;
        } else {
          increment("brackets");
        }
        push({ type: "bracket", value });
        continue;
      }
      if (value === "]") {
        if (opts.nobracket === true || prev && prev.type === "bracket" && prev.value.length === 1) {
          push({ type: "text", value, output: `\\${value}` });
          continue;
        }
        if (state.brackets === 0) {
          if (opts.strictBrackets === true) {
            throw new SyntaxError(syntaxError("opening", "["));
          }
          push({ type: "text", value, output: `\\${value}` });
          continue;
        }
        decrement("brackets");
        const prevValue = prev.value.slice(1);
        if (prev.posix !== true && prevValue[0] === "^" && !prevValue.includes("/")) {
          value = `/${value}`;
        }
        prev.value += value;
        append({ value });
        if (opts.literalBrackets === false || utils.hasRegexChars(prevValue)) {
          continue;
        }
        const escaped = utils.escapeRegex(prev.value);
        state.output = state.output.slice(0, -prev.value.length);
        if (opts.literalBrackets === true) {
          state.output += escaped;
          prev.value = escaped;
          continue;
        }
        prev.value = `(${capture}${escaped}|${prev.value})`;
        state.output += prev.value;
        continue;
      }
      if (value === "{" && opts.nobrace !== true) {
        increment("braces");
        const open = {
          type: "brace",
          value,
          output: "(",
          outputIndex: state.output.length,
          tokensIndex: state.tokens.length
        };
        braces.push(open);
        push(open);
        continue;
      }
      if (value === "}") {
        const brace = braces[braces.length - 1];
        if (opts.nobrace === true || !brace) {
          push({ type: "text", value, output: value });
          continue;
        }
        let output = ")";
        if (brace.dots === true) {
          const arr = tokens.slice();
          const range = [];
          for (let i = arr.length - 1;i >= 0; i--) {
            tokens.pop();
            if (arr[i].type === "brace") {
              break;
            }
            if (arr[i].type !== "dots") {
              range.unshift(arr[i].value);
            }
          }
          output = expandRange(range, opts);
          state.backtrack = true;
        }
        if (brace.comma !== true && brace.dots !== true) {
          const out = state.output.slice(0, brace.outputIndex);
          const toks = state.tokens.slice(brace.tokensIndex);
          brace.value = brace.output = "\\{";
          value = output = "\\}";
          state.output = out;
          for (const t of toks) {
            state.output += t.output || t.value;
          }
        }
        push({ type: "brace", value, output });
        decrement("braces");
        braces.pop();
        continue;
      }
      if (value === "|") {
        if (extglobs.length > 0) {
          extglobs[extglobs.length - 1].conditions++;
        }
        push({ type: "text", value });
        continue;
      }
      if (value === ",") {
        let output = value;
        const brace = braces[braces.length - 1];
        if (brace && stack[stack.length - 1] === "braces") {
          brace.comma = true;
          output = "|";
        }
        push({ type: "comma", value, output });
        continue;
      }
      if (value === "/") {
        if (prev.type === "dot" && state.index === state.start + 1) {
          state.start = state.index + 1;
          state.consumed = "";
          state.output = "";
          tokens.pop();
          prev = bos;
          continue;
        }
        push({ type: "slash", value, output: SLASH_LITERAL });
        continue;
      }
      if (value === ".") {
        if (state.braces > 0 && prev.type === "dot") {
          if (prev.value === ".")
            prev.output = DOT_LITERAL;
          const brace = braces[braces.length - 1];
          prev.type = "dots";
          prev.output += value;
          prev.value += value;
          brace.dots = true;
          continue;
        }
        if (state.braces + state.parens === 0 && prev.type !== "bos" && prev.type !== "slash") {
          push({ type: "text", value, output: DOT_LITERAL });
          continue;
        }
        push({ type: "dot", value, output: DOT_LITERAL });
        continue;
      }
      if (value === "?") {
        const isGroup = prev && prev.value === "(";
        if (!isGroup && opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
          extglobOpen("qmark", value);
          continue;
        }
        if (prev && prev.type === "paren") {
          const next = peek();
          let output = value;
          if (prev.value === "(" && !/[!=<:]/.test(next) || next === "<" && !/<([!=]|\w+>)/.test(remaining())) {
            output = `\\${value}`;
          }
          push({ type: "text", value, output });
          continue;
        }
        if (opts.dot !== true && (prev.type === "slash" || prev.type === "bos")) {
          push({ type: "qmark", value, output: QMARK_NO_DOT });
          continue;
        }
        push({ type: "qmark", value, output: QMARK });
        continue;
      }
      if (value === "!") {
        if (opts.noextglob !== true && peek() === "(") {
          if (peek(2) !== "?" || !/[!=<:]/.test(peek(3))) {
            extglobOpen("negate", value);
            continue;
          }
        }
        if (opts.nonegate !== true && state.index === 0) {
          negate();
          continue;
        }
      }
      if (value === "+") {
        if (opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
          extglobOpen("plus", value);
          continue;
        }
        if (prev && prev.value === "(" || opts.regex === false) {
          push({ type: "plus", value, output: PLUS_LITERAL });
          continue;
        }
        if (prev && (prev.type === "bracket" || prev.type === "paren" || prev.type === "brace") || state.parens > 0) {
          push({ type: "plus", value });
          continue;
        }
        push({ type: "plus", value: PLUS_LITERAL });
        continue;
      }
      if (value === "@") {
        if (opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
          push({ type: "at", extglob: true, value, output: "" });
          continue;
        }
        push({ type: "text", value });
        continue;
      }
      if (value !== "*") {
        if (value === "$" || value === "^") {
          value = `\\${value}`;
        }
        const match = REGEX_NON_SPECIAL_CHARS.exec(remaining());
        if (match) {
          value += match[0];
          state.index += match[0].length;
        }
        push({ type: "text", value });
        continue;
      }
      if (prev && (prev.type === "globstar" || prev.star === true)) {
        prev.type = "star";
        prev.star = true;
        prev.value += value;
        prev.output = star;
        state.backtrack = true;
        state.globstar = true;
        consume(value);
        continue;
      }
      let rest = remaining();
      if (opts.noextglob !== true && /^\([^?]/.test(rest)) {
        extglobOpen("star", value);
        continue;
      }
      if (prev.type === "star") {
        if (opts.noglobstar === true) {
          consume(value);
          continue;
        }
        const prior = prev.prev;
        const before = prior.prev;
        const isStart = prior.type === "slash" || prior.type === "bos";
        const afterStar = before && (before.type === "star" || before.type === "globstar");
        if (opts.bash === true && (!isStart || rest[0] && rest[0] !== "/")) {
          push({ type: "star", value, output: "" });
          continue;
        }
        const isBrace = state.braces > 0 && (prior.type === "comma" || prior.type === "brace");
        const isExtglob = extglobs.length && (prior.type === "pipe" || prior.type === "paren");
        if (!isStart && prior.type !== "paren" && !isBrace && !isExtglob) {
          push({ type: "star", value, output: "" });
          continue;
        }
        while (rest.slice(0, 3) === "/**") {
          const after = input[state.index + 4];
          if (after && after !== "/") {
            break;
          }
          rest = rest.slice(3);
          consume("/**", 3);
        }
        const isEnd = eos() || state.parens > 0 && rest === ")".repeat(state.parens) && !extglobs.some((extglob) => extglob.type === "negate");
        if (prior.type === "bos" && eos()) {
          prev.type = "globstar";
          prev.value += value;
          prev.output = globstar(opts);
          state.output = prev.output;
          state.globstar = true;
          consume(value);
          continue;
        }
        if (prior.type === "slash" && prior.prev.type !== "bos" && !afterStar && isEnd) {
          state.output = state.output.slice(0, -(prior.output + prev.output).length);
          prior.output = `(?:${prior.output}`;
          prev.type = "globstar";
          prev.output = globstar(opts) + (opts.strictSlashes ? ")" : "|$)");
          prev.value += value;
          state.globstar = true;
          state.output += prior.output + prev.output;
          consume(value);
          continue;
        }
        if (prior.type === "slash" && prior.prev.type !== "bos" && rest[0] === "/") {
          const end = rest[1] !== undefined ? "|$" : "";
          state.output = state.output.slice(0, -(prior.output + prev.output).length);
          prior.output = `(?:${prior.output}`;
          prev.type = "globstar";
          prev.output = `${globstar(opts)}${SLASH_LITERAL}|${SLASH_LITERAL}${end})`;
          prev.value += value;
          state.output += prior.output + prev.output;
          state.globstar = true;
          consume(value + advance());
          push({ type: "slash", value: "/", output: "" });
          continue;
        }
        if (prior.type === "bos" && rest[0] === "/") {
          prev.type = "globstar";
          prev.value += value;
          prev.output = `(?:^|${SLASH_LITERAL}|${globstar(opts)}${SLASH_LITERAL})`;
          state.output = prev.output;
          state.globstar = true;
          consume(value + advance());
          push({ type: "slash", value: "/", output: "" });
          continue;
        }
        state.output = state.output.slice(0, -prev.output.length);
        prev.type = "globstar";
        prev.output = globstar(opts);
        prev.value += value;
        state.output += prev.output;
        state.globstar = true;
        consume(value);
        continue;
      }
      const token = { type: "star", value, output: star };
      if (opts.bash === true) {
        token.output = ".*?";
        if (prev.type === "bos" || prev.type === "slash") {
          token.output = nodot + token.output;
        }
        push(token);
        continue;
      }
      if (prev && (prev.type === "bracket" || prev.type === "paren") && opts.regex === true) {
        token.output = value;
        push(token);
        continue;
      }
      if (state.index === state.start || prev.type === "slash" || prev.type === "dot") {
        if (prev.type === "dot") {
          state.output += NO_DOT_SLASH;
          prev.output += NO_DOT_SLASH;
        } else if (opts.dot === true) {
          state.output += NO_DOTS_SLASH;
          prev.output += NO_DOTS_SLASH;
        } else {
          state.output += nodot;
          prev.output += nodot;
        }
        if (peek() !== "*") {
          state.output += ONE_CHAR;
          prev.output += ONE_CHAR;
        }
      }
      push(token);
    }
    while (state.brackets > 0) {
      if (opts.strictBrackets === true)
        throw new SyntaxError(syntaxError("closing", "]"));
      state.output = utils.escapeLast(state.output, "[");
      decrement("brackets");
    }
    while (state.parens > 0) {
      if (opts.strictBrackets === true)
        throw new SyntaxError(syntaxError("closing", ")"));
      state.output = utils.escapeLast(state.output, "(");
      decrement("parens");
    }
    while (state.braces > 0) {
      if (opts.strictBrackets === true)
        throw new SyntaxError(syntaxError("closing", "}"));
      state.output = utils.escapeLast(state.output, "{");
      decrement("braces");
    }
    if (opts.strictSlashes !== true && (prev.type === "star" || prev.type === "bracket")) {
      push({ type: "maybe_slash", value: "", output: `${SLASH_LITERAL}?` });
    }
    if (state.backtrack === true) {
      state.output = "";
      for (const token of state.tokens) {
        state.output += token.output != null ? token.output : token.value;
        if (token.suffix) {
          state.output += token.suffix;
        }
      }
    }
    return state;
  };
  parse.fastpaths = (input, options) => {
    const opts = { ...options };
    const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
    const len = input.length;
    if (len > max) {
      throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
    }
    input = REPLACEMENTS[input] || input;
    const {
      DOT_LITERAL,
      SLASH_LITERAL,
      ONE_CHAR,
      DOTS_SLASH,
      NO_DOT,
      NO_DOTS,
      NO_DOTS_SLASH,
      STAR,
      START_ANCHOR
    } = constants.globChars(opts.windows);
    const nodot = opts.dot ? NO_DOTS : NO_DOT;
    const slashDot = opts.dot ? NO_DOTS_SLASH : NO_DOT;
    const capture = opts.capture ? "" : "?:";
    const state = { negated: false, prefix: "" };
    let star = opts.bash === true ? ".*?" : STAR;
    if (opts.capture) {
      star = `(${star})`;
    }
    const globstar = (opts) => {
      if (opts.noglobstar === true)
        return star;
      return `(${capture}(?:(?!${START_ANCHOR}${opts.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
    };
    const create = (str) => {
      switch (str) {
        case "*":
          return `${nodot}${ONE_CHAR}${star}`;
        case ".*":
          return `${DOT_LITERAL}${ONE_CHAR}${star}`;
        case "*.*":
          return `${nodot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;
        case "*/*":
          return `${nodot}${star}${SLASH_LITERAL}${ONE_CHAR}${slashDot}${star}`;
        case "**":
          return nodot + globstar(opts);
        case "**/*":
          return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${ONE_CHAR}${star}`;
        case "**/*.*":
          return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;
        case "**/.*":
          return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${DOT_LITERAL}${ONE_CHAR}${star}`;
        default: {
          const match = /^(.*?)\.(\w+)$/.exec(str);
          if (!match)
            return;
          const source = create(match[1]);
          if (!source)
            return;
          return source + DOT_LITERAL + match[2];
        }
      }
    };
    const output = utils.removePrefix(input, state);
    let source = create(output);
    if (source && opts.strictSlashes !== true) {
      source += `${SLASH_LITERAL}?`;
    }
    return source;
  };
  module2.exports = parse;
});

// node_modules/.bun/picomatch@4.0.7/node_modules/picomatch/lib/picomatch.js
var require_picomatch = __commonJS(function(exports2, module2) {
  var scan = require_scan();
  var parse = require_parse();
  var utils = require_utils();
  var constants = require_constants();
  var isObject = (val) => val && typeof val === "object" && !Array.isArray(val);
  var picomatch = (glob, options, returnState = false) => {
    if (Array.isArray(glob)) {
      const fns = glob.map((input) => picomatch(input, options, returnState));
      const arrayMatcher = (str) => {
        for (const isMatch of fns) {
          const state = isMatch(str);
          if (state)
            return state;
        }
        return false;
      };
      return arrayMatcher;
    }
    const isState = isObject(glob) && glob.tokens && glob.input;
    if (glob === "" || typeof glob !== "string" && !isState) {
      throw new TypeError("Expected pattern to be a non-empty string");
    }
    const opts = options || {};
    const posix = opts.windows;
    const regex = isState ? picomatch.compileRe(glob, options) : picomatch.makeRe(glob, options, false, true);
    const state = regex.state;
    delete regex.state;
    let isIgnored = () => false;
    if (opts.ignore) {
      const ignoreOpts = { ...options, ignore: null, onMatch: null, onResult: null };
      isIgnored = picomatch(opts.ignore, ignoreOpts, returnState);
    }
    const matcher = (input, returnObject = false) => {
      const { isMatch, match, output } = picomatch.test(input, regex, options, { glob, posix });
      const result = { glob, state, regex, posix, input, output, match, isMatch };
      if (typeof opts.onResult === "function") {
        opts.onResult(result);
      }
      if (isMatch === false) {
        result.isMatch = false;
        return returnObject ? result : false;
      }
      if (isIgnored(input)) {
        if (typeof opts.onIgnore === "function") {
          opts.onIgnore(result);
        }
        result.isMatch = false;
        return returnObject ? result : false;
      }
      if (typeof opts.onMatch === "function") {
        opts.onMatch(result);
      }
      return returnObject ? result : true;
    };
    if (returnState) {
      matcher.state = state;
    }
    return matcher;
  };
  picomatch.test = (input, regex, options, { glob, posix } = {}) => {
    if (typeof input !== "string") {
      throw new TypeError("Expected input to be a string");
    }
    if (input === "") {
      return { isMatch: false, output: "" };
    }
    const opts = options || {};
    const format = opts.format || (posix ? utils.toPosixSlashes : null);
    let match = input === glob;
    let output = match && format ? format(input) : input;
    if (match === false) {
      output = format ? format(input) : input;
      match = output === glob;
    }
    if (match === false || opts.capture === true) {
      if (opts.matchBase === true || opts.basename === true) {
        match = picomatch.matchBase(input, regex, options, posix);
      } else {
        match = regex.exec(output);
      }
    }
    return { isMatch: Boolean(match), match, output };
  };
  picomatch.matchBase = (input, glob, options, posix = options && options.windows) => {
    const regex = glob instanceof RegExp ? glob : picomatch.makeRe(glob, options);
    return regex.test(utils.basename(input, { windows: posix }));
  };
  picomatch.isMatch = (str, patterns, options) => picomatch(patterns, options)(str);
  picomatch.parse = (pattern, options) => {
    if (Array.isArray(pattern))
      return pattern.map((p) => picomatch.parse(p, options));
    return parse(pattern, { ...options, fastpaths: false });
  };
  picomatch.scan = (input, options) => scan(input, options);
  picomatch.compileRe = (state, options, returnOutput = false, returnState = false) => {
    if (returnOutput === true) {
      return state.output;
    }
    const opts = options || {};
    const prepend = opts.contains ? "" : "^";
    const append = opts.contains ? "" : "$";
    let source = `${prepend}(?:${state.output})${append}`;
    if (state && state.negated === true) {
      source = `^(?!${source}).*$`;
    }
    const regex = picomatch.toRegex(source, options);
    if (returnState === true) {
      regex.state = state;
    }
    return regex;
  };
  picomatch.makeRe = (input, options = {}, returnOutput = false, returnState = false) => {
    if (!input || typeof input !== "string") {
      throw new TypeError("Expected a non-empty string");
    }
    let parsed = { negated: false, fastpaths: true };
    if (options.fastpaths !== false && (input[0] === "." || input[0] === "*")) {
      parsed.output = parse.fastpaths(input, options);
    }
    if (!parsed.output) {
      parsed = parse(input, options);
    }
    return picomatch.compileRe(parsed, options, returnOutput, returnState);
  };
  picomatch.toRegex = (source, options) => {
    try {
      const opts = options || {};
      return new RegExp(source, opts.flags || (opts.nocase ? "i" : ""));
    } catch (err) {
      if (options && options.debug === true)
        throw err;
      return /$^/;
    }
  };
  picomatch.constants = constants;
  module2.exports = picomatch;
});

// node_modules/.bun/picomatch@4.0.7/node_modules/picomatch/index.js
var require_picomatch2 = __commonJS(function(exports2, module2) {
  var pico = require_picomatch();
  var utils = require_utils();
  function picomatch(glob, options, returnState = false) {
    if (options && (options.windows === null || options.windows === undefined)) {
      options = { ...options, windows: utils.isWindows() };
    }
    return pico(glob, options, returnState);
  }
  Object.assign(picomatch, pico);
  module2.exports = picomatch;
});

// node_modules/.bun/fdir@6.5.0+ef9fefe4b3f078a5/node_modules/fdir/dist/index.cjs
var require_dist = __commonJS(function(exports2) {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function")
      for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key;i < n; i++) {
        key = keys[i];
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, {
            get: ((k) => from[k]).bind(null, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
      }
    return to;
  };
  var __toESM2 = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
    value: mod,
    enumerable: true
  }) : target, mod));
  var path = __toESM2(require("path"));
  var fs = __toESM2(require("fs"));
  function cleanPath(path$1) {
    let normalized = (0, path.normalize)(path$1);
    if (normalized.length > 1 && normalized[normalized.length - 1] === path.sep)
      normalized = normalized.substring(0, normalized.length - 1);
    return normalized;
  }
  var SLASHES_REGEX = /[\\/]/g;
  function convertSlashes(path$1, separator) {
    return path$1.replace(SLASHES_REGEX, separator);
  }
  var WINDOWS_ROOT_DIR_REGEX = /^[a-z]:[\\/]$/i;
  function isRootDirectory(path$1) {
    return path$1 === "/" || WINDOWS_ROOT_DIR_REGEX.test(path$1);
  }
  function normalizePath(path$1, options) {
    const { resolvePaths, normalizePath: normalizePath$1, pathSeparator } = options;
    const pathNeedsCleaning = process.platform === "win32" && path$1.includes("/") || path$1.startsWith(".");
    if (resolvePaths)
      path$1 = (0, path.resolve)(path$1);
    if (normalizePath$1 || pathNeedsCleaning)
      path$1 = cleanPath(path$1);
    if (path$1 === ".")
      return "";
    const needsSeperator = path$1[path$1.length - 1] !== pathSeparator;
    return convertSlashes(needsSeperator ? path$1 + pathSeparator : path$1, pathSeparator);
  }
  function joinPathWithBasePath(filename, directoryPath) {
    return directoryPath + filename;
  }
  function joinPathWithRelativePath(root, options) {
    return function(filename, directoryPath) {
      const sameRoot = directoryPath.startsWith(root);
      if (sameRoot)
        return directoryPath.slice(root.length) + filename;
      else
        return convertSlashes((0, path.relative)(root, directoryPath), options.pathSeparator) + options.pathSeparator + filename;
    };
  }
  function joinPath(filename) {
    return filename;
  }
  function joinDirectoryPath(filename, directoryPath, separator) {
    return directoryPath + filename + separator;
  }
  function build$7(root, options) {
    const { relativePaths, includeBasePath } = options;
    return relativePaths && root ? joinPathWithRelativePath(root, options) : includeBasePath ? joinPathWithBasePath : joinPath;
  }
  function pushDirectoryWithRelativePath(root) {
    return function(directoryPath, paths) {
      paths.push(directoryPath.substring(root.length) || ".");
    };
  }
  function pushDirectoryFilterWithRelativePath(root) {
    return function(directoryPath, paths, filters) {
      const relativePath = directoryPath.substring(root.length) || ".";
      if (filters.every((filter) => filter(relativePath, true)))
        paths.push(relativePath);
    };
  }
  var pushDirectory = (directoryPath, paths) => {
    paths.push(directoryPath || ".");
  };
  var pushDirectoryFilter = (directoryPath, paths, filters) => {
    const path$1 = directoryPath || ".";
    if (filters.every((filter) => filter(path$1, true)))
      paths.push(path$1);
  };
  var empty$2 = () => {};
  function build$6(root, options) {
    const { includeDirs, filters, relativePaths } = options;
    if (!includeDirs)
      return empty$2;
    if (relativePaths)
      return filters && filters.length ? pushDirectoryFilterWithRelativePath(root) : pushDirectoryWithRelativePath(root);
    return filters && filters.length ? pushDirectoryFilter : pushDirectory;
  }
  var pushFileFilterAndCount = (filename, _paths, counts, filters) => {
    if (filters.every((filter) => filter(filename, false)))
      counts.files++;
  };
  var pushFileFilter = (filename, paths, _counts, filters) => {
    if (filters.every((filter) => filter(filename, false)))
      paths.push(filename);
  };
  var pushFileCount = (_filename, _paths, counts, _filters) => {
    counts.files++;
  };
  var pushFile = (filename, paths) => {
    paths.push(filename);
  };
  var empty$1 = () => {};
  function build$5(options) {
    const { excludeFiles, filters, onlyCounts } = options;
    if (excludeFiles)
      return empty$1;
    if (filters && filters.length)
      return onlyCounts ? pushFileFilterAndCount : pushFileFilter;
    else if (onlyCounts)
      return pushFileCount;
    else
      return pushFile;
  }
  var getArray = (paths) => {
    return paths;
  };
  var getArrayGroup = () => {
    return [""].slice(0, 0);
  };
  function build$4(options) {
    return options.group ? getArrayGroup : getArray;
  }
  var groupFiles = (groups, directory, files) => {
    groups.push({
      directory,
      files,
      dir: directory
    });
  };
  var empty = () => {};
  function build$3(options) {
    return options.group ? groupFiles : empty;
  }
  var resolveSymlinksAsync = function(path$1, state, callback$1) {
    const { queue, fs: fs$1, options: { suppressErrors } } = state;
    queue.enqueue();
    fs$1.realpath(path$1, (error, resolvedPath) => {
      if (error)
        return queue.dequeue(suppressErrors ? null : error, state);
      fs$1.stat(resolvedPath, (error$1, stat) => {
        if (error$1)
          return queue.dequeue(suppressErrors ? null : error$1, state);
        if (stat.isDirectory() && isRecursive(path$1, resolvedPath, state))
          return queue.dequeue(null, state);
        callback$1(stat, resolvedPath);
        queue.dequeue(null, state);
      });
    });
  };
  var resolveSymlinks = function(path$1, state, callback$1) {
    const { queue, fs: fs$1, options: { suppressErrors } } = state;
    queue.enqueue();
    try {
      const resolvedPath = fs$1.realpathSync(path$1);
      const stat = fs$1.statSync(resolvedPath);
      if (stat.isDirectory() && isRecursive(path$1, resolvedPath, state))
        return;
      callback$1(stat, resolvedPath);
    } catch (e) {
      if (!suppressErrors)
        throw e;
    }
  };
  function build$2(options, isSynchronous) {
    if (!options.resolveSymlinks || options.excludeSymlinks)
      return null;
    return isSynchronous ? resolveSymlinks : resolveSymlinksAsync;
  }
  function isRecursive(path$1, resolved, state) {
    if (state.options.useRealPaths)
      return isRecursiveUsingRealPaths(resolved, state);
    let parent = (0, path.dirname)(path$1);
    let depth = 1;
    while (parent !== state.root && depth < 2) {
      const resolvedPath = state.symlinks.get(parent);
      const isSameRoot = !!resolvedPath && (resolvedPath === resolved || resolvedPath.startsWith(resolved) || resolved.startsWith(resolvedPath));
      if (isSameRoot)
        depth++;
      else
        parent = (0, path.dirname)(parent);
    }
    state.symlinks.set(path$1, resolved);
    return depth > 1;
  }
  function isRecursiveUsingRealPaths(resolved, state) {
    return state.visited.includes(resolved + state.options.pathSeparator);
  }
  var onlyCountsSync = (state) => {
    return state.counts;
  };
  var groupsSync = (state) => {
    return state.groups;
  };
  var defaultSync = (state) => {
    return state.paths;
  };
  var limitFilesSync = (state) => {
    return state.paths.slice(0, state.options.maxFiles);
  };
  var onlyCountsAsync = (state, error, callback$1) => {
    report(error, callback$1, state.counts, state.options.suppressErrors);
    return null;
  };
  var defaultAsync = (state, error, callback$1) => {
    report(error, callback$1, state.paths, state.options.suppressErrors);
    return null;
  };
  var limitFilesAsync = (state, error, callback$1) => {
    report(error, callback$1, state.paths.slice(0, state.options.maxFiles), state.options.suppressErrors);
    return null;
  };
  var groupsAsync = (state, error, callback$1) => {
    report(error, callback$1, state.groups, state.options.suppressErrors);
    return null;
  };
  function report(error, callback$1, output, suppressErrors) {
    if (error && !suppressErrors)
      callback$1(error, output);
    else
      callback$1(null, output);
  }
  function build$1(options, isSynchronous) {
    const { onlyCounts, group, maxFiles } = options;
    if (onlyCounts)
      return isSynchronous ? onlyCountsSync : onlyCountsAsync;
    else if (group)
      return isSynchronous ? groupsSync : groupsAsync;
    else if (maxFiles)
      return isSynchronous ? limitFilesSync : limitFilesAsync;
    else
      return isSynchronous ? defaultSync : defaultAsync;
  }
  var readdirOpts = { withFileTypes: true };
  var walkAsync = (state, crawlPath, directoryPath, currentDepth, callback$1) => {
    state.queue.enqueue();
    if (currentDepth < 0)
      return state.queue.dequeue(null, state);
    const { fs: fs$1 } = state;
    state.visited.push(crawlPath);
    state.counts.directories++;
    fs$1.readdir(crawlPath || ".", readdirOpts, (error, entries = []) => {
      callback$1(entries, directoryPath, currentDepth);
      state.queue.dequeue(state.options.suppressErrors ? null : error, state);
    });
  };
  var walkSync = (state, crawlPath, directoryPath, currentDepth, callback$1) => {
    const { fs: fs$1 } = state;
    if (currentDepth < 0)
      return;
    state.visited.push(crawlPath);
    state.counts.directories++;
    let entries = [];
    try {
      entries = fs$1.readdirSync(crawlPath || ".", readdirOpts);
    } catch (e) {
      if (!state.options.suppressErrors)
        throw e;
    }
    callback$1(entries, directoryPath, currentDepth);
  };
  function build(isSynchronous) {
    return isSynchronous ? walkSync : walkAsync;
  }
  var Queue = class {
    count = 0;
    constructor(onQueueEmpty) {
      this.onQueueEmpty = onQueueEmpty;
    }
    enqueue() {
      this.count++;
      return this.count;
    }
    dequeue(error, output) {
      if (this.onQueueEmpty && (--this.count <= 0 || error)) {
        this.onQueueEmpty(error, output);
        if (error) {
          output.controller.abort();
          this.onQueueEmpty = undefined;
        }
      }
    }
  };
  var Counter = class {
    _files = 0;
    _directories = 0;
    set files(num) {
      this._files = num;
    }
    get files() {
      return this._files;
    }
    set directories(num) {
      this._directories = num;
    }
    get directories() {
      return this._directories;
    }
    get dirs() {
      return this._directories;
    }
  };
  var Aborter = class {
    aborted = false;
    abort() {
      this.aborted = true;
    }
  };
  var Walker = class {
    root;
    isSynchronous;
    state;
    joinPath;
    pushDirectory;
    pushFile;
    getArray;
    groupFiles;
    resolveSymlink;
    walkDirectory;
    callbackInvoker;
    constructor(root, options, callback$1) {
      this.isSynchronous = !callback$1;
      this.callbackInvoker = build$1(options, this.isSynchronous);
      this.root = normalizePath(root, options);
      this.state = {
        root: isRootDirectory(this.root) ? this.root : this.root.slice(0, -1),
        paths: [""].slice(0, 0),
        groups: [],
        counts: new Counter,
        options,
        queue: new Queue((error, state) => this.callbackInvoker(state, error, callback$1)),
        symlinks: /* @__PURE__ */ new Map,
        visited: [""].slice(0, 0),
        controller: new Aborter,
        fs: options.fs || fs
      };
      this.joinPath = build$7(this.root, options);
      this.pushDirectory = build$6(this.root, options);
      this.pushFile = build$5(options);
      this.getArray = build$4(options);
      this.groupFiles = build$3(options);
      this.resolveSymlink = build$2(options, this.isSynchronous);
      this.walkDirectory = build(this.isSynchronous);
    }
    start() {
      this.pushDirectory(this.root, this.state.paths, this.state.options.filters);
      this.walkDirectory(this.state, this.root, this.root, this.state.options.maxDepth, this.walk);
      return this.isSynchronous ? this.callbackInvoker(this.state, null) : null;
    }
    walk = (entries, directoryPath, depth) => {
      const { paths, options: { filters, resolveSymlinks: resolveSymlinks$1, excludeSymlinks, exclude, maxFiles, signal, useRealPaths, pathSeparator }, controller } = this.state;
      if (controller.aborted || signal && signal.aborted || maxFiles && paths.length > maxFiles)
        return;
      const files = this.getArray(this.state.paths);
      for (let i = 0;i < entries.length; ++i) {
        const entry = entries[i];
        if (entry.isFile() || entry.isSymbolicLink() && !resolveSymlinks$1 && !excludeSymlinks) {
          const filename = this.joinPath(entry.name, directoryPath);
          this.pushFile(filename, files, this.state.counts, filters);
        } else if (entry.isDirectory()) {
          let path$1 = joinDirectoryPath(entry.name, directoryPath, this.state.options.pathSeparator);
          if (exclude && exclude(entry.name, path$1))
            continue;
          this.pushDirectory(path$1, paths, filters);
          this.walkDirectory(this.state, path$1, path$1, depth - 1, this.walk);
        } else if (this.resolveSymlink && entry.isSymbolicLink()) {
          let path$1 = joinPathWithBasePath(entry.name, directoryPath);
          this.resolveSymlink(path$1, this.state, (stat, resolvedPath) => {
            if (stat.isDirectory()) {
              resolvedPath = normalizePath(resolvedPath, this.state.options);
              if (exclude && exclude(entry.name, useRealPaths ? resolvedPath : path$1 + pathSeparator))
                return;
              this.walkDirectory(this.state, resolvedPath, useRealPaths ? resolvedPath : path$1 + pathSeparator, depth - 1, this.walk);
            } else {
              resolvedPath = useRealPaths ? resolvedPath : path$1;
              const filename = (0, path.basename)(resolvedPath);
              const directoryPath$1 = normalizePath((0, path.dirname)(resolvedPath), this.state.options);
              resolvedPath = this.joinPath(filename, directoryPath$1);
              this.pushFile(resolvedPath, files, this.state.counts, filters);
            }
          });
        }
      }
      this.groupFiles(this.state.groups, directoryPath, files);
    };
  };
  function promise(root, options) {
    return new Promise((resolve$1, reject) => {
      callback(root, options, (err, output) => {
        if (err)
          return reject(err);
        resolve$1(output);
      });
    });
  }
  function callback(root, options, callback$1) {
    let walker = new Walker(root, options, callback$1);
    walker.start();
  }
  function sync(root, options) {
    const walker = new Walker(root, options);
    return walker.start();
  }
  var APIBuilder = class {
    constructor(root, options) {
      this.root = root;
      this.options = options;
    }
    withPromise() {
      return promise(this.root, this.options);
    }
    withCallback(cb) {
      callback(this.root, this.options, cb);
    }
    sync() {
      return sync(this.root, this.options);
    }
  };
  var pm = null;
  try {
    require.resolve("/Users/pp/fuongz_projects/lanework-public/node_modules/.bun/picomatch@4.0.7/node_modules/picomatch/index.js");
    pm = require_picomatch2();
  } catch {}
  var Builder = class {
    globCache = {};
    options = {
      maxDepth: Infinity,
      suppressErrors: true,
      pathSeparator: path.sep,
      filters: []
    };
    globFunction;
    constructor(options) {
      this.options = {
        ...this.options,
        ...options
      };
      this.globFunction = this.options.globFunction;
    }
    group() {
      this.options.group = true;
      return this;
    }
    withPathSeparator(separator) {
      this.options.pathSeparator = separator;
      return this;
    }
    withBasePath() {
      this.options.includeBasePath = true;
      return this;
    }
    withRelativePaths() {
      this.options.relativePaths = true;
      return this;
    }
    withDirs() {
      this.options.includeDirs = true;
      return this;
    }
    withMaxDepth(depth) {
      this.options.maxDepth = depth;
      return this;
    }
    withMaxFiles(limit) {
      this.options.maxFiles = limit;
      return this;
    }
    withFullPaths() {
      this.options.resolvePaths = true;
      this.options.includeBasePath = true;
      return this;
    }
    withErrors() {
      this.options.suppressErrors = false;
      return this;
    }
    withSymlinks({ resolvePaths = true } = {}) {
      this.options.resolveSymlinks = true;
      this.options.useRealPaths = resolvePaths;
      return this.withFullPaths();
    }
    withAbortSignal(signal) {
      this.options.signal = signal;
      return this;
    }
    normalize() {
      this.options.normalizePath = true;
      return this;
    }
    filter(predicate) {
      this.options.filters.push(predicate);
      return this;
    }
    onlyDirs() {
      this.options.excludeFiles = true;
      this.options.includeDirs = true;
      return this;
    }
    exclude(predicate) {
      this.options.exclude = predicate;
      return this;
    }
    onlyCounts() {
      this.options.onlyCounts = true;
      return this;
    }
    crawl(root) {
      return new APIBuilder(root || ".", this.options);
    }
    withGlobFunction(fn) {
      this.globFunction = fn;
      return this;
    }
    crawlWithOptions(root, options) {
      this.options = {
        ...this.options,
        ...options
      };
      return new APIBuilder(root || ".", this.options);
    }
    glob(...patterns) {
      if (this.globFunction)
        return this.globWithOptions(patterns);
      return this.globWithOptions(patterns, ...[{ dot: true }]);
    }
    globWithOptions(patterns, ...options) {
      const globFn = this.globFunction || pm;
      if (!globFn)
        throw new Error("Please specify a glob function to use glob matching.");
      var isMatch = this.globCache[patterns.join("\x00")];
      if (!isMatch) {
        isMatch = globFn(patterns, ...options);
        this.globCache[patterns.join("\x00")] = isMatch;
      }
      this.options.filters.push((path$1) => isMatch(path$1));
      return this;
    }
  };
  exports2.fdir = Builder;
});

// apps/desktop/electron/hook/lanework-checkpoint.ts
var exports_lanework_checkpoint = {};
__export(exports_lanework_checkpoint, {
  buildBody: () => buildBody,
  checkedApi: () => checkedApi,
  digest: () => digest,
  digestCodex: () => digestCodex,
  digestOpencode: () => digestOpencode,
  isSecretFile: () => isSecretFile,
  readOpencodeSession: () => readOpencodeSession,
  redact: () => redact,
  snapshot: () => snapshot
});
module.exports = __toCommonJS(exports_lanework_checkpoint);
init_src();
var import_node_child_process7 = require("node:child_process");
var import_node_crypto5 = require("node:crypto");
var import_node_fs7 = require("node:fs");
var import_node_os9 = require("node:os");
var import_node_path13 = require("node:path");

// apps/desktop/electron/main/git/runner.ts
var import_node_child_process = require("node:child_process");
var MAX_OUTPUT = 32 * 1024 * 1024;
var DEFAULT_TIMEOUT = 15000;
var BASE_FLAGS = [
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=never",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "log.showSignature=false",
  "--no-pager",
  "--literal-pathspecs"
];
var READ_FLAGS = [
  ...BASE_FLAGS,
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null"
];
class GitMissingError extends Error {
}
function exec(flags, cwd, args, options) {
  const ok = options.ok ?? [0];
  return new Promise((resolve, reject) => {
    import_node_child_process.execFile("git", [...flags, ...args], {
      cwd,
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      maxBuffer: options.maxBuffer ?? MAX_OUTPUT,
      windowsHide: true,
      encoding: options.encoding ?? "utf8",
      env: options.env ?? process.env
    }, (error, stdout, stderr) => {
      if (!error)
        return resolve({ stdout, code: 0 });
      const code = typeof error.code === "number" ? error.code : null;
      if (error.code === "ENOENT")
        return reject(new GitMissingError("git is not installed."));
      if (code !== null && ok.includes(code))
        return resolve({ stdout, code });
      const message = options.encoding === "base64" ? Buffer.from(stderr, "base64").toString("utf8") : stderr || stdout;
      const said = (message || error.message).trim();
      reject(new Error(said.split(`
`).slice(-6).join(`
`).slice(0, 800)));
    });
  });
}
function gitRead(cwd, args, options = {}) {
  return exec(READ_FLAGS, cwd, args, options);
}
async function gitReadOut(cwd, args, options = {}) {
  return (await gitRead(cwd, args, options)).stdout;
}

// apps/desktop/electron/main/git/trust-gate.ts
init_paths();
var import_promises2 = require("node:fs/promises");
var import_node_path3 = require("node:path");

// apps/desktop/electron/main/git/repo-trust.ts
var import_promises = require("node:fs/promises");
var import_node_path2 = require("node:path");
var OFF = new Set(["false", "no", "off", "0", ""]);
function risky(key, value) {
  const lower = key.toLowerCase();
  if (lower.startsWith("filter."))
    return true;
  if (lower === "core.fsmonitor")
    return !OFF.has(value.trim().toLowerCase());
  if (lower === "core.hookspath")
    return true;
  if (lower === "core.sshcommand")
    return true;
  if (lower.startsWith("gpg."))
    return true;
  if (lower === "diff.external")
    return true;
  if (lower.startsWith("diff.") && (lower.endsWith(".command") || lower.endsWith(".textconv")))
    return true;
  return false;
}
async function commonDir(folder) {
  try {
    const raw = await gitReadOut(folder, ["rev-parse", "--git-common-dir"], {
      timeout: 5000
    });
    const dir = raw.trim();
    return dir ? import_node_path2.resolve(folder, dir) : null;
  } catch {
    return null;
  }
}
async function configFindings(folder) {
  const raw = await gitReadOut(folder, ["config", "--list", "--show-scope", "-z"], {
    timeout: 5000
  });
  const found = [];
  const parts = raw.split("\x00");
  for (let i = 0;i + 1 < parts.length; i += 2) {
    const scope = parts[i];
    if (scope !== "local" && scope !== "worktree")
      continue;
    const entry = parts[i + 1];
    const cut = entry.indexOf(`
`);
    const key = cut < 0 ? entry : entry.slice(0, cut);
    const value = cut < 0 ? "true" : entry.slice(cut + 1);
    if (risky(key, value))
      found.push({ kind: "config", key, value });
  }
  return found;
}
async function hookFindings(dir) {
  const hooks = import_node_path2.join(dir, "hooks");
  const names = await import_promises.readdir(hooks).catch(() => []);
  const found = [];
  for (const name of names.sort()) {
    if (name.endsWith(".sample"))
      continue;
    const info = await import_promises.stat(import_node_path2.join(hooks, name)).catch(() => null);
    if (!info?.isFile())
      continue;
    if (process.platform !== "win32" && (info.mode & 73) === 0)
      continue;
    found.push({ kind: "hook", name });
  }
  return found;
}
async function scanRepoTrust(folder) {
  const dir = await commonDir(folder);
  if (!dir)
    return { risky: false, findings: [], gitDir: null };
  const [config, hooks] = await Promise.all([
    configFindings(folder).catch(() => []),
    hookFindings(dir)
  ]);
  const findings = [...config, ...hooks];
  return { risky: findings.length > 0, findings, gitDir: dir };
}
function trustFingerprint(findings) {
  return findings.map((f) => f.kind === "hook" ? `hook:${f.name}` : `config:${f.key}=${f.value}`).sort().join(`
`);
}

class TrustStore {
  onChange;
  answers = new Map;
  constructor(initial = {}, onChange) {
    this.onChange = onChange;
    for (const [folder, value] of Object.entries(initial))
      this.answers.set(import_node_path2.resolve(folder), value);
  }
  get(folder) {
    return this.answers.get(import_node_path2.resolve(folder));
  }
  set(folder, answer, scan) {
    this.answers.set(import_node_path2.resolve(folder), {
      answer,
      fingerprint: trustFingerprint(scan.findings)
    });
    this.onChange?.(this.toJSON());
  }
  forget(folder) {
    if (this.answers.delete(import_node_path2.resolve(folder)))
      this.onChange?.(this.toJSON());
  }
  async decide(folder) {
    const scan = await scanRepoTrust(folder);
    if (!scan.risky)
      return { kind: "run" };
    const known = this.get(folder);
    if (known && known.fingerprint === trustFingerprint(scan.findings))
      return known.answer === "trusted" ? { kind: "run" } : { kind: "restricted" };
    return { kind: "ask", scan };
  }
  toJSON() {
    return Object.fromEntries(this.answers);
  }
}

// apps/desktop/electron/main/git/trust-gate.ts
var FRESH_MS = 60000;
var asker = null;
var store = null;
var fresh = new Map;
var pending = new Map;
function storeFile() {
  return import_node_path3.join(appHomeDir(), "repo-trust.json");
}
async function save(all) {
  const file = storeFile();
  await import_promises2.mkdir(import_node_path3.dirname(file), { recursive: true, mode: 448 });
  const temp = `${file}.${process.pid}.tmp`;
  await import_promises2.writeFile(temp, `${JSON.stringify(all, null, 2)}
`, { mode: 384 });
  await import_promises2.rename(temp, file);
}
function load() {
  store ??= import_promises2.readFile(storeFile(), "utf8").then((text) => JSON.parse(text)).catch(() => ({})).then((initial) => new TrustStore(initial, (all) => {
    save(all).catch(() => {});
  }));
  return store;
}
async function readsAllowed(folder) {
  return await readsVerdict(folder) === "run";
}
function readsVerdict(folder) {
  const key = import_node_path3.resolve(folder);
  const until = fresh.get(key);
  if (until !== undefined && until > Date.now())
    return Promise.resolve("run");
  const running = pending.get(key);
  if (running)
    return running;
  const decided = decide(key).catch(() => "unchecked").finally(() => pending.delete(key));
  pending.set(key, decided);
  return decided;
}
async function decide(folder) {
  const trust = await load();
  const verdict = await trust.decide(folder);
  if (verdict.kind === "run") {
    fresh.set(folder, Date.now() + FRESH_MS);
    return "run";
  }
  if (verdict.kind === "restricted")
    return "refused";
  if (!asker)
    return "unchecked";
  const answer = await asker(folder, verdict.scan);
  trust.set(folder, answer, verdict.scan);
  if (answer !== "trusted")
    return "refused";
  fresh.set(folder, Date.now() + FRESH_MS);
  return "run";
}

// apps/desktop/electron/hook/cli.ts
init_src();
init_client();
init_loopback();
init_pkce();
init_redirect();
var import_node_child_process6 = require("node:child_process");
var import_node_fs4 = require("node:fs");
var import_node_os8 = require("node:os");
var import_node_path11 = require("node:path");

// apps/desktop/electron/mcp-local/server.ts
init_local_store();
var import_node_os6 = require("node:os");

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
      const list = value;
      if (param.minItems && list.length < param.minItems)
        fail(`a list of at least ${param.minItems}`);
      return list.map((entry, index) => {
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
init_cards();
init_local_store();

// apps/desktop/electron/main/transcripts/search.ts
var import_promises6 = require("node:fs/promises");
var import_node_os5 = require("node:os");
var import_node_path9 = require("node:path");

// apps/desktop/shared/terminal.ts
var BACKGROUND_COMMAND_MAX = 4 * 1024;
var BACKGROUND_OUTPUT_MAX = 64 * 1024;
var SUBAGENT_INPUT_MAX = 8 * 1024;
var AGENT_FACTS_READ_MAX = 4 * 1024 * 1024;
var UUID2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isAgentSessionId(value) {
  return typeof value === "string" && UUID2.test(value);
}
var TERMINAL_LIMITS = {
  perProject: 8,
  maxGeometry: 1000,
  scrollback: 5000,
  maxInput: 256 * 1024
};

// apps/desktop/electron/main/transcripts/search.ts
init_agent_home();

// apps/desktop/electron/main/fs-kit/rg.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs2 = require("node:fs");
var import_node_module2 = require("node:module");
var import_node_path7 = require("node:path");
var __dirname = "/Users/pp/fuongz_projects/lanework-public/apps/desktop/electron/main/fs-kit", __filename = "/Users/pp/fuongz_projects/lanework-public/apps/desktop/electron/main/fs-kit/rg.ts";

class RipgrepMissingError extends Error {
}

class FsSearchTimeoutError extends Error {
}
var cached = null;
function rgPath() {
  if (cached)
    return cached;
  const exe = process.platform === "win32" ? ".exe" : "";
  const bundled = import_node_path7.join(__dirname, "..", "bin", `rg-${process.arch}${exe}`).replace(`${import_node_path7.sep}app.asar${import_node_path7.sep}`, `${import_node_path7.sep}app.asar.unpacked${import_node_path7.sep}`);
  if (import_node_fs2.existsSync(bundled)) {
    cached = bundled;
    return cached;
  }
  const dev = devRgPath();
  if (dev) {
    cached = dev;
    return cached;
  }
  throw new RipgrepMissingError("ripgrep is missing from this build. Run `bun run build` in apps/desktop.");
}
function devRgPath() {
  const name = ["@vscode", "ripgrep"].join("/");
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  try {
    const entry = import_node_fs2.realpathSync(import_node_module2.createRequire(__filename).resolve(name));
    const found = import_node_module2.createRequire(entry).resolve(`${name}-${process.platform}-${process.arch}/bin/${exe}`);
    return import_node_fs2.existsSync(found) ? found : null;
  } catch {
    return null;
  }
}
function runRg(args, options) {
  const bin = rgPath();
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted)
      return reject(abortReason(options.signal));
    let child;
    try {
      child = import_node_child_process2.spawn(bin, ["--no-config", "--no-require-git", ...args], {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      return reject(error);
    }
    let stopped = false;
    let timedOut = false;
    let settled = false;
    let rest = [];
    let stderr = "";
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    };
    const finish = (error) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      kill();
      if (error !== undefined)
        reject(error);
      else
        resolve({ stopped, timedOut });
    };
    const onAbort = () => finish(abortReason(options.signal));
    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (settled)
        return;
      let start = 0;
      for (;; ) {
        const end = chunk.indexOf(`
`, start);
        if (end === -1)
          break;
        let line = chunk.slice(start, end);
        if (rest.length > 0) {
          rest.push(line);
          line = rest.join("");
          rest = [];
        }
        start = end + 1;
        if (line && options.onLine(line) === false) {
          stopped = true;
          return finish();
        }
      }
      if (start < chunk.length)
        rest.push(chunk.slice(start));
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.once("error", (error) => finish(error.code === "ENOENT" ? new RipgrepMissingError(`ripgrep could not be started: ${bin}`) : error));
    child.once("close", (code) => {
      if (settled)
        return;
      const last = rest.join("");
      if (last && options.onLine(last) === false)
        stopped = true;
      if (code === 2 && !stopped && /regex parse error|error parsing glob/i.test(stderr))
        return finish(new Error(`Not a valid ${/glob/i.test(stderr) ? "file filter" : "regular expression"}: ${/error: (.+)/.exec(stderr)?.[1]?.trim() ?? "rg could not read it"}.`));
      if (code === 0 || code === 1 || code === 2 || stopped)
        return finish();
      finish(new Error(stderr.trim().split(`
`).slice(-3).join(`
`) || `rg exited with ${code}`));
    });
  });
}
function abortReason(signal) {
  return signal?.reason ?? new DOMException("The search was aborted.", "AbortError");
}

// apps/desktop/electron/main/fs-kit/list-files.ts
var { fdir } = require_dist();
var WALK_SKIP = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo"
]);
// apps/desktop/electron/main/terminal/agent-sessions.ts
init_conversation();

// apps/desktop/electron/main/transcripts/jsonl.ts
var import_promises4 = require("node:fs/promises");
var CHUNK = 64 * 1024;
var META_CHUNK = 256 * 1024;
var TITLE_MAX = 120;
async function readRange(file, start, length) {
  const handle = await import_promises4.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
function lines(text, { head }) {
  const parts = text.split(`
`);
  if (head)
    parts.pop();
  else
    parts.shift();
  const out = [];
  for (const part of parts) {
    if (!part.trim())
      continue;
    try {
      const value = JSON.parse(part);
      if (value && typeof value === "object")
        out.push(value);
    } catch {}
  }
  return out;
}
function tidy(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}
function claudeProjectDir(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
var LINE_STEP = 1024 * 1024;

// apps/desktop/electron/main/transcripts/journal.ts
var journals = new Map;
var reading = new Map;

// apps/desktop/electron/main/transcripts/activity.ts
var endsRead = new Map;
var endsReading = new Map;
var STALE_MS = 10 * 60000;
var SUBAGENT_STALE_MS = 60 * 60000;
var META_MAX = 64 * 1024;

// apps/desktop/electron/main/terminal/background-tasks.ts
var import_node_child_process4 = require("node:child_process");
var import_node_util2 = require("node:util");

// apps/desktop/electron/main/terminal/process-table.ts
var import_node_child_process3 = require("node:child_process");
var import_node_util = require("node:util");
var runFile = import_node_util.promisify(import_node_child_process3.execFile);

// apps/desktop/electron/main/terminal/background-tasks.ts
var WORKFLOW_AGENT_MAX = 200;
var WORKFLOW_FILE_MAX = 4 * WORKFLOW_AGENT_MAX;
var META_MAX2 = 64 * 1024;
var STEP = 1024 * 1024;
var runFile2 = import_node_util2.promisify(import_node_child_process4.execFile);
var stoppedTasks = new Set;
var cache = new Map;
var reading2 = new Map;

// apps/desktop/electron/main/terminal/agent-sessions.ts
var PROMPT_SCAN = 16 * 1024 * 1024;
function typed(text) {
  if (typeof text !== "string")
    return null;
  const clean = text.trim();
  if (!clean)
    return null;
  const orchestrate = clean.startsWith("<lanework_orchestrate");
  if (orchestrate || clean.startsWith("<lanework_conductor")) {
    const start = clean.lastIndexOf(`<user_request>
`);
    const end = clean.lastIndexOf(`
</user_request>`);
    if (start === -1 || end < start)
      return null;
    const request = clean.slice(start + 15, end).trim();
    if (!request)
      return null;
    return tidy(orchestrate ? `/orchestrate ${request}` : mentionsAsNames(request));
  }
  if (clean.startsWith("<"))
    return null;
  return tidy(mentionsAsNames(clean));
}
function claudePrompt(line) {
  if (line.type !== "user" || line.isMeta || line.isSidechain)
    return null;
  const content = line.message?.content;
  if (typeof content === "string")
    return typed(content);
  if (Array.isArray(content)) {
    for (const part of content)
      if (part?.type === "text")
        return typed(part.text);
  }
  return null;
}
function claudeImagePrompt(line) {
  if (line.type !== "user" || line.isMeta || line.isSidechain)
    return null;
  const content = line.message?.content;
  if (!Array.isArray(content))
    return null;
  const parts = content;
  if (parts.some((part) => part?.type === "tool_result"))
    return null;
  const images = parts.filter((part) => part?.type === "image").length;
  if (!images)
    return null;
  return images === 1 ? "Image" : `${images} images`;
}
var CARD_SCAN = 4 * 1024 * 1024;
function codexPrompt(line) {
  const payload = line.payload;
  if (line.type === "event_msg" && payload?.type === "user_message")
    return typed(payload.message);
  if (line.type !== "response_item" || payload?.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content))
    return null;
  for (const part of payload.content) {
    if (part?.type !== "input_text" || typeof part.text !== "string")
      continue;
    if (part.text.startsWith("# AGENTS.md"))
      return null;
    const prompt = typed(part.text);
    if (prompt)
      return prompt;
  }
  return null;
}
var text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
function codexRole(meta) {
  const source = meta.source;
  if (!source || typeof source !== "object" || !("subagent" in source))
    return { kind: "conversation" };
  const spawn = source.subagent?.thread_spawn;
  if (!spawn)
    return { kind: "helper" };
  const root = [meta.session_id, spawn.parent_thread_id, meta.parent_thread_id].filter(isAgentSessionId).find((id) => id !== meta.id);
  if (!root)
    return { kind: "helper" };
  const path = text(spawn.agent_path ?? meta.agent_path);
  return {
    kind: "spawned",
    root,
    nickname: text(spawn.agent_nickname ?? meta.agent_nickname),
    task: path ? path.split("/").pop()?.replace(/_/g, " ") ?? null : null,
    role: text(spawn.agent_role)
  };
}

// apps/desktop/electron/main/terminal/opencode-sessions.ts
var import_promises5 = require("node:fs/promises");
var import_node_os4 = require("node:os");
var import_node_path8 = require("node:path");
var DEFAULT_TITLE = /^(New|Child) session - \d{4}-\d{2}-\d{2}T/;
var TITLE_MAX2 = 200;
function opencodeDataDir(home, env = process.env, realHome = true) {
  if (realHome && env.OPENCODE_DATA_DIR)
    return env.OPENCODE_DATA_DIR;
  const app = realHome && env.OPENCODE_APPNAME?.trim() || "opencode";
  if (realHome && env.XDG_DATA_HOME)
    return import_node_path8.join(env.XDG_DATA_HOME, app);
  return import_node_path8.join(home, ".local", "share", app);
}
function opencodeDataDirOf(home) {
  return opencodeDataDir(home, process.env, home === import_node_os4.homedir());
}
function hasTable(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
function schemaOf(db) {
  const v2 = hasTable(db, "session_v2");
  if (!v2 && !hasTable(db, "session"))
    return null;
  const table = v2 ? "session_v2" : "session";
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().flatMap((row) => typeof row.name === "string" ? [row.name] : []));
  return { v2, table, columns };
}
async function withOpencodeDb(dataDir, fallback, read) {
  const file = import_node_path8.join(dataDir, "opencode.db");
  if (!(await import_promises5.stat(file).catch(() => null))?.isFile())
    return fallback;
  let db = null;
  try {
    const driver = await import("node:sqlite");
    db = new driver.DatabaseSync(file, { readOnly: true });
    const schema = schemaOf(db);
    return schema ? read(db, schema) : fallback;
  } catch {
    return fallback;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}
function tidy2(text) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX2 ? `${line.slice(0, TITLE_MAX2 - 1)}…` : line;
}
function opencodeTitle(title) {
  if (typeof title !== "string" || DEFAULT_TITLE.test(title))
    return null;
  return tidy2(title) || null;
}
function opencodePromptText(data) {
  if (typeof data !== "string")
    return null;
  try {
    const text = JSON.parse(data).text;
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  }
}

// apps/desktop/electron/main/transcripts/search.ts
var SESSION_LIMIT = 20;
var SESSION_LIMIT_MAX = 50;
var LINES_PER_SESSION = 3;
var RG_MAX_COUNT = 40;
var FIRST_BATCH_BYTES = 128 * 1024 * 1024;
var SNIPPET_MAX = 200;
var SNIPPET_LEAD = 60;
var OPENING_MAX = 4 * 1024 * 1024;
var OPENCODE_ROWS = 12;
async function searchSessions(query, options = {}) {
  if (!query.trim())
    return [];
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? SESSION_LIMIT)), SESSION_LIMIT_MAX);
  const harnesses = new Set(options.harnesses ?? ["claude", "codex", "opencode"]);
  const home = options.home ?? import_node_os5.homedir();
  const folders = options.folders ? new Set(options.folders) : null;
  const finder = makeFinder(query, options);
  const deadline = Date.now() + (options.timeoutMs ?? 1e4);
  const found = new Map;
  const keep = (match) => {
    const key = `${match.harness}:${match.sessionId}`;
    const had = found.get(key);
    if (!had)
      return void found.set(key, match);
    for (const line of match.lines)
      if (had.lines.length < LINES_PER_SESSION)
        had.lines.push(line);
    if (match.at > had.at)
      had.at = match.at;
  };
  let opencode = null;
  const startOpencode = () => {
    opencode ??= harnesses.has("opencode") ? searchOpencode(home, query, finder, options, folders, limit, deadline) : Promise.resolve([]);
    return opencode;
  };
  const candidates = (await Promise.all([
    harnesses.has("claude") ? claudeCandidates(home, folders) : Promise.resolve([]),
    harnesses.has("codex") ? codexCandidates(home, folders, options.signal) : Promise.resolve([])
  ])).flat().sort((a, b) => b.mtimeMs - a.mtimeMs);
  let timedOut = false;
  let budget = FIRST_BATCH_BYTES;
  let at = 0;
  while (at < candidates.length && found.size < limit) {
    const batch = [];
    let bytes = 0;
    while (at < candidates.length && (batch.length === 0 || bytes < budget)) {
      const next = candidates[at++];
      batch.push(next);
      bytes += next.size;
    }
    budget *= 2;
    const left = deadline - Date.now();
    if (left <= 0) {
      timedOut = true;
      break;
    }
    const searching = searchFiles(batch, query, finder, options, left);
    startOpencode();
    const hits = await searching;
    timedOut = hits.timedOut;
    const matches = await Promise.all(batch.filter((file) => hits.lines.has(file.path)).map((file) => describe(file, hits.lines.get(file.path) ?? [], home, folders)));
    for (const match of matches)
      if (match)
        keep(match);
    if (timedOut)
      break;
  }
  for (const match of await startOpencode())
    keep(match);
  const out = [...found.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  if (timedOut && out.length === 0)
    throw new FsSearchTimeoutError("The search took too long.");
  return out;
}
async function statCandidate(harness, path) {
  const info = await import_promises6.stat(path).catch(() => null);
  return info?.isFile() ? { harness, path, mtimeMs: info.mtimeMs, size: info.size } : null;
}
async function claudeCandidates(home, folders) {
  const root = import_node_path9.join(claudeDir(home), "projects");
  const dirs = folders ? [...new Set([...folders].map(claudeProjectDir))] : await import_promises6.readdir(root).catch(() => []);
  const found = await Promise.all(dirs.map(async (dir) => {
    const names = await import_promises6.readdir(import_node_path9.join(root, dir)).catch(() => []);
    return Promise.all(names.filter((name) => isAgentSessionId(name.replace(/\.jsonl$/, ""))).filter((name) => name.endsWith(".jsonl")).map((name) => statCandidate("claude", import_node_path9.join(root, dir, name))));
  }));
  return found.flat().filter((file) => file !== null);
}
async function codexCandidates(home, folders, signal) {
  const files = [];
  const down = async (dir, depth) => {
    const names = await import_promises6.readdir(dir).catch(() => []);
    await Promise.all(names.map(async (name) => {
      if (depth < 3)
        return down(import_node_path9.join(dir, name), depth + 1);
      if (name.startsWith("rollout-") && name.endsWith(".jsonl"))
        files.push(import_node_path9.join(dir, name));
    }));
  };
  await down(import_node_path9.join(codexHome(home), "sessions"), 0);
  const stated = (await Promise.all(files.map((file) => statCandidate("codex", file)))).filter((file) => file !== null);
  if (!folders)
    return stated;
  signal?.throwIfAborted();
  const metas = await Promise.all(stated.map((file) => codexMeta(file.path)));
  return stated.filter((_, index) => {
    const cwd = metas[index]?.cwd;
    return typeof cwd === "string" && folders.has(cwd);
  });
}
var codexMetas = new Map;
async function codexMeta(file) {
  if (codexMetas.has(file))
    return codexMetas.get(file) ?? null;
  const head = lines(await readRange(file, 0, META_CHUNK).catch(() => ""), {
    head: true
  });
  const meta = head.find((line) => line.type === "session_meta")?.payload ?? null;
  if (meta)
    codexMetas.set(file, meta);
  return meta;
}
var MATCH_HEAD = /^\{"type":"match","data":\{"path":\{"text":"((?:[^"\\]|\\.)*)"\}/;
var LINE_PARSE_MAX = 2 * 1024 * 1024;
var SPOKEN_TYPES = {
  claude: ["\\\"type\\\":\\\"user\\\"", "\\\"type\\\":\\\"assistant\\\""],
  codex: ["\\\"type\\\":\\\"response_item\\\"", "\\\"type\\\":\\\"event_msg\\\""]
};
async function searchFiles(batch, query, finder, options, timeoutMs) {
  const out = new Map;
  const harness = new Map(batch.map((file) => [file.path, file.harness]));
  const args = [
    "--json",
    options.regex ? "--no-fixed-strings" : "--fixed-strings",
    options.caseSensitive ? "--case-sensitive" : "--ignore-case",
    "--max-count",
    String(RG_MAX_COUNT),
    "--no-messages",
    "--regexp",
    query,
    "--",
    ...batch.map((file) => file.path)
  ];
  const result = await runRg(args, {
    cwd: batch[0] ? import_node_path9.join(batch[0].path, "..") : import_node_os5.homedir(),
    timeoutMs,
    signal: options.signal,
    onLine: (raw) => {
      const head = MATCH_HEAD.exec(raw);
      if (!head || raw.length > LINE_PARSE_MAX)
        return;
      let path;
      try {
        path = JSON.parse(`"${head[1]}"`);
      } catch {
        return;
      }
      const kind = harness.get(path);
      const kept = out.get(path) ?? [];
      if (!kind || kept.length >= LINES_PER_SESSION)
        return;
      if (!SPOKEN_TYPES[kind].some((type) => raw.includes(type)))
        return;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }
      const text = event.data.lines?.text;
      if (text === undefined)
        return;
      const snippet = snippetOf(kind, text, event.data.line_number ?? 0, finder);
      if (!snippet || kept.some((line) => line.text === snippet.text))
        return;
      kept.push(snippet);
      out.set(path, kept);
      return;
    }
  });
  return { lines: out, timedOut: result.timedOut };
}
var NOT_SAID = new Set([
  "id",
  "type",
  "uuid",
  "parentUuid",
  "tool_use_id",
  "call_id",
  "signature",
  "data",
  "encrypted_content",
  "media_type",
  "model",
  "cwd",
  "providerID"
]);
var INJECTED = /^(<[a-z][\w-]*[\s>]|# AGENTS\.md)/;
function said(value, out, depth = 0) {
  if (depth > 8 || out.length > 200)
    return;
  if (typeof value === "string") {
    if (!INJECTED.test(value.trimStart()))
      out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value)
      said(item, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value))
      if (!NOT_SAID.has(key))
        said(item, out, depth + 1);
  }
}
function spoken(harness, line) {
  if (harness === "claude") {
    if (line.type !== "user" && line.type !== "assistant")
      return;
    if (line.isMeta)
      return;
    return line.message?.content;
  }
  if (line.type !== "response_item" && line.type !== "event_msg")
    return;
  return line.payload;
}
function snippetOf(harness, raw, line, finder) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object")
    return null;
  const texts = [];
  said(spoken(harness, parsed), texts);
  return snippetFrom(texts, line, finder);
}
function snippetFrom(texts, line, finder) {
  for (const text of texts) {
    const pattern = finder(text);
    const first = pattern.exec(text);
    if (!first)
      continue;
    const start = first.index;
    const end = start + first[0].length;
    const from = Math.max(0, start - SNIPPET_LEAD * 2);
    const to = Math.min(text.length, end + SNIPPET_MAX * 2);
    let window = text.slice(from, to).replace(/\s+/g, " ");
    const lead = window.search(finder(window));
    if (lead === -1)
      continue;
    const cut = Math.max(0, lead - SNIPPET_LEAD);
    window = window.slice(cut, cut + SNIPPET_MAX);
    const before = from > 0 || cut > 0 ? "…" : "";
    const after = to < text.length || window.length >= SNIPPET_MAX ? "…" : "";
    const body = `${before}${window.trim()}${after}`;
    const ranges = [];
    const marks = finder(body);
    for (const match of body.matchAll(new RegExp(marks.source, `${marks.flags}g`))) {
      if (!match[0])
        break;
      ranges.push([match.index, match.index + match[0].length]);
    }
    if (ranges.length === 0)
      continue;
    return { line, text: body, ranges };
  }
  return null;
}
function makeFinder(query, options) {
  const flags = options.caseSensitive ? "u" : "iu";
  let source = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (options.regex) {
    try {
      new RegExp(query, flags);
      source = query;
    } catch {}
  }
  return () => new RegExp(source, flags);
}
var titles = new Map;
async function describe(file, matched, home, folders) {
  const cached = titles.get(file.path);
  let value;
  if (cached && cached.mtimeMs === file.mtimeMs)
    value = cached.value;
  else {
    value = await (file.harness === "claude" ? claudeDescribed(file) : codexDescribed(file, home)).catch(() => null);
    titles.set(file.path, { mtimeMs: file.mtimeMs, value });
  }
  if (!value)
    return null;
  if (folders && value.cwd !== null && !folders.has(value.cwd))
    return null;
  const root = file.harness === "claude" ? claudeDir(home) : codexHome(home);
  return {
    harness: file.harness,
    sessionId: value.sessionId,
    title: value.title,
    at: new Date(file.mtimeMs).toISOString(),
    file: import_node_path9.relative(root, file.path).split(import_node_path9.sep).join("/"),
    lines: matched
  };
}
async function claudeDescribed(file) {
  const head = lines(await readRange(file.path, 0, CHUNK), { head: true });
  const tail = file.size > CHUNK ? lines(await readRange(file.path, file.size - CHUNK, CHUNK), {
    head: false
  }) : head;
  const named = [...tail, ...head].reverse().find((line) => line.type === "ai-title" && typeof line.aiTitle === "string")?.aiTitle;
  const cwd = head.find((line) => typeof line.cwd === "string")?.cwd;
  let title = named ? tidy(named) : head.map(claudePrompt).find(Boolean);
  if (!title) {
    const opening = lines(await readRange(file.path, 0, OPENING_MAX), {
      head: true
    });
    title = opening.map(claudePrompt).find(Boolean) ?? opening.map(claudeImagePrompt).find(Boolean);
  }
  return {
    sessionId: import_node_path9.basename(file.path, ".jsonl"),
    title: title ?? "Untitled conversation",
    cwd: typeof cwd === "string" ? cwd : null
  };
}
var codexNamesRead = null;
async function codexIndex(home) {
  const file = import_node_path9.join(codexHome(home), "session_index.jsonl");
  const mtimeMs = (await import_promises6.stat(file).catch(() => null))?.mtimeMs ?? 0;
  if (codexNamesRead?.file === file && codexNamesRead.mtimeMs === mtimeMs)
    return codexNamesRead.names;
  const names = new Map;
  const text = await readText(file, 16 * 1024 * 1024) ?? "";
  for (const line of lines(`${text}
`, { head: true }))
    if (typeof line.id === "string" && typeof line.thread_name === "string")
      names.set(line.id, line.thread_name);
  codexNamesRead = { file, mtimeMs, names };
  return names;
}
async function codexDescribed(file, home) {
  const meta = await codexMeta(file.path);
  if (!meta || !isAgentSessionId(meta.id))
    return null;
  const role = codexRole(meta);
  if (role.kind === "helper")
    return null;
  const sessionId = role.kind === "spawned" ? role.root : meta.id;
  const named = (await codexIndex(home)).get(sessionId);
  let title = named ? tidy(named) : null;
  if (!title && role.kind === "conversation") {
    const head = lines(await readRange(file.path, 0, META_CHUNK), {
      head: true
    });
    title = head.map(codexPrompt).find(Boolean) ?? null;
  }
  return {
    sessionId,
    title: title ?? "Codex conversation",
    cwd: typeof meta.cwd === "string" ? meta.cwd : null
  };
}
async function searchOpencode(home, query, finder, options, folders, limit, deadline) {
  if (folders?.size === 0)
    return [];
  return withOpencodeDb(opencodeDataDirOf(home), [], (db) => {
    let test;
    let bound;
    if (options.regex) {
      const pattern = finder("");
      db.function("lw_matches", { deterministic: true }, (value) => typeof value === "string" && pattern.test(value) ? 1 : 0);
      test = "lw_matches(data) = 1 AND ?2 IS NOT NULL";
      bound = query;
    } else if (options.caseSensitive) {
      test = "instr(data, ?2) > 0";
      bound = query;
    } else {
      test = "data LIKE ?2 ESCAPE '\\'";
      bound = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    }
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    const scope = folders ? JSON.stringify([...folders]) : null;
    const sources = [];
    if (tables.has("session_v2") && tables.has("session_message"))
      sources.push({
        table: "session_v2",
        rows: db.prepare(`SELECT seq, data FROM session_message
            WHERE session_id = ?1 AND type IN ('user', 'assistant')
              AND ${test}
            ORDER BY seq LIMIT ${OPENCODE_ROWS}`)
      });
    if (tables.has("session") && tables.has("part"))
      sources.push({
        table: "session",
        rows: db.prepare(`SELECT 0 AS seq, data FROM part
            WHERE session_id = ?1 AND ${test}
            ORDER BY time_created LIMIT ${OPENCODE_ROWS}`)
      });
    const sessions = sources.flatMap(({ table, rows }) => db.prepare(`SELECT id, parent_id AS parent, title, time_updated AS updated
               FROM ${table}
              WHERE ?1 IS NULL OR directory IN (SELECT value FROM json_each(?1))`).all(scope).map((session) => ({ ...session, table, rows })));
    sessions.sort((a, b) => (typeof b.updated === "number" ? b.updated : 0) - (typeof a.updated === "number" ? a.updated : 0));
    const out = new Map;
    for (const session of sessions) {
      if (out.size >= limit || Date.now() > deadline)
        break;
      if (typeof session.id !== "string")
        continue;
      const sessionId = typeof session.parent === "string" ? session.parent : session.id;
      const found = out.get(sessionId);
      if (found && found.lines.length >= LINES_PER_SESSION)
        continue;
      const kept = found?.lines ?? [];
      for (const row of session.rows.all(session.id, bound)) {
        if (kept.length >= LINES_PER_SESSION)
          break;
        let data;
        try {
          data = JSON.parse(String(row.data));
        } catch {
          continue;
        }
        const texts = [];
        said(data, texts);
        const seq = typeof row.seq === "number" ? row.seq : 0;
        const snippet = snippetFrom(texts, seq, finder);
        if (snippet && !kept.some((line) => line.text === snippet.text))
          kept.push(snippet);
      }
      if (found || kept.length === 0)
        continue;
      const updated = typeof session.updated === "number" ? session.updated : 0;
      out.set(sessionId, {
        harness: "opencode",
        sessionId,
        title: opencodeSessionTitle(db, session.table, sessionId) ?? "OpenCode session",
        at: new Date(updated).toISOString(),
        file: "opencode.db",
        lines: kept
      });
    }
    return [...out.values()];
  });
}
function opencodeSessionTitle(db, table, id) {
  const row = db.prepare(`SELECT title FROM ${table} WHERE id = ?`).get(id);
  const named = opencodeTitle(row?.title);
  if (named || table !== "session_v2")
    return named;
  const first = db.prepare(`SELECT data FROM session_message
        WHERE session_id = ? AND type = 'user' ORDER BY seq LIMIT 1`).get(id);
  const prompt = opencodePromptText(first?.data);
  return prompt ? tidy(prompt) : null;
}

// apps/desktop/electron/mcp-local/tools.ts
var BOARD_ID = {
  type: "string",
  description: "The board's id (the local project id) from list_boards. There is no default."
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
  const project = store.getProject(String(boardId));
  if (!project)
    fail("not_found", `board ${String(boardId)} not found; call list_boards for its id`);
  return project;
}
function cardOf(store, board, card) {
  const detail = store.getWorkItem(String(card), { project: board.id });
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
        const boards = store.boardSummaries();
        return {
          boards,
          next: boards.length === 0 ? "No boards yet. Ask the user whether to create one for this repo (create_board)." : "Ask the user which board this repo belongs to; never pick one by its name."
        };
      }
      const repo = normalizeRepo(remote);
      if (!repo)
        fail("invalid", `not a git remote: ${remote}`);
      const boards = store.boardSummaries(remote);
      return {
        repo,
        boards,
        next: boards.length === 1 ? "Use this board." : boards.length === 0 ? "No board is linked to this repo. Call list_boards without repo and ask the user which board it belongs to, or whether to create a new one; then link_repo or create_board." : "Several boards are linked to this repo. Ask the user which one."
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
        description: "Board name the user agreed to, e.g. `acme/widgets`"
      },
      repo: REPO,
      slug: {
        type: "string",
        description: "Lower-case hyphenated key; omitted = derived from the name."
      }
    },
    required: ["name", "repo"],
    run(args, { store }) {
      const project = store.createProject({
        name: String(args.name),
        slug: str2(args.slug),
        repo: String(args.repo)
      });
      return {
        board_id: project.id,
        board: {
          workspaceId: project.id,
          name: project.name,
          slug: project.slug,
          repo: project.repo
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
        project: board.id
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
        const keys = new Set(current.checklist.map((item) => item.key));
        const unknown = Object.keys(retag).filter((key) => !keys.has(key));
        if (unknown.length > 0)
          fail("not_found", `checklist item ${unknown.join(", ")} not found`);
        checklist = asInput(current.checklist).map((item) => item.key && (item.key in retag) ? { ...item, stream: retag[item.key] ?? null } : item);
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
      }, { project: board.id, ifRevision: current.revision });
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
      const item = store.toggleChecklistItem(String(args.card), String(args.key), patch, { project: board.id });
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
      const byKey = new Map(items.map((item) => [item.key, item]));
      const missing = picks.filter((pick) => !byKey.has(pick.key));
      if (missing.length > 0)
        fail("not_found", `checklist item ${missing.map((pick) => pick.key).join(", ")} not found`);
      const tickedGroups = new Map;
      for (const pick of picks) {
        const item = byKey.get(pick.key);
        item.checked = pick.checked;
        if (pick.note !== undefined)
          item.note = pick.note || null;
        if (pick.checked && item.group) {
          const other = tickedGroups.get(item.group);
          if (other)
            fail("invalid", `${other} and ${pick.key} are options of the same pick-ONE group "${item.group}"; pick one`);
          tickedGroups.set(item.group, pick.key);
        }
      }
      for (const [group, key] of tickedGroups)
        for (const item of items)
          if (item.group === group && item.key !== key)
            item.checked = false;
      const item = store.updateWorkItem(current.id, { checklist: items }, {
        project: board.id,
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
    description: "Move a card to another lane, the board's status columns. Finished, verified work goes to the review lane, not done. Moving it to a done or archive lane clears its checkpoints.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      card: CARD,
      status: {
        type: "string",
        description: "Lane key, e.g. todo | processing | review | done"
      },
      reason: {
        type: "string",
        description: "What to change when sending a card back from review. Accepted and not stored on a local board, which keeps no history."
      }
    },
    required: ["board_id", "card", "status"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const item = store.setStatus(String(args.card), String(args.status), {
        project: board.id
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
        project: board.id
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
        project: board.id,
        agent
      });
      return { checkpoint };
    }
  },
  {
    name: "lifecycle_status",
    description: "What the board is waiting on: cards whose decisions are not all ticked (waiting), cards cleared to start (ready), cards being worked (in flight), and cards waiting for a human to review (review).",
    readOnly: true,
    properties: { board_id: BOARD_ID },
    required: ["board_id"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const order = columnOrder(board);
      const waiting = [];
      const ready = [];
      const inFlight = [];
      const review = [];
      for (const card of store.listWorkItems(board.id)) {
        const role = order.get(card.columnKey)?.role ?? null;
        if (role === "done" || role === "archive")
          continue;
        if (role === "review") {
          review.push(brief(card));
          continue;
        }
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
      return { waiting, ready, inFlight, review };
    }
  },
  {
    name: "search_sessions",
    description: "Search this machine's Claude Code, Codex and OpenCode conversations for a phrase in what was said (prompts, answers, tool calls and output), newest first. Returns each session's harness, id, title, last write and up to 3 matching snippets.",
    readOnly: true,
    properties: {
      query: { type: "string", description: "A literal phrase, not a regex" },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: SESSION_LIMIT_MAX,
        description: `Sessions returned; default ${SESSION_LIMIT}`
      },
      folder: {
        type: "string",
        description: "Only sessions run in this folder (an absolute path, e.g. the repo's root); every folder's when omitted"
      }
    },
    required: ["query"],
    async run(args) {
      const query = String(args.query).trim();
      if (!query)
        fail("invalid", "query is empty");
      const folder = str2(args.folder);
      const sessions = await searchSessions(query, {
        limit: typeof args.limit === "number" ? args.limit : undefined,
        folders: folder ? [folder] : undefined
      });
      return { sessions };
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
function text2(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...isError ? { isError: true } : {}
  };
}

class LocalMcpSession {
  store;
  #agent = "agent";
  #host = import_node_os6.hostname();
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
      const result = this.#dispatch(method, params);
      if (result instanceof Promise)
        return result.then((value) => ({ jsonrpc: "2.0", id, result: value }));
      return { jsonrpc: "2.0", id, result };
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
    const failed = (error) => {
      if (error instanceof LocalStoreError)
        return text2({ error: error.code, message: error.message }, true);
      if (error instanceof InvalidParams)
        return text2({ error: "invalid", message: error.message }, true);
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`lanework mcp: ${tool.name} failed: ${message}
`);
      return text2({ error: "internal", message }, true);
    };
    try {
      const result = tool.run(checkShape(tool, params.arguments), ctx);
      if (result instanceof Promise)
        return result.then((value) => text2(value), failed);
      return text2(result);
    } catch (error) {
      return failed(error);
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
    const pending = parsed.map((message) => session.handle(message));
    const lines = (all) => {
      const answers = all.filter((answer) => answer !== null);
      return answers.length > 0 ? [JSON.stringify(answers)] : [];
    };
    return pending.some((answer) => answer instanceof Promise) ? Promise.all(pending).then(lines) : lines(pending);
  }
  const answer = session.handle(parsed);
  if (answer instanceof Promise)
    return answer.then((value) => [JSON.stringify(value)]);
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
    const inFlight = new Set;
    const report = (error) => {
      process.stderr.write(`lanework mcp: ${error instanceof Error ? error.stack : String(error)}
`);
    };
    const write = (lines) => {
      for (const out of lines)
        output.write(`${out}
`);
    };
    const respond = (line) => {
      try {
        const lines = handleLine(session, line);
        if (!(lines instanceof Promise))
          return write(lines);
        const later = lines.then(write, report).finally(() => {
          inFlight.delete(later);
        });
        inFlight.add(later);
      } catch (error) {
        report(error);
      }
    };
    let done = false;
    const finish = () => {
      if (done)
        return;
      done = true;
      flush(true);
      Promise.allSettled([...inFlight]).then(() => {
        store.close();
        resolve();
      });
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
init_src();
var import_node_child_process5 = require("node:child_process");
var import_node_crypto3 = require("node:crypto");
var import_node_fs3 = require("node:fs");
var import_node_os7 = require("node:os");
var import_node_path10 = require("node:path");
var KEYCHAIN_SERVICE = "dev.lanework.checkpoint-hook";
var SECURITY = "/usr/bin/security";
function configDir() {
  return import_node_path10.join(process.env.XDG_CONFIG_HOME || import_node_path10.join(import_node_os7.homedir(), ".config"), "lanework");
}
function originOf(api) {
  try {
    return new URL(api).origin;
  } catch {
    return api;
  }
}
function secretFile(api) {
  if (process.env.LANEWORK_HOOK_SECRET_FILE)
    return process.env.LANEWORK_HOOK_SECRET_FILE;
  if (process.platform === "darwin")
    return null;
  const origin = originOf(api);
  if (origin === DEFAULT_API_ORIGIN)
    return import_node_path10.join(configDir(), "credential");
  const key = import_node_crypto3.createHash("sha256").update(origin).digest("hex").slice(0, 16);
  return import_node_path10.join(configDir(), `credential-${key}`);
}
function credentialLocation(api) {
  return secretFile(api) ?? `macOS Keychain (${KEYCHAIN_SERVICE})`;
}
function unsafe(value) {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === '"' || char === "\\" || code < 32 || code === 127)
      return true;
  }
  return false;
}
function assertSafe(what, value) {
  if (!value || unsafe(value))
    throw new Error(`Refusing to store a ${what} with unsafe characters.`);
}
function readSecret(api) {
  const file = secretFile(api);
  if (file) {
    try {
      return import_node_fs3.readFileSync(file, "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  try {
    return import_node_child_process5.execFileSync(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", api, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
function writeSecret(api, secret) {
  assertSafe("credential", secret);
  const file = secretFile(api);
  if (file) {
    import_node_fs3.mkdirSync(import_node_path10.dirname(file), { recursive: true, mode: 448 });
    import_node_fs3.writeFileSync(file, `${secret}
`, { mode: 384 });
    import_node_fs3.chmodSync(file, 384);
    return;
  }
  assertSafe("API address", api);
  import_node_child_process5.execFileSync(SECURITY, ["-i"], {
    input: `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${api}" -w "${secret}"
`,
    stdio: ["pipe", "ignore", "inherit"]
  });
}
function deleteSecret(api) {
  const file = secretFile(api);
  if (file) {
    import_node_fs3.rmSync(file, { force: true });
    return;
  }
  try {
    import_node_child_process5.execFileSync(SECURITY, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", api], { stdio: "ignore" });
  } catch {}
}

// apps/desktop/electron/hook/cli.ts
var pluginConfigPath = () => import_node_path11.join(configDir(), "hook.json");
function readConfig() {
  try {
    return JSON.parse(import_node_fs4.readFileSync(pluginConfigPath(), "utf8"));
  } catch {
    return {};
  }
}
function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!opener)
    return false;
  try {
    import_node_child_process6.spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
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
function save2(api, issued) {
  writeSecret(api, issued.secret);
  if (readSecret(api) !== issued.secret)
    throw new Error("Signed in, but the credential could not be read back.");
  return `Signed in as machine ${issued.machineId}. Saved to ${credentialLocation(api)}.
${outcome()}`;
}
async function startDeviceLogin(api, stateDir) {
  const { verifier, challenge } = pkcePair();
  const started = await startDevice(api, { challenge, facts: machineFacts() });
  import_node_fs4.mkdirSync(stateDir, { recursive: true, mode: 448 });
  const file = import_node_path11.join(stateDir, `device-${process.pid}-${Date.now()}.json`);
  const pending = {
    api,
    deviceCode: started.deviceCode,
    verifier,
    interval: started.interval,
    deadline: Date.now() + DEVICE_TTL_MS
  };
  import_node_fs4.writeFileSync(file, JSON.stringify(pending), { mode: 384 });
  import_node_child_process6.spawn(process.execPath, [process.argv[1] ?? "", "--plugin", "login-wait", file], { detached: true, stdio: "ignore" }).unref();
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
      import_node_fs4.mkdirSync(stateDir, { recursive: true, mode: 448 });
      import_node_fs4.appendFileSync(import_node_path11.join(stateDir, "hook.log"), `${new Date().toISOString()} device sign-in: ${line}
`, { mode: 384 });
    } catch {}
  };
  let pending;
  try {
    pending = JSON.parse(import_node_fs4.readFileSync(file, "utf8"));
  } finally {
    import_node_fs4.rmSync(file, { force: true });
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
      note(save2(pending.api, result).split(`
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
  console.log(save2(api, await loginLoopback(api)));
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
    for (const name of import_node_fs4.readdirSync(stateDir)) {
      if (!name.startsWith("session-"))
        continue;
      const s = JSON.parse(import_node_fs4.readFileSync(import_node_path11.join(stateDir, name), "utf8"));
      if (typeof s.at === "number" && s.taskId && (!best || s.at > best.at))
        best = { at: s.at, taskId: s.taskId };
    }
    if (best)
      last = `${best.taskId} at ${new Date(best.at).toLocaleString()}`;
  } catch {}
  console.log([
    `API:              ${api}`,
    `Signed in:        ${signedIn}`,
    `Credential:       ${credentialLocation(api)}`,
    `Push unfinished:  ${readConfig().pushWip ? "on" : "off"} (lanework config push-wip on|off)`,
    `  with new files: ${readConfig().pushWipUntracked ? "on" : "off"} (lanework config push-wip-untracked on|off)`,
    `Last checkpoint:  ${last}`,
    ...desktopHook ? [
      "Desktop app:      its hook is installed, so this plugin's hook stays quiet (one checkpoint per turn)"
    ] : [],
    `Log:              ${import_node_path11.join(stateDir, "hook.log")}`
  ].join(`
`));
}
var CONFIG_KEYS = {
  "push-wip": {
    field: "pushWip",
    on: "The hook will also push uncommitted changes to tracked files to refs/lanework/wip/<task id>. New files go too only with `lanework config push-wip-untracked on`. Anyone who can read the remote can fetch that ref.",
    off: "The hook will not push code."
  },
  "push-wip-untracked": {
    field: "pushWipUntracked",
    on: "When it pushes unfinished work, the hook will also include new files that are not ignored. Anyone who can read the remote can fetch that ref. A snapshot that looks like it holds a secret (an .env or key file, or a token in an added line) is never pushed.",
    off: "When it pushes unfinished work, the hook will include changes to tracked files only."
  }
};
function config(key, value) {
  const entry = key && Object.hasOwn(CONFIG_KEYS, key) ? CONFIG_KEYS[key] : null;
  if (!entry || value !== "on" && value !== "off") {
    console.error(`usage: lanework config push-wip on|off
       lanework config push-wip-untracked on|off`);
    process.exitCode = 1;
    return;
  }
  const next = { ...readConfig(), [entry.field]: value === "on" };
  import_node_fs4.mkdirSync(configDir(), { recursive: true, mode: 448 });
  import_node_fs4.writeFileSync(pluginConfigPath(), `${JSON.stringify(next, null, 2)}
`, {
    mode: 384
  });
  const said = value === "on" ? entry.on : entry.off;
  console.log(entry.field === "pushWipUntracked" && value === "on" && !next.pushWip ? `${said}
Nothing is pushed until \`lanework config push-wip on\`.` : said);
}
function desktopHookInstalled() {
  const settings = import_node_path11.join(process.env.CLAUDE_CONFIG_DIR || import_node_path11.join(import_node_os8.homedir(), ".claude"), "settings.json");
  if (!import_node_fs4.existsSync(settings))
    return false;
  try {
    return import_node_fs4.readFileSync(settings, "utf8").includes("lanework-checkpoint");
  } catch {
    return false;
  }
}
function mcp() {
  return runLocalMcpServer();
}

// apps/desktop/electron/hook/compaction.ts
var import_node_crypto4 = require("node:crypto");
var import_node_fs5 = require("node:fs");
var import_node_path12 = require("node:path");
var COMPACT_WINDOW_MS = 15 * 60 * 1000;
var REMINDABLE_ID = /^[A-Z][A-Z0-9]{0,9}-\d{1,6}$/;
function isRemindableTaskId(taskId) {
  return REMINDABLE_ID.test(taskId);
}
function compactReminder(taskId) {
  return `Lanework: the context was just compacted while you were working ${taskId}. Before continuing, call the lanework \`checkpoint\` tool for card ${taskId} with \`next_step\` (and a \`summary\` of where the work stands).`;
}
function sessionStartOutput(context) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context
    }
  });
}
function markerFile(stateDir, sessionId) {
  const id = import_node_crypto4.createHash("sha256").update(sessionId).digest("hex");
  return import_node_path12.join(stateDir, `compact-${id}.json`);
}
function writeMarker(file, marker) {
  import_node_fs5.writeFileSync(file, JSON.stringify(marker), { mode: 384 });
}
function markCompaction(stateDir, sessionId) {
  import_node_fs5.mkdirSync(stateDir, { recursive: true, mode: 448 });
  writeMarker(markerFile(stateDir, sessionId), { at: Date.now() });
}
function noteCompactionCard(stateDir, sessionId, taskId) {
  const file = markerFile(stateDir, sessionId);
  let marker;
  try {
    marker = JSON.parse(import_node_fs5.readFileSync(file, "utf8"));
  } catch {
    return;
  }
  writeMarker(file, { ...marker, taskId });
}
function takeCompactionMarker(stateDir, sessionId) {
  const file = markerFile(stateDir, sessionId);
  const taken = `${file}.${process.pid}.taken`;
  try {
    import_node_fs5.renameSync(file, taken);
  } catch {
    return null;
  }
  try {
    const marker = JSON.parse(import_node_fs5.readFileSync(taken, "utf8"));
    if (typeof marker.at !== "number")
      return null;
    if (Date.now() - marker.at > COMPACT_WINDOW_MS)
      return null;
    return marker;
  } catch {
    return null;
  } finally {
    import_node_fs5.rmSync(taken, { force: true });
  }
}

// apps/desktop/electron/hook/local-board.ts
init_local_store();
var import_node_fs6 = require("node:fs");
function localBoardFor(remote, path = localStorePath()) {
  if (!import_node_fs6.existsSync(path))
    return null;
  const store = openLocalStore({ path });
  try {
    const boards = store.findProjectsByRepo(remote).filter((project) => !project.cloudId);
    const board = boards.length === 1 ? boards[0] : undefined;
    if (!board) {
      store.close();
      return null;
    }
    return { store, projectId: board.id };
  } catch (error) {
    store.close();
    throw error;
  }
}
function writeLocalCheckpoint(board, taskId, body, agent) {
  return board.store.addCheckpoint(taskId, body, {
    project: board.projectId,
    agent
  }).id;
}

// apps/desktop/electron/hook/redact.ts
var R = "[REDACTED]";
var SECRET_FLAG = /(--(?:password|passwd|pass|token|api-key|apikey|secret|client-secret|access-token|auth-token)(?:=|\s+))(["']?)(?!-)(?!\[REDACTED)[^\s"']+/gi;
var RULES = [
  [
    /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?(?:-----END \1-----|$)/g,
    "[REDACTED $1]"
  ],
  [/\blw_(?:reg|mch|dev|code)_[A-Za-z0-9_-]+/g, R],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, R],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, R],
  [
    /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g,
    R
  ],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bgl(?:pat|dt|rt|ptt|cbt|imt|oas|soat|ft|agent)-[A-Za-z0-9_-]{16,}/g, R],
  [/\bnpm_[A-Za-z0-9]{20,}/g, R],
  [/\bhf_[A-Za-z0-9]{20,}/g, R],
  [/\bpypi-[A-Za-z0-9_-]{30,}/g, R],
  [/\bxox[abposre]-[A-Za-z0-9-]{10,}/g, R],
  [/\bxapp-[A-Za-z0-9-]{10,}/g, R],
  [/\bhooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, `hooks.slack.com/${R}`],
  [/\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, R],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, R],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, R],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    "[REDACTED jwt]"
  ],
  [/\b(Bearer|Basic)\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${R}`],
  [
    /(\bAuthorization\s*[:=]\s*["']?(?:[A-Za-z]+\s+)?)(?!\[REDACTED)[^\s"',;]{8,}/gi,
    `$1${R}`
  ],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${R}@`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]{16,}@/gi, `$1${R}@`],
  [/((?:^|\s)(?:-u|--user)(?:=|\s*))(["']?)[^\s"':]+:[^\s"']+/g, `$1$2${R}`],
  [
    /(\b(?:docker|podman|nerdctl|helm)\s+(?:registry\s+)?login\b[^\n]*?\s-p\s*)(["']?)(?!-)[^\s"']+/g,
    `$1$2${R}`
  ],
  [/(\bsshpass\s+(?:-\w+\s+)*?-p\s*)(["']?)(?!-)[^\s"']+/g, `$1$2${R}`],
  [
    /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n]*?\s-p)(["']?)(?![\s"'-])[^\s"']+/g,
    `$1$2${R}`
  ],
  [SECRET_FLAG, `$1$2${R}`],
  [
    /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|passw(?:or)?d|passphrase|token|credential|private[_-]?key|access[_-]?key|auth[_-]?key)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)(?!\[REDACTED)[^\s"',;]{6,}/gi,
    `$1$2${R}`
  ]
];
function redact(input) {
  let out = input;
  for (const [pattern, replacement] of RULES)
    out = out.replace(pattern, replacement);
  return out;
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
var LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
function checkedApi(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const ok = url.protocol === "https:" || url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (!ok)
    return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}
var API_ASKED = (typeof ARGS.flags.get("api") === "string" ? ARGS.flags.get("api") : "") || process.env.LANEWORK_API_URL || DEFAULT_API_ORIGIN;
var API_REFUSED = checkedApi(API_ASKED) === null;
var API = checkedApi(API_ASKED) ?? DEFAULT_API_ORIGIN;
function hookConfig() {
  const file = process.env.LANEWORK_HOOK_CONFIG || (ARGS.flags.has("plugin") ? pluginConfigPath() : null);
  if (!file)
    return {};
  try {
    return JSON.parse(import_node_fs7.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
var HOOK_CONFIG = hookConfig();
var PUSH_WIP = ARGS.flags.has("push-wip") || HOOK_CONFIG.pushWip === true;
var PUSH_WIP_UNTRACKED = ARGS.flags.has("push-wip-untracked") || HOOK_CONFIG.pushWipUntracked === true;
var AGENT = ARGS.flags.get("agent") === "codex" ? "codex" : ARGS.flags.get("agent") === "opencode" ? "opencode" : "claude-code";
var AGENT_NAME = AGENT === "codex" ? "Codex" : AGENT === "opencode" ? "OpenCode" : "Claude Code";
var STATE_DIR = import_node_path13.join(import_node_os9.homedir(), ".cache", "lanework", "checkpoint");
var LOG = import_node_path13.join(STATE_DIR, "hook.log");
var THIN_MS = 60000;
var PUSH_TIMEOUT_MS = 30000;
var HTTP_TIMEOUT_MS = 1e4;
function log(message) {
  try {
    import_node_fs7.mkdirSync(STATE_DIR, { recursive: true, mode: 448 });
    if (import_node_fs7.existsSync(LOG)) {
      const { size, mode } = import_node_fs7.statSync(LOG);
      if (size > 512 * 1024)
        import_node_fs7.rmSync(LOG);
      else if (mode & 63)
        import_node_fs7.chmodSync(LOG, 384);
    }
    import_node_fs7.appendFileSync(LOG, `${new Date().toISOString()} ${redact(message)}
`, {
      mode: 384
    });
  } catch {}
}
function git(cwd, args, env) {
  const safe = args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
  return import_node_child_process7.execFileSync("git", [...READ_FLAGS, ...safe], {
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
var sha256 = (s) => import_node_crypto5.createHash("sha256").update(s).digest("hex");
function clip2(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
function readJson(file, fallback) {
  try {
    return JSON.parse(import_node_fs7.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  import_node_fs7.mkdirSync(STATE_DIR, { recursive: true, mode: 448 });
  import_node_fs7.writeFileSync(file, JSON.stringify(value), { mode: 384 });
}
function repoPath(path, root) {
  const trimmed = path.trim();
  if (!trimmed)
    return null;
  const rel = import_node_path13.isAbsolute(trimmed) ? import_node_path13.relative(root, trimmed) : trimmed;
  if (!rel || import_node_path13.isAbsolute(rel) || rel.startsWith("..") || rel.startsWith("~"))
    return null;
  return rel;
}
function humanText(content) {
  const raw = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join(`
`) : "";
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text || text.startsWith("<"))
    return null;
  return text;
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
            const rel = repoPath(path, root);
            if (rel) {
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
  const base = import_node_path13.join(process.env.CODEX_HOME || import_node_path13.join(import_node_os9.homedir(), ".codex"), "sessions");
  const ls = (dir) => {
    try {
      return import_node_fs7.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  let days = 0;
  for (const year of ls(base))
    for (const month of ls(import_node_path13.join(base, year)))
      for (const day of ls(import_node_path13.join(base, year, month))) {
        if (++days > 3)
          return null;
        const dir = import_node_path13.join(base, year, month, day);
        const hit = ls(dir).find((name) => name.endsWith(`${sessionId}.jsonl`));
        if (hit)
          return import_node_path13.join(dir, hit);
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
  const touch = (list, path) => {
    const rel = repoPath(path.trim().replace(/^file:\/\//, ""), root);
    if (!rel)
      return;
    const at = list.indexOf(rel);
    if (at !== -1)
      list.splice(at, 1);
    list.push(rel);
  };
  const typed = (text) => {
    if (!text || text.startsWith("<") || text.startsWith("# AGENTS.md"))
      return;
    request = text;
    if (replies.length)
      previousReplies = replies;
    replies = [];
    for (const m of text.match(TASK_ID) ?? [])
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
        const text = texts(item.content);
        if (text)
          replies.push(text);
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
function opencodeDataDir2() {
  if (process.env.OPENCODE_DATA_DIR)
    return process.env.OPENCODE_DATA_DIR;
  if (process.env.XDG_DATA_HOME)
    return import_node_path13.join(process.env.XDG_DATA_HOME, "opencode");
  return import_node_path13.join(import_node_os9.homedir(), ".local", "share", "opencode");
}
var asObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
function parseData(raw) {
  if (typeof raw !== "string")
    return {};
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return {};
  }
}
function opencodeTool(block) {
  const name = typeof block.name === "string" ? block.name : typeof block.tool === "string" ? block.tool : null;
  if (!name)
    return null;
  const state = asObject(block.state);
  const metadata = asObject(state.metadata);
  const output = typeof state.output === "string" ? state.output : Array.isArray(state.content) ? state.content.map((part) => {
    const text = asObject(part).text;
    return typeof text === "string" ? text : "";
  }).join(`
`) : "";
  return {
    name,
    input: asObject(state.input),
    status: typeof state.status === "string" ? state.status : null,
    output,
    exit: typeof metadata.exit === "number" ? metadata.exit : null
  };
}
function opencodeV2Messages(db, sessionId) {
  const rows = db.prepare(`SELECT type, data FROM session_message
        WHERE session_id = ? AND type IN ('user', 'assistant')
        ORDER BY seq`).all(sessionId);
  const messages = [];
  for (const row of rows) {
    const data = parseData(row.data);
    if (row.type === "user") {
      const text = typeof data.text === "string" ? data.text : "";
      messages.push({ role: "user", texts: [text], tools: [] });
      continue;
    }
    const message = {
      role: "assistant",
      texts: [],
      tools: []
    };
    for (const raw of Array.isArray(data.content) ? data.content : []) {
      const block = asObject(raw);
      if (block.type === "text" && typeof block.text === "string")
        message.texts.push(block.text);
      else if (block.type === "tool") {
        const tool = opencodeTool(block);
        if (tool)
          message.tools.push(tool);
      }
    }
    messages.push(message);
  }
  return messages;
}
function opencodeV1Messages(db, sessionId) {
  const rows = db.prepare(`SELECT m.id AS id, m.data AS message, p.data AS part
         FROM message m LEFT JOIN part p ON p.message_id = m.id
        WHERE m.session_id = ?
        ORDER BY m.time_created, m.id, p.id`).all(sessionId);
  const messages = [];
  let current = null;
  for (const row of rows) {
    if (current?.id !== row.id) {
      const role = parseData(row.message).role;
      current = role === "user" || role === "assistant" ? { id: row.id, message: { role, texts: [], tools: [] } } : null;
      if (current)
        messages.push(current.message);
    }
    if (!current)
      continue;
    const part = parseData(row.part);
    if (part.type === "text" && typeof part.text === "string") {
      if (part.synthetic !== true)
        current.message.texts.push(part.text);
    } else if (part.type === "tool") {
      const tool = opencodeTool(part);
      if (tool)
        current.message.tools.push(tool);
    }
  }
  return messages;
}
function readOpencodeSession(sessionId, file = import_node_path13.join(opencodeDataDir2(), "opencode.db")) {
  if (!import_node_fs7.existsSync(file))
    return null;
  const sqlite = process.getBuiltinModule?.("node:sqlite");
  if (!sqlite) {
    log("node:sqlite is not available; OpenCode's session cannot be read");
    return null;
  }
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const has = (table) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
    for (const [sessions, read] of [
      ["session_v2", opencodeV2Messages],
      ["session", opencodeV1Messages]
    ]) {
      if (!has(sessions))
        continue;
      const session = db.prepare(`SELECT directory FROM ${sessions} WHERE id = ?`).get(sessionId);
      if (!session)
        continue;
      return {
        directory: typeof session.directory === "string" ? session.directory : null,
        messages: read(db, sessionId)
      };
    }
    return null;
  } finally {
    db.close();
  }
}
var OPENCODE_FILE_TOOLS = new Set(["edit", "write", "multiedit", "patch"]);
function digestOpencode(messages, root) {
  let mcpTaskId = null;
  let typedTaskId = null;
  let request = null;
  let replies = [];
  let previousReplies = [];
  const files = [];
  const commands = [];
  const touch = (path) => {
    const rel = repoPath(path, root);
    if (!rel)
      return;
    const at = files.indexOf(rel);
    if (at !== -1)
      files.splice(at, 1);
    files.push(rel);
  };
  for (const message of messages) {
    if (message.role === "user") {
      const text = message.texts.join(`
`).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
      if (!text || text.startsWith("<"))
        continue;
      request = text;
      if (replies.length)
        previousReplies = replies;
      replies = [];
      for (const m of text.match(TASK_ID) ?? [])
        if (!NOT_TASK_ID.test(m))
          typedTaskId = m;
      continue;
    }
    for (const text of message.texts)
      if (text.trim())
        replies.push(text.trim());
    for (const tool of message.tools) {
      const { name, input } = tool;
      if (name.startsWith("lanework_")) {
        if (typeof input.card === "string")
          mcpTaskId = input.card;
        if (name.endsWith("create_review")) {
          const minted = /\\?"taskId\\?"\s*:\s*\\?"([^"\\]+)/.exec(tool.output);
          if (minted?.[1])
            mcpTaskId = minted[1];
        }
      }
      if (OPENCODE_FILE_TOOLS.has(name)) {
        const path = input.filePath ?? input.file_path ?? input.path;
        if (typeof path === "string")
          touch(path);
      }
      if (name === "apply_patch" && typeof input.patchText === "string")
        for (const m of input.patchText.matchAll(PATCH_FILE))
          touch((m[1] ?? "").trim());
      if (name === "bash" && typeof input.command === "string")
        commands.push({
          command: clip2(input.command.split(`
`)[0] ?? "", 300),
          ok: tool.status === "error" ? false : tool.exit !== null ? tool.exit === 0 : tool.status === "completed" ? true : null
        });
    }
  }
  return {
    taskId: mcpTaskId ?? typedTaskId,
    request,
    lastReply: (replies.length ? replies : previousReplies).join(`

`) || null,
    replyIsPrevious: !replies.length && previousReplies.length > 0,
    files: files.slice(-100),
    commands: commands.slice(-15)
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
var BOARD_TTL_MS = 60 * 60 * 1000;
var BOARDS_FILE = import_node_path13.join(STATE_DIR, "boards.json");
function boardKey(remote, secret) {
  return [API, sha256(secret).slice(0, 12), remote].join(" ");
}
function readBoards() {
  const cache = readJson(BOARDS_FILE, {});
  const fresh = {};
  const now = Date.now();
  for (const [key, entry] of Object.entries(cache)) {
    const e = entry;
    if (e && typeof e.id === "string" && typeof e.at === "number" && now - e.at < BOARD_TTL_MS)
      fresh[key] = { id: e.id, at: e.at };
  }
  return fresh;
}
function evictBoard(remote, secret) {
  const cache = readBoards();
  const key = boardKey(remote, secret);
  if (!(key in cache))
    return;
  delete cache[key];
  writeJson(BOARDS_FILE, cache);
}
async function boardFor(remote, secret) {
  const cache = readBoards();
  const key = boardKey(remote, secret);
  const hit = cache[key];
  if (hit)
    return hit.id;
  const res = await http(paths.boardsForRepo(remote), { secret });
  if (!res.ok) {
    log(`board lookup ${res.status} for ${remote}`);
    return null;
  }
  const { boards } = await res.json();
  if (boards.length !== 1) {
    log(`${boards.length} boards linked to ${remote}; not guessing`);
    return null;
  }
  const id = boards[0]?.workspaceId ?? null;
  if (id)
    writeJson(BOARDS_FILE, { ...cache, [key]: { id, at: Date.now() } });
  return id;
}
var SECRET_FILES = [
  /^\.env(?!\.(?:example|sample|template|dist|defaults)$)(?:\..*)?$/,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/,
  /\.tfstate(?:\..*)?$/,
  /\.tfvars(?:\.json)?$/,
  /^service[-_]?account.*\.json$/,
  /^credentials.*\.json$/,
  /^client_secret.*\.json$/,
  /^(?:\.envrc|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.htpasswd|\.pgpass|\.dockercfg|\.s3cfg|\.boto)$/
];
function isSecretFile(path) {
  const name = import_node_path13.basename(path).toLowerCase();
  return SECRET_FILES.some((pattern) => pattern.test(name));
}
function refusal(root, env) {
  const changed = git(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRT", "HEAD"], env).split("\x00").filter(Boolean);
  const file = changed.find(isSecretFile);
  if (file)
    return `${file} looks like a secrets file`;
  const patch = import_node_child_process7.execFileSync("git", [
    "diff",
    "--cached",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--diff-filter=ACMRT",
    "HEAD"
  ], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: PUSH_TIMEOUT_MS
  });
  let current = "";
  for (const line of patch.split(`
`)) {
    if (line.startsWith("+++ ")) {
      current = line.slice(4).replace(/^b\//, "");
    } else if (line.startsWith("+") && redact(line) !== line) {
      return `an added line in ${current} looks like a secret`;
    }
  }
  return null;
}
function snapshot(root, taskId, untracked = PUSH_WIP_UNTRACKED) {
  const index = import_node_path13.resolve(root, git(root, ["rev-parse", "--git-path", `lanework-wip-${process.pid}.index`]));
  try {
    const env = { GIT_INDEX_FILE: index };
    git(root, ["read-tree", "HEAD"], env);
    git(root, ["add", untracked ? "-A" : "-u"], env);
    const tree = git(root, ["write-tree"], env);
    if (tree === git(root, ["rev-parse", "HEAD^{tree}"])) {
      return { wipRef: null, wipSha: null };
    }
    let refused;
    try {
      refused = refusal(root, env);
    } catch (error) {
      refused = `it could not be checked for secrets (${String(error)})`;
    }
    if (refused) {
      log(`wip for ${taskId} not pushed: ${refused}`);
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
    import_node_fs7.rmSync(index, { force: true });
  }
}
var compactionOf = (input) => input.hook_event_name !== "PreCompact" ? null : input.trigger === "manual" || input.trigger === "auto" ? input.trigger : "unknown";
function buildBody(d, extra) {
  const heading = d.replyIsPrevious ? `${AGENT_NAME}'s last message, from the turn BEFORE the request below (it stopped before replying to that one):` : `${AGENT_NAME}'s last message before it stopped:`;
  const body = d.lastReply ? `${heading}

${clip2(redact(d.lastReply), 5000)}` : `${AGENT_NAME} stopped before writing any reply in this session.`;
  const summary = extra.compaction ? `[pre-compact, ${extra.compaction}] ${AGENT_NAME} was about to compact its context: this is where the work stood just before. Its next step is not known here; the agent is reminded to record one after the compaction.

${body}` : body;
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
  import_node_fs7.rmSync(inputFile, { force: true });
  if (AGENT === "opencode")
    return workOpencode(input);
  if (!input.cwd)
    return;
  const transcriptPath = input.transcript_path || (AGENT === "codex" ? findCodexRollout(input.session_id) : null);
  if (!transcriptPath)
    return;
  const root = tryGit(input.cwd, ["rev-parse", "--show-toplevel"]);
  const origin = root && tryGit(root, ["remote", "get-url", "origin"]);
  if (!root || !origin)
    return;
  const remote = stripUserinfo(origin);
  const transcript = import_node_fs7.readFileSync(transcriptPath, "utf8");
  const d = AGENT === "codex" ? digestCodex(transcript, root, input.last_assistant_message ?? null) : digest(transcript, root);
  const compaction = compactionOf(input);
  if (compaction && input.session_id)
    noteCompactionCard(STATE_DIR, input.session_id, d.taskId);
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
    await checkpointTo(local, { ...d, taskId: d.taskId }, input, root, remote, {
      compaction
    });
  } finally {
    local?.store.close();
  }
}
async function workOpencode(input) {
  if (!input.session_id)
    return;
  const session = readOpencodeSession(input.session_id);
  if (!session) {
    log(`opencode session ${input.session_id}: not found; nothing sent`);
    return;
  }
  const cwd = input.cwd || session.directory;
  if (!cwd)
    return;
  const root = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  const origin = root && tryGit(root, ["remote", "get-url", "origin"]);
  if (!root || !origin)
    return;
  const remote = stripUserinfo(origin);
  const d = digestOpencode(session.messages, root);
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
async function checkpointTo(local, d, input, root, remote, options = {}) {
  const secret = local ? null : readSecret2();
  if (!local && !secret) {
    log("no credential; turn the hook on in the Lanework app (Settings → Harness)");
    return;
  }
  if (!await readsAllowed(root)) {
    log(`${root}: its git settings run programs and it is not trusted in Lanework; nothing sent`);
    return;
  }
  const head = tryGit(root, ["rev-parse", "HEAD"]);
  const status = tryGit(root, ["status", "--porcelain"]) ?? "";
  const diff = tryGit(root, ["diff", "HEAD"]) ?? "";
  const code = sha256([d.taskId, head, status, sha256(diff)].join("\x00"));
  const stateFile = import_node_path13.join(STATE_DIR, `session-${sha256(input.session_id ?? "")}.json`);
  const last = readJson(stateFile, null);
  if (!options.compaction && last && last.code === code && Date.now() - last.at < THIN_MS)
    return;
  const boardId = local ? null : await boardFor(remote, secret);
  if (!local && !boardId)
    return;
  const pushed = last?.pushedCode === code ? last.wip : null;
  const wip = PUSH_WIP ? pushed ?? snapshot(root, d.taskId) : { wipRef: null, wipSha: null };
  const body = buildBody(d, {
    host: import_node_os9.hostname(),
    session: input.session_id ?? null,
    git: {
      branch: tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      head,
      wipRef: wip.wipRef,
      wipSha: wip.wipSha,
      diffStat: clip2(tryGit(root, ["diff", "HEAD", "--stat"]) ?? "", 3000) || null
    },
    compaction: options.compaction ?? null
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
      if ([403, 404, 409].includes(res.status))
        evictBoard(remote, secret);
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
  if (options.compaction)
    log(`pre-compact checkpoint for ${d.taskId} (${options.compaction})`);
}
function boundTaskId(input) {
  if (!input.cwd || AGENT === "opencode")
    return null;
  const transcriptPath = input.transcript_path || (AGENT === "codex" ? findCodexRollout(input.session_id) : null);
  if (!transcriptPath)
    return null;
  const root = tryGit(input.cwd, ["rev-parse", "--show-toplevel"]);
  if (!root || !tryGit(root, ["remote", "get-url", "origin"]))
    return null;
  const transcript = import_node_fs7.readFileSync(transcriptPath, "utf8");
  return (AGENT === "codex" ? digestCodex(transcript, root, null) : digest(transcript, root)).taskId;
}
function remindAfterCompaction(input) {
  if (input.source !== "compact" || !input.session_id)
    return;
  const marker = takeCompactionMarker(STATE_DIR, input.session_id);
  if (!marker)
    return;
  const taskId = marker.taskId === undefined ? boundTaskId(input) : marker.taskId;
  if (!taskId)
    return;
  if (!isRemindableTaskId(taskId)) {
    log(`after compaction: ${clip2(taskId, 40)} is not a task id; no reminder`);
    return;
  }
  process.stdout.write(sessionStartOutput(compactReminder(taskId)));
  log(`after compaction: reminded the agent to checkpoint ${taskId}`);
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
      name: `${import_node_os9.hostname()} (checkpoint hook)`,
      hostname: import_node_os9.hostname(),
      os: import_node_os9.platform(),
      arch: import_node_os9.arch()
    })
  });
  if (!res.ok) {
    console.error(`registration failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const { machineId, secret } = await res.json();
  if (!isMachineSecret(secret)) {
    console.error("registration failed: the server sent no valid credential");
    process.exit(1);
  }
  writeSecret(API, secret);
  if (readSecret2() !== secret) {
    console.error("the credential could not be read back");
    process.exit(1);
  }
  console.log(`enrolled as machine ${machineId}; credential saved to ${credentialLocation(API)}. Revoke it at ${API}/setup.`);
}
var SELF = process.argv[1] ?? "";
async function main() {
  const [mode, arg, value] = ARGS.positional;
  if (API_REFUSED && mode) {
    const note = `refused API ${stripUserinfo(API_ASKED)}: only https, or http on 127.0.0.1, ::1 or localhost; using ${API}`;
    log(note);
    if (mode !== "worker" && mode !== "mcp")
      console.error(note);
  }
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
    const stdin = import_node_fs7.readFileSync(0, "utf8");
    let input = {};
    try {
      input = JSON.parse(stdin);
    } catch {}
    if (input.hook_event_name === "SessionStart") {
      remindAfterCompaction(input);
      return;
    }
    if (input.hook_event_name === "PreCompact" && input.session_id)
      markCompaction(STATE_DIR, input.session_id);
    import_node_fs7.mkdirSync(STATE_DIR, { recursive: true, mode: 448 });
    const file = import_node_path13.join(STATE_DIR, `input-${process.pid}-${Date.now()}.json`);
    import_node_fs7.writeFileSync(file, stdin, { mode: 384 });
    const flags = process.argv.slice(2).filter((a) => !ARGS.positional.includes(a));
    import_node_child_process7.spawn(process.execPath, [SELF, ...flags, "worker", file], {
      detached: true,
      stdio: "ignore"
    }).unref();
  } catch (error) {
    log(`hook failed: ${String(error)}`);
  }
}
if (import_node_path13.basename(SELF).startsWith("lanework-checkpoint"))
  main();
