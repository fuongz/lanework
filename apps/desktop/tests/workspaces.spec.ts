import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { MachineRecord } from "../electron/main/auth/store";
import { parseWorkspaces } from "../electron/main/workspaces/client";
import { readActive, writeActive } from "../electron/main/workspaces/store";
import type { DesktopApi } from "../shared/desktop";
import type { Workspace } from "../shared/workspaces";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

const workspaces: Workspace[] = [
  {
    slug: "lanework",
    name: "Lanework",
    path: "/projects/lanework",
    baseBranch: "main",
  },
  {
    slug: "cloud-project",
    name: "Cloud project",
    path: null,
    baseBranch: null,
  },
];

test("workspace responses reject malformed lists and only return display fields", () => {
  expect(parseWorkspaces({ workspaces: [] })).toEqual([]);
  expect(
    parseWorkspaces({
      profile: { name: "Private" },
      workspaces: [{ ...workspaces[0], secret: "ignored" }],
    }),
  ).toEqual([workspaces[0]]);
  for (const value of [
    null,
    {},
    { workspaces: null },
    { workspaces: [null] },
    { workspaces: [{ ...workspaces[0], path: 42 }] },
    { workspaces: [{ ...workspaces[0], slug: "" }] },
    { workspaces: [workspaces[0], workspaces[0]] },
  ])
    expect(() => parseWorkspaces(value)).toThrow(/invalid workspace/);
});

test("active workspace persists separately for each account, machine and API origin", async () => {
  const home = await mkdtemp(join(tmpdir(), "lanew-workspace-store-"));
  const previous = process.env.LANEWORK_HOME;
  process.env.LANEWORK_HOME = home;
  const record: MachineRecord = {
    machineId: "machine-a",
    userId: "account-a",
    apiUrl: "https://example.test",
    name: "Test",
    secret: "never-persist-this",
    owner: null,
  };
  try {
    expect(await readActive(record)).toBeNull();
    await writeActive(record, "lanework");
    expect(await readActive(record)).toBe("lanework");
    for (const other of [
      { ...record, userId: "account-b" },
      { ...record, machineId: "machine-b" },
      { ...record, apiUrl: "https://other.test" },
    ]) {
      expect(await readActive(other)).toBeNull();
      await writeActive(other, "cloud-project");
      expect(await readActive(record)).toBe("lanework");
    }
    for (const file of await readdir(join(home, "workspaces")))
      expect(
        await readFile(join(home, "workspaces", file), "utf8"),
      ).not.toContain(record.secret);
    await writeActive(record, null);
    expect(await readActive(record)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.LANEWORK_HOME;
    else process.env.LANEWORK_HOME = previous;
    await removeProfile(home);
  }
});

test("home loads the picker, saves a selection across relaunch and clears a removed workspace", async () => {
  const plane = await startStubPlane({ workspaces });
  // Keep the loading state observable without slowing every request.
  plane.setWorkspaceResponse(200, undefined, 400);
  const profile = await mkdtemp(join(tmpdir(), "lanew-workspaces-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const env = launchEnv({ profile, home, apiUrl: plane.origin });
  let app = await electron.launch({ args: [process.cwd()], env });
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByRole("status")).toHaveText(
      "Loading your workspaces…",
    );
    await expect(page.getByRole("list", { name: "Workspaces" })).toBeVisible();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeHidden();
    await expect(
      page.getByText("No local folder linked on this machine"),
    ).toBeVisible();
    expect(plane.calls).toContain("GET /v1/sync/state");
    expect(plane.workspaceAuth).toEqual(["Bearer lw_mch_test-secret"]);
    await page.screenshot({
      path: "../../.agents/artifacts/2026-09-08-workspace-picker.png",
      // Native macOS vibrancy is outside the renderer capture. Flatten only
      // the screenshot so the light theme is reviewable against its backdrop.
      style: "html { background: var(--background) !important; }",
    });

    await page.getByRole("button", { name: "Open Cloud project" }).click();
    await expect(
      page.getByRole("button", { name: "Open Lanework" }),
    ).toBeDisabled();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Cloud project", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("list", { name: "Workspaces" })).toBeHidden();
    expect(errors).toEqual([]);
    await page.screenshot({
      path: "../../.agents/artifacts/2026-09-08-workspace-active.png",
      style: "html { background: var(--background) !important; }",
    });
    await app.close();

    plane.setWorkspaces(workspaces);
    app = await electron.launch({ args: [process.cwd()], env });
    page = await app.firstWindow();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Cloud project", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Change workspace" }).click();
    await page.getByRole("button", { name: "Open Lanework" }).click();
    await expect(
      page.getByRole("heading", { name: "Lanework", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Branch: main")).toBeVisible();

    // A removed selection does not silently fall back to the first project.
    plane.setWorkspaces([workspaces[1]]);
    await page.reload();
    await expect(page.getByRole("list", { name: "Workspaces" })).toBeVisible();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeHidden();
    // Restoring that project does not resurrect a stale active pointer.
    plane.setWorkspaces(workspaces);
    await page.reload();
    await expect(page.getByRole("list", { name: "Workspaces" })).toBeVisible();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeHidden();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("home distinguishes service errors from empty and selection failures never replace active", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setWorkspaceResponse(503);
  const profile = await mkdtemp(join(tmpdir(), "lanew-workspace-errors-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("alert")).toContainText("HTTP 503");
    await expect(
      page.getByText("No workspaces yet", { exact: true }),
    ).toBeHidden();
    plane.setWorkspaces([]);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByText("No workspaces yet", { exact: true }),
    ).toBeVisible();
    plane.setWorkspaceResponse(200, { workspaces: "invalid" });
    await page.getByRole("button", { name: "Refresh list" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "invalid workspace list",
    );
    await expect(
      page.getByText("No workspaces yet", { exact: true }),
    ).toBeHidden();
    plane.setWorkspaces(workspaces);
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByRole("button", { name: "Open Lanework" }).click();
    await page.getByRole("button", { name: "Change workspace" }).click();
    await expect(
      page.getByRole("button", { name: "Open Cloud project" }),
    ).toBeVisible();
    plane.setWorkspaces([workspaces[0]]);
    await page.getByRole("button", { name: "Open Cloud project" }).click();
    await expect(page.getByRole("alert")).toContainText("no longer available");
    await page.reload();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Lanework", exact: true }),
    ).toBeVisible();
    // An offline launch reports an error and preserves the saved selection.
    plane.setWorkspaceResponse(503);
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("HTTP 503");
    plane.setWorkspaces(workspaces);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("workspace IPC rejects invalid selections and signed-out callers", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lanew-workspace-ipc-"));
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home: join(profile, "home") }),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Sign in to continue" }),
    ).toBeVisible();
    const failures = await page.evaluate(async () => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
        .workspaces;
      const result: string[] = [];
      for (const call of [
        () => api.load(),
        () => api.select("lanework"),
        () => api.select(""),
        () => api.select(42 as unknown as string),
      ]) {
        try {
          await call();
          result.push("unexpected success");
        } catch (error) {
          result.push((error as Error).message);
        }
      }
      return result;
    });
    expect(failures[0]).toContain("Sign in");
    expect(failures[1]).toContain("Sign in");
    expect(failures[2]).toContain("valid workspace slug");
    expect(failures[3]).toContain("valid workspace slug");
  } finally {
    await app.close();
    await removeProfile(profile);
  }
});
