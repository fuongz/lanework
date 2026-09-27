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
var import_node_crypto2 = require("node:crypto");
var import_node_fs3 = require("node:fs");
var import_node_os4 = require("node:os");
var import_node_path3 = require("node:path");

// apps/desktop/electron/hook/cli.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs2 = require("node:fs");
var import_node_os3 = require("node:os");
var import_node_path2 = require("node:path");

// apps/desktop/electron/main/auth/client.ts
var import_node_os = require("node:os");

// apps/desktop/electron/main/auth/redirect.ts
var CALLBACK_PATH = "/oauth/callback";
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
  const { status, ok, data } = await postJson(api, "/v1/cli/auth", {
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
  const { status, ok, data } = await postJson(api, "/v1/cli/auth", {
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
  const { status, ok, data } = await postJson(api, "/v1/cli/token", {
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

// apps/desktop/electron/hook/credential.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_os2 = require("node:os");
var import_node_path = require("node:path");
var KEYCHAIN_SERVICE = "dev.lanework.checkpoint-hook";
function configDir() {
  return import_node_path.join(process.env.XDG_CONFIG_HOME || import_node_path.join(import_node_os2.homedir(), ".config"), "lanework");
}
function secretFile() {
  if (process.env.LANEWORK_HOOK_SECRET_FILE)
    return process.env.LANEWORK_HOOK_SECRET_FILE;
  return process.platform === "darwin" ? null : import_node_path.join(configDir(), "credential");
}
function credentialLocation() {
  return secretFile() ?? `macOS Keychain (${KEYCHAIN_SERVICE})`;
}
function readSecret(api) {
  const file = secretFile();
  if (file) {
    try {
      return import_node_fs.readFileSync(file, "utf8").trim() || null;
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
    import_node_fs.mkdirSync(import_node_path.dirname(file), { recursive: true, mode: 448 });
    import_node_fs.writeFileSync(file, `${secret}
`, { mode: 384 });
    import_node_fs.chmodSync(file, 384);
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
    import_node_fs.rmSync(file, { force: true });
    return;
  }
  try {
    import_node_child_process.execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", api], { stdio: "ignore" });
  } catch {}
}

// apps/desktop/electron/hook/cli.ts
var pluginConfigPath = () => import_node_path2.join(configDir(), "hook.json");
function readConfig() {
  try {
    return JSON.parse(import_node_fs2.readFileSync(pluginConfigPath(), "utf8"));
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
  import_node_fs2.mkdirSync(stateDir, { recursive: true, mode: 448 });
  const file = import_node_path2.join(stateDir, `device-${process.pid}-${Date.now()}.json`);
  const pending = {
    api,
    deviceCode: started.deviceCode,
    verifier,
    interval: started.interval,
    deadline: Date.now() + DEVICE_TTL_MS
  };
  import_node_fs2.writeFileSync(file, JSON.stringify(pending), { mode: 384 });
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
      import_node_fs2.mkdirSync(stateDir, { recursive: true, mode: 448 });
      import_node_fs2.appendFileSync(import_node_path2.join(stateDir, "hook.log"), `${new Date().toISOString()} device sign-in: ${line}
`);
    } catch {}
  };
  let pending;
  try {
    pending = JSON.parse(import_node_fs2.readFileSync(file, "utf8"));
  } finally {
    import_node_fs2.rmSync(file, { force: true });
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
    console.log("The Lanework desktop app already signed this machine in and runs the hook (Settings → Agents). Nothing to do.\nUse `lanework login --force` to sign in separately anyway.");
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
  const revoked = await fetch(`${api}/v1/machines/me`, {
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
    const res = await fetch(`${api}/v1/machines/me`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5000)
    }).catch(() => null);
    signedIn = !res ? "yes (control plane unreachable, not verified)" : res.ok ? "yes" : res.status === 401 ? "no — this machine was revoked; run `lanework login`" : `unknown (HTTP ${res.status})`;
  }
  let last = "none yet";
  try {
    let best = null;
    for (const name of import_node_fs2.readdirSync(stateDir)) {
      if (!name.startsWith("session-"))
        continue;
      const s = JSON.parse(import_node_fs2.readFileSync(import_node_path2.join(stateDir, name), "utf8"));
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
    `Log:              ${import_node_path2.join(stateDir, "hook.log")}`
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
  import_node_fs2.mkdirSync(configDir(), { recursive: true, mode: 448 });
  import_node_fs2.writeFileSync(pluginConfigPath(), `${JSON.stringify(next, null, 2)}
`, {
    mode: 384
  });
  console.log(value === "on" ? "The hook will also push uncommitted work to refs/lanework/wip/<task id>." : "The hook will not push code.");
}
function desktopHookInstalled() {
  const settings = import_node_path2.join(process.env.CLAUDE_CONFIG_DIR || import_node_path2.join(import_node_os3.homedir(), ".claude"), "settings.json");
  if (!import_node_fs2.existsSync(settings))
    return false;
  try {
    return import_node_fs2.readFileSync(settings, "utf8").includes("lanework-checkpoint");
  } catch {
    return false;
  }
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
var API = ((typeof ARGS.flags.get("api") === "string" ? ARGS.flags.get("api") : "") || process.env.LANEWORK_API_URL || "https://api.lanework.dev").replace(/\/$/, "");
function hookConfig() {
  const file = process.env.LANEWORK_HOOK_CONFIG || (ARGS.flags.has("plugin") ? pluginConfigPath() : null);
  if (!file)
    return {};
  try {
    return JSON.parse(import_node_fs3.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
var PUSH_WIP = ARGS.flags.has("push-wip") || hookConfig().pushWip === true;
var AGENT = ARGS.flags.get("agent") === "codex" ? "codex" : "claude-code";
var AGENT_NAME = AGENT === "codex" ? "Codex" : "Claude Code";
var STATE_DIR = import_node_path3.join(import_node_os4.homedir(), ".cache", "lanework", "checkpoint");
var LOG = import_node_path3.join(STATE_DIR, "hook.log");
var THIN_MS = 60000;
var PUSH_TIMEOUT_MS = 30000;
var HTTP_TIMEOUT_MS = 1e4;
function log(message) {
  try {
    import_node_fs3.mkdirSync(STATE_DIR, { recursive: true, mode: 448 });
    if (import_node_fs3.existsSync(LOG) && import_node_fs3.statSync(LOG).size > 512 * 1024)
      import_node_fs3.rmSync(LOG);
    import_node_fs3.appendFileSync(LOG, `${new Date().toISOString()} ${message}
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
var sha256 = (s) => import_node_crypto2.createHash("sha256").update(s).digest("hex");
function clip(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
function readJson(file, fallback) {
  try {
    return JSON.parse(import_node_fs3.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  import_node_fs3.mkdirSync(STATE_DIR, { recursive: true, mode: 448 });
  import_node_fs3.writeFileSync(file, JSON.stringify(value), { mode: 384 });
}
function redact(input) {
  return input.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED private key]").replace(/\blw_(?:reg|mch|dev|code)_[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, "[REDACTED]").replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[REDACTED]").replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]").replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED]").replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]").replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "[REDACTED]").replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED jwt]").replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]").replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@").replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|secret|passw(?:or)?d|token|credential|private[_-]?key)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1$2[REDACTED]");
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
            const rel = path.startsWith(root) ? import_node_path3.relative(root, path) : path;
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
    command: clip(String(uses.get(id)?.input.command ?? "").split(`
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
  const base = import_node_path3.join(process.env.CODEX_HOME || import_node_path3.join(import_node_os4.homedir(), ".codex"), "sessions");
  const ls = (dir) => {
    try {
      return import_node_fs3.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  let days = 0;
  for (const year of ls(base))
    for (const month of ls(import_node_path3.join(base, year)))
      for (const day of ls(import_node_path3.join(base, year, month))) {
        if (++days > 3)
          return null;
        const dir = import_node_path3.join(base, year, month, day);
        const hit = ls(dir).find((name) => name.endsWith(`${sessionId}.jsonl`));
        if (hit)
          return import_node_path3.join(dir, hit);
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
    const trimmed = path.trim().replace(/^file:\/\//, "");
    const rel = trimmed.startsWith(root) ? import_node_path3.relative(root, trimmed) : trimmed;
    if (!rel || rel.startsWith(".."))
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
          command: clip(script.split(`
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
          command: clip(unquote(m[1] ?? "").split(`
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
      "x-lanework-agent": AGENT,
      ...secret ? { Authorization: `Bearer ${secret}` } : {},
      ...rest.headers
    }
  });
}
async function boardFor(remote, secret) {
  const cacheFile = import_node_path3.join(STATE_DIR, "boards.json");
  const cache = readJson(cacheFile, {});
  if (cache[remote])
    return cache[remote];
  const res = await http(`/v1/boards?repo=${encodeURIComponent(remote)}`, {
    secret
  });
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
    writeJson(cacheFile, { ...cache, [remote]: id });
  return id;
}
function snapshot(root, taskId) {
  const index = import_node_path3.join(import_node_os4.tmpdir(), `lanework-wip-${process.pid}.index`);
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
    import_node_fs3.rmSync(index, { force: true });
  }
}
function buildBody(d, extra) {
  const heading = d.replyIsPrevious ? `${AGENT_NAME}'s last message, from the turn BEFORE the request below (it stopped before replying to that one):` : `${AGENT_NAME}'s last message before it stopped:`;
  const summary = d.lastReply ? `${heading}

${clip(redact(d.lastReply), 5000)}` : `${AGENT_NAME} stopped before writing any reply in this session.`;
  return {
    summary,
    request: d.request ? clip(redact(d.request), 2000) : null,
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
  import_node_fs3.rmSync(inputFile, { force: true });
  if (!input.cwd)
    return;
  const transcriptPath = input.transcript_path || (AGENT === "codex" ? findCodexRollout(input.session_id) : null);
  if (!transcriptPath)
    return;
  const root = tryGit(input.cwd, ["rev-parse", "--show-toplevel"]);
  const remote = root && tryGit(root, ["remote", "get-url", "origin"]);
  if (!root || !remote)
    return;
  const transcript = import_node_fs3.readFileSync(transcriptPath, "utf8");
  const d = AGENT === "codex" ? digestCodex(transcript, root, input.last_assistant_message ?? null) : digest(transcript, root);
  if (!d.taskId) {
    log(`session ${input.session_id}: no card in the transcript; nothing sent`);
    return;
  }
  const secret = readSecret2();
  if (!secret) {
    log("no credential; turn the hook on in the Lanework app (Settings → Agents)");
    return;
  }
  const head = tryGit(root, ["rev-parse", "HEAD"]);
  const status2 = tryGit(root, ["status", "--porcelain"]) ?? "";
  const diff = tryGit(root, ["diff", "HEAD"]) ?? "";
  const code = sha256([d.taskId, head, status2, sha256(diff)].join("\x00"));
  const stateFile = import_node_path3.join(STATE_DIR, `session-${sha256(input.session_id ?? "")}.json`);
  const last = readJson(stateFile, null);
  if (last && last.code === code && Date.now() - last.at < THIN_MS)
    return;
  const boardId = await boardFor(remote, secret);
  if (!boardId)
    return;
  const pushed = last?.pushedCode === code ? last.wip : null;
  const wip = PUSH_WIP ? pushed ?? snapshot(root, d.taskId) : { wipRef: null, wipSha: null };
  const body = buildBody(d, {
    host: import_node_os4.hostname(),
    session: input.session_id ?? null,
    git: {
      branch: tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      head,
      wipRef: wip.wipRef,
      wipSha: wip.wipSha,
      diffStat: clip(tryGit(root, ["diff", "HEAD", "--stat"]) ?? "", 3000) || null
    }
  });
  const res = await http(`/v1/boards/${boardId}/items/${encodeURIComponent(d.taskId)}/checkpoints`, { method: "POST", secret, body: JSON.stringify(body) });
  if (!res.ok) {
    log(`checkpoint for ${d.taskId}: ${res.status} ${clip(await res.text(), 300)}`);
    return;
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
  if (!token?.startsWith("lw_reg_")) {
    console.error(`usage: bun apps/desktop/electron/hook/lanework-checkpoint.ts setup <lw_reg_…>
` + `Mint the token at ${API}/setup ("Create registration token").`);
    process.exit(1);
  }
  const res = await http("/v1/machines/register", {
    method: "POST",
    body: JSON.stringify({
      token,
      name: `${import_node_os4.hostname()} · checkpoint hook`,
      hostname: import_node_os4.hostname(),
      os: import_node_os4.platform(),
      arch: import_node_os4.arch()
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
    const stdin = import_node_fs3.readFileSync(0, "utf8");
    import_node_fs3.mkdirSync(STATE_DIR, { recursive: true, mode: 448 });
    const file = import_node_path3.join(STATE_DIR, `input-${process.pid}-${Date.now()}.json`);
    import_node_fs3.writeFileSync(file, stdin, { mode: 384 });
    const flags = process.argv.slice(2).filter((a) => !ARGS.positional.includes(a));
    import_node_child_process3.spawn(process.execPath, [SELF, ...flags, "worker", file], {
      detached: true,
      stdio: "ignore"
    }).unref();
  } catch (error) {
    log(`hook failed: ${String(error)}`);
  }
}
if (import_node_path3.basename(SELF).startsWith("lanework-checkpoint"))
  main();
