import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

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

test("the packaged app runs a real terminal from outside the asar", async () => {
  test.skip(
    process.platform !== "darwin",
    "This packaging smoke test targets macOS.",
  );
  const directory = process.arch === "arm64" ? "mac-arm64" : "mac";
  const plane = await startStubPlane({
    projects: [
      {
        id: "ws-alpha",
        slug: "alpha",
        name: "Alpha",
        path: null,
        baseBranch: null,
      },
    ],
  });
  plane.setBoard("ws-alpha", {
    columns: [{ key: "todo", name: "To-Do", role: "start" }],
    cards: [],
  });
  const profile = await mkdtemp(join(tmpdir(), "lanework-packaged-term-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const application = await electron.launch({
    executablePath: resolve(
      `release/${directory}/Lanework.app/Contents/MacOS/Lanework`,
    ),
    args: [],
    env: {
      ...launchEnv({ profile, home, apiUrl: plane.origin }),
      LANEWORK_TERMINAL_SHELL: "/bin/sh",
    },
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: /^Switch project/ }).click();
    await page.getByRole("option", { name: "Alpha" }).first().click();
    await expect(
      page.getByRole("button", { name: "Switch project — currently Alpha" }),
    ).toBeVisible();
    // ⚠️ The pty binary loads from app.asar.unpacked and `spawn-helper` runs
    // from there — neither can from inside the archive (FE-19/V3).
    await application.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById("terminal-toggle")?.click();
    });
    const screen = page
      .getByRole("region", { name: "Terminal" })
      .locator(".xterm-rows");
    await expect(screen).toContainText("$");
    await page.locator(".xterm").click();
    await page.keyboard.type("echo packaged-$((6*7))");
    await page.keyboard.press("Enter");
    await expect(screen).toContainText("packaged-42");
    // No live shell left behind: a packaged app asks before quitting over one,
    // and a native dialog is something this test cannot answer.
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("list", { name: "Terminals" })).toContainText(
      "exited",
    );
  } finally {
    await application.close();
    await plane.close();
    await removeProfile(profile);
  }
});
