import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

test("with no credential the app shows the gate, not the app", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lanework-gate-"));
  const home = await mkdtemp(join(tmpdir(), "lanew-gate-home-"));
  const application = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home }),
  });
  try {
    const page = await application.firstWindow();

    await expect(
      page.getByRole("heading", { name: "Sign in to continue" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /A little space/ }),
    ).toBeHidden();
    // No app chrome: drawing nav for someone who cannot use it is drawing
    // things to bounce off.
    await expect(page.getByRole("navigation")).toBeHidden();
    // R1: the gate is the only screen there is, so it carries what someone
    // needs to diagnose a control plane they cannot reach.
    await expect(page.getByText("Signing in against")).toBeVisible();

    // The boundary is at the root, so a deep link is gated too — there is no
    // per-route guard to forget.
    await page.goto("app://lanework/settings");
    await expect(
      page.getByRole("heading", { name: "Sign in to continue" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeHidden();
  } finally {
    await application.close();
    await removeProfile(profile, home);
  }
});

test("a revoke on the control plane closes the gate with no restart", async () => {
  const plane = await startStubPlane();
  const profile = await mkdtemp(join(tmpdir(), "lanework-revoke-"));
  const home = await mkdtemp(join(tmpdir(), "lanew-revoke-home-"));
  await seedCredential(home, plane.origin);

  const application = await electron.launch({
    args: [process.cwd()],
    // A short beat so the revocation lands inside the test's budget; 60s is the
    // default that ships.
    env: launchEnv({
      profile,
      home,
      apiUrl: plane.origin,
      heartbeatMs: 1_000,
    }),
  });
  try {
    const page = await application.firstWindow();

    // An accepted credential opens the app.
    await expect(
      page.getByRole("heading", { name: /A little space/ }),
    ).toBeVisible();

    // Revoked on the SERVER. Nothing travels down to this machine, so only the
    // heartbeat can notice — and `onSessionChange` is what carries it to the UI.
    plane.setRevoked(true);
    await expect(
      page.getByRole("heading", { name: "This machine's access was revoked" }),
    ).toBeVisible({ timeout: 15_000 });
    // A revoked machine is not merely signed out, and the screen says so.
    await expect(
      page.getByRole("heading", { name: "Sign in to continue" }),
    ).toBeHidden();
    await expect(
      page.getByRole("heading", { name: /A little space/ }),
    ).toBeHidden();
  } finally {
    await application.close();
    await plane.close();
    await removeProfile(profile, home);
  }
});
