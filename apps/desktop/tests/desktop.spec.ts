import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { launchEnv, seedCredential } from "./auth-fixtures";

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
      page.getByRole("heading", { name: /A little space/ }),
    ).toBeVisible();
    if (process.platform === "darwin") {
      // Keep content beyond the native window buttons, including after CSS bundling.
      await expect
        .poll(async () => {
          const bounds = await page
            .getByRole("link", { name: "lanework", exact: true })
            .boundingBox();
          return bounds?.x ?? 0;
        })
        .toBeGreaterThanOrEqual(104);
      await expect(page.locator("body")).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect(page.locator('[data-slot="card"]').first()).not.toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
    } else {
      await expect(page.locator("body")).not.toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
    }
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByText("0.1.0", { exact: true })).toBeVisible();
    const toggle = page.getByRole("switch", { name: "Compact layout" });
    await toggle.check();
    await expect(page.locator("main")).toHaveAttribute("data-compact", "true");
    await page.reload();
    await expect(toggle).toBeChecked();
    if (process.platform === "darwin")
      await expect(page.locator("body")).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
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
    ).toEqual(["getAppInfo", "auth"]);
    expect(
      await page.evaluate(
        async () => (await fetch("app://lanework/assets/missing.js")).status,
      ),
    ).toBe(404);
    await page.screenshot({ path: "../../.agents/artifacts/settings.png" });
    expect(errors).toEqual([]);
  } finally {
    await application.close();
  }
  const reopened = await electron.launch({ args: [resolve(".")], env });
  try {
    const page = await reopened.firstWindow();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("switch", { name: "Compact layout" }),
    ).toBeChecked();
  } finally {
    await reopened.close();
    await rm(profile, { recursive: true, force: true });
  }
});
