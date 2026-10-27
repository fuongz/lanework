import { execFileSync } from "node:child_process";
// The terminal panel end to end, with real shells in the real pty host
// (FE-19 V2). What these pin is the reason the host exists: a shell outlives
// every view of it — a hidden panel, another project, a reloaded window.
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
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
import { claudeProjectDir } from "../electron/main/terminal/agent-sessions";
import { writeFolders } from "../electron/main/workspaces/store";
import type { DesktopTerminalApi } from "../shared/terminal";
import type { Workspace } from "../shared/workspaces";
import {
  CLAUDE_BG_ID,
  CLAUDE_ID,
  CODEX_ID,
  claudeRowName,
  resumeClaudeInTerminal,
  seedAgentFacts,
  seedAgentHome,
  seedBackgroundTasks,
  seedSubagents,
} from "./agent-fixtures";
import {
  launchEnv,
  removeProfile,
  type StubCard,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

/**
 * The window's title bar (FE-58). An agent's header — its name, facts, Model,
 * Tasks, Stop — is drawn there, outside the page's region, so a locator for
 * any of it starts here.
 */
const titlebar = (page: Page) => page.locator('[data-slot="window-titlebar"]');

/** A card's row in the Issues list (FE-75), found by its title. */
const issueRow = (page: Page, title: string) =>
  page.getByRole("listitem").filter({ hasText: title });

/**
 * A conversation's rail row, either agent's: Codex's resumes it, Claude's
 * opens its chat (FE-62/D3). Not "Open new … session", a nameless agent's.
 */
const CONVERSATION_ROW = /^(Resume|Open) “/;

/**
 * Close the turn `seedBackgroundTasks` leaves open on `CLAUDE_BG_ID`, as
 * Claude does once it has started its background shells: they run on after
 * the turn. ⚠️ A conversation mid-turn cannot go from its chat to a terminal
 * (FE-62/D3), and its row now opens that chat.
 */
async function endBackgroundTurn(agentHome: string, repo: string) {
  await appendFile(
    join(
      agentHome,
      ".claude",
      "projects",
      claudeProjectDir(repo),
      `${CLAUDE_BG_ID}.jsonl`,
    ),
    `${JSON.stringify({ type: "system", subtype: "turn_duration" })}\n`,
  );
}

/**
 * A stand-in for an agent's CLI: it prints what it was asked in a form the
 * typed line does not contain, then stays running — as a real CLI does —
 * until it is told `/exit`.
 */
async function standIn(dir: string, name: string, format: string) {
  const file = join(dir, `${name}-stand-in.sh`);
  await writeFile(
    file,
    `#!/bin/sh\nprintf '${format}\\n' ${name} "$@"\nwhile IFS= read -r line; do [ "$line" = "/exit" ] && exit 0; done\n`,
    { mode: 0o755 },
  );
  return file;
}

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

test("the Agents + offers only the CLIs this machine has, and a new agent opens in the main view — never as a panel tab", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  // Claude "installed", Codex not; and what it types is a marker, not the
  // real CLI (the printed line is not the typed one).
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TERMINAL_AGENTS: "claude",
    LANEWORK_CLAUDE_BIN: await standIn(profile, "claude", "%s-started"),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");

    // The panel's + is shells only now (FE-26/D3).
    await menu(app, "terminal-toggle");
    await expect(tabs(page)).toHaveCount(1);
    await panel(page).getByRole("button", { name: "New terminal" }).click();
    await expect(page.getByRole("menuitem")).toHaveText([/^Terminal\s*⌘T$/]);
    await page.keyboard.press("Escape");

    // The Agents group has a folder to run in, so it shows — with its +.
    const group = page.getByRole("navigation", { name: "Agents" });
    await group.getByRole("button", { name: "New agent" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["New Claude"]);
    await page.getByRole("menuitem", { name: "New Claude" }).click();

    const view = page.getByRole("region", {
      name: "Claude — New Claude session",
    });
    await expect(view).toBeVisible();
    await expect(view.locator(".xterm-rows")).toContainText("claude-started");
    await expect(titlebar(page)).toContainText(basename(repo));
    // Its own row, under Running, marked as the one on screen — and no tab
    // in the panel.
    await expect(
      page
        .getByRole("navigation", { name: "Running" })
        .getByRole("button", { name: "Open new Claude session" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(tabs(page)).toHaveCount(1);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

/**
 * A stand-in Codex that behaves as the real one does about its rollout
 * (FE-31): stamped with the moment it started, but written only once
 * somebody types, its turn opened before its prompt is — and, like Codex,
 * taking no conversation id from us.
 */
async function codexStandIn(dir: string, agentHome: string, id: string) {
  const day = join(agentHome, ".codex", "sessions", "2026", "09", "28");
  const file = join(dir, "codex-rollout-stand-in.sh");
  await writeFile(
    file,
    `#!/bin/sh
started=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
echo codex-started
rollout='${day}/rollout-2026-09-28T09-46-37-${id}.jsonl'
while IFS= read -r line; do
  [ "$line" = "/exit" ] && exit 0
  if [ ! -f "$rollout" ]; then
    mkdir -p '${day}'
    # Held OPEN and appended to, as Codex does — which a recursive watch on
    # macOS reports only when the file is made, not as it is written.
    exec 3>>"$rollout"
    printf '{"type":"session_meta","payload":{"id":"${id}","cwd":"%s","timestamp":"%s"}}\n{"type":"event_msg","payload":{"type":"task_started"}}\n' "$PWD" "$started" >&3
    # The prompt that titles it lands a moment later, in the same turn —
    # no news to anything watching the turn's state.
    sleep 1
  fi
  printf '{"type":"event_msg","payload":{"type":"user_message","message":"%s"}}\n' "$line" >&3
  echo "codex-heard-$line"
done
`,
    { mode: 0o755 },
  );
  return file;
}

/**
 * A stand-in Claude that keeps `~/.claude/sessions/<pid>.json` as the real
 * one does (FE-31): `/clear` moves it to a new, empty conversation, and
 * `/resume` takes it back to the first — writing nothing to its transcript.
 */
async function claudeStandIn(
  dir: string,
  agentHome: string,
  repo: string,
  cleared: string,
) {
  const projects = join(
    agentHome,
    ".claude",
    "projects",
    claudeProjectDir(repo),
  );
  const sessions = join(agentHome, ".claude", "sessions");
  const file = join(dir, "claude-pid-stand-in.sh");
  await writeFile(
    file,
    `#!/bin/sh
first="$2"
current="$first"
startedAt=$(($(date +%s) * 1000))
mkdir -p '${projects}' '${sessions}'
at() {
  printf '{"pid":%s,"sessionId":"%s","startedAt":%s}' $$ "$current" "$startedAt" > '${sessions}/'$$.json
}
at
echo claude-started
while IFS= read -r line; do
  case "$line" in
    /exit) exit 0 ;;
    /clear) current='${cleared}'; printf '{"type":"mode"}\n' >> '${projects}/'"$current".jsonl; at ;;
    /resume) current="$first"; at ;;
    *)
      printf '{"type":"user","cwd":"%s","message":{"role":"user","content":"%s"}}\n{"type":"system","subtype":"turn_duration"}\n' "$PWD" "$line" >> '${projects}/'"$current".jsonl ;;
  esac
  echo "claude-heard-$line"
done
`,
    { mode: 0o755 },
  );
  return file;
}

test("a running agent keeps ONE row as its CLI moves between conversations (FE-31)", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const agentHome = join(profile, "agent-home");
  // As on a machine that has run both here before: their folders exist,
  // today's Codex day does not yet.
  await mkdir(join(agentHome, ".codex", "sessions", "2026", "09", "27"), {
    recursive: true,
  });
  await mkdir(join(agentHome, ".claude", "sessions"), { recursive: true });
  await mkdir(join(agentHome, ".claude", "projects", claudeProjectDir(repo)), {
    recursive: true,
  });
  const codexId = "01a0e5e8-3b95-7df3-a823-000000000abc";
  const cleared = "77777777-2222-4333-8444-555555555555";
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
    LANEWORK_CODEX_BIN: await codexStandIn(profile, agentHome, codexId),
    LANEWORK_CLAUDE_BIN: await claudeStandIn(profile, agentHome, repo, cleared),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const group = page.getByRole("navigation", { name: "Agents" });
    const running = page.getByRole("navigation", { name: "Running" });
    const type = async (region: string, line: string) => {
      await page
        .getByRole("region", { name: region })
        .locator(".xterm")
        .click();
      await page.keyboard.type(line);
      await page.keyboard.press("Enter");
    };

    // A new Codex: no id until its first prompt writes a rollout — then
    // its row IS that conversation, in Running, and nowhere else.
    await group.getByRole("button", { name: "New agent" }).click();
    await page.getByRole("menuitem", { name: "New Codex" }).click();
    await expect(
      page
        .getByRole("region", { name: "Codex — New Codex session" })
        .locator(".xterm-rows"),
    ).toContainText("codex-started");
    await type("Codex — New Codex session", "Respond to hello");
    await expect(
      page
        .getByRole("region", { name: "Codex — New Codex session" })
        .locator(".xterm-rows"),
    ).toContainText("codex-heard-Respond to hello");
    await expect(
      running.getByRole("button", {
        name: "Resume “Respond to hello” in Codex",
      }),
    ).toBeVisible();
    await expect(
      running.getByRole("button", { name: "Open new Codex session" }),
    ).toHaveCount(0);
    await expect(group.getByRole("button", { name: /in Codex$/ })).toHaveCount(
      0,
    );

    // A new Claude, asked something: one row, in Running.
    await group.getByRole("button", { name: "New agent" }).click();
    await page.getByRole("menuitem", { name: "New Claude" }).click();
    await expect(
      page
        .getByRole("region", { name: "Claude — New Claude session" })
        .locator(".xterm-rows"),
    ).toContainText("claude-started");
    await type("Claude — New Claude session", "Read readme");
    await expect(
      page
        .getByRole("region", { name: "Claude — New Claude session" })
        .locator(".xterm-rows"),
    ).toContainText("claude-heard-Read readme");
    const readme = claudeRowName("Read readme");
    await expect(running.getByRole("button", { name: readme })).toBeVisible();

    // `/clear`: the agent is on an empty conversation now, and the one it
    // left is a transcript — in Agents.
    await type("Claude — Read readme", "/clear");
    await expect(
      running.getByRole("button", { name: "Open new Claude session" }),
    ).toBeVisible();
    await expect(group.getByRole("button", { name: readme })).toBeVisible();

    // `/resume` back to it: ONE row again, in Running — though nothing was
    // written to its transcript.
    await type("Claude — New Claude session", "/resume");
    await expect(running.getByRole("button", { name: readme })).toBeVisible();
    await expect(
      running.getByRole("button", { name: "Open new Claude session" }),
    ).toHaveCount(0);
    await expect(group.getByRole("button", { name: readme })).toHaveCount(0);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("an agent whose CLI cannot start stays on screen to say why — only a clean exit closes it", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home } = await seedProfile(plane.origin);
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TERMINAL_AGENTS: "claude",
    LANEWORK_CLAUDE_BIN: join(profile, "no-such-claude"),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const group = page.getByRole("navigation", { name: "Agents" });
    await group.getByRole("button", { name: "New agent" }).click();
    await page.getByRole("menuitem", { name: "New Claude" }).click();
    const view = page.getByRole("region", {
      name: "Claude — New Claude session",
    });
    // The shell's own words, shown rather than held back, and a way on.
    await expect(view.locator(".xterm-rows")).toContainText("no-such-claude");
    await expect(
      titlebar(page).getByText("exited", { exact: true }),
    ).toBeVisible();
    await expect(
      titlebar(page).getByRole("button", { name: "Start again" }),
    ).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("an Agents row resumes its conversation in the main view, which outlives leaving it — and Stop ends it", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const agentHome = join(profile, "agent-home");
  await seedAgentHome(agentHome, repo);
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
    LANEWORK_CLAUDE_BIN: await standIn(profile, "claude", "ran-%s-%s-%s"),
    LANEWORK_CODEX_BIN: await standIn(profile, "codex", "ran-%s-%s-%s"),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const group = page.getByRole("navigation", { name: "Agents" });
    const runningGroup = page.getByRole("navigation", { name: "Running" });
    // A row is in ONE group — Running while its agent is — so found by page.
    // Claude's opens its chat, whose Terminal resumes it in a pty (FE-62).
    const claudeRow = page.getByRole("button", {
      name: claudeRowName("Flaky login test"),
    });
    await expect(
      group.getByRole("button", { name: CONVERSATION_ROW }),
    ).toHaveCount(2);
    await expect(runningGroup).toHaveCount(0);

    await resumeClaudeInTerminal(page, "Flaky login test");
    const claude = page.getByRole("region", {
      name: "Claude — Flaky login test",
    });
    await expect(claude.locator(".xterm-rows")).toContainText(
      `ran-claude---resume-${CLAUDE_ID}`,
    );
    await expect(claudeRow).toHaveAttribute("aria-current", "page");
    // Running now: it moved out of Agents, into Running.
    await expect(
      runningGroup.getByRole("button", { name: CONVERSATION_ROW }),
    ).toHaveCount(1);
    await expect(
      group.getByRole("button", { name: CONVERSATION_ROW }),
    ).toHaveCount(1);
    const first = page.url();

    // The terminal panel is its own: no agent tab in it, and a shell opened
    // there leaves the agent where it was (FE-26).
    await menu(app, "terminal-toggle");
    await expect(tabs(page)).toHaveCount(1);
    await expect(
      tabs(page).first().getByRole("button").first(),
    ).toHaveAccessibleName(/^(sh|zsh|bash) in /);
    await expect(claude).toBeVisible();

    await page
      .getByRole("button", { name: "Resume “Settings page cleanup” in Codex" })
      .click();
    const codex = page.getByRole("region", {
      name: "Codex — Settings page cleanup",
    });
    await expect(codex.locator(".xterm-rows")).toContainText(
      `ran-codex-resume-${CODEX_ID}`,
    );

    // Back to Claude: the SAME agent, not a second resume (FE-23/D6), with
    // its screen as it was. Its row opens the chat, which knows a tab runs
    // it and offers that tab (FE-62/D3).
    await claudeRow.click();
    const chat = page.getByRole("region", {
      name: "Claude — Flaky login test",
    });
    await expect(chat.getByText("Running in Terminal")).toBeVisible();
    await chat.getByRole("button", { name: "Open Terminal" }).click();
    await expect(page).toHaveURL(first);
    await expect(claude.locator(".xterm-rows")).toContainText(
      `ran-claude---resume-${CLAUDE_ID}`,
    );

    // A Running row has Stop in its context menu, and as a quick action on
    // hover beside Pin.
    const codexName = "Resume “Settings page cleanup” in Codex";
    const codexRunning = runningGroup.getByRole("button", { name: codexName });
    await codexRunning.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Stop" })).toBeVisible();
    // FE-57/D4: a running conversation cannot be deleted — off in the menu,
    // and refused by main whatever the page sends.
    await expect(
      page.getByRole("menuitem", { name: "Delete…" }),
    ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(
        (id) =>
          (
            window as unknown as { desktop: { terminal: DesktopTerminalApi } }
          ).desktop.terminal
            .deleteAgentSession("ws-alpha", "codex", id)
            .then(
              () => "deleted",
              (error: Error) => error.message,
            ),
        CODEX_ID,
      ),
    ).toContain("Stop this conversation before deleting it.");
    await codexRunning.hover();
    const codexActions = codexRunning.locator("xpath=..");
    await expect(
      codexActions.getByRole("button", { name: "Pin" }),
    ).toBeVisible();
    // An idle agent's Stop ends it without asking, and its row goes back to
    // Agents as a transcript — whose quick actions and menu have no Stop.
    const stopAction = codexActions.getByRole("button", { name: "Stop" });
    // Icon-only, so a tooltip names it before the click. ⚠️ Retried as a
    // pair, as the Changes list's: it fades in under a hovered row, and a
    // pointer that lands mid-fade can miss the tooltip's enter event.
    const tip = page.locator('[data-slot="tooltip-content"]');
    await expect(async () => {
      await codexRunning.hover();
      await stopAction.hover();
      await expect(tip).toHaveText("Stop", { timeout: 1_500 });
    }).toPass({ timeout: 10_000 });
    await stopAction.click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    const codexIdle = group.getByRole("button", { name: codexName });
    await expect(codexIdle).toBeVisible();
    await expect(
      runningGroup.getByRole("button", { name: CONVERSATION_ROW }),
    ).toHaveCount(1);
    await codexIdle.hover();
    const idleActions = codexIdle.locator("xpath=..");
    await expect(
      idleActions.getByRole("button", { name: "Pin" }),
    ).toBeVisible();
    await expect(idleActions.getByRole("button", { name: "Stop" })).toHaveCount(
      0,
    );
    await codexIdle.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Pin" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Stop" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(claude).toBeVisible();

    // Stop while its transcript is being written: asked first (FE-26/D5).
    await appendFile(
      join(
        agentHome,
        ".claude",
        "projects",
        claudeProjectDir(repo),
        `${CLAUDE_ID}.jsonl`,
      ),
      `${JSON.stringify({ type: "assistant" })}\n`,
    );
    await expect(titlebar(page).getByLabel("Working")).toBeVisible();
    await titlebar(page).getByRole("button", { name: "Stop" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("while it is working");
    await confirm.getByRole("button", { name: "Stop" }).click();
    // Gone, back to the board; the row (through its chat) resumes it again.
    await expect(claude).toHaveCount(0);
    await resumeClaudeInTerminal(page, "Flaky login test");
    await expect(page).not.toHaveURL(first);
    await expect(
      page
        .getByRole("region", { name: "Claude — Flaky login test" })
        .locator(".xterm-rows"),
    ).toContainText(`ran-claude---resume-${CLAUDE_ID}`);

    // `/exit` ends the agent, and the SESSION with it (FE-26): no shell
    // prompt left behind, the view closes, and the rail lets go of the row.
    const again = page.getByRole("region", {
      name: "Claude — Flaky login test",
    });
    await again.locator(".xterm").click();
    await page.keyboard.type("/exit");
    await page.keyboard.press("Enter");
    await expect(again).toHaveCount(0);
    await expect(page).toHaveURL(/\/issues/);
    await expect(claudeRow).not.toHaveAttribute("aria-current", "page");
    await expect(runningGroup).toHaveCount(0);

    // Another project has no conversations and no folder: no group at all.
    await switchTo(page, "Beta");
    await expect(group).toHaveCount(0);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("an Agents row is renamed and pinned from its context menu, and spins while its transcript is written", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const agentHome = join(profile, "agent-home");
  await seedAgentHome(agentHome, repo);
  const transcript = join(
    agentHome,
    ".claude",
    "projects",
    claudeProjectDir(repo),
    `${CLAUDE_ID}.jsonl`,
  );
  // An hour old: nothing is working when the rail first lists them.
  const old = new Date(Date.now() - 3_600_000);
  await utimes(transcript, old, old);
  const env = {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
  };
  let app = await boot(profile, home, plane.origin, env);
  try {
    let page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const group = () => page.getByRole("navigation", { name: "Agents" });
    const pinnedGroup = () => page.getByRole("navigation", { name: "Pinned" });
    // A row changes group when pinned, so found across the rail's groups.
    const claude = () =>
      page.locator("nav").getByRole("button", { name: /^Open “/ });
    await expect(claude()).toHaveAccessibleName(
      claudeRowName("Flaky login test"),
    );
    await expect(claude()).not.toHaveAttribute("aria-busy", "true");

    // Rename: Lanework's name, shown on the row.
    await claude().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const field = page.getByRole("textbox", { name: "Session name" });
    await expect(field).toHaveAttribute("placeholder", "Flaky login test");
    await field.fill("Login fix");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(claude()).toHaveAccessibleName(claudeRowName("Login fix"));

    // Pin: its own group, out of Agents, and kept across a relaunch.
    await expect(pinnedGroup()).toHaveCount(0);
    await claude().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin" }).click();
    await expect(
      pinnedGroup().getByRole("button", { name: CONVERSATION_ROW }),
    ).toHaveAccessibleName(claudeRowName("Login fix"));
    await expect(
      group().getByRole("button", { name: CONVERSATION_ROW }),
    ).toHaveCount(1);

    await app.close();
    app = await boot(profile, home, plane.origin, env);
    page = await app.firstWindow();
    await switchTo(page, "Alpha");
    await expect(claude()).toHaveAccessibleName(claudeRowName("Login fix"));
    await expect(
      pinnedGroup().getByRole("button", { name: CONVERSATION_ROW }),
    ).toHaveCount(1);

    // Bookkeeping — what opening a conversation writes — is not work.
    await appendFile(transcript, `${JSON.stringify({ type: "cost-state" })}\n`);
    await page.waitForTimeout(1_000);
    await expect(claude()).not.toHaveAttribute("aria-busy", "true");
    // A prompt opens a turn: it spins, until the turn's closing line.
    await appendFile(
      transcript,
      `${JSON.stringify({ type: "user", message: { content: "Go on" } })}\n`,
    );
    await expect(claude()).toHaveAttribute("aria-busy", "true");
    await appendFile(
      transcript,
      `${JSON.stringify({ type: "system", subtype: "turn_duration" })}\n`,
    );
    await expect(claude()).not.toHaveAttribute("aria-busy", "true");

    // Emptied, the name goes back to the CLI's; Unpin gives up the top.
    await claude().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.getByRole("textbox", { name: "Session name" }).fill("");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(claude()).toHaveAccessibleName(
      claudeRowName("Flaky login test"),
    );
    // Unpin, from the row's hover quick action this time.
    await claude().hover();
    await claude()
      .locator("xpath=..")
      .getByRole("button", { name: "Unpin" })
      .click();
    await expect(pinnedGroup()).toHaveCount(0);
    await expect(
      group().getByRole("button", { name: CONVERSATION_ROW }),
    ).toHaveCount(2);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("FE-57: an Agents row's transcript is deleted for good from its context menu", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const agentHome = join(profile, "agent-home");
  await seedAgentHome(agentHome, repo);
  const claudeDir = join(
    agentHome,
    ".claude",
    "projects",
    claudeProjectDir(repo),
  );
  // Its sub-agents and tool results live in a folder named after it.
  await mkdir(join(claudeDir, CLAUDE_ID, "subagents"), { recursive: true });
  await writeFile(join(claudeDir, CLAUDE_ID, "subagents", "x.jsonl"), "{}\n");
  const codexDay = join(agentHome, ".codex", "sessions", "2026", "09", "26");
  const gone = (path: string) =>
    stat(path).then(
      () => false,
      () => true,
    );
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const rail = page.locator("nav");
    const claude = rail.getByRole("button", { name: /^Open “/ });
    const codex = rail.getByRole("button", { name: /in Codex$/ });
    await expect(claude).toHaveAccessibleName(
      claudeRowName("Flaky login test"),
    );

    // An id this project does not list is refused by main (FE-57).
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { desktop: { terminal: DesktopTerminalApi } }
        ).desktop.terminal
          .deleteAgentSession(
            "ws-alpha",
            "claude",
            "33333333-2222-4333-8444-555555555555",
          )
          .then(
            () => "deleted",
            (error: Error) => error.message,
          ),
      ),
    ).toContain("not one of this project's");
    expect(
      await gone(join(claudeDir, "33333333-2222-4333-8444-555555555555.jsonl")),
    ).toBe(false);

    // Pinned first, so the mark has to go with it.
    await claude.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin" }).click();
    await expect(
      page.getByRole("navigation", { name: "Pinned" }),
    ).toBeVisible();

    // Cancel keeps everything.
    await claude.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Delete “Flaky login test”?");
    await expect(dialog).toContainText("claude --resume");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(await gone(join(claudeDir, `${CLAUDE_ID}.jsonl`))).toBe(false);

    await claude.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(dialog).toBeHidden();
    await expect(claude).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Pinned" })).toHaveCount(
      0,
    );
    expect(await gone(join(claudeDir, `${CLAUDE_ID}.jsonl`))).toBe(true);
    expect(await gone(join(claudeDir, CLAUDE_ID))).toBe(true);
    // Its neighbours are not touched.
    expect(
      await gone(join(claudeDir, "33333333-2222-4333-8444-555555555555.jsonl")),
    ).toBe(false);
    expect(
      await readFile(join(home, "agent-sessions.json"), "utf8"),
    ).not.toContain(CLAUDE_ID);

    // Codex: its rollout, and its lines in Codex's own index (FE-57/D3).
    await codex.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await expect(dialog).toContainText("codex resume");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(dialog).toBeHidden();
    await expect(codex).toHaveCount(0);
    const left = await readdir(codexDay);
    expect(left.some((name) => name.includes(CODEX_ID))).toBe(false);
    expect(left).toContain("rollout-2026-09-26T08-00-00-elsewhere.jsonl");
    expect(
      await readFile(join(agentHome, ".codex", "session_index.jsonl"), "utf8"),
    ).not.toContain(CODEX_ID);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a conversation's sub-agents sit under its row — folded until one works (FE-33)", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const agentHome = join(profile, "agent-home");
  await seedAgentHome(agentHome, repo);
  await seedSubagents(agentHome, repo);
  const claudeDir = join(
    agentHome,
    ".claude",
    "projects",
    claudeProjectDir(repo),
  );
  const subagents = join(claudeDir, CLAUDE_ID, "subagents");
  // An hour old, all of Claude's: nothing of it is going at first.
  const old = Date.now() / 1000 - 3_600;
  await utimes(join(claudeDir, `${CLAUDE_ID}.jsonl`), old, old);
  for (const [name, age] of [
    ["done", 180],
    ["handback", 120],
    ["going", 60],
  ] as const)
    await utimes(join(subagents, `agent-${name}.jsonl`), old - age, old - age);
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
    LANEWORK_CLAUDE_BIN: await standIn(profile, "claude", "ran-%s-%s-%s"),
    LANEWORK_CODEX_BIN: await standIn(profile, "codex", "ran-%s-%s-%s"),
  });
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const group = page.getByRole("navigation", { name: "Agents" });
    const claudeRow = page.getByRole("button", {
      name: claudeRowName("Flaky login test"),
    });
    const subRows = (parent: string) =>
      page.getByRole("button", { name: `a sub-agent of “${parent}”` });
    // Codex's guardian is a row nowhere, and its spawned thread no row of
    // its own (FE-33/D1).
    await expect(
      group.getByRole("button", { name: CONVERSATION_ROW }),
    ).toHaveCount(2);
    // The spawned thread is going: its conversation shows it unasked (D2).
    const gibbs = subRows("Settings page cleanup");
    await expect(gibbs).toHaveAccessibleName(/^Gibbs: social card,/);
    await expect(gibbs).toHaveAttribute("aria-busy", "true");

    // Claude's are all done: folded, and counted beside the age (D7).
    await expect(subRows("Flaky login test")).toHaveCount(0);
    await expect(claudeRow.getByTestId("subagent-count")).toHaveText("3");
    await claudeRow.hover();
    await page.getByRole("button", { name: "Show 3 sub-agents" }).click();
    await expect(
      page.getByRole("button", { name: "Hide 3 sub-agents" }),
    ).toHaveAttribute("aria-expanded", "true");
    // Newest first, each by what it was asked to do (D3, D4).
    await expect(subRows("Flaky login test")).toHaveText([
      /Count the tests/,
      /Find specs/,
      /Map the rail code/,
    ]);

    // One goes again: it spins, and comes to the top.
    const mapped = subRows("Flaky login test").filter({
      hasText: "Map the rail code",
    });
    // ⚠️ Written AGAIN until it is seen: the watcher takes a moment to start.
    await expect(async () => {
      await appendFile(
        join(subagents, "agent-done.jsonl"),
        line({ type: "user", isSidechain: true, message: { content: "More" } }),
      );
      await expect(mapped).toHaveAttribute("aria-busy", "true", {
        timeout: 1_500,
      });
    }).toPass({ timeout: 15_000 });
    await expect(subRows("Flaky login test").first()).toContainText(
      "Map the rail code",
    );
    await expect(claudeRow.getByTestId("subagent-count")).toHaveText("1");
    await appendFile(
      join(subagents, "agent-done.jsonl"),
      line({
        type: "assistant",
        isSidechain: true,
        message: { stop_reason: "end_turn", content: [] },
      }),
    );
    await expect(mapped).not.toHaveAttribute("aria-busy", "true");
    await expect(claudeRow.getByTestId("subagent-count")).toHaveText("3");

    // One just spawned: listed once it writes, going — and a fourth folds
    // the oldest away (D4).
    await writeFile(
      join(subagents, "agent-fresh.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "Fresh probe" }),
    );
    await appendFile(
      join(subagents, "agent-fresh.jsonl"),
      line({ type: "user", isSidechain: true, message: { content: "Look" } }),
    );
    await expect(subRows("Flaky login test").first()).toContainText(
      "Fresh probe",
    );
    await expect(subRows("Flaky login test").first()).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(subRows("Flaky login test")).toHaveCount(3);
    await page.getByRole("button", { name: "Show 1 more" }).click();
    await expect(subRows("Flaky login test")).toHaveCount(4);
    // A click opens its transcript now, not its conversation (FE-35/D9):
    // see the FE-35 case below.
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("FE-35: a sub-agent's row opens its transcript read-only — prompt, tool calls, report — starts no agent, follows it live, and links back to its conversation", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const agentHome = join(profile, "agent-home");
  await seedAgentHome(agentHome, repo);
  await seedSubagents(agentHome, repo);
  const going = join(
    agentHome,
    ".claude",
    "projects",
    claudeProjectDir(repo),
    CLAUDE_ID,
    "subagents",
    "agent-going.jsonl",
  );
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
    LANEWORK_CLAUDE_BIN: await standIn(profile, "claude", "ran-%s-%s-%s"),
    LANEWORK_CODEX_BIN: await standIn(profile, "codex", "ran-%s-%s-%s"),
  });
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const subRows = page.getByRole("button", {
      name: "a sub-agent of “Flaky login test”",
    });
    // `going` is going, so Claude's sub-agents show unasked (FE-33/D2).
    const mapped = subRows.filter({ hasText: "Map the rail code" });
    await expect(mapped).toHaveAccessibleName(/Open its transcript$/);
    await mapped.click();

    const viewer = page.getByRole("region", {
      name: "Sub-agent — Map the rail code",
    });
    await expect(
      titlebar(page).getByRole("heading", { name: "Map the rail code" }),
    ).toBeVisible();
    // The header's second row: each fact by its icon, read with what it is.
    const facts = viewer.getByTestId("subagent-meta");
    await expect(facts.getByRole("term")).toHaveText([
      "Agent type",
      "Model",
      "Ran for",
      "Tool calls",
      "Status",
    ]);
    await expect(facts.getByRole("definition")).toHaveText([
      "Explore",
      "Haiku 4.5",
      "1m 8s",
      "2 tools",
      "done",
    ]);
    // One row a call; a failed one says so (FE-35/D3).
    const calls = viewer
      .getByRole("region", { name: "Tool calls" })
      .getByRole("listitem");
    await expect(calls).toHaveText([
      /^Grep"subagents" src$/,
      /^Readsrc\/nav\.tsx:410-470error$/,
    ]);
    // Opened, a call shows its input — and never its result.
    await calls.nth(1).getByRole("button").click();
    await expect(calls.nth(1).locator("pre")).toContainText('"offset": 410');
    await expect(viewer).not.toContainText("File does not exist");
    // The prompt is folded until asked; the report is open.
    const prompt = viewer.getByRole("region", { name: "Prompt" });
    await expect(prompt).not.toContainText("Map the rail");
    await viewer.getByRole("button", { name: "Prompt" }).click();
    await expect(prompt).toContainText("Map the rail");
    await expect(viewer.getByRole("region", { name: "Report" })).toContainText(
      "The rail is mapped.",
    );

    // The row it opened from is marked; nothing was started (FE-35/V4).
    await expect(mapped).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("navigation", { name: "Running" })).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { desktop: { terminal: DesktopTerminalApi } }
        ).desktop.terminal.list("ws-alpha"),
      ),
    ).toEqual([]);

    // One still going: working, and read again as it writes — no polling,
    // its own writes (FE-35/D11).
    const counting = subRows.filter({ hasText: "Count the tests" });
    await counting.click();
    const live = page.getByRole("region", {
      name: "Sub-agent — Count the tests",
    });
    await expect(
      titlebar(page).getByRole("img", { name: "Working" }),
    ).toBeVisible();
    // Its own folds, not the last one's: the prompt opened there is shut.
    await expect(live.getByRole("button", { name: "Prompt" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(counting).toHaveAttribute("aria-current", "page");
    await expect(mapped).not.toHaveAttribute("aria-current", "page");
    const liveCalls = live
      .getByRole("region", { name: "Tool calls" })
      .getByRole("listitem");
    await expect(liveCalls).toHaveCount(1);
    // ⚠️ Written AGAIN until it is seen: the watcher takes a moment to start.
    await expect(async () => {
      await appendFile(
        going,
        line({
          type: "assistant",
          isSidechain: true,
          message: {
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "toolu_count",
                name: "Bash",
                input: { command: "bun test --list | wc -l" },
              },
            ],
          },
        }),
      );
      await expect(liveCalls.nth(1)).toHaveText(/^Bashbun test --list/, {
        timeout: 1_500,
      });
    }).toPass({ timeout: 15_000 });
    await appendFile(
      going,
      line({
        type: "user",
        isSidechain: true,
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_count" }],
        },
      }),
    );
    await appendFile(
      going,
      line({
        type: "assistant",
        isSidechain: true,
        message: {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "There are 42 tests." }],
        },
      }),
    );
    await expect(live.getByRole("region", { name: "Report" })).toContainText(
      "There are 42 tests.",
    );
    await expect(
      titlebar(page).getByRole("img", { name: "Working" }),
    ).toHaveCount(0);

    // Back is the router's: the transcript before it.
    await page.goBack();
    await expect(viewer).toBeVisible();

    // Its conversation is a link away, resumed in a terminal (D9) — its row
    // marked, though the row itself opens the chat (FE-62).
    await titlebar(page)
      .getByRole("button", {
        name: "Open its conversation, “Flaky login test”, in Claude",
      })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Claude — Flaky login test" })
        .locator(".xterm-rows"),
    ).toContainText(`ran-claude---resume-${CLAUDE_ID}`);
    await expect(
      page.getByRole("button", { name: claudeRowName("Flaky login test") }),
    ).toHaveAttribute("aria-current", "page");
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("FE-38: an agent's view shows its conversation's numbers and Claude's recap, and follows its writes — a row's tooltip and Settings read them too", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const agentHome = join(profile, "agent-home");
  await seedAgentHome(agentHome, repo);
  await seedAgentFacts(agentHome, repo);
  const transcript = join(
    agentHome,
    ".claude",
    "projects",
    claudeProjectDir(repo),
    `${CLAUDE_ID}.jsonl`,
  );
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
    LANEWORK_CLAUDE_BIN: await standIn(profile, "claude", "ran-%s-%s-%s"),
    LANEWORK_CODEX_BIN: await standIn(profile, "codex", "ran-%s-%s-%s"),
  });
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");

    // A row's tooltip has its cost and context once it is hovered — read
    // then, and not before (FE-38/D5).
    const codexRow = page.getByRole("button", {
      name: "Resume “Settings page cleanup” in Codex",
    });
    await expect(codexRow).toHaveAttribute("title", /\nCodex, /);
    await expect(codexRow).not.toHaveAttribute("title", /context/);
    await codexRow.hover();
    await expect(codexRow).toHaveAttribute("title", /\ncontext 88k \(34%\)$/);

    await resumeClaudeInTerminal(page, "Flaky login test");
    const claude = page.getByRole("region", {
      name: "Claude — Flaky login test",
    });
    // In the header's row: how long it ran, by its icon (D1).
    const facts = titlebar(page).getByTestId("agent-facts");
    await expect(facts.getByRole("term")).toHaveText(["Run time"]);
    await expect(facts.getByRole("definition")).toHaveText(["4m 12s"]);
    // Claude's own count of its lines is inside Changes.
    await titlebar(page).getByTestId("agent-changes").click();
    await expect(page.locator('[data-slot="popover-content"]')).toContainText(
      "+120 −8",
    );
    await page.keyboard.press("Escape");
    // The model names it, its ring how full the context is: Claude's window
    // taken from the model, 1M (D2).
    const model = titlebar(page).getByTestId("agent-model");
    await expect(model).toHaveText("Opus 5.5");
    await expect(model).toHaveAccessibleName(
      "Opus 5.5, context 14% full. Show its usage",
    );
    await model.click();
    const claudeUsage = page.getByTestId("model-facts");
    await expect(claudeUsage.getByRole("term")).toHaveText([
      "Model",
      "Cost",
      "Tokens in and out",
      "Context",
    ]);
    const values = claudeUsage.getByRole("definition");
    await expect(values).toHaveText([
      "Opus 5.5",
      "≈ $0.73",
      "141k in, 4k out",
      "142k (14%)",
    ]);
    // The cost says what it is: an estimate, sub-agents in it (V5).
    await expect(
      claudeUsage.locator('[title^="An estimate at API prices"]'),
    ).toContainText("≈ $0.73");
    await page.keyboard.press("Escape");
    // Claude's newer recap, one line until opened (D4).
    const recap = claude.getByRole("region", { name: "Recap" });
    await expect(recap).toContainText(
      "Fixed the flaky login test; the retry is next.",
    );
    const opener = recap.getByRole("button", { name: "Recap" });
    await expect(opener).toHaveAttribute("aria-expanded", "false");
    await opener.click();
    await expect(opener).toHaveAttribute("aria-expanded", "true");

    // A turn written after Claude last saved: the context and tokens follow
    // it, no polling; the saved cost is marked as lagging.
    await model.click();
    await appendFile(
      transcript,
      line({ type: "user", message: { content: "And the retry?" } }),
    );
    const turn = line({
      type: "assistant",
      message: {
        id: "msg_fourth",
        model: "claude-opus-5-5",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 152_000,
          cache_creation_input_tokens: 0,
          output_tokens: 300,
        },
        content: [{ type: "text", text: "On it." }],
      },
    });
    // ⚠️ Written AGAIN until it is seen: the watcher takes a moment to
    // start. One answer however often: its id is counted once.
    await expect(async () => {
      await appendFile(transcript, turn);
      await expect(values.nth(3)).toHaveText("152k (15%)", {
        timeout: 1_500,
      });
    }).toPass({ timeout: 15_000 });
    await expect(values.nth(1)).toHaveText("≈ $0.73+");
    await expect(values.nth(2)).toHaveText("293k in, 4.3k out");
    // Saved again: the new totals, current.
    await appendFile(
      transcript,
      line({ type: "system", subtype: "turn_duration" }) +
        line({
          type: "cost-state",
          totalCostUSD: 0.91,
          totalLinesAdded: 130,
          totalLinesRemoved: 9,
          totalDuration: 300_000,
          modelUsage: {
            "claude-opus-5-5": {
              inputTokens: 200,
              outputTokens: 5000,
              cacheReadInputTokens: 150_000,
              cacheCreationInputTokens: 2000,
            },
          },
        }),
    );
    await expect(values).toHaveText([
      "Opus 5.5",
      "≈ $0.91",
      "152k in, 5k out",
      "152k (15%)",
    ]);
    await expect(facts.getByRole("definition")).toHaveText(["5m 0s"]);
    await page.keyboard.press("Escape");

    // Codex: no cost, lines, run time or recap — its context a share of the
    // window it records (D2).
    await page
      .getByRole("button", { name: "Resume “Settings page cleanup” in Codex" })
      .click();
    const codex = page.getByRole("region", {
      name: "Codex — Settings page cleanup",
    });
    await expect(titlebar(page).getByTestId("agent-facts")).toHaveCount(0);
    await titlebar(page).getByTestId("agent-model").click();
    const codexFacts = page.getByTestId("model-facts");
    await expect(codexFacts.getByRole("term")).toHaveText([
      "Model",
      "Tokens in and out",
      "Context",
    ]);
    await expect(codexFacts.getByRole("definition")).toHaveText([
      "gpt-6.1-sol (low)",
      "1.8M in, 17.3k out",
      "88k (34%)",
    ]);
    await page.keyboard.press("Escape");
    await expect(codex.getByRole("region", { name: "Recap" })).toHaveCount(0);

    // Settings → Projects totals the folder's conversations (D6).
    await page.goto("app://lanework/settings/workspaces");
    const usage = page.getByTestId("agent-usage");
    await expect(usage).toContainText("Last 7 days");
    await expect(usage).toContainText("Last 30 days");
    await expect(usage).toContainText(
      "Claude ≈ $0.91, 152k in, 5k out, 1 conversation",
    );
    await expect(usage).toContainText(
      "Codex 1.8M in, 17.3k out, 1 conversation",
    );
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("FE-42: an agent's header counts its background tasks; a shell opens its command and output, an agent its transcript — and the rail lists the shells still running", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const agentHome = join(profile, "agent-home");
  await seedAgentHome(agentHome, repo);
  // ⚠️ Under the real temp dir, in a `claude-*` folder: main reads a task's
  // output only at `<temp>/claude-*/…/tasks/` (FE-42/D5).
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "claude-lanew-")));
  await seedBackgroundTasks(agentHome, repo, tmp);
  await endBackgroundTurn(agentHome, repo);
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
    LANEWORK_CLAUDE_BIN: await standIn(profile, "claude", "ran-%s-%s-%s"),
    LANEWORK_CODEX_BIN: await standIn(profile, "codex", "ran-%s-%s-%s"),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");

    // The rail: its running shell and monitor under it, unasked — never the
    // failed shell, and never the agent, which is a sub-agent row (D1).
    const shellRow = page.getByRole("button", {
      name: "Run the gate, a background shell of “Run the gate”. Open its output",
    });
    await expect(shellRow).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Watch the log, a background monitor of “Run the gate”. Open its output",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Run the tests, a background/ }),
    ).toHaveCount(0);

    await resumeClaudeInTerminal(page, "Run the gate");
    await expect(
      page.getByRole("region", { name: "Claude — Run the gate" }),
    ).toBeVisible();
    // The header's chip counts the running ones, by kind (D1).
    const chip = titlebar(page).getByTestId("background-tasks");
    await expect(chip).toHaveText("1 shell, 1 monitor");

    // Running first; the finished folded, with how they ended (D2).
    await chip.click();
    await expect(
      page.getByRole("button", { name: "Run the gate, shell, running" }),
    ).toBeVisible();
    const finished = page.getByRole("button", { name: "Finished (2)" });
    await expect(finished).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByRole("button", { name: /^Run the tests, shell, / }),
    ).toHaveCount(0);
    await finished.click();
    await expect(
      page.getByRole("button", { name: /^Run the tests, shell, / }),
    ).toContainText("failed, exit 1");

    // A shell opens its own page: the command, then its output (D3).
    await page
      .getByRole("button", { name: "Run the gate, shell, running" })
      .click();
    const task = page.getByRole("region", {
      name: "Background task — Run the gate",
    });
    await expect(
      titlebar(page).getByRole("heading", { name: "Run the gate" }),
    ).toBeVisible();
    await expect(task.getByRole("region", { name: "Command" })).toContainText(
      "bun run gate",
    );
    const output = task.getByTestId("task-output");
    await expect(output).toContainText("running e2e…");
    // Escape codes stripped: the text, not the colours.
    await expect(output).not.toContainText("[32m");
    await expect(task.getByTestId("task-meta")).toContainText("running");
    await expect(shellRow).toHaveAttribute("aria-current", "page");

    // An agent opens its transcript in the sub-agent viewer.
    await page.goBack();
    await expect(chip).toBeVisible();
    await chip.click();
    await page.getByRole("button", { name: "Finished (2)" }).click();
    await page
      .getByRole("button", { name: "Explore the views, agent, completed" })
      .click();
    await expect(
      page.getByRole("region", { name: "Sub-agent — Explore the views" }),
    ).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
    await rm(tmp, { recursive: true, force: true });
  }
});

test("FE-43: shell Stop confirms all entry points, cancels safely, reports races and errors, and re-reads killed state", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const agentHome = join(profile, "agent-home");
  await seedAgentHome(agentHome, repo);
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "claude-lanew-")));
  await seedBackgroundTasks(agentHome, repo, tmp);
  await endBackgroundTurn(agentHome, repo);
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
    LANEWORK_CLAUDE_BIN: await standIn(profile, "claude", "ran-%s-%s-%s"),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const seeded = await page.evaluate(
      async (conversation) =>
        (
          window as unknown as { desktop: { terminal: DesktopTerminalApi } }
        ).desktop.terminal.agentBackgroundTasks("alpha", conversation),
      CLAUDE_BG_ID,
    );
    await app.evaluate(({ ipcMain }, tasks) => {
      const state = { calls: [] as string[][], mode: "zero", tasks };
      (
        globalThis as typeof globalThis & { stopFixture: typeof state }
      ).stopFixture = state;
      ipcMain.removeHandler("terminal:agent-background-tasks");
      ipcMain.handle("terminal:agent-background-tasks", () => state.tasks);
      ipcMain.removeHandler("terminal:agent-stop-task");
      ipcMain.handle("terminal:agent-stop-task", (_event, ...ids: string[]) => {
        state.calls.push(ids);
        if (state.mode === "error")
          throw new Error("Process inspection failed");
        if (state.mode === "zero") return { stopped: 0 };
        state.tasks = state.tasks.map((task) =>
          task.id === ids[2]
            ? { ...task, status: "killed", endedAt: new Date().toISOString() }
            : task,
        );
        return { stopped: 1 };
      });
    }, seeded);
    const calls = () =>
      app.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              stopFixture: { calls: string[][] };
            }
          ).stopFixture.calls,
      );
    const setMode = (mode: string) =>
      app.evaluate((_electron, mode) => {
        (
          globalThis as typeof globalThis & { stopFixture: { mode: string } }
        ).stopFixture.mode = mode;
      }, mode);
    const shellRow = page.getByRole("button", {
      name: "Run the gate, a background shell of “Run the gate”. Open its output",
    });
    await shellRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("bun run gate");
    await dialog.getByRole("button", { name: "Keep it running" }).click();
    expect(await calls()).toEqual([]);

    await resumeClaudeInTerminal(page, "Run the gate");
    const chip = page.getByTestId("background-tasks");
    await chip.click();
    await expect(
      page.getByRole("button", { name: "Stop Watch the log", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Stop Run the gate", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      page.getByText("That task was no longer running", { exact: true }),
    ).toBeVisible();
    expect(await calls()).toEqual([["ws-alpha", CLAUDE_BG_ID, "bgrun01"]]);
    await page.getByRole("button", { name: "Dismiss notification" }).click();

    await shellRow.click();
    const task = page.getByRole("region", {
      name: "Background task — Run the gate",
    });
    await setMode("error");
    await titlebar(page)
      .getByRole("button", { name: "Stop", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByText(/Process inspection failed/)).toBeVisible();
    await page.getByRole("button", { name: "Dismiss notification" }).click();
    await setMode("success");
    await titlebar(page)
      .getByRole("button", { name: "Stop", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(task.getByTestId("task-meta")).toContainText("killed");
    await expect(
      titlebar(page).getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(0);
    expect(await calls()).toEqual(
      Array.from({ length: 3 }, () => ["ws-alpha", CLAUDE_BG_ID, "bgrun01"]),
    );
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
    await rm(tmp, { recursive: true, force: true });
  }
});

test("FE-56: running shells and monitors show their pid, and a found monitor can be stopped", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const agentHome = join(profile, "agent-home");
  await seedAgentHome(agentHome, repo);
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "claude-lanew-")));
  await seedBackgroundTasks(agentHome, repo, tmp);
  await endBackgroundTurn(agentHome, repo);
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
    LANEWORK_CLAUDE_BIN: await standIn(profile, "claude", "ran-%s-%s-%s"),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const seeded = await page.evaluate(
      async (conversation) =>
        (
          window as unknown as { desktop: { terminal: DesktopTerminalApi } }
        ).desktop.terminal.agentBackgroundTasks("alpha", conversation),
      CLAUDE_BG_ID,
    );
    // The shell and monitor run as groups 4242 and 4343; the agent is
    // running too, inside its CLI — no pid of its own (FE-56/D2).
    const tasks = seeded.map((task) =>
      task.id === "bgrun01"
        ? { ...task, pid: 4242 }
        : task.id === "bgmon01"
          ? { ...task, pid: 4343 }
          : task.id === "agbg01"
            ? { ...task, status: "running", endedAt: null }
            : task,
    );
    await app.evaluate(({ ipcMain }, tasks) => {
      const state = { calls: [] as string[][], tasks };
      (
        globalThis as typeof globalThis & { stopFixture: typeof state }
      ).stopFixture = state;
      ipcMain.removeHandler("terminal:agent-background-tasks");
      ipcMain.handle("terminal:agent-background-tasks", () => state.tasks);
      ipcMain.removeHandler("terminal:agent-stop-task");
      ipcMain.handle("terminal:agent-stop-task", (_event, ...ids: string[]) => {
        state.calls.push(ids);
        state.tasks = state.tasks.map((task) =>
          task.id === ids[2]
            ? {
                ...task,
                status: "killed",
                pid: null,
                endedAt: new Date().toISOString(),
              }
            : task,
        );
        return { stopped: 2 };
      });
    }, tasks);

    await resumeClaudeInTerminal(page, "Run the gate");
    await page.getByTestId("background-tasks").click();
    const row = (name: string) =>
      page.getByRole("button", { name, exact: true });
    await expect(row("Run the gate, shell, running")).toContainText("pid 4242");
    await expect(row("Watch the log, monitor, running")).toContainText(
      "pid 4343",
    );
    await expect(row("Explore the views, agent, running")).not.toContainText(
      "pid",
    );

    await page
      .getByRole("button", { name: "Stop Watch the log", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("tail -f log");
    await expect(dialog).toContainText("process group 4343");
    await dialog.getByRole("button", { name: "Stop", exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                stopFixture: { calls: string[][] };
              }
            ).stopFixture.calls,
        ),
      )
      .toEqual([["ws-alpha", CLAUDE_BG_ID, "bgmon01"]]);

    // The shell's page: its pid in the header, ready to copy.
    await page
      .getByRole("button", {
        name: "Run the gate, a background shell of “Run the gate”. Open its output",
      })
      .click();
    await expect(
      page.getByRole("region", {
        name: "Background task — Run the gate",
      }),
    ).toBeVisible();
    await expect(
      titlebar(page).getByRole("button", {
        name: "Copy pid 4242",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
    await rm(tmp, { recursive: true, force: true });
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

test("a card an agent is working on carries its spinner, on the board and in the issue, until the turn closes (FE-27)", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", {
    columns: [{ key: "todo", name: "To-Do", role: "start" }],
    cards: [
      {
        id: "card-1",
        revision: 1,
        title: "Show who is working",
        body: "",
        columnKey: "todo",
        categoryKey: "frontend",
        taskId: "FE-01",
        priority: "medium",
        tags: [],
        rank: "V",
        createdAt: null,
        updatedAt: null,
        checklist: [],
      },
      {
        id: "card-2",
        revision: 1,
        title: "Nobody on this one",
        body: "",
        columnKey: "todo",
        categoryKey: "frontend",
        taskId: "FE-02",
        priority: "medium",
        tags: [],
        rank: "W",
        createdAt: null,
        updatedAt: null,
        checklist: [],
      },
    ],
  });
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const agentHome = join(profile, "agent-home");
  await seedAgentHome(agentHome, repo);
  const transcript = join(
    agentHome,
    ".claude",
    "projects",
    claudeProjectDir(repo),
    `${CLAUDE_ID}.jsonl`,
  );
  const old = new Date(Date.now() - 3_600_000);
  await utimes(transcript, old, old);
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const working = issueRow(page, "Show who is working");
    await expect(working).toHaveCount(1);
    await expect(issueRow(page, "Nobody on this one")).toHaveCount(1);
    const marks = page.locator("[data-card-agents]");
    await expect(marks).toHaveCount(0);

    // A turn that named FE-01 — on THIS board — marks that card, and only it.
    await appendFile(
      transcript,
      line({ type: "user", message: { content: "Pick up FE-01" } }) +
        line({
          type: "assistant",
          message: {
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                name: "mcp__lanework__set_status",
                input: {
                  board_id: "ws-alpha",
                  card: "FE-01",
                  status: "processing",
                },
              },
            ],
          },
        }),
    );
    await expect(working.locator("[data-card-agents]")).toHaveCount(1);
    await expect(marks).toHaveCount(1);
    // In the status icon's place, and said in the row link's name.
    await expect(working.getByRole("link")).toHaveAccessibleName(
      /Claude working: Flaky login test/,
    );

    // The issue says who, and a click opens that agent.
    await working.getByRole("link").click();
    await expect(
      page.getByRole("button", {
        name: "Open Claude working: Flaky login test",
      }),
    ).toBeVisible();

    // The turn closes: the line goes with it.
    await appendFile(
      transcript,
      line({ type: "system", subtype: "turn_duration" }),
    );
    await expect(
      page.getByRole("button", { name: /^Open Claude working/ }),
    ).toHaveCount(0);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("an agent on another machine marks its card too, and this machine's own is not shown twice (BE-16)", async () => {
  const plane = await startStubPlane({ workspaces });
  const card = (
    id: string,
    taskId: string,
    title: string,
    rank: string,
  ): StubCard => ({
    id,
    revision: 1,
    title,
    body: "",
    columnKey: "todo",
    categoryKey: "frontend",
    taskId,
    priority: "medium",
    tags: [],
    rank,
    createdAt: null,
    updatedAt: null,
    checklist: [],
  });
  plane.setBoard("ws-alpha", {
    columns: [{ key: "todo", name: "To-Do", role: "start" }],
    members: [
      { userId: "test-user", name: "Viewer", role: "owner" },
      { userId: "u-decio", name: "Decio", role: "member" },
    ],
    cards: [
      card("card-1", "FE-01", "Show who is working", "V"),
      card("card-2", "FE-02", "Decio is on this one", "W"),
    ],
  });
  plane.setBoard("ws-beta", board);
  const now = new Date().toISOString();
  plane.setPresence("ws-alpha", [
    // Somebody else's agent, on another machine.
    {
      workItemId: "card-2",
      userId: "u-decio",
      agent: "claude-code",
      lastSeenAt: now,
    },
    // The signed-in user's own Claude, over OAuth — the service's copy of the
    // local session the transcript below puts on FE-01.
    {
      workItemId: "card-1",
      userId: "test-user",
      agent: "claude-code",
      lastSeenAt: now,
    },
  ]);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const agentHome = join(profile, "agent-home");
  await seedAgentHome(agentHome, repo);
  const transcript = join(
    agentHome,
    ".claude",
    "projects",
    claudeProjectDir(repo),
    `${CLAUDE_ID}.jsonl`,
  );
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  await appendFile(
    transcript,
    line({ type: "user", message: { content: "Pick up FE-01" } }) +
      line({
        type: "assistant",
        message: {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              name: "mcp__lanework__get_review",
              input: { board_id: "ws-alpha", card: "FE-01" },
            },
          ],
        },
      }),
  );
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const decio = issueRow(page, "Decio is on this one");
    const mine = issueRow(page, "Show who is working");

    // Decio's agent: the same spinner, and the name says whose.
    await expect(decio.locator('[data-card-agents="1"]')).toHaveCount(1);
    await expect(decio.getByRole("link")).toHaveAccessibleName(
      /Claude on Decio, (just now|now)/,
    );

    // FE-01: the local session, once — not again as the service's copy.
    await expect(mine.locator('[data-card-agents="1"]')).toHaveCount(1);
    await expect(mine.getByRole("link")).not.toHaveAccessibleName(/Viewer/);

    // In the issue, Decio's agent is listed but is not something to open.
    await decio.getByRole("link").click();
    const cloud = page.locator('[data-card-agent="cloud"]');
    await expect(cloud).toHaveCount(1);
    await expect(cloud).toContainText("Decio");
    await expect(
      page.getByRole("button", { name: /^Open Claude/ }),
    ).toHaveCount(0);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

// ── FE-34: hand a card to an agent ─────────────────────────────────────────

/**
 * A board whose id is a UUID, as every cloud workspace's is: the host puts
 * the board's id in the agent's prompt, and takes nothing else.
 */
const handBoardId = "6a1c0d3e-5b7f-4c2a-9d1e-0f3b2a4c5d6e";
const handWorkspaces: Workspace[] = [
  {
    id: handBoardId,
    slug: "alpha",
    name: "Alpha",
    path: null,
    baseBranch: null,
  },
  workspaces[1],
];

type Box = NonNullable<StubCard["checklist"]>[number];
const box = (key: string, text: string, fields: Partial<Box> = {}): Box => ({
  key,
  section: "decisions",
  text,
  checked: false,
  checkedAt: null,
  note: null,
  group: null,
  ...fields,
});
const ticked = { checked: true, checkedAt: "2026-09-30T08:00:00.000Z" };

function handCard(
  id: string,
  taskId: string,
  rank: string,
  checklist: Box[],
  fields: Partial<StubCard> = {},
): StubCard {
  return {
    id,
    revision: 1,
    title: `Work for ${taskId}`,
    body: "",
    columnKey: "todo",
    categoryKey: "frontend",
    taskId,
    priority: "medium",
    tags: [],
    rank,
    createdAt: null,
    updatedAt: null,
    checklist,
    assignees: { users: [], agents: [] },
    ...fields,
  };
}

async function bootHanding(cards: StubCard[]) {
  const plane = await startStubPlane({ workspaces: handWorkspaces });
  plane.setBoard(handBoardId, {
    columns: [
      { key: "todo", name: "To-Do", role: "start" },
      { key: "done", name: "Done", role: "done" },
    ],
    cards,
  });
  plane.setBoard("ws-beta", board);
  const { profile, home } = await seedProfile(plane.origin);
  // Each CLI prints every argument it was given on a line of its own: a
  // prompt the shell split into words would show up as several.
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
    LANEWORK_CLAUDE_BIN: await standIn(profile, "claude", "arg[%s]"),
    LANEWORK_CODEX_BIN: await standIn(profile, "codex", "arg[%s]"),
  });
  const page = await app.firstWindow();
  await switchTo(page, "Alpha");
  return { plane, profile, app, page };
}

/** A card's row in the Issues list, by the title `handCard` gives it. */
const handRow = (page: Page, taskId: string) =>
  issueRow(page, `Work for ${taskId}`);
const agentView = (page: Page, agent: "Claude" | "Codex") =>
  page.getByRole("region", { name: new RegExp(`^${agent} — `) });
const toBoard = (page: Page) =>
  page
    .getByRole("navigation", { name: "Project" })
    .getByRole("link", { name: /^Issues/ })
    .click();
const checklistWrites = (calls: string[], card: string) =>
  calls.filter(
    (call) => call === `PUT /v1/boards/${handBoardId}/items/${card}/checklist`,
  );

test("FE-34: a settled card starts its agent at once; an open one is approved as recommended only on confirm — and a card being worked opens its session", async () => {
  const { plane, profile, app, page } = await bootHanding([
    handCard("card-41", "FE-41", "V", [
      box("D1", "Settled already", ticked),
      box("V1", "typecheck", { section: "verify" }),
    ]),
    handCard("card-42", "FE-42", "W", [
      box("D1a", "(Recommended) The header", { group: "entry" }),
      box("D1b", "The assignee field", { group: "entry" }),
      box("D2", "Write the agent on the card"),
      box("V1", "typecheck", { section: "verify" }),
    ]),
    handCard("card-49", "FE-49", "X", [], { columnKey: "done" }),
  ]);
  try {
    // Finished work is handed to nobody: no Assign in its menu. The list
    // leaves Done out until the status filter asks for it (FE-75).
    const issues = page.url();
    const finished = new URL(issues);
    finished.searchParams.set("status", "done");
    await page.goto(finished.toString());
    await handRow(page, "FE-49").click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Delete…" })).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: /^Assign to/ }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.goto(issues);

    // Settled: the header's menu starts Claude straight away, no question.
    await expect(handRow(page, "FE-41")).toHaveCount(1);
    await expect(handRow(page, "FE-42")).toHaveCount(1);
    await handRow(page, "FE-41").getByRole("link").click();
    await page.getByRole("button", { name: "Assign to agent" }).click();
    // (Codex's two theme marks carry their own `<title>` text.)
    await expect(page.getByRole("menuitem")).toHaveText([/Claude$/, /Codex$/]);
    await page.getByRole("menuitem", { name: "Claude" }).click();
    const claude = agentView(page, "Claude").locator(".xterm-rows");
    await expect(claude).toContainText("arg[claude]");
    await expect(claude).toContainText("arg[--session-id]");
    await expect(claude).toContainText(`arg[Work lanework card FE-41 on board`);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(checklistWrites(plane.calls, "card-41")).toEqual([]);
    // D2: the agent is on the card now.
    await expect
      .poll(() => plane.readCard(handBoardId, "card-41")?.assignees)
      .toEqual({ users: [], agents: ["claude"] });

    // Open: the right-click menu asks first, and Cancel sends nothing.
    await toBoard(page);
    await handRow(page, "FE-42").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Assign to Claude" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Hand FE-42 to Claude?");
    await expect(dialog.locator("[data-pick]")).toHaveText([
      /^D1a.*The header/,
      /^D2.*Write the agent on the card/,
    ]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(checklistWrites(plane.calls, "card-42")).toEqual([]);
    expect(plane.readCard(handBoardId, "card-42")?.assignees?.agents).toEqual(
      [],
    );

    // Confirmed: ONE write ticks exactly the listed boxes, with a note — and
    // only then does Codex start, briefed to work the card.
    await handRow(page, "FE-42").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Assign to Codex" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Approve and start" })
      .click();
    const codex = agentView(page, "Codex").locator(".xterm-rows");
    await expect(codex).toContainText("arg[codex]");
    await expect(codex).toContainText(`arg[Work lanework card FE-42 on board`);
    expect(checklistWrites(plane.calls, "card-42")).toHaveLength(1);
    const approved = plane.readCard(handBoardId, "card-42");
    expect(
      approved?.checklist?.map(({ key, checked }) => [key, checked]),
    ).toEqual([
      ["D1a", true],
      ["D1b", false],
      ["D2", true],
      ["V1", false],
    ]);
    expect(approved?.checklist?.find((row) => row.key === "D2")?.note).toMatch(
      /^Approved as recommended from the desktop app on \d{4}-\d{2}-\d{2}$/,
    );
    expect(approved?.checklist?.find((row) => row.key === "D1b")?.note).toBe(
      null,
    );
    expect(approved?.assignees?.agents).toEqual(["codex"]);

    // D8: a card whose agent is still running is opened, not handed out again.
    await toBoard(page);
    await handRow(page, "FE-41").click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: /^Assign to/ }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await handRow(page, "FE-41").getByRole("link").click();
    await page.getByRole("button", { name: "Open session" }).click();
    await expect(
      agentView(page, "Claude").locator(".xterm-rows"),
    ).toContainText("card FE-41");
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("FE-34: a group with no recommendation can only be reviewed in session — and main refuses a card it cannot vouch for", async () => {
  const { plane, profile, app, page } = await bootHanding([
    handCard("card-43", "FE-43", "V", [
      box("D1a", "One way", { group: "entry" }),
      box("D1b", "Another", { group: "entry" }),
    ]),
  ]);
  try {
    await handRow(page, "FE-43").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Assign to Claude" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("entry has no recommended option");
    await expect(
      dialog.getByRole("button", { name: "Approve and start" }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Review in session" }).click();
    await expect(
      agentView(page, "Claude").locator(".xterm-rows"),
    ).toContainText("arg[Review lanework card FE-43 on board");
    // Nothing was approved for the person.
    expect(checklistWrites(plane.calls, "card-43")).toEqual([]);

    // Main's own checks, past any button: a card shaped wrong, a mode it
    // does not know, a card on a shell — each refused before the host is
    // asked.
    const spawn = (kind: string, resume: unknown, card: unknown) =>
      page.evaluate(
        ([ws, kind, resume, card]) =>
          (
            window as unknown as {
              desktop: { terminal: DesktopTerminalApi };
            }
          ).desktop.terminal
            .spawn(
              ws as string,
              80,
              24,
              kind as "claude",
              resume as string,
              card as never,
            )
            .then(
              () => "started",
              (error: Error) => error.message,
            ),
        [handBoardId, kind, resume, card] as const,
      );
    expect(
      await spawn("claude", null, { card: "FE-1; id", mode: "work" }),
    ).toMatch(/Unknown card/);
    expect(await spawn("claude", null, { card: "FE-43", mode: "go" })).toMatch(
      /Unknown card/,
    );
    expect(await spawn("shell", null, { card: "FE-43", mode: "work" })).toMatch(
      /A card starts a new agent/,
    );
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("folded, the window gets a title bar and the rail shows each agent as an icon, without its sub-agents", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  const { profile, home, repo } = await seedProfile(plane.origin);
  const agentHome = join(profile, "agent-home");
  await seedAgentHome(agentHome, repo);
  const claudeDir = join(
    agentHome,
    ".claude",
    "projects",
    claudeProjectDir(repo),
  );
  await mkdir(join(claudeDir, CLAUDE_ID, "subagents"), { recursive: true });
  await writeFile(join(claudeDir, CLAUDE_ID, "subagents", "x.jsonl"), "{}\n");
  // A real repository, so Changes and History draw their own headers.
  for (const args of [
    ["init", "-q", "-b", "main"],
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "first",
    ],
  ])
    execFileSync("git", args, { cwd: repo });
  await writeFile(join(repo, "notes.md"), "changed\n");
  const env = {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_AGENTS: "claude,codex",
  };
  const app = await boot(profile, home, plane.origin, env);
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    await expect(
      page
        .locator("nav")
        .getByRole("button", { name: claudeRowName("Flaky login test") }),
    ).toBeVisible();
    // Folded, the way ⌘B does it.
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById("sidebar-toggle")?.click();
    });
    const rail = page.getByTestId("sidebar");
    await expect
      .poll(async () => (await rail.boundingBox())?.width ?? 0)
      .toBeLessThan(57);

    const agents = rail.getByRole("navigation", { name: "Agents" });
    const claude = agents.getByRole("button", {
      name: claudeRowName("Flaky login test"),
    });
    await expect(claude).toBeVisible();
    await expect(
      agents.getByRole("button", { name: /in Codex$/ }),
    ).toBeVisible();
    const box = await claude.boundingBox();
    expect((box?.x ?? 99) + (box?.width ?? 0)).toBeLessThanOrEqual(56);
    // No sub-agent rows: those are the open rail's.
    await expect(
      rail.getByRole("button", { name: /a sub-agent of/ }),
    ).toHaveCount(0);

    // The window's title bar runs across its whole width (FE-58), holding the
    // window controls, back and forward; every page's header sits IN its slot
    // or starts under it, never beside the controls.
    const bar = async () =>
      page.locator(".window-titlebar").evaluate((node) => {
        const box = node.getBoundingClientRect();
        return box.height > 0 ? box.bottom : 0;
      });
    const vibrancy = await page.evaluate(
      () => document.documentElement.dataset.vibrancy === "true",
    );
    if (vibrancy) {
      await expect.poll(bar).toBeGreaterThan(30);
      const back = await page
        .getByRole("button", { name: "Go back" })
        .boundingBox();
      expect((back?.y ?? 99) + (back?.height ?? 0)).toBeLessThanOrEqual(
        await bar(),
      );
    }
    const below = async (target: import("@playwright/test").Locator) => {
      await expect(target).toBeVisible();
      const inSlot = await target.evaluate(
        (node) => !!node.closest(".window-titlebar-slot"),
      );
      if (!inSlot)
        await expect
          .poll(
            async () => ((await target.boundingBox())?.y ?? 0) - (await bar()),
          )
          .toBeGreaterThanOrEqual(0);
      const box = await target.boundingBox();
      expect(box?.x ?? 0).toBeGreaterThanOrEqual(56);
    };
    await below(page.getByRole("heading", { level: 1 }).first());
    await rail.getByRole("link", { name: "Changes", exact: true }).click();
    await below(
      page
        .locator(".window-titlebar-slot")
        .getByText("Changes", { exact: true }),
    );
    await rail.getByRole("link", { name: "History", exact: true }).click();
    await below(page.getByPlaceholder(/Search commits/));
    // Pull requests are a tab of Issues now (FE-75).
    await rail.getByRole("link", { name: "Issues", exact: true }).click();
    await page.getByRole("button", { name: "Pull requests" }).click();
    await below(page.getByRole("heading", { level: 2 }).first());
    await page.screenshot({
      path: "../../.agents/artifacts/test-results/mini-agents.png",
      clip: { x: 0, y: 0, width: 420, height: 760 },
    });
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});
