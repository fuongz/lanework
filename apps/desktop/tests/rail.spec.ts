// The sidebar hidden and shown again (FE-19), and a rail at its narrowest
// that keeps every label on one line. Real app, stub control plane.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import type { Workspace } from "../shared/workspaces";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

const workspaces: Workspace[] = [
  {
    id: "ws-alpha",
    slug: "alpha",
    name: "Alpha",
    path: null,
    baseBranch: null,
  },
];

/** 30 cards in the active lane: more than its 20-card page, so a Load more. */
const board = {
  migratedAt: "2026-09-08T05:00:00.000Z",
  columns: [
    { key: "todo", name: "To-Do", role: "start" },
    { key: "processing", name: "In Progress", role: "active" },
  ],
  categories: [],
  cards: Array.from({ length: 30 }, (_, i) => ({
    id: `card-${i}`,
    revision: 1,
    title: `Card number ${i + 1}`,
    body: "",
    columnKey: "processing",
    categoryKey: null,
    taskId: `FE-${String(i + 1).padStart(2, "0")}`,
    priority: null,
    tags: [],
    rank: String(i).padStart(4, "0"),
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-08T07:00:00.000Z",
    checklist: [],
  })),
};

async function seed(projects = workspaces) {
  const plane = await startStubPlane({ workspaces: projects });
  plane.setBoard("ws-alpha", board);
  const profile = await mkdtemp(join(tmpdir(), "lanew-rail-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const boot = () =>
    electron.launch({
      args: [process.cwd()],
      env: launchEnv({ profile, home, apiUrl: plane.origin }),
    });
  return { plane, profile, boot };
}

async function switchTo(page: Page, name: string) {
  await page.getByRole("button", { name: /^Switch project/ }).click();
  await page.getByRole("option", { name }).first().click();
  await expect(
    page.getByRole("button", { name: `Switch project — currently ${name}` }),
  ).toBeVisible();
  // ⚠️ The picker CLOSED, not only chosen from: while it animates away it
  // still covers the window, and a drag started then lands on it instead of
  // the rail's edge.
  await expect(page.getByRole("option")).toHaveCount(0);
}

/** Click a View-menu item the way its accelerator does. */
async function menu(app: ElectronApplication, id: string) {
  await app.evaluate(({ Menu }, itemId) => {
    Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click();
  }, id);
}

/** The rail folded to its icons (FE-57). */
const MINI = 56;

const width = async (page: Page) =>
  (await page.getByTestId("sidebar").boundingBox())?.width ?? 0;

/** Drag the rail's edge by `dx` pixels (left is negative). */
async function dragRail(page: Page, dx: number) {
  const box = await page
    .getByRole("separator", { name: "Resize sidebar" })
    .boundingBox();
  if (!box) throw new Error("no rail handle");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

/** A box in the page, from the DOM — opacity-0 things included. */
const rect = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const box = node.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        height: box.height,
        opacity: Number(getComputedStyle(node).opacity),
      };
    });

/** The window's title bar (FE-58) and its slot. */
const BAR = ".window-titlebar";
const SLOT = ".window-titlebar-slot";

test("the sidebar hides and comes back — by its button beside the window controls, ⌘B or a drag — and a relaunch keeps it hidden", async () => {
  const { plane, profile, boot } = await seed();
  let app = await boot();
  try {
    let page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const accelerator = await app.evaluate(
      ({ Menu }) =>
        Menu.getApplicationMenu()?.getMenuItemById("sidebar-toggle")
          ?.accelerator,
    );
    expect(accelerator).toBe("CommandOrControl+B");
    const full = await width(page);
    expect(full).toBeGreaterThan(180);
    const vibrancy = await page.evaluate(
      () => document.documentElement.dataset.vibrancy === "true",
    );
    const barBottom = async () => (await rect(page, BAR)).bottom;
    // The rail and the page's card start UNDER the window's title bar, open
    // or folded (FE-58), so nothing in them steps around the window controls.
    const underBar = async () => {
      const bottom = await barBottom();
      const rail = await page.getByTestId("sidebar").boundingBox();
      const main = await page.getByTestId("main").boundingBox();
      expect(rail?.y ?? 0).toBeGreaterThanOrEqual(bottom - 0.5);
      expect(main?.y ?? 0).toBeGreaterThanOrEqual(bottom - 0.5);
    };
    // Open: the bar is there, its slot starting where the rail ends — with
    // no rule drawn between the two.
    expect((await rect(page, BAR)).height).toBeGreaterThan(30);
    await underBar();
    await expect(page.locator(".window-titlebar-divider")).toHaveCount(0);
    expect((await rect(page, SLOT)).left).toBeGreaterThan(full + 8);

    // Dragged shut: folded to its icons, not gone (FE-57/D1a).
    await dragRail(page, -(full - 20));
    await expect.poll(() => width(page)).toBeLessThan(MINI + 1);
    expect(await width(page)).toBeGreaterThan(MINI - 1);
    const show = page.getByRole("button", { name: "Show sidebar" });
    // The way back is the mini rail's first slot (FE-57/D5a)…
    expect((await show.boundingBox())?.x ?? 99).toBeLessThan(MINI);
    // …and the title bar stays, as tall as it was open.
    expect((await rect(page, BAR)).height).toBeGreaterThan(30);
    await underBar();
    if (vibrancy) {
      // …while back and forward stay beside the window controls, clear of
      // them — the current, larger ones end about 79pt in — at Codex's
      // spacing…
      const back = page.getByRole("button", { name: "Go back" });
      const nav = page.getByRole("navigation", { name: "Window" });
      expect((await back.boundingBox())?.x ?? 0).toBeGreaterThanOrEqual(90);
      // …and the page's slot starts after them, not at the rail's 56px
      // edge, under the window controls.
      const slotClear = async () => {
        const box = await nav.boundingBox();
        return (
          (await rect(page, SLOT)).left - (box?.x ?? 0) - (box?.width ?? 0)
        );
      };
      await expect.poll(slotClear).toBeGreaterThanOrEqual(8);
      // …on the line the window controls sit on, 22pt down (FE-19).
      const middle = async (
        box: Promise<{ y: number; height: number } | null>,
      ) => {
        const b = await box;
        return (b?.y ?? 0) + (b?.height ?? 0) / 2;
      };
      const across = await middle(back.boundingBox());
      expect(Math.abs(across - 22)).toBeLessThanOrEqual(1);
      expect(across).toBeLessThan(await barBottom());
      const lights = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition(),
      );
      // The lights are 14pt tall on current macOS (12pt before it).
      expect(Math.abs((lights?.y ?? 0) + 7 - across)).toBeLessThanOrEqual(1.5);
      // It stays put while the window is resized — read in the resize event
      // itself, where a zoom worked out from `outerWidth / innerWidth` came
      // out a few percent off on every step and moved the button with it.
      await page.evaluate(() => {
        const w = window as unknown as { __toggleXs: number[] };
        w.__toggleXs = [];
        const toggle = document.querySelector(".sidebar-nav");
        window.addEventListener("resize", () =>
          w.__toggleXs.push(toggle?.getBoundingClientRect().left ?? -1),
        );
      });
      for (let i = 1; i <= 8; i++) {
        await app.evaluate(({ BrowserWindow }, step) => {
          const win = BrowserWindow.getAllWindows()[0];
          const [w = 1000, h = 760] = win?.getSize() ?? [];
          win?.setSize(w + (step % 2 ? 23 : -17), h);
        }, i);
        await page.waitForTimeout(40);
      }
      const xs = await page.evaluate(
        () => (window as unknown as { __toggleXs: number[] }).__toggleXs,
      );
      expect(xs.length).toBeGreaterThan(3);
      expect(new Set(xs.map((x) => x.toFixed(1)))).toEqual(
        new Set([(xs[0] ?? 0).toFixed(1)]),
      );
      // ⚠️ At 90% too: the page zooms, the controls do not.
      const zoom = (factor: number) =>
        app.evaluate(({ BrowserWindow }, f) => {
          BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(f);
        }, factor);
      await zoom(0.9);
      await expect
        .poll(async () => (await back.boundingBox())?.x ?? 0)
        .toBeGreaterThanOrEqual(90 / 0.9);
      await expect.poll(slotClear).toBeGreaterThanOrEqual(8);
      await expect
        .poll(async () => across - (await barBottom()))
        .toBeLessThan(0);
      await underBar();
      await zoom(1);

      // The button brings it back, at the width it was dragged to.
      await show.click();
      await expect.poll(() => width(page)).toBeGreaterThan(full - 4);
      await expect(
        page.getByRole("button", { name: "Hide sidebar" }),
      ).toBeVisible();

      // ⚠️ And no frame of folding it draws the page's title under back and
      // forward: each frame the slot starts clear of them to the right.
      // Read where the page is about to paint: in a ResizeObserver on the
      // rail, called in every frame the rail changes size and — made after
      // the shell's own — after the shell has set `--rail-width` for that
      // frame. The clearance used to follow a re-render, which landed a frame
      // late, and "All issues" flashed up under the lights.
      await page.evaluate(() => {
        const w = window as unknown as { __titleGaps: number[] };
        w.__titleGaps = [];
        const rail = document.querySelector('[data-testid="sidebar"]');
        const toggle = document.querySelector(".sidebar-nav");
        const slot = document.querySelector(".window-titlebar-slot");
        if (!rail || !toggle || !slot) throw new Error("no rail or slot");
        new ResizeObserver(() => {
          const nav = toggle.getBoundingClientRect();
          w.__titleGaps.push(slot.getBoundingClientRect().left - nav.right);
        }).observe(rail);
        // Its first call — the rail as it stands — before it is hidden.
        return new Promise((done) =>
          requestAnimationFrame(() => setTimeout(done, 50)),
        );
      });
      await menu(app, "sidebar-toggle");
      await expect.poll(() => width(page)).toBeLessThan(MINI + 1);
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => setTimeout(done, 50)),
          ),
      );
      const gaps = await page.evaluate(
        () => (window as unknown as { __titleGaps: number[] }).__titleGaps,
      );
      // The first call is the rail as it stood; at least one more is it gone.
      expect(gaps.length).toBeGreaterThan(1);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(8);
      await menu(app, "sidebar-toggle");
      await expect.poll(() => width(page)).toBeGreaterThan(full - 4);
    } else {
      await menu(app, "sidebar-toggle");
      await expect.poll(() => width(page)).toBeGreaterThan(full - 4);
    }

    // Dragged wider, then ⌘B hides it and brings it back at that width.
    await dragRail(page, 60);
    await expect.poll(() => width(page)).toBeGreaterThan(full + 40);
    const dragged = await width(page);
    // The title bar's slot follows the rail's edge.
    expect((await rect(page, SLOT)).left).toBeGreaterThan(dragged + 8);
    await menu(app, "sidebar-toggle");
    await expect.poll(() => width(page)).toBeLessThan(MINI + 1);
    await menu(app, "sidebar-toggle");
    await expect.poll(() => width(page)).toBeGreaterThan(dragged - 4);
    expect(await width(page)).toBeLessThan(dragged + 4);

    // ⚠️ Hidden by ⌘B — which the group's own saved layout ignores, since
    // only a drag writes it — and hidden still after a relaunch.
    await menu(app, "sidebar-toggle");
    await expect.poll(() => width(page)).toBeLessThan(MINI + 1);
    await app.close();
    app = await boot();
    page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "Switch project — currently Alpha" }),
    ).toBeAttached();
    await expect.poll(() => width(page)).toBeLessThan(MINI + 1);
    await menu(app, "sidebar-toggle");
    await expect.poll(() => width(page)).toBeGreaterThan(dragged - 4);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("at its narrowest the rail keeps every label on one line, and a ghost button draws no border", async () => {
  const { plane, profile, boot } = await seed();
  const app = await boot();
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    await dragRail(page, 180 - (await width(page)));
    await expect.poll(() => width(page)).toBeLessThan(185);
    expect(await width(page)).toBeGreaterThan(175);

    // One line each: a row keeps its 30px however little room its label has.
    const newIssue = page.getByRole("button", { name: /^New issue/ });
    expect((await newIssue.boundingBox())?.height ?? 99).toBeLessThan(32);
    const label = newIssue.getByText("New issue", { exact: true });
    expect((await label.boundingBox())?.height ?? 99).toBeLessThan(20);
    // ⌘N steps aside so the words can stay.
    await expect(newIssue.locator("kbd")).toBeHidden();
    for (const name of ["Issues", "Pull requests", "Settings"]) {
      const row = page.getByRole("link", { name: new RegExp(`^${name}`) });
      expect((await row.boundingBox())?.height ?? 99, name).toBeLessThan(32);
    }

    // Ghost is ghost: nothing is drawn round Load more (FE-19). An unlayered
    // default border colour used to outrank `border-transparent`.
    const more = page.getByRole("button", { name: /^Load more in/ }).first();
    await expect(more).toBeVisible();
    expect(
      await more.evaluate((el) => getComputedStyle(el).borderTopColor),
    ).toBe("rgba(0, 0, 0, 0)");
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("one hover background slides from row to row, and fades once the pointer leaves the rail", async () => {
  const { plane, profile, boot } = await seed();
  const app = await boot();
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const hover = page.locator(".app-sidebar").getByTestId("rail-hover");
    const rail = page.getByRole("navigation", { name: "Repository" });
    const top = async (locator: ReturnType<Page["locator"]>) =>
      Math.round((await locator.boundingBox())?.y ?? -1);
    const opacity = () =>
      hover.evaluate((node) => Number(getComputedStyle(node).opacity));

    const changes = rail.getByRole("link", { name: /^Changes/ });
    const history = rail.getByRole("link", { name: "History" });
    await changes.hover();
    await expect.poll(() => top(hover)).toBe(await top(changes));
    await expect.poll(opacity).toBe(1);

    // To the next row: the SAME element goes there, it is not a second one.
    await history.hover();
    await expect.poll(() => top(hover)).toBe(await top(history));
    await expect(hover).toHaveCount(1);

    // Out of the rail: gone, not stuck on the last row.
    await page.mouse.move(900, 400);
    await expect.poll(opacity).toBe(0);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("shared hover follows project, settings, select, filter and issue rows", async () => {
  const { plane, profile, boot } = await seed([
    ...workspaces,
    { ...workspaces[0], id: "ws-beta", slug: "beta", name: "Beta" },
  ]);
  const app = await boot();
  try {
    const page = await app.firstWindow();
    const follow = async (row: Locator) => {
      await row.hover();
      const area = row.locator(
        'xpath=ancestor::div[@data-slot="rail-hover-area"][1]',
      );
      const background = area.getByTestId("rail-hover");
      await expect(background).toHaveCount(1);
      await expect
        .poll(async () => {
          const target = await row.boundingBox();
          const box = await background.boundingBox();
          if (!target || !box) return false;
          return ["x", "y", "width", "height"].every(
            (key) =>
              Math.abs(
                target[key as keyof typeof target] -
                  box[key as keyof typeof box],
              ) < 1,
          );
        })
        .toBe(true);
      await expect
        .poll(async () => {
          await row.hover();
          return background.evaluate((node) =>
            Number(getComputedStyle(node).opacity),
          );
        })
        .toBe(1);
      return background;
    };

    await page.getByRole("button", { name: /^Switch project/ }).click();
    await follow(page.getByRole("option", { name: "Alpha", exact: true }));
    await follow(page.getByRole("option", { name: "Beta", exact: true }));
    await follow(
      page.getByRole("button", { name: "New project", exact: true }),
    );
    await follow(
      page.getByRole("button", { name: "Project settings", exact: true }),
    );
    await page.getByRole("option", { name: "Alpha", exact: true }).click();
    await expect(
      page.getByRole("option", { name: "Alpha", exact: true }),
    ).toBeHidden();

    await follow(page.getByRole("link", { name: /FE-01 Card number 1/ }));
    await follow(page.getByRole("link", { name: /FE-02 Card number 2/ }));

    await page.getByRole("combobox", { name: "Group by" }).click();
    await follow(page.getByRole("option", { name: "Status", exact: true }));
    const selectHover = await follow(
      page.getByRole("option", { name: "Priority", exact: true }),
    );
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() =>
        selectHover.evaluate((node) => Number(getComputedStyle(node).opacity)),
      )
      .toBe(0);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await follow(page.getByRole("menuitem", { name: "Status", exact: true }));
    await follow(page.getByRole("option", { name: "To-Do", exact: true }));
    for (const row of [
      page.getByRole("menuitem", { name: "Status", exact: true }),
      page.getByRole("option", { name: "To-Do", exact: true }),
      page.getByPlaceholder("Status", { exact: true }),
    ]) {
      expect(
        await row.evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe("13px");
    }
    const filterHover = await follow(
      page.getByRole("option", { name: "In Progress", exact: true }),
    );
    await page.getByPlaceholder("Status", { exact: true }).press("ArrowDown");
    await expect
      .poll(() =>
        filterHover.evaluate((node) => Number(getComputedStyle(node).opacity)),
      )
      .toBe(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await follow(page.getByRole("link", { name: "Account", exact: true }));
    await follow(page.getByRole("link", { name: "Appearance", exact: true }));
    await page.mouse.move(900, 400);
    await expect
      .poll(() =>
        page
          .getByTestId("rail-hover")
          .evaluate((node) => Number(getComputedStyle(node).opacity)),
      )
      .toBe(0);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("back and forward move through the window's history like a browser's, from buttons against the rail's right edge", async () => {
  const { plane, profile, boot } = await seed();
  const app = await boot();
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const vibrancy = await page.evaluate(
      () => document.documentElement.dataset.vibrancy === "true",
    );
    test.skip(!vibrancy, "the title-bar buttons are drawn on macOS only");
    const back = page.getByRole("button", { name: "Go back" });
    const forward = page.getByRole("button", { name: "Go forward" });

    // One group, flush right in the rail: back, forward, then the sidebar.
    const nav = await page
      .getByRole("navigation", { name: "Window" })
      .boundingBox();
    const rail = await page.getByTestId("sidebar").boundingBox();
    expect(
      Math.abs(
        (rail?.x ?? 0) +
          (rail?.width ?? 0) -
          10 -
          ((nav?.x ?? 0) + (nav?.width ?? 0)),
      ),
    ).toBeLessThanOrEqual(1);
    const xs = await Promise.all(
      [back, forward, page.getByRole("button", { name: "Hide sidebar" })].map(
        async (button) => (await button.boundingBox())?.x ?? 0,
      ),
    );
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);

    // Forward needs somewhere to go: nothing ahead yet.
    await expect(forward).toBeDisabled();
    await page.getByText("Card number 1", { exact: true }).click();
    await expect.poll(() => page.url()).toContain("/issues/FE-01");
    await expect(forward).toBeDisabled();

    await back.click();
    await expect.poll(() => page.url()).toMatch(/\/issues(\?.*)?$/);
    await expect(forward).toBeEnabled();
    await forward.click();
    await expect.poll(() => page.url()).toContain("/issues/FE-01");
    await expect(forward).toBeDisabled();

    // A new navigation drops what was ahead, as a browser does.
    await back.click();
    await expect(forward).toBeEnabled();
    await page.getByText("Card number 2", { exact: true }).click();
    await expect.poll(() => page.url()).toContain("/issues/FE-02");
    await expect(forward).toBeDisabled();
    await expect(back).toBeEnabled();
    await page.screenshot({
      path: "../../.agents/artifacts/test-results/history-nav.png",
      clip: { x: 0, y: 0, width: 420, height: 60 },
    });
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("folded, the rail keeps every destination as an icon — named, lit when open, reachable by Tab — and its first slot opens it", async () => {
  const { plane, profile, boot } = await seed();
  const app = await boot();
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    await menu(app, "sidebar-toggle");
    await expect.poll(() => width(page)).toBeLessThan(MINI + 1);
    const rail = page.getByTestId("sidebar");

    // D2: every slot, top to bottom, by the name its open row has.
    const names = [
      "Show sidebar",
      "Switch project — currently Alpha",
      "New issue",
      "Search",
      "Issues",
      "Changes",
      "History",
      "Pull requests",
      "Settings",
    ];
    const ys: number[] = [];
    for (const name of names) {
      const slot = rail.getByRole(
        /^(Issues|Changes|History|Pull requests|Settings)$/.test(name)
          ? "link"
          : "button",
        { name, exact: true },
      );
      await expect(slot).toBeVisible();
      const box = await slot.boundingBox();
      expect((box?.x ?? 99) + (box?.width ?? 0)).toBeLessThanOrEqual(MINI);
      ys.push(box?.y ?? 0);
    }
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    // …all of them drawn: the column fills the rail's height, and the last
    // slot sits inside the window, not in a sliver that scrolls.
    const railBox = await rail.boundingBox();
    const column = await rail.locator(".app-sidebar").boundingBox();
    expect(column?.height ?? 0).toBeGreaterThan((railBox?.height ?? 0) - 2);
    const settings = await rail
      .getByRole("link", { name: "Settings", exact: true })
      .boundingBox();
    const viewport =
      page.viewportSize() ??
      (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    expect((settings?.y ?? 0) + (settings?.height ?? 0)).toBeLessThanOrEqual(
      viewport.height,
    );
    // The quota bars and the local-mode card are the open rail's only.
    await expect(rail.getByText("Settings", { exact: true })).toHaveCount(0);

    // V2: a slot goes where its row does, and the open page is lit.
    const issues = rail.getByRole("link", { name: "Issues", exact: true });
    await expect(issues).toHaveAttribute("aria-current", "page");
    const history = rail.getByRole("link", { name: "History", exact: true });
    await history.click();
    await expect.poll(() => page.url()).toContain("/w/alpha/history");
    await expect(history).toHaveAttribute("aria-current", "page");
    await expect(issues).not.toHaveAttribute("aria-current", "page");

    // Named on hover, with the shortcut.
    await rail.getByRole("button", { name: "Search", exact: true }).hover();
    const tip = page.locator('[data-slot="tooltip-content"]');
    await expect(tip).toContainText("Search");
    await expect(tip).toContainText("⌘K");

    // Reachable from the keyboard, in order.
    await rail.getByRole("button", { name: "New issue", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(
      rail.getByRole("button", { name: "Search", exact: true }),
    ).toBeFocused();

    await page.screenshot({
      path: "../../.agents/artifacts/test-results/mini-rail.png",
      clip: { x: 0, y: 0, width: 420, height: 520 },
    });

    // Its first slot opens it again.
    await rail
      .getByRole("button", { name: "Show sidebar", exact: true })
      .click();
    await expect.poll(() => width(page)).toBeGreaterThan(180);
    await expect(
      page.getByRole("button", { name: "Hide sidebar" }),
    ).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});
