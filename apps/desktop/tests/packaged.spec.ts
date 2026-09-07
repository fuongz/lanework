import { resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("unpacked macOS app opens and calls native IPC", async () => {
  test.skip(
    process.platform !== "darwin",
    "This packaging smoke test targets macOS.",
  );
  const directory = process.arch === "arm64" ? "mac-arm64" : "mac";
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
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
      page.getByRole("heading", { name: /A little space/ }),
    ).toBeVisible();
    expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await page.screenshot({
      path: "../../.agents/artifacts/packaged-welcome.png",
    });
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByText("0.1.0", { exact: true })).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await application.close();
  }
});
