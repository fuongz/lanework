import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { launchEnv, removeProfile, seedCredential } from "./auth-fixtures";

test("unpacked macOS app opens and calls native IPC", async () => {
  test.skip(
    process.platform !== "darwin",
    "This packaging smoke test targets macOS.",
  );
  const directory = process.arch === "arm64" ? "mac-arm64" : "mac";
  // ⚠️ This test previously isolated NOTHING — no userData, no app home. Once
  // login is required that means reading the developer's real credential, so it
  // would pass or fail depending on whether they happen to be signed in.
  const profile = await mkdtemp(join(tmpdir(), "lanework-packaged-"));
  const home = join(profile, "home");
  await seedCredential(home);
  const env = launchEnv({ profile, home });
  const application = await electron.launch({
    executablePath: resolve(
      `release/${directory}/Lanework.app/Contents/MacOS/Lanework`,
    ),
    args: [],
    env,
  });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(
      page.getByRole("button", { name: /^Switch project/ }),
    ).toBeVisible();
    expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await page.screenshot({
      path: "../../.agents/artifacts/packaged-welcome.png",
    });
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Account", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "About", exact: true }).click();
    await expect(page.getByText("0.1.0", { exact: true })).toBeVisible();
    // A reload deep in the settings tree — the route split has to survive
    // the app:// protocol handler in a packaged build too.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "About", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await removeProfile(profile);
  }
});
