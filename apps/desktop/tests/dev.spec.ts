import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { DEAD_API, removeProfile, seedCredential } from "./auth-fixtures";

test("renderer HMR preserves the page; main and preload changes restart Electron", async () => {
  test.setTimeout(60_000);
  // ⚠️ The rail, not a page. Whatever this test edits has to be on screen in
  // EVERY state the app can boot into, and it boots here against a dead API —
  // so a string from a board or a picker would be a string that is sometimes
  // absent for reasons that have nothing to do with HMR.
  const source = "src/components/features/shell/app-sidebar.tsx";
  const main = "electron/main/index.ts";
  const preload = "electron/preload/index.ts";
  const originals = await Promise.all(
    [source, main, preload].map((file) => readFile(file, "utf8")),
  );
  const profile = await mkdtemp(join(tmpdir(), "lanework-dev-test-"));
  const home = join(profile, "home");
  // Login is required, and `LANEWORK_TEST_USER_DATA` does not move the app
  // home — without the seed and the override this reads the developer's real
  // credential and shows the gate instead of the page it asserts on.
  await seedCredential(home);
  const proc = spawn(process.execPath, ["scripts/dev.mjs"], {
    env: {
      ...process.env,
      LANEWORK_TEST_USER_DATA: profile,
      LANEWORK_HOME: home,
      LANEWORK_API_URL: DEAD_API,
      LANEWORK_DEV_DEBUG_PORT: "9223",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  proc.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  proc.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch("http://127.0.0.1:9223/json/version")).ok;
          } catch {
            return false;
          }
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) throw new Error("No Electron renderer page");
    await expect(page.getByText("Search…", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      (globalThis as { hmrProbe?: string }).hmrProbe = "preserved";
    });
    await writeFile(
      source,
      originals[0].replace(">Search…<", ">Live search…<"),
    );
    await expect(page.getByText("Live search…", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => (globalThis as { hmrProbe?: string }).hmrProbe),
    ).toBe("preserved");
    await writeFile(source, originals[0]);
    await expect(page.getByText("Search…", { exact: true })).toBeVisible();
    const initialStarts = (logs.match(/Electron started/g) ?? []).length;
    await writeFile(main, `${originals[1]}\n// HMR verification\n`);
    await expect
      .poll(() => (logs.match(/Electron started/g) ?? []).length)
      .toBe(initialStarts + 1);
    const beforePreload = (logs.match(/Electron started/g) ?? []).length;
    await writeFile(preload, `${originals[2]}\n// HMR verification\n`);
    await expect
      .poll(() => (logs.match(/Electron started/g) ?? []).length)
      .toBe(beforePreload + 1);
  } finally {
    const exited = new Promise<void>((resolve) =>
      proc.once("exit", () => resolve()),
    );
    proc.kill("SIGTERM");
    await exited;
    await Promise.all(
      [source, main, preload].map((file, index) =>
        writeFile(file, originals[index]),
      ),
    );
    await removeProfile(profile);
    if (test.info().status !== test.info().expectedStatus) console.error(logs);
  }
});
