// Codex's account, read from the claims of the `id_token` in its `auth.json`
// and nothing else. Free of Electron, so a test can drive it
// (`codex-account.test.ts`).
import type { HarnessAccount } from "../../../shared/harness";

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;

/** A JWT's payload, or null. The signature is not checked: this is a label. */
function claimsOf(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Codex's account from the parsed `$CODEX_HOME/auth.json`.
 *
 * Signed in with ChatGPT when it holds an `id_token` that decodes. The
 * organization is the default one's title, else the first one's. An account
 * with none is Personal.
 */
export function codexAccountOf(json: unknown): HarnessAccount {
  const none: HarnessAccount = {
    agent: "codex",
    signedIn: false,
    email: null,
    org: null,
    plan: null,
  };
  if (!json || typeof json !== "object") return none;
  const tokens = (json as { tokens?: unknown }).tokens;
  const claims = claimsOf(
    tokens && typeof tokens === "object"
      ? (tokens as { id_token?: unknown }).id_token
      : null,
  );
  if (!claims) return none;
  const auth = claims["https://api.openai.com/auth"];
  const openai =
    auth && typeof auth === "object" ? (auth as Record<string, unknown>) : {};
  const orgs = Array.isArray(openai.organizations) ? openai.organizations : [];
  const pick =
    orgs.find(
      (org): org is Record<string, unknown> =>
        !!org &&
        typeof org === "object" &&
        (org as { is_default?: unknown }).is_default === true,
    ) ?? (orgs[0] as Record<string, unknown> | undefined);
  return {
    agent: "codex",
    signedIn: true,
    email: text(claims.email),
    org: text(pick?.title) ?? "Personal",
    plan: text(openai.chatgpt_plan_type)?.toLowerCase() ?? null,
  };
}
