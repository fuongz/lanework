import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  type Page,
  test,
} from "@playwright/test";
import {
  DEAD_API,
  launchEnv,
  removeProfile,
  type StubCard,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

/**
 * Every screen this app can show, as pictures.
 *
 * ⚠️ NOT a test — it asserts nothing, and it is excluded from the `production`
 * project for that reason. It exists so a human can look at the whole UI in one
 * pass, which is the only way some classes of problem (a state nobody thought
 * to open, a colour that dies in dark mode, a screen that only appears when the
 * network is down) are ever found.
 *
 * ⚠️ It drives the REAL built app against the stub control plane — the same
 * fixture the tests use. A gallery rendered from mock components would be a
 * gallery of things the app does not actually do.
 *
 *   bun run gallery
 */
const OUT = "../../.agents/artifacts/ui-gallery";

const workspaces = [
  {
    id: "ws-lanework",
    slug: "lanework",
    name: "Lanework",
    path: "/projects/lanework",
    baseBranch: "main",
  },
  {
    id: "ws-cloud",
    slug: "cloud-project",
    name: "Cloud project",
    path: null,
    baseBranch: null,
  },
];

const COLUMNS = [
  { key: "backlog", name: "Backlog", role: "intake" },
  { key: "todo", name: "To-Do", role: "start" },
  { key: "processing", name: "In Progress", role: "active" },
  { key: "done", name: "Done", role: "done" },
  { key: "dropped", name: "Archived", role: "archive" },
];

const CATEGORIES = [
  {
    key: "product-design",
    name: "Product Design",
    prefix: "PD",
    tone: "violet",
  },
  { key: "frontend", name: "Frontend", prefix: "FE", tone: "sky" },
  { key: "backend", name: "Backend", prefix: "BE", tone: "emerald" },
  {
    key: "infrastructure",
    name: "Infrastructure",
    prefix: "INF",
    tone: "amber",
  },
  { key: "documentation", name: "Documentation", prefix: "DOC", tone: "teal" },
];

const TITLES = [
  "Cloud workspace board and migration entry",
  "Import receipts keep what landed",
  "Onboarding copy for the empty board",
  "Packaging pipeline for macOS",
  "Auth core: machine credentials",
  "Sidebar rail and project switcher",
  "Command palette jumps by task id",
  "Checklist survives a rewrite",
  "Board tones come from the service",
  "Filter bar with a single button",
  "Skeletons for every load",
  "Select everywhere, no native menus",
  "Drag to reorder inside a lane",
  "Deep link to a card by task id",
  "Offline shows the saved copy",
];

const BODY = `## Context

The rail is 240px and never scrolls away. **Grouping** and filters live in the
URL, so a link carries them and Back undoes them.

- \`settings-shell.tsx\` was already the right language
- \`BoardCategory.prefix\` is the Jira issue key
- the old board was a card wall

| File | Change |
| --- | --- |
| \`routes/\` | new project routes |
| \`stores/\` | one board store |

> Behaviours that were already right have to survive a redesign.

\`\`\`ts
const groups = groupIssues(view, "status", search);
\`\`\``;

function cards(count: number): StubCard[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `card-${i}`,
    revision: 1,
    title: TITLES[i % TITLES.length],
    body: i === 0 ? BODY : "",
    columnKey: COLUMNS[i % COLUMNS.length].key,
    categoryKey: CATEGORIES[i % CATEGORIES.length].key,
    taskId: `${CATEGORIES[i % CATEGORIES.length].prefix}-${String(i + 1).padStart(2, "0")}`,
    priority: (["high", "medium", "low", null] as const)[i % 4],
    tags: i % 2 ? ["ui"] : ["cloud", "electron"],
    rank: String(i).padStart(4, "0"),
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-08T07:00:00.000Z",
    parentId: i > 12 ? "card-0" : null,
    checklist:
      i === 0
        ? [
            {
              key: "D1",
              section: "decisions",
              text: "Project lives in the URL: /w/$slug/issues",
              checked: true,
              checkedAt: "2026-09-08T01:00:00.000Z",
              note: null,
            },
            {
              key: "D2",
              section: "decisions",
              text: "A 240px rail replaces the app header",
              checked: true,
              checkedAt: "2026-09-08T01:00:00.000Z",
              note: null,
            },
            {
              key: "D3",
              section: "decisions",
              text: "Detail is a route",
              checked: false,
              checkedAt: null,
              note: null,
              group: "g1",
            },
            {
              key: "D4",
              section: "decisions",
              text: "Detail is a slide-over",
              checked: false,
              checkedAt: null,
              note: null,
              group: "g1",
            },
            {
              key: "V1",
              section: "verify",
              text: "bun run gate is green",
              checked: true,
              checkedAt: "2026-09-08T02:00:00.000Z",
              note: null,
            },
            {
              key: "V2",
              section: "verify",
              text: "A board of 30+ cards stays readable",
              checked: false,
              checkedAt: null,
              note: null,
            },
          ]
        : [],
  }));
}

/**
 * The contact sheet, and the lightbox behind it.
 *
 * ⚠️ Its own function so the page can be rebuilt from the PNGs already on disk
 * — `GALLERY_INDEX_ONLY=1` — without launching Electron 7 times to re-take
 * shots that have not changed.
 */
function renderIndex(entries: { file: string; label: string }[]): string {
  return `<!doctype html><meta charset="utf-8"><title>Lanework UI gallery</title>
<style>
  body{margin:0;padding:24px;font:13px/1.5 -apple-system,system-ui,sans-serif;background:#f6f6f7;color:#111}
  h1{font-size:15px;margin:0 0 4px}
  p{margin:0 0 20px;color:#666}
  .grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(460px,1fr))}
  figure{margin:0;background:#fff;border-radius:10px;box-shadow:0 0 0 1px rgba(0,0,0,.07),0 1px 3px rgba(0,0,0,.06);overflow:hidden}
  button.shot{display:block;width:100%;padding:0;border:0;background:none;cursor:zoom-in}
  img{display:block;width:100%;height:auto}
  figcaption{padding:8px 10px;color:#444;border-top:1px solid rgba(0,0,0,.06);text-align:left}
  dialog{border:0;padding:0;max-width:100vw;max-height:100vh;background:transparent}
  dialog::backdrop{background:rgba(0,0,0,.82)}
  .viewer{display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px}
  .viewer img{max-width:min(1600px,94vw);max-height:86vh;width:auto;border-radius:8px;background:#fff;cursor:zoom-out}
  .bar{display:flex;align-items:center;gap:14px;color:#fff;font-size:12px}
  .bar button{border:0;border-radius:6px;padding:4px 10px;background:rgba(255,255,255,.14);color:#fff;font:inherit;cursor:pointer}
  .bar button:hover{background:rgba(255,255,255,.24)}
</style>
<h1>Lanework UI gallery</h1>
<p>${entries.length} screens, captured from the built app. Click one to enlarge — arrows move, Esc closes. Regenerate with <code>bun run gallery</code>.</p>
<div class="grid">
${entries
  .map(
    (entry, i) =>
      `<figure><button class="shot" data-i="${i}"><img src="${entry.file}" alt="${entry.label}" loading="lazy"></button><figcaption>${entry.label}</figcaption></figure>`,
  )
  .join("\n")}
</div>
<dialog id="viewer">
  <div class="viewer">
    <img id="big" alt="">
    <div class="bar">
      <button data-step="-1">← Prev</button>
      <span id="cap"></span>
      <button data-step="1">Next →</button>
      <button data-close>Close</button>
    </div>
  </div>
</dialog>
<script>
  const shots = ${JSON.stringify(entries)};
  const viewer = document.getElementById("viewer");
  const big = document.getElementById("big");
  const cap = document.getElementById("cap");
  let at = 0;
  function show(i) {
    at = (i + shots.length) % shots.length;
    big.src = shots[at].file;
    big.alt = shots[at].label;
    cap.textContent = (at + 1) + " / " + shots.length + " — " + shots[at].label;
  }
  for (const button of document.querySelectorAll("button.shot"))
    button.addEventListener("click", () => {
      show(Number(button.dataset.i));
      viewer.showModal();
    });
  for (const button of document.querySelectorAll("[data-step]"))
    button.addEventListener("click", () => show(at + Number(button.dataset.step)));
  for (const button of document.querySelectorAll("[data-close]"))
    button.addEventListener("click", () => viewer.close());
  big.addEventListener("click", () => viewer.close());
  // Clicking the backdrop closes it: the dialog itself fills the viewport, so
  // a press that lands on the element rather than on its content is a miss.
  viewer.addEventListener("click", (event) => {
    if (event.target === viewer) viewer.close();
  });
  addEventListener("keydown", (event) => {
    if (!viewer.open) return;
    if (event.key === "ArrowRight") show(at + 1);
    if (event.key === "ArrowLeft") show(at - 1);
  });
</script>`;
}

let shot = 0;
const index: { file: string; label: string }[] = [];

/**
 * ⚠️ Both themes, every time. A tone that dies against one ground is the single
 * commonest thing a screenshot pass catches, and it is invisible if you only
 * ever look at the theme you happen to use.
 */
async function capture(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((mode) => {
      // ⚠️ Through `globalThis`: this file is typechecked with the Node lib,
      // which has no DOM globals, and the body only ever runs in the page.
      (
        globalThis as unknown as {
          document: {
            documentElement: {
              classList: { toggle(name: string, on: boolean): void };
            };
          };
        }
      ).document.documentElement.classList.toggle("dark", mode === "dark");
    }, theme);
    await page.waitForTimeout(160);
    const file = `${String(++shot).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${theme}.png`;
    await page.screenshot({ path: join(OUT, file) });
    index.push({ file, label: `${label} — ${theme}` });
  }
}

async function open(options: {
  apiUrl?: string;
  seed?: (plane: Awaited<ReturnType<typeof startStubPlane>>) => void;
  planeWorkspaces?: typeof workspaces;
  /**
   * Folders the OS chooser will "return", so the create dialog can be shot
   * with a list in it.
   *
   * ⚠️ A native panel is the one control this file cannot drive, and the empty
   * state is not the interesting picture — the list with a primary in it is.
   */
  folders?: string[];
}): Promise<{
  app: ElectronApplication;
  page: Page;
  plane: Awaited<ReturnType<typeof startStubPlane>>;
  close: () => Promise<void>;
}> {
  const plane = await startStubPlane({
    workspaces: options.planeWorkspaces ?? workspaces,
  });
  options.seed?.(plane);
  const profile = await mkdtemp(join(tmpdir(), "lanework-gallery-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: {
      ...launchEnv({
        profile,
        home,
        apiUrl: options.apiUrl ?? plane.origin,
      }),
      ...(options.folders?.length
        ? { LANEWORK_TEST_FOLDERS: options.folders.join(":") }
        : {}),
    },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 820 });
  return {
    app,
    page,
    plane,
    close: async () => {
      await app.close();
      await plane.close();
      await removeProfile(profile);
    },
  };
}

test("ui gallery", async () => {
  await mkdir(OUT, { recursive: true });

  // ⚠️ Rebuild the page from what is already on disk. Editing the contact sheet
  // is not a reason to re-drive the app seven times, and re-shooting would
  // quietly replace screens somebody may be halfway through reviewing.
  if (process.env.GALLERY_INDEX_ONLY) {
    const files = (await readdir(OUT))
      .filter((name) => name.endsWith(".png"))
      .sort();
    await writeFile(
      join(OUT, "index.html"),
      renderIndex(
        files.map((file) => ({
          file,
          label: file
            .replace(/^\d+-/, "")
            .replace(/\.png$/, "")
            .replace(/-(light|dark)$/, " — $1")
            .replace(/-/g, " "),
        })),
      ),
    );
    return;
  }

  // ── A board with real cards ────────────────────────────────────────────────
  {
    const { page, plane, close } = await open({
      seed: (p) =>
        p.setBoard("ws-lanework", {
          migratedAt: "2026-09-08T05:00:00.000Z",
          columns: COLUMNS,
          categories: CATEGORIES,
          cards: cards(15),
        }),
    });
    try {
      await page.getByRole("button", { name: /^Switch project/ }).waitFor();
      await page
        .getByRole("link", { name: /^Lanework/ })
        .first()
        .click();
      await page.waitForTimeout(1200);
      await capture(page, "issues list");

      await page.getByRole("combobox", { name: "Group by" }).click();
      await page.waitForTimeout(300);
      await capture(page, "group select open");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Filter" }).click();
      await page.waitForTimeout(400);
      // ⚠️ Before any hover. One click must open ONE panel — a submenu that
      // appears here means something is opening it on focus.
      await capture(page, "filter menu");
      await page.getByRole("menuitem", { name: "Status" }).hover();
      await page.waitForTimeout(500);
      await capture(page, "filter submenu");
      await page.getByRole("option", { name: "To-Do" }).click();
      await page.waitForTimeout(500);
      await capture(page, "filter chip");
      await page.getByRole("button", { name: "Remove Status filter" }).click();
      await page.waitForTimeout(400);

      await page.getByRole("link", { name: /^Issues/ }).click();
      await page.waitForTimeout(500);
      await page.keyboard.press("ControlOrMeta+k");
      await page.waitForTimeout(400);
      await capture(page, "command palette");
      await page.keyboard.press("Escape");

      await page.goto("app://lanework/w/lanework/issues/PD-01");
      await page.waitForTimeout(900);
      await capture(page, "issue detail");

      // Empty first, because an empty composer is the state everybody sees and
      // the one where a missing placeholder or a dead rail shows up.
      await page.keyboard.press("ControlOrMeta+n");
      await page.waitForTimeout(600);
      await capture(page, "new issue empty");
      await page
        .getByRole("textbox", { name: "Issue title" })
        .fill("Sidebar keeps the folder item visible");
      await page
        .getByRole("textbox", { name: "Description" })
        .fill(
          "## Context\n\nThe rail answers “where is this repo on my machine”, and that question is not only asked when the board is empty.",
        );
      await page.getByRole("combobox", { name: "Category" }).click();
      await page.waitForTimeout(300);
      await page.getByRole("option", { name: "Frontend" }).click();
      await page.getByRole("combobox", { name: "Priority" }).click();
      await page.waitForTimeout(300);
      await page.getByRole("option", { name: "High" }).click();
      // Labels are picked, not typed into a bare field — the same control the
      // card's own rail carries.
      await page.getByRole("button", { name: "Add label" }).click();
      await page.waitForTimeout(300);
      await page
        .getByRole("textbox", { name: "New label" })
        .fill("ui, electron");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      await capture(page, "new issue filled");

      await page.goto("app://lanework/settings/workspaces");
      await page.waitForTimeout(700);
      await page
        .getByRole("button", { name: /^Import from local into / })
        .first()
        .click();
      await page.waitForTimeout(700);
      await capture(page, "import from local");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);

      // Offline: the saved copy, with its label.
      plane.setBoardOffline(true);
      await page.goto("app://lanework/w/lanework/issues");
      await page.getByRole("button", { name: "Refresh board" }).click();
      await page.waitForTimeout(800);
      await capture(page, "board offline");
    } finally {
      await close();
    }
  }

  // ── An empty board ─────────────────────────────────────────────────────────
  {
    const { page, close } = await open({
      folders: [join(tmpdir(), "idle-game"), join(tmpdir(), "lanework-mcp")],
      seed: (p) =>
        p.setBoard("ws-lanework", {
          migratedAt: "2026-09-08T05:00:00.000Z",
          columns: COLUMNS,
          categories: CATEGORIES,
          cards: [],
        }),
    });
    try {
      await page.getByRole("button", { name: /^Switch project/ }).waitFor();
      await page
        .getByRole("link", { name: /^Lanework/ })
        .first()
        .click();
      await page.waitForTimeout(1000);
      await capture(page, "issues empty");
      await page.getByRole("button", { name: /^Switch project/ }).click();
      await page.waitForTimeout(400);
      await capture(page, "project switcher");
      await page.getByRole("button", { name: "New project" }).click();
      await page.waitForTimeout(400);
      await capture(page, "create project empty");
      await page.getByLabel("New project name").fill("Idle game");
      await page.getByRole("button", { name: /^Add folders/ }).click();
      await page.waitForTimeout(400);
      await capture(page, "create project folders");
      await page.keyboard.press("Escape");
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.waitForTimeout(800);
      await capture(page, "settings account");
      await page.getByRole("link", { name: "Appearance", exact: true }).click();
      await page.waitForTimeout(500);
      await capture(page, "settings appearance");
      await page.getByRole("link", { name: "About", exact: true }).click();
      await page.waitForTimeout(500);
      await capture(page, "settings about");
      await page.getByRole("link", { name: "Projects", exact: true }).click();
      await page.waitForTimeout(500);
      await capture(page, "settings projects");
      await page.getByRole("button", { name: "Delete Lanework" }).click();
      await page.waitForTimeout(400);
      await capture(page, "settings project delete");
      await page.keyboard.press("Escape");
    } finally {
      await close();
    }
  }

  // ── An account with no projects ────────────────────────────────────────────
  {
    const { page, close } = await open({ planeWorkspaces: [] });
    try {
      await page.getByRole("button", { name: /^Switch project/ }).waitFor();
      await page.waitForTimeout(900);
      await capture(page, "no projects");
    } finally {
      await close();
    }
  }

  // ── A project the picker has to ask about ──────────────────────────────────
  {
    const { page, close } = await open({});
    try {
      await page.getByRole("button", { name: /^Switch project/ }).waitFor();
      await page.waitForTimeout(900);
      await capture(page, "choose a project");
    } finally {
      await close();
    }
  }

  // ── The control plane is down ──────────────────────────────────────────────
  {
    const { page, close } = await open({
      seed: (p) => p.setWorkspaceResponse(503),
    });
    try {
      await page.getByRole("button", { name: /^Switch project/ }).waitFor();
      await page.waitForTimeout(1200);
      await capture(page, "projects unreachable");
    } finally {
      await close();
    }
  }

  // ── A service too old to name a board ──────────────────────────────────────
  {
    const older = workspaces.map(({ slug, name, path, baseBranch }) => ({
      slug,
      name,
      path,
      baseBranch,
    })) as unknown as typeof workspaces;
    const { page, close } = await open({ planeWorkspaces: older });
    try {
      await page.getByRole("button", { name: /^Switch project/ }).waitFor();
      await page
        .getByRole("link", { name: /^Lanework/ })
        .first()
        .click();
      await page.waitForTimeout(1000);
      await capture(page, "board unavailable");
    } finally {
      await close();
    }
  }

  // ── First run: the three steps that end on the sign-in gate ────────────────
  {
    const profile = await mkdtemp(join(tmpdir(), "lanework-gallery-gate-"));
    const app = await electron.launch({
      args: [process.cwd()],
      env: launchEnv({
        profile,
        home: join(profile, "home"),
        apiUrl: DEAD_API,
      }),
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1280, height: 820 });
      await page.waitForTimeout(1500);
      await capture(page, "onboarding welcome");

      await page.getByRole("button", { name: "Get started" }).click();
      await page.waitForTimeout(400);
      await capture(page, "onboarding theme");

      await page.getByRole("button", { name: "Continue" }).click();
      await page.waitForTimeout(400);
      await capture(page, "sign in");
    } finally {
      await app.close();
      await removeProfile(profile);
    }
  }

  await writeFile(join(OUT, "index.html"), renderIndex(index));
});
