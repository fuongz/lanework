import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

/** An enrolled install talking to a stub, so every test starts past the gate. */
async function open(options: { owner?: boolean } = {}): Promise<{
  app: ElectronApplication;
  page: Page;
  plane: Awaited<ReturnType<typeof startStubPlane>>;
  cleanup: () => Promise<void>;
}> {
  const plane = await startStubPlane(options);
  const profile = await mkdtemp(join(tmpdir(), "lanework-settings-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  const page = await app.firstWindow();
  // ⚠️ Wait for the first load to settle before any test navigates. A `goto`
  // issued while the initial `app://lanework/` load is still in flight aborts
  // it, and the navigation times out — the failure looks like a broken route
  // rather than a race.
  //
  // The rail's project switcher is the signal: it is on screen for every state
  // the app can be in — no projects, one open, or a list to choose from — which
  // a heading from any single one of those is not.
  await page
    .getByRole("button", { name: /^Switch project/ })
    .waitFor({ state: "visible", timeout: 15_000 });
  return {
    app,
    page,
    plane,
    cleanup: async () => {
      await app.close();
      await plane.close();
      await removeProfile(profile);
    },
  };
}

test("settings is a full window, and every section deep-links", async () => {
  const { page, cleanup } = await open();
  try {
    await page.getByRole("link", { name: "Settings", exact: true }).click();

    // Bare /settings lands on Account by name, not on whichever section is
    // first — reordering the nav must not move where this goes.
    await expect(
      page.getByRole("heading", { name: "Account", exact: true }),
    ).toBeVisible();
    // Full window: the app's own header is gone, and settings carries its way back.
    await expect(page.getByRole("link", { name: "Back to app" })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Main navigation" }),
    ).toBeHidden();
    await expect(
      page.getByRole("navigation", { name: "Settings sections" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Appearance", exact: true }).click();
    await expect(page.getByRole("radiogroup", { name: "Theme" })).toBeVisible();

    // A reload straight onto a section is the real test of the route split.
    await page.goto("app://lanework/settings/about");
    await expect(
      page.getByRole("heading", { name: "About", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "About", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("0.1.0", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Back to app" }).click();
    await expect(
      page.getByRole("button", { name: /^Switch project/ }),
    ).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("search filters both the sidebar and the page", async () => {
  const { page, cleanup } = await open();
  try {
    await page.goto("app://lanework/settings/appearance");
    const search = page.getByRole("textbox", { name: "Search settings" });
    const nav = page.getByRole("navigation", { name: "Settings sections" });

    await expect(nav.getByRole("link", { name: "Account" })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Theme" })).toBeVisible();

    // A word that exists only under Account: the sidebar narrows to it, and the
    // open page — which has no match — says so instead of going blank.
    await search.fill("revoke");
    await expect(nav.getByRole("link", { name: "Account" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Appearance" })).toBeHidden();
    await expect(page.getByText(/Nothing on this page matches/)).toBeVisible();

    // Nonsense narrows the sidebar to an explanation, never to a blank rail.
    await search.fill("zzzznope");
    await expect(page.getByText(/No settings match/)).toBeVisible();

    await search.fill("theme");
    await expect(nav.getByRole("link", { name: "Appearance" })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("the account page shows what the API gives a machine, and no secret", async () => {
  const { page, cleanup } = await open();
  try {
    await page.goto("app://lanework/settings/account");
    await expect(
      page.getByRole("heading", { name: "Account", exact: true }),
    ).toBeVisible();

    // Exactly what `GET /v1/machines/me` returns: the owner block the control
    // plane now sends on this one machine route, plus the ids.
    await expect(page.getByText("Test Person", { exact: true })).toBeVisible();
    await expect(
      page.getByText("test@example.test", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("test-user", { exact: true })).toBeVisible();
    await expect(page.getByText("test-machine").first()).toBeVisible();

    const body = (await page.locator("body").textContent()) ?? "";
    expect(body).not.toMatch(/lw_mch_|secret/i);
  } finally {
    await cleanup();
  }
});

test("a control plane that sends no owner still gives a usable account page", async () => {
  // The field is new, so an older control plane answering `/v1/machines/me`
  // without it has to degrade to the id rather than to a broken page.
  const { page, cleanup } = await open({ owner: false });
  try {
    await page.goto("app://lanework/settings/account");
    await expect(
      page.getByRole("heading", { name: "Account", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("test-user", { exact: true })).toBeVisible();
    await expect(page.getByText("Test Person")).toBeHidden();
    // Sign-out still works, which is the part that would matter most.
    await expect(
      page.getByRole("button", { name: "Sign out", exact: true }),
    ).toBeEnabled();
  } finally {
    await cleanup();
  }
});

test("signing out revokes on the control plane and closes the gate", async () => {
  const { page, plane, cleanup } = await open();
  try {
    await page.goto("app://lanework/settings/account");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();

    // Scoped to the dialog: the row behind it carries the same warning, so a
    // page-wide text locator would match two elements.
    const dialog = page.locator('[data-slot="alert-dialog-content"]');
    // The dialog names the consequence rather than asking "are you sure?".
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Sign out of this machine?");
    await expect(dialog).toContainText("revokes");
    await expect(dialog).toContainText("needs a fresh approval");

    // Cancelling does nothing at all.
    await page.getByRole("button", { name: "Keep this machine" }).click();
    await expect(
      page.getByRole("heading", { name: "Account", exact: true }),
    ).toBeVisible();
    expect(plane.calls).not.toContain("DELETE /v1/machines/me");

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("button", { name: "Sign out and revoke" }).click();

    // Revoked on the server, not merely forgotten locally, and the gate returns
    // without a reload.
    await expect(
      page.getByRole("heading", { name: "Sign in to continue" }),
    ).toBeVisible({ timeout: 15_000 });
    expect(plane.calls).toContain("DELETE /v1/machines/me");
  } finally {
    await cleanup();
  }
});

test("appearance switches the window between light, dark and the system", async () => {
  const { app, page, cleanup } = await open();
  try {
    await page.goto("app://lanework/settings/appearance");
    const group = page.getByRole("radiogroup", { name: "Theme" });
    const html = page.locator("html");
    const themeSource = () =>
      app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);

    // The whole chain in one pass: renderer → IPC → nativeTheme → the resolved
    // answer coming back → the `.dark` class the tokens hang off.
    await group.getByRole("radio", { name: "Dark" }).click();
    await expect(html).toHaveClass(/dark/);
    expect(await themeSource()).toBe("dark");
    // The chosen card is the one marked, so the page shows its own state.
    // A native radio carries this as a property, not an aria attribute.
    await expect(group.getByRole("radio", { name: "Dark" })).toBeChecked();
    await expect(group.getByRole("radio", { name: "Light" })).not.toBeChecked();

    await group.getByRole("radio", { name: "Light" }).click();
    await expect(html).not.toHaveClass(/dark/);
    expect(await themeSource()).toBe("light");

    // Survives a reload: the choice is a persisted preference, not a state the
    // window happened to be left in.
    await group.getByRole("radio", { name: "Dark" }).click();
    await expect(html).toHaveClass(/dark/);
    await page.reload();
    await expect(html).toHaveClass(/dark/);
    expect(await themeSource()).toBe("dark");

    // "System" hands the decision back to the OS, so the assertion is that we
    // stopped forcing one and that the class agrees with what main resolved.
    await page
      .getByRole("radiogroup", { name: "Theme" })
      .getByRole("radio", { name: "System" })
      .click();
    await expect.poll(themeSource).toBe("system");
    const dark = await app.evaluate(
      ({ nativeTheme }) => nativeTheme.shouldUseDarkColors,
    );
    if (dark) await expect(html).toHaveClass(/dark/);
    else await expect(html).not.toHaveClass(/dark/);
  } finally {
    await cleanup();
  }
});

test("settings looks the way it was reviewed", async () => {
  const { page, cleanup } = await open();
  try {
    await page.goto("app://lanework/settings/account");
    await expect(
      page.getByRole("heading", { name: "Account", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "../../.agents/artifacts/settings-account.png",
    });

    // The confirm dialog, because its destructive button is the third place the
    // registry button's transparent border showed through as a ring.
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    const dialog = page.locator('[data-slot="alert-dialog-content"]');
    // `toBeVisible` resolves as soon as it has a box, which is the START of a
    // 100ms fade — a screenshot then catches it at opacity 0 and looks like the
    // dialog never opened. Waiting on the settled opacity is the real signal.
    await expect(dialog).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: "../../.agents/artifacts/settings-signout-dialog.png",
    });
    await page.getByRole("button", { name: "Keep this machine" }).click();

    // Dark too: a two-pane layout with its own panel colours is exactly the
    // kind of thing that looks fine in one theme and wrong in the other.
    await page.goto("app://lanework/settings/appearance");
    await page
      .getByRole("radiogroup", { name: "Theme" })
      .getByRole("radio", { name: "Dark" })
      .click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({
      path: "../../.agents/artifacts/settings-appearance-dark.png",
    });
  } finally {
    await cleanup();
  }
});
