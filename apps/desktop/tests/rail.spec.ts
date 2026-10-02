// The sidebar hidden and shown again (FE-20), and a rail at its narrowest
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

    // Dragged shut: gone, not folded to a strip (FE-20, the Codex way).
    await dragRail(page, -(full - 20));
    await expect.poll(() => width(page)).toBe(0);
    if (vibrancy) {
      // The way back sits beside the window controls, clear of them — the
      // current, larger ones end about 79pt in — at Codex's spacing…
      const show = page.getByRole("button", { name: "Show sidebar" });
      await expect(show).toHaveAttribute("title", "Show sidebar (⌘B)");
      expect((await show.boundingBox())?.x ?? 0).toBeGreaterThanOrEqual(90);
      // …and the header starts clear of both: 12pt after the button.
      const first = async () =>
        (await page.getByRole("heading", { level: 1 }).first().boundingBox())
          ?.x ?? 0;
      const button = async () => {
        const box = await show.boundingBox();
        return (box?.x ?? 0) + (box?.width ?? 0);
      };
      expect(await first()).toBeGreaterThanOrEqual((await button()) + 12);
      // …on the line the window controls sit on: the lights, the button and
      // the title share one centre, 22pt down (FE-20, as Codex has it).
      const middle = async (
        box: Promise<{ y: number; height: number } | null>,
      ) => {
        const b = await box;
        return (b?.y ?? 0) + (b?.height ?? 0) / 2;
      };
      const across = await middle(show.boundingBox());
      expect(Math.abs(across - 22)).toBeLessThanOrEqual(1);
      const title = page.getByRole("heading", { level: 1 }).first();
      expect(
        Math.abs((await middle(title.boundingBox())) - across),
      ).toBeLessThanOrEqual(1.5);
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
        const toggle = document.querySelector(".sidebar-toggle");
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
        .poll(async () => (await show.boundingBox())?.x ?? 0)
        .toBeGreaterThanOrEqual(90 / 0.9);
      await expect
        .poll(async () => (await first()) - (await button()))
        .toBeGreaterThanOrEqual(12 / 0.9 - 1);
      await zoom(1);

      // The button brings it back, at the width it was dragged to.
      await show.click();
      await expect.poll(() => width(page)).toBeGreaterThan(full - 4);
      await expect(
        page.getByRole("button", { name: "Hide sidebar" }),
      ).toBeVisible();

      // ⚠️ And no frame of hiding it draws the title under the controls.
      // Read where the page is about to paint: in a ResizeObserver on the
      // rail, called in every frame the rail changes size and — made after
      // the shell's own — after the shell has set the header's clearance for
      // that frame. The clearance used to follow a re-render, which landed a
      // frame late, and "All issues" flashed up under the lights.
      await page.evaluate(() => {
        const w = window as unknown as { __titleGaps: number[] };
        w.__titleGaps = [];
        const rail = document.querySelector('[data-testid="sidebar"]');
        const toggle = document.querySelector(".sidebar-toggle");
        const heading = document.querySelector("h1");
        if (!rail || !toggle || !heading) throw new Error("no rail or title");
        new ResizeObserver(() =>
          w.__titleGaps.push(
            heading.getBoundingClientRect().left -
              toggle.getBoundingClientRect().right,
          ),
        ).observe(rail);
        // Its first call — the rail as it stands — before it is hidden.
        return new Promise((done) =>
          requestAnimationFrame(() => setTimeout(done, 50)),
        );
      });
      await menu(app, "sidebar-toggle");
      await expect.poll(() => width(page)).toBe(0);
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
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(12 - 0.5);
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
    await menu(app, "sidebar-toggle");
    await expect.poll(() => width(page)).toBe(0);
    await menu(app, "sidebar-toggle");
    await expect.poll(() => width(page)).toBeGreaterThan(dragged - 4);
    expect(await width(page)).toBeLessThan(dragged + 4);

    // ⚠️ Hidden by ⌘B — which the group's own saved layout ignores, since
    // only a drag writes it — and hidden still after a relaunch.
    await menu(app, "sidebar-toggle");
    await expect.poll(() => width(page)).toBe(0);
    await app.close();
    app = await boot();
    page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "Switch project — currently Alpha" }),
    ).toBeAttached();
    await expect.poll(() => width(page)).toBe(0);
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

    // Ghost is ghost: nothing is drawn round Load more (FE-20). An unlayered
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
