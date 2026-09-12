import type { GitConnectProgress } from "../../../shared/git";

/**
 * GitHub's OAuth device flow: the only browser flow a desktop app can run
 * honestly.
 *
 * ⚠️ Device flow rather than the loopback + PKCE this app uses for its own
 * control plane, and the reason is GitHub rather than preference: GitHub does
 * not support PKCE, so its authorization-code flow needs a CLIENT SECRET at the
 * exchange — and a secret shipped inside a desktop binary is a published
 * secret. Device flow needs only the client id, which is public by design.
 *
 * ⚠️ There is deliberately no refresh. GitHub requires the client secret to
 * refresh a user token, so this app cannot do it; when a token expires the
 * account reads `expired` and the user connects again. What avoids that
 * entirely is the app's own setting — a classic OAuth App's tokens do not
 * expire, and a GitHub App can opt out of expiring user tokens.
 */

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * The OAuth client this app identifies as.
 *
 * ⚠️ Public, and not a secret that leaked. An OAuth client id is meant to be
 * readable by everyone who runs the client — it names the app, it does not
 * authorize anything. The secret that pairs with it stays on the control plane
 * and never reaches this process.
 *
 * Overridable so a fork, a second environment, or a developer's own app can be
 * pointed at without editing source.
 */
const DEFAULT_CLIENT_ID = "Ov23li2I723pQE1kE4qm";

export function clientId(): string {
  return process.env.LANEWORK_GITHUB_CLIENT_ID || DEFAULT_CLIENT_ID;
}

/**
 * What we ask for.
 *
 * `repo` reads pull requests on private repositories, which is the case this
 * feature exists for; `read:user` is what lets the app say who you are on
 * screen. A GitHub App ignores these — its access comes from the permissions it
 * was registered with — and sending them costs nothing in that case.
 */
const SCOPE = "repo read:user";

/** How long a poll may run before it gives up on its own. */
const MAX_WAIT_MS = 15 * 60 * 1000;

export interface DeviceToken {
  token: string;
  refreshToken: string | null;
  /** Epoch ms, or null when this token does not expire. */
  expiresAt: number | null;
}

/** Anything GitHub says about a device flow that a user can act on. */
export class DeviceFlowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "DeviceFlowError";
  }
}

async function post(
  url: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch {
    throw new DeviceFlowError(
      "unreachable",
      "Could not reach GitHub. Check your connection and try again.",
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new DeviceFlowError(
      "invalid",
      "GitHub returned an unreadable response. Try again.",
    );
  }
  if (!data || typeof data !== "object")
    throw new DeviceFlowError(
      "invalid",
      "GitHub returned an unreadable response. Try again.",
    );
  return data as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** GitHub's error codes, as sentences a person can act on. */
function explain(code: string, description: string | null): DeviceFlowError {
  const message =
    code === "device_flow_disabled"
      ? "This GitHub app does not have Device Flow enabled. Turn it on in the app's settings on GitHub, then try again."
      : code === "expired_token"
        ? "The code expired before it was approved. Start again to get a new one."
        : code === "access_denied"
          ? "The request was declined on GitHub."
          : code === "incorrect_client_credentials"
            ? "This build is configured with a client id GitHub does not recognise."
            : description ||
              `GitHub refused the connection (${code}). Try again.`;
  return new DeviceFlowError(code, message);
}

/** Ask GitHub for a code the user will type. */
export async function requestDeviceCode(): Promise<
  GitConnectProgress & { deviceCode: string }
> {
  const data = await post(DEVICE_CODE_URL, {
    client_id: clientId(),
    scope: SCOPE,
  });
  const error = str(data.error);
  if (error) throw explain(error, str(data.error_description));

  const deviceCode = str(data.device_code);
  const userCode = str(data.user_code);
  const verificationUri = str(data.verification_uri);
  if (!deviceCode || !userCode || !verificationUri)
    throw new DeviceFlowError(
      "invalid",
      "GitHub did not return a device code. Try again.",
    );

  return {
    deviceCode,
    userCode,
    verificationUri,
    // GitHub asks for 5s and answers `slow_down` if we ignore it.
    interval: typeof data.interval === "number" ? data.interval : 5,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : 900,
  };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the user approves, refuses, or the code expires.
 *
 * ⚠️ `slow_down` widens the interval permanently rather than for one attempt —
 * that is what GitHub means by it, and a client that backed off once and then
 * resumed its old pace would be rate-limited into failing a flow the user
 * already approved.
 */
export async function pollForToken(
  deviceCode: string,
  intervalSeconds: number,
  signal: AbortSignal,
): Promise<DeviceToken> {
  let interval = Math.max(intervalSeconds, 1) * 1000;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new DeviceFlowError("cancelled", "Cancelled.");
    await sleep(interval);
    if (signal.aborted) throw new DeviceFlowError("cancelled", "Cancelled.");

    const data = await post(ACCESS_TOKEN_URL, {
      client_id: clientId(),
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    const error = str(data.error);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval =
        (typeof data.interval === "number"
          ? data.interval
          : interval / 1000 + 5) * 1000;
      continue;
    }
    if (error) throw explain(error, str(data.error_description));

    const token = str(data.access_token);
    if (!token)
      throw new DeviceFlowError(
        "invalid",
        "GitHub approved the request but returned no token. Try again.",
      );

    // Present for a GitHub App, absent for a classic OAuth App. Both are
    // valid; see the note at the top of this file.
    const expiresIn =
      typeof data.expires_in === "number" ? data.expires_in : null;
    return {
      token,
      refreshToken: str(data.refresh_token),
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    };
  }

  throw new DeviceFlowError(
    "expired_token",
    "The code expired before it was approved. Start again to get a new one.",
  );
}
