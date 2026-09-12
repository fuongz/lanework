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

test("a new machine is walked through onboarding and left at the gate", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lanework-gate-"));
  const home = await mkdtemp(join(tmpdir(), "lanew-gate-home-"));
  const application = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home }),
  });
  try {
    const page = await application.firstWindow();

    // Step 1 — the app introduces itself before it asks for anything.
    await expect(
      page.getByRole("heading", { name: "Welcome to Lanework" }),
    ).toBeVisible();
    await expect(page.getByText("Step 1 of 3")).toBeAttached();
    await expect(
      page.getByRole("button", { name: /^Switch project/ }),
    ).toBeHidden();
    // No app chrome: drawing nav for someone who cannot use it is drawing
    // things to bounce off.
    await expect(page.getByRole("navigation")).toBeHidden();

    // Step 2 — the appearance, the same control Settings draws.
    await page.getByRole("button", { name: "Get started" }).click();
    await expect(
      page.getByRole("heading", { name: "Choose your style" }),
    ).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Theme" })).toBeVisible();

    // Step 3 — the gate itself is the last step, not something beyond it.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Sign in to continue" }),
    ).toBeVisible();
    await expect(page.getByText("Step 3 of 3")).toBeAttached();
    // At rest the gate says what to do and nothing else; the endpoint it talks
    // to appears with the error that makes it worth reading.
    await expect(page.getByText("Signing in against")).toBeHidden();
    await expect(page.getByText("Version")).toBeHidden();

    // The boundary is at the root, so a deep link is gated too — there is no
    // per-route guard to forget. A reload also proves the flow is not replayed:
    // the walk-through was recorded on the way into the last step.
    await page.goto("app://lanework/settings");
    await expect(
      page.getByRole("heading", { name: "Sign in to continue" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Welcome to Lanework" }),
    ).toBeHidden();
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
      page.getByRole("button", { name: /^Switch project/ }),
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
      page.getByRole("button", { name: /^Switch project/ }),
    ).toBeHidden();
  } finally {
    await application.close();
    await plane.close();
    await removeProfile(profile, home);
  }
});
