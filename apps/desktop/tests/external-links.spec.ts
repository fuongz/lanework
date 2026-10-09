import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { launchEnv, removeProfile, seedCredential } from "./auth-fixtures";

test("GitHub device login opens in the browser while other popups stay blocked", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lanework-external-"));
  const home = join(profile, "home");
  await seedCredential(home);
  const application = await electron.launch({
    args: [resolve(".")],
    env: launchEnv({ profile, home }),
  });
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByRole("button", { name: /^Switch project/ }),
    ).toBeVisible();
    await application.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as typeof globalThis & { opened: string[] }).opened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    for (const url of [
      "https://github.com/login/device",
      "https://github.com/acme/widgets/pull/7",
      "https://github.com/acme/widgets/pull/7/files",
      "https://github.com.evil.example/acme/widgets/pull/7",
      "https://user:password@github.com/acme/widgets/pull/7",
      "https://github.com/login/device/other",
      "https://github.com.evil.example/login/device",
      "https://example.com/",
      "file:///tmp/example",
    ]) {
      await page.evaluate((href) => {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = "Open GitHub test";
        document.body.append(link);
      }, url);
      await page
        .getByRole("link", { name: "Open GitHub test", exact: true })
        .click();
      await page
        .getByRole("link", { name: "Open GitHub test", exact: true })
        .evaluate((link) => link.remove());
    }
    await expect
      .poll(() =>
        application.evaluate(
          () => (globalThis as typeof globalThis & { opened: string[] }).opened,
        ),
      )
      .toEqual([
        "https://github.com/login/device",
        "https://github.com/acme/widgets/pull/7",
        "https://github.com/acme/widgets/pull/7/files",
        "https://github.com/login/device/other",
      ]);
    expect(application.windows()).toHaveLength(1);
    expect(page.url()).toMatch(/^app:\/\/lanework\//);
  } finally {
    await application.close();
    await removeProfile(profile);
  }
});
