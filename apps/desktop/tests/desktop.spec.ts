import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { launchEnv, removeProfile, seedCredential } from "./auth-fixtures";

test("production SPA supports native IPC, navigation and persisted preferences", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lanework-test-"));
  const home = join(profile, "home");
  // Login is required, so this seeds an enrolled machine. Pointed at a dead
  // port, the probe says `unreachable` and the principal stays a `machine` —
  // which is FE-01 O1 in one line: enrolled, offline, still usable.
  await seedCredential(home);
  const env = launchEnv({ profile, home });
  const application = await electron.launch({ args: [resolve(".")], env });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(error.message);
    });
    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });
    await expect(
      page.getByRole("button", { name: /^Switch project/ }),
    ).toBeVisible();
    if (process.platform === "darwin") {
      // ⚠️ Clearance is VERTICAL now: the window buttons sit over the top of the
      // rail, so the first control in it has to start below them rather than to
      // the right of them. Same bug class as before, different geometry.
      await expect
        .poll(async () => {
          const bounds = await page
            .getByRole("button", { name: /^Switch project/ })
            .boundingBox();
          return bounds?.y ?? 0;
        })
        .toBeGreaterThanOrEqual(36);
      await expect(page.locator("body")).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      // ⚠️ The rail stays OPAQUE under vibrancy. `.settings-sidebar` was
      // translucent once and its colour then depended on whatever the window
      // happened to be composited over — fine in light, a washed mid-grey in
      // dark. The app's own rail must not repeat it.
      await expect(page.locator("aside.app-sidebar")).not.toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
    } else {
      await expect(page.locator("body")).not.toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
    }
    // Settings is its own full window, so there is no page called "Settings":
    // it lands on Account, and the version lives under About.
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Account", exact: true }),
    ).toBeVisible();

    // The theme is the persisted preference. Set it here; the RELAUNCH at the
    // bottom is what proves it survived the process rather than a reload —
    // coverage `settings.spec.ts` cannot give, because it never quits the app.
    await page.getByRole("link", { name: "Appearance", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme" })
      .getByRole("radio", { name: "Dark" })
      .click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    if (process.platform === "darwin")
      await expect(page.locator("body")).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );

    await page.getByRole("link", { name: "Back to app" }).click();
    await expect(
      page.getByRole("button", { name: /^Switch project/ }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => typeof (globalThis as { require?: unknown }).require,
      ),
    ).toBe("undefined");
    expect(
      await page.evaluate(() =>
        Object.keys((globalThis as { desktop?: object }).desktop ?? {}),
      ),
    ).toEqual([
      "getAppInfo",
      "setTheme",
      "onThemeChange",
      "onViewCommand",
      "zoomFactor",
      "auth",
      "workspaces",
      "git",
      "worktree",
      "terminal",
      // FE-28: Settings → Agents, the checkpoint hook on and off.
      "handoff",
      // FE-30: whether a project's folder is ready for an agent.
      "readiness",
    ]);
    expect(
      await page.evaluate(
        async () => (await fetch("app://lanework/assets/missing.js")).status,
      ),
    ).toBe(404);
    // Named for what it now captures: the flow ends back in the app, not in
    // settings, so `settings.png` would have been a lie.
    await page.screenshot({
      path: "../../.agents/artifacts/app-shell-dark.png",
    });
    expect(errors).toEqual([]);
  } finally {
    await application.close();
  }
  const reopened = await electron.launch({ args: [resolve(".")], env });
  try {
    const page = await reopened.firstWindow();
    // Survived a full quit and relaunch, not merely a reload.
    await expect(page.locator("html")).toHaveClass(/dark/);
    // Settings lands on Account, so the theme card is a click further in.
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Appearance", exact: true }).click();
    await expect(
      page
        .getByRole("radiogroup", { name: "Theme" })
        .getByRole("radio", { name: "Dark" }),
    ).toBeChecked();
  } finally {
    await reopened.close();
    await removeProfile(profile);
  }
});
