import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { resolveApi } from "../electron/main/auth/client";
import { pkcePair } from "../electron/main/auth/pkce";
import {
  externalUrlOn,
  looksLikeUserCode,
  parseLoopbackRedirect,
} from "../electron/main/auth/redirect";
import { APP_HOME_NAME, appHomeDir } from "../electron/main/paths";
import type { Principal, RedactedSession } from "../shared/auth";
import { can } from "../shared/policy";

// These modules are deliberately free of any `electron` import, so the whole
// pure core is exercised here without booting the app.

test("the app home folder is one constant, overridable for isolation", () => {
  expect(APP_HOME_NAME).toBe(".lanew");

  const saved = process.env.LANEWORK_HOME;
  try {
    delete process.env.LANEWORK_HOME;
    expect(appHomeDir()).toBe(join(homedir(), ".lanew"));
    // The override branch is what keeps a test run from writing into the
    // developer's real credential, so it is tested, not assumed.
    process.env.LANEWORK_HOME = "/tmp/lanew-test-home";
    expect(appHomeDir()).toBe("/tmp/lanew-test-home");
  } finally {
    if (saved === undefined) delete process.env.LANEWORK_HOME;
    else process.env.LANEWORK_HOME = saved;
  }
});

test("a PKCE pair is 256 bits and never repeats", async () => {
  const { createHash } = await import("node:crypto");
  const a = pkcePair();
  const b = pkcePair();

  expect(a.verifier).toHaveLength(43);
  expect(a.verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  expect(a.challenge).toBe(
    createHash("sha256").update(a.verifier).digest().toString("base64url"),
  );
  expect(a.verifier).not.toBe(b.verifier);
});

test("only a loopback callback URI is accepted", () => {
  expect(
    parseLoopbackRedirect("http://127.0.0.1:8976/oauth/callback")?.port,
  ).toBe("8976");

  for (const rejected of [
    // Goes through a resolver, and is ambiguous between 127.0.0.1 and ::1.
    "http://localhost:8976/oauth/callback",
    "http://[::1]:8976/oauth/callback",
    "https://127.0.0.1:8976/oauth/callback",
    // Port 80 is privileged, so an absent port is a rejection, not a default.
    "http://127.0.0.1/oauth/callback",
    "http://127.0.0.1:80/oauth/callback",
    "http://127.0.0.1:1023/oauth/callback",
    "http://127.0.0.1:70000/oauth/callback",
    "http://127.0.0.1:8976/other",
    "http://127.0.0.1:8976/oauth/callback?x=1",
    "http://127.0.0.1:8976/oauth/callback#x",
    "http://user:pw@127.0.0.1:8976/oauth/callback",
    "http://127.0.0.2:8976/oauth/callback",
    "not a url",
    "",
    undefined,
    null,
    42,
  ])
    expect(parseLoopbackRedirect(rejected), String(rejected)).toBeNull();
});

test("a URL handed to the system browser must be on the API's own origin", () => {
  const api = "https://api.example.test";
  expect(externalUrlOn(`${api}/cli/authorize?id=1`, api)).toBe(
    `${api}/cli/authorize?id=1`,
  );

  for (const rejected of [
    "https://evil.example/cli/authorize",
    "http://api.example.test/cli/authorize", // scheme is part of the origin
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pw@api.example.test/cli/authorize",
    "not a url",
    undefined,
  ])
    expect(externalUrlOn(rejected, api), String(rejected)).toBeNull();
});

test("a device user code is checked before anyone is asked to retype it", () => {
  expect(looksLikeUserCode("ABCD-2345")).toBe(true);
  // 0 O 1 I L are absent from the alphabet on purpose — they are the pairs
  // people mistype, and a wrong character reads as "the code doesn't work".
  for (const rejected of [
    "ABC0-2345",
    "ABCO-2345",
    "ABCI-2345",
    "ABCL-2345",
    "ABCD2345",
    "abcd-2345",
    "ABCD-234",
    "",
    undefined,
  ])
    expect(looksLikeUserCode(rejected), String(rejected)).toBe(false);
});

test("the control plane defaults to production, overridable in order", () => {
  const saved = process.env.LANEWORK_API_URL;
  try {
    delete process.env.LANEWORK_API_URL;
    expect(resolveApi()).toBe("https://api.lanework.dev");
    // https, never http: this origin receives a PKCE verifier and hands back a
    // machine credential, so the transport is part of the flow's security.
    expect(new URL(resolveApi()).protocol).toBe("https:");

    process.env.LANEWORK_API_URL = "https://env.example.test//";
    expect(resolveApi()).toBe("https://env.example.test");
    // An explicit origin still wins over the environment.
    expect(resolveApi("https://arg.example.test/")).toBe(
      "https://arg.example.test",
    );
  } finally {
    if (saved === undefined) delete process.env.LANEWORK_API_URL;
    else process.env.LANEWORK_API_URL = saved;
  }
});

test("a machine credential may never do a human's job", () => {
  const anonymous: Principal = { kind: "anonymous" };
  const machine: Principal = {
    kind: "machine",
    machineId: "m1",
    userId: "u1",
    name: "laptop",
  };
  const revoked: Principal = {
    kind: "revoked",
    machineId: "m1",
    name: "laptop",
  };

  // Enrolling a machine or revoking someone else's is held behind a browser
  // session this app never has — false for every principal it can hold.
  for (const principal of [anonymous, machine, revoked]) {
    expect(can(principal, "machine:enrol")).toBe(false);
    expect(can(principal, "machine:revokeAny")).toBe(false);
    expect(can(principal, "session:read")).toBe(true);
  }

  expect(can(anonymous, "session:signIn")).toBe(true);
  expect(can(revoked, "session:signIn")).toBe(true);
  // Already signed in: re-enrolling would leave a second live machine.
  expect(can(machine, "session:signIn")).toBe(false);

  expect(can(anonymous, "session:signOut")).toBe(false);
  expect(can(machine, "session:signOut")).toBe(true);
  expect(can(revoked, "session:signOut")).toBe(true);

  expect(can(machine, "machine:self")).toBe(true);
  expect(can(machine, "machine:revokeSelf")).toBe(true);
  // A credential the other side stopped accepting can do neither.
  expect(can(revoked, "machine:self")).toBe(false);
  expect(can(revoked, "machine:revokeSelf")).toBe(false);
});

test("the renderer gets a redacted session and no way to reach a credential", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lanework-auth-"));
  const home = await mkdtemp(join(tmpdir(), "lanew-home-"));
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    LANEWORK_TEST_USER_DATA: profile,
    LANEWORK_HOME: home,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  // ⚠️ Pointed at a dead local port, NOT left to the default. The control plane
  // now defaults to production, so an unset value here would make this test
  // sign in against the real service.
  const deadApi = "http://127.0.0.1:1";
  env.LANEWORK_API_URL = deadApi;

  const application = await electron.launch({ args: [resolve(".")], env });
  try {
    const page = await application.firstWindow();

    expect(
      await page.evaluate(() =>
        Object.keys(
          (globalThis as { desktop?: { auth?: object } }).desktop?.auth ?? {},
        ),
      ),
    ).toEqual([
      "getSession",
      "signIn",
      "signOut",
      "cancelSignIn",
      "onSessionChange",
      "onSignInProgress",
    ]);

    const session = (await page.evaluate(() =>
      (
        globalThis as unknown as {
          desktop: { auth: { getSession: () => Promise<RedactedSession> } };
        }
      ).desktop.auth.getSession(),
    )) as RedactedSession;

    expect(session.principal).toEqual({ kind: "anonymous" });
    expect(session.apiUrl).toBe(deadApi);
    // Nobody has asked yet, which is not the same as "unreachable" — with no
    // credential on disk there is nothing to probe and no request is made.
    expect(session.verdict).toBeNull();
    // Nothing anywhere in what crosses the bridge may look like a credential.
    expect(JSON.stringify(session)).not.toMatch(/secret|token|bearer/i);
    expect(Object.keys(session).sort()).toEqual([
      "apiUrl",
      "checkedAt",
      "principal",
      "verdict",
    ]);

    // A failure to reach the control plane names the origin and the remedy, so
    // the reader is not left guessing which service was even being called.
    const unreachable = await page.evaluate(async () => {
      try {
        await (
          globalThis as unknown as {
            desktop: { auth: { signIn: () => Promise<unknown> } };
          }
        ).desktop.auth.signIn();
        return "resolved";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(unreachable).toContain("Could not reach the control plane at");
    expect(unreachable).toContain(deadApi);

    // Arguments are validated in main: a bad mode never reaches a flow.
    const badMode = await page.evaluate(async () => {
      try {
        await (
          globalThis as unknown as {
            desktop: { auth: { signIn: (mode: string) => Promise<unknown> } };
          }
        ).desktop.auth.signIn("nonsense");
        return "resolved";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(badMode).toContain("loopback");

    // Signing out while anonymous is refused by the policy table, so it is a
    // no-op that still reports the real session rather than throwing.
    const afterSignOut = (await page.evaluate(() =>
      (
        globalThis as unknown as {
          desktop: { auth: { signOut: () => Promise<RedactedSession> } };
        }
      ).desktop.auth.signOut(),
    )) as RedactedSession;
    expect(afterSignOut.principal).toEqual({ kind: "anonymous" });
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
