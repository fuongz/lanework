import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Workspace } from "../shared/workspaces";

/** A port nothing listens on, so a probe fails fast instead of reaching prod. */
export const DEAD_API = "http://127.0.0.1:1";

/**
 * Write a credential the app will accept, without needing safeStorage.
 *
 * `store.ts` reads `enc: false` records — the documented fallback for a platform
 * with no OS keyring — and a test cannot produce a safeStorage blob from
 * outside the app.
 *
 * With `apiUrl` pointed at a dead port the probe reports `unreachable`, which
 * by FE-01 O1 keeps the principal a `machine`: an enrolled install stays usable
 * offline. So this seeds an UNLOCKED app that touches no network.
 */
export async function seedCredential(
  home: string,
  apiUrl: string = DEAD_API,
): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({
      v: 1,
      machineId: "test-machine",
      apiUrl,
      name: "test-machine",
      userId: "test-user",
      enc: false,
      secret: "lw_mch_test-secret",
    }),
    { encoding: "utf8", mode: 0o600 },
  );
}

/**
 * The environment an Electron launch needs to stay off the real control plane
 * and out of the developer's real `~/.lanew`.
 *
 * ⚠️ `LANEWORK_HOME` is not optional. `LANEWORK_TEST_USER_DATA` moves only
 * Electron's `userData`; the app home is a fixed dotfolder under `$HOME` and
 * does not follow it, so a launch without this reads and writes the real
 * credential.
 */
export function launchEnv(options: {
  profile: string;
  home: string;
  apiUrl?: string;
  heartbeatMs?: number;
}): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    LANEWORK_TEST_USER_DATA: options.profile,
    LANEWORK_HOME: options.home,
    LANEWORK_API_URL: options.apiUrl ?? DEAD_API,
  };
  if (options.heartbeatMs)
    env.LANEWORK_HEARTBEAT_MS = String(options.heartbeatMs);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  return env;
}

/**
 * The one control-plane route the app polls: `/v1/machines/me`, whose 401 is
 * how a revocation becomes visible. Enough to drive the gate open and shut.
 */
export async function startStubPlane(
  options: {
    /** Omit the owner block, standing in for a control plane older than it. */
    owner?: boolean;
    workspaces?: Workspace[];
  } = {},
): Promise<{
  origin: string;
  setRevoked: (value: boolean) => void;
  /** Every request seen, as `METHOD /path` — so a test can prove a call happened. */
  calls: string[];
  setWorkspaces: (value: Workspace[]) => void;
  setWorkspaceResponse: (
    status: number,
    body?: unknown,
    delayMs?: number,
  ) => void;
  workspaceAuth: string[];
  close: () => Promise<void>;
}> {
  let revoked = false;
  let workspaces = options.workspaces ?? [];
  let workspaceStatus = 200;
  let workspaceBody: unknown;
  let workspaceDelay = 0;
  const workspaceAuth: string[] = [];
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);

    if (req.method === "GET" && req.url === "/v1/sync/state") {
      workspaceAuth.push(req.headers.authorization ?? "");
      const status = revoked ? 401 : workspaceStatus;
      const body = workspaceBody ?? { workspaces };
      setTimeout(
        () =>
          res
            .writeHead(status, { "Content-Type": "application/json" })
            .end(JSON.stringify(body)),
        workspaceDelay,
      );
      return;
    }

    // What sign-out calls. Revoking is the server's doing, not a local delete.
    if (req.method === "DELETE" && req.url === "/v1/machines/me") {
      revoked = true;
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ revoked: "test-machine" }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/machines/me" && !revoked) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          machineId: "test-machine",
          name: "test-machine",
          userId: "test-user",
          // The owner block the real control plane now returns from this route.
          ...(options.owner === false
            ? {}
            : {
                user: {
                  name: "Test Person",
                  email: "test@example.test",
                  image: null,
                },
              }),
        }),
      );
      return;
    }
    res
      .writeHead(revoked ? 401 : 404, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "unknown or revoked machine" }));
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    calls,
    workspaceAuth,
    setWorkspaces: (value) => {
      workspaces = value;
      workspaceStatus = 200;
      workspaceBody = undefined;
      workspaceDelay = 0;
    },
    setWorkspaceResponse: (status, body, delayMs = 0) => {
      workspaceStatus = status;
      workspaceBody = body;
      workspaceDelay = delayMs;
    },
    setRevoked: (value) => {
      revoked = value;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Delete a launch profile, tolerating Electron's parting writes.
 *
 * ⚠️ `maxRetries` is the whole point. Electron keeps flushing `GPUCache` for a
 * moment after its process has exited, so a bare `rm` loses the race and throws
 * `ENOTEMPTY` — out of a `finally`, which turns a passing test red for reasons
 * that have nothing to do with what it tested.
 */
export async function removeProfile(...dirs: string[]): Promise<void> {
  for (const dir of dirs)
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 120,
    }).catch(() => {});
}
