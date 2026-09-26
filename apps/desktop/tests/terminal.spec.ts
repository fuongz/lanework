// The terminal panel end to end, with real shells in the real pty host
// (FE-19 V2). What these pin is the reason the host exists: a shell outlives
// every view of it — a hidden panel, another project, a reloaded window.
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { MenuItem } from "electron";
import type { MachineRecord } from "../electron/main/auth/store";
import { writeFolders } from "../electron/main/workspaces/store";
import type { Workspace } from "../shared/workspaces";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

test.skip(process.platform === "win32", "These drive a POSIX shell.");

const workspaces: Workspace[] = [
  {
    id: "ws-alpha",
    slug: "alpha",
    name: "Alpha",
    path: null,
    baseBranch: null,
  },
  { id: "ws-beta", slug: "beta", name: "Beta", path: null, baseBranch: null },
];

const board = {
  columns: [{ key: "todo", name: "To-Do", role: "start" }],
  cards: [],
};

/** A profile whose Alpha project is linked to a real folder on disk. */
async function seedProfile(origin: string) {
  const profile = await mkdtemp(join(tmpdir(), "lanew-terminal-"));
  const home = join(profile, "home");
  const repo = await realpath(await mkdtemp(join(tmpdir(), "lanew-repo-")));
  await mkdir(home, { recursive: true });
  await seedCredential(home, origin);
  const previous = process.env.LANEWORK_HOME;
  process.env.LANEWORK_HOME = home;
  await writeFolders(
    {
      machineId: "test-machine",
      userId: "test-user",
      apiUrl: origin,
      name: "test-machine",
      secret: "lw_mch_test-secret",
      owner: null,
    } satisfies MachineRecord,
    "alpha",
    [repo],
  );
  if (previous === undefined) delete process.env.LANEWORK_HOME;
  else process.env.LANEWORK_HOME = previous;
  return { profile, home, repo };
}

function boot(
  profile: string,
  home: string,
  origin: string,
  extra: Record<string, string> = {},
) {
  return electron.launch({
    args: [process.cwd()],
    env: {
      ...launchEnv({ profile, home, apiUrl: origin }),
      // A plain login `sh`: nothing of the developer's own shell setup.
      LANEWORK_TERMINAL_SHELL: "/bin/sh",
      // No agent CLIs "installed", whatever this machine has: + offers a
      // plain terminal only, unless a test says otherwise.
      LANEWORK_TERMINAL_AGENTS: "",
      ...extra,
    },
  });
}

async function switchTo(page: Page, name: string) {
  await page.getByRole("button", { name: /^Switch project/ }).click();
  await page.getByRole("option", { name }).first().click();
  await expect(
    page.getByRole("button", { name: `Switch project — currently ${name}` }),
  ).toBeVisible();
}

/** + in the panel's header, then one of the kinds it offers. */
async function newTab(page: Page, kind: "Terminal" | "Claude" | "Codex") {
  await panel(page).getByRole("button", { name: "New terminal" }).click();
  await page.getByRole("menuitem", { name: kind }).click();
}

/** Click a View-menu item the way the ⌘` accelerator does. */
async function menu(app: ElectronApplication, id: string) {
  await app.evaluate(({ Menu }, itemId) => {
    Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click();
  }, id);
}

const panel = (page: Page) => page.getByRole("region", { name: "Terminal" });
const screen = (page: Page) => panel(page).locator(".xterm-rows");
const tabs = (page: Page) =>
  panel(page).getByRole("list", { name: "Terminals" }).getByRole("listitem");
/** The bar a hidden panel folds into: "Terminal", and the count if any. */
const bar = (page: Page) => page.getByRole("button", { name: /^Terminal\b/ });

/** Type a command at the prompt and press Enter. */
async function run(page: Page, command: string) {
  await expect(screen(page)).toContainText("$");
  await panel(page).locator(".xterm").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

/** The shell's own pid, as it reports it. */
async function shellPid(page: Page, tag: string): Promise<string> {
  await run(page, `echo ${tag}-$$`);
  await expect(screen(page)).toContainText(new RegExp(`${tag}-\\d+`));
  const text = await screen(page).innerText();
  return text.match(new RegExp(`${tag}-(\\d+)`))?.[1] ?? "";
}

test("⌘` opens a terminal in the project's folder, and hiding it folds it into the bar", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const app = await boot(profile, home, plane.origin);
  try {
    const page = await app.firstWindow();
    // The View menu toggles on ⌘` and starts one on ⌘T — each with the key
    // FE-19/D6 first picked (⌃`, ⌃⇧`) kept as a hidden second one.
    const accelerators = await app.evaluate(({ Menu }) => {
      const item = (id: string) =>
        Menu.getApplicationMenu()?.getMenuItemById(id);
      return {
        toggle: item("terminal-toggle")?.accelerator,
        ctrl: item("terminal-toggle-ctrl")?.accelerator,
        ctrlHidden: item("terminal-toggle-ctrl")?.visible === false,
        add: item("terminal-new")?.accelerator,
        addCtrl: item("terminal-new-ctrl")?.accelerator,
        addCtrlHidden: item("terminal-new-ctrl")?.visible === false,
      };
    });
    expect(accelerators).toEqual({
      toggle: "CommandOrControl+`",
      ctrl: "Ctrl+`",
      ctrlHidden: true,
      add: "CommandOrControl+T",
      addCtrl: "Ctrl+Shift+`",
      addCtrlHidden: true,
    });
    // ⌘W is bound to nothing: in a one-window app, Close Window on it took
    // the whole app off the screen. The item stays in File, without a key.
    const closers = await app.evaluate(({ Menu }) => {
      const found: string[] = [];
      const walk = (items: MenuItem[]) => {
        for (const item of items) {
          if (
            item.role?.toLowerCase() === "close" ||
            /\+w$/i.test(item.accelerator ?? "")
          )
            found.push(item.label || String(item.role));
          if (item.submenu) walk(item.submenu.items);
        }
      };
      walk(Menu.getApplicationMenu()?.items ?? []);
      const close = Menu.getApplicationMenu()?.getMenuItemById("close-window");
      return { found, close: close?.label, key: close?.accelerator ?? null };
    });
    expect(closers).toEqual({ found: [], close: "Close Window", key: null });

    await switchTo(page, "Alpha");
    await expect(panel(page)).toHaveCount(0);
    // Before the first one: the bar, with no count.
    await expect(bar(page)).toHaveAccessibleName("Terminal");
    await menu(app, "terminal-toggle");
    // Toggling open with no terminal starts one.
    await expect(tabs(page)).toHaveCount(1);
    // The shell, then where it runs — a folder mark, no "·" (read out as
    // "in" to a screen reader).
    await expect(
      tabs(page).first().getByRole("button").first(),
    ).toHaveAccessibleName(`sh in ${basename(repo)}`);
    await run(page, "pwd; echo ok-$((6*7))");
    await expect(screen(page)).toContainText("ok-42");
    await expect(screen(page)).toContainText(repo);
    const pid = await shellPid(page, "before");

    // Hidden: folded into the bar, which counts it.
    await menu(app, "terminal-toggle");
    await expect(panel(page)).toHaveCount(0);
    await expect(bar(page)).toHaveAccessibleName("Terminal 1");
    // Shown again from the bar: the same shell, its output still there.
    await bar(page).click();
    await expect(tabs(page)).toHaveCount(1);
    await expect(bar(page)).toHaveCount(0);
    await expect(screen(page)).toContainText("ok-42");
    expect(await shellPid(page, "after")).toBe(pid);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("switching projects keeps a running shell running, and coming back shows it as it was", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home } = await seedProfile(plane.origin);
  const app = await boot(profile, home, plane.origin);
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    await menu(app, "terminal-toggle");
    await expect(tabs(page)).toHaveCount(1);
    const pid = await shellPid(page, "alpha");
    // Still running when the project is switched away from.
    await run(page, "sleep 2; echo late-$((40+2))");

    await switchTo(page, "Beta");
    // Beta has its own tabs — none — and switching starts nothing: there is
    // no empty panel, only the bar, with no count.
    await expect(panel(page)).toHaveCount(0);
    await expect(bar(page)).toHaveAccessibleName("Terminal");
    await page.waitForTimeout(2_500);

    await switchTo(page, "Alpha");
    await expect(tabs(page)).toHaveCount(1);
    // Printed while nobody was watching, and drawn from the snapshot.
    await expect(screen(page)).toContainText("late-42");
    expect(await shellPid(page, "again")).toBe(pid);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a reloaded window finds its terminals again", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home } = await seedProfile(plane.origin);
  const app = await boot(profile, home, plane.origin);
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    await menu(app, "terminal-toggle");
    const pid = await shellPid(page, "before");
    await run(page, "echo written-before-reload");

    await page.reload();
    await expect(
      page.getByRole("button", { name: "Switch project — currently Alpha" }),
    ).toBeVisible();
    await menu(app, "terminal-toggle");
    // The one it had, not a new one.
    await expect(tabs(page)).toHaveCount(1);
    await expect(screen(page)).toContainText("written-before-reload");
    expect(await shellPid(page, "after")).toBe(pid);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a closed tab stops its shell, and + starts another", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home } = await seedProfile(plane.origin);
  const app = await boot(profile, home, plane.origin);
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    await menu(app, "terminal-toggle");
    await expect(tabs(page)).toHaveCount(1);
    const first = await shellPid(page, "first");

    await newTab(page, "Terminal");
    await expect(tabs(page)).toHaveCount(2);
    const second = await shellPid(page, "second");
    expect(second).not.toBe(first);

    await panel(page).getByRole("button", { name: "Close terminal 2" }).click();
    await expect(tabs(page)).toHaveCount(1);
    await expect(bar(page)).toHaveCount(0);
    // The shell is gone, not merely hidden.
    await expect
      .poll(() => {
        try {
          process.kill(Number(second), 0);
          return "alive";
        } catch {
          return "gone";
        }
      })
      .toBe("gone");
    // And the first one is shown again, still the same shell.
    expect(await shellPid(page, "still")).toBe(first);

    // Closing the last one folds the panel away: no empty panel, the bar.
    await panel(page).getByRole("button", { name: "Close terminal 1" }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(bar(page)).toHaveAccessibleName("Terminal");
    // And the bar opens a new one, the same as ⌘`.
    await bar(page).click();
    await expect(tabs(page)).toHaveCount(1);
    expect(await shellPid(page, "fresh")).not.toBe(first);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

/** Drag one tab by its label and let go over another's far half. */
test("⇧↩ sends a new line without submitting, and a dropped file is typed as its quoted path", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home } = await seedProfile(plane.origin);
  const dropped = join(
    await realpath(await mkdtemp(join(tmpdir(), "lanework-drop-"))),
    "export (3).csv",
  );
  await writeFile(dropped, "a,b\n");
  const app = await boot(profile, home, plane.origin);
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    await menu(app, "terminal-toggle");
    await expect(tabs(page)).toHaveCount(1);

    // Raw mode, so the bytes arrive as sent: ESC + CR for ⇧↩, and ONE CR —
    // xterm's own Enter must not follow it.
    await run(
      page,
      "stty raw -echo; echo raw-$((40+2)); head -c 4 | od -An -tx1; stty sane",
    );
    await expect(screen(page)).toContainText("raw-42");
    await page.keyboard.type("a");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("b");
    await expect(screen(page)).toContainText("61 1b 0d 62");

    // A real file-backed File, the way Finder hands one over.
    await run(page, "clear");
    await panel(page).locator(".xterm").click();
    await page.keyboard.type("echo ");
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "drop-source";
      input.hidden = true;
      document.body.append(input);
    });
    await page.setInputFiles("#drop-source", dropped);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("#drop-source");
      const target = document.querySelector(".xterm")?.parentElement;
      const data = new DataTransfer();
      for (const file of Array.from(input?.files ?? [])) data.items.add(file);
      target?.dispatchEvent(
        new DragEvent("dragover", {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
        }),
      );
      target?.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    // Typed quoted, and the shell reads it back as one argument.
    await expect(screen(page)).toContainText("export (3).csv'");
    await page.keyboard.press("Enter");
    // The echoed line, then echo's output — the path again, unquoted.
    const path = dropped.replace(/[()./]/g, "\\$&");
    await expect(screen(page)).toContainText(
      new RegExp(`'${path}'\\s*${path}(?!')`),
    );
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

async function dragTab(page: Page, from: number, to: number) {
  const start = await tabs(page)
    .nth(from)
    .getByRole("button")
    .first()
    .boundingBox();
  const target = await tabs(page).nth(to).boundingBox();
  if (!start || !target) throw new Error("no tab to drag");
  const y = start.y + start.height / 2;
  await page.mouse.move(start.x + start.width / 2, y);
  await page.mouse.down();
  // Past the 6px that tell a drag from a click, then the rest of the way.
  await page.mouse.move(start.x + start.width / 2 + 12, y, { steps: 3 });
  await page.mouse.move(target.x + target.width * 0.8, y, { steps: 10 });
  await page.mouse.up();
}

test("dragging a tab moves it, leaves the shown one alone, and outlives a reload", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home } = await seedProfile(plane.origin);
  const app = await boot(profile, home, plane.origin);
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    await menu(app, "terminal-toggle");
    await expect(tabs(page)).toHaveCount(1);
    const first = await shellPid(page, "first");
    await newTab(page, "Terminal");
    await expect(tabs(page)).toHaveCount(2);
    const second = await shellPid(page, "second");
    const current = (index: number) =>
      tabs(page).nth(index).getByRole("button").first();

    // The first tab — not the one shown — dragged past the second.
    await dragTab(page, 0, 1);
    // The shown shell is still the second one, and now it is the first tab:
    // the drop was not also a click on the tab that was dragged.
    await expect(current(0)).toHaveAttribute("aria-current", "true");
    await expect(current(1)).not.toHaveAttribute("aria-current", "true");
    expect(await shellPid(page, "shown")).toBe(second);
    await current(1).click();
    expect(await shellPid(page, "moved")).toBe(first);

    // The HOST keeps the order, so a reloaded window lists it the same way.
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Switch project — currently Alpha" }),
    ).toBeVisible();
    await menu(app, "terminal-toggle");
    await expect(tabs(page)).toHaveCount(2);
    await current(0).click();
    expect(await shellPid(page, "reloaded-0")).toBe(second);
    await current(1).click();
    expect(await shellPid(page, "reloaded-1")).toBe(first);

    // The keyboard path for the same move: ⌥⌘→ on a focused tab, which keeps
    // the focus as it goes.
    await current(0).focus();
    await page.keyboard.press("Alt+Meta+ArrowRight");
    await expect(current(1)).toBeFocused();
    await current(0).click();
    expect(await shellPid(page, "keyed")).toBe(first);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("+ offers Claude or Codex only where this machine has it, and an agent tab starts its CLI", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  // Claude "installed", Codex not; and what a Claude tab types is a marker,
  // not the real CLI (the printed line is not the typed one).
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TERMINAL_AGENTS: "claude",
    LANEWORK_CLAUDE_BIN: "printf '%s-%s\\n' claude started",
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    await menu(app, "terminal-toggle");
    await expect(tabs(page)).toHaveCount(1);

    await panel(page).getByRole("button", { name: "New terminal" }).click();
    const items = page.getByRole("menuitem");
    await expect(items).toHaveText([/^Terminal\s*⌘T$/, "Claude"]);
    await page.getByRole("menuitem", { name: "Claude" }).click();

    await expect(tabs(page)).toHaveCount(2);
    await expect(
      tabs(page).nth(1).getByRole("button").first(),
    ).toHaveAccessibleName(`Claude in ${basename(repo)}`);
    // Typed into a shell once the tab's view is up: the CLI's output, then
    // — the stand-in exits at once — the shell's prompt again.
    await expect(screen(page)).toContainText("claude-started");
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

/** Drag the terminal's handle by `dy` pixels (up is negative). */
async function dragHandle(page: Page, dy: number) {
  const box = await page
    .getByRole("separator", { name: "Resize terminal" })
    .boundingBox();
  if (!box) throw new Error("no terminal handle");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 8 });
  await page.mouse.up();
}

const height = async (page: Page) =>
  (await panel(page).boundingBox())?.height ?? 0;

test("the panel opens tall, and at the height it was dragged to — after a hide and a relaunch too", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home } = await seedProfile(plane.origin);
  let app = await boot(profile, home, plane.origin);
  try {
    let page = await app.firstWindow();
    await switchTo(page, "Alpha");
    await menu(app, "terminal-toggle");
    await expect(tabs(page)).toHaveCount(1);
    // The first time: 40% of the column, not the 96px minimum.
    const column = await page.evaluate(() => window.innerHeight);
    const opened = await height(page);
    expect(opened / column).toBeGreaterThan(0.36);
    expect(opened / column).toBeLessThan(0.44);

    await dragHandle(page, -120);
    await expect.poll(() => height(page)).toBeGreaterThan(opened + 80);
    const dragged = await height(page);
    const near = async () => {
      await expect.poll(() => height(page)).toBeGreaterThan(dragged - 8);
      expect(await height(page)).toBeLessThan(dragged + 8);
    };

    // Hidden, then shown from the bar: the dragged height.
    await panel(page).getByRole("button", { name: "Hide terminal" }).click();
    await expect(panel(page)).toHaveCount(0);
    await bar(page).click();
    await near();

    // ⚠️ Hidden BEFORE the relaunch. A panel that starts collapsed has no size
    // of its own to go back to, and this is where it used to open at 96px.
    await menu(app, "terminal-toggle");
    await expect(panel(page)).toHaveCount(0);
    await app.close();

    app = await boot(profile, home, plane.origin);
    page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "Switch project — currently Alpha" }),
    ).toBeVisible();
    await menu(app, "terminal-toggle");
    await expect(tabs(page)).toHaveCount(1);
    await near();

    // Dragged shut past its minimum: a hide — the bar — and the height it
    // had is still the one it opens at.
    await dragHandle(page, dragged + 80);
    await expect(panel(page)).toHaveCount(0);
    await expect(bar(page)).toHaveAccessibleName("Terminal 1");
    await bar(page).click();
    await near();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});
