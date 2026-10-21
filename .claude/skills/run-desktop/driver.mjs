// Drive the built desktop app (apps/desktop/dist) like a user, one command per
// stdin line. See SKILL.md for the command list.
//
// - Isolated state: a temp LANEWORK_HOME and userData, so the real ~/.lanew
//   and the real login are never touched.
// - Local mode: onboarding is skipped with "Skip for now", so no account and
//   no control plane are needed.
// - Read-only on GitHub by convention: nothing here merges, reviews or
//   comments unless a command clicks it.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DESKTOP = join(ROOT, "apps/desktop");
// Playwright lives in the desktop app's node_modules, not the repo root's.
const { _electron: electron } = createRequire(join(DESKTOP, "package.json"))(
  "@playwright/test",
);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const folder = resolve(flag("folder", ROOT));
const ghMode = flag("gh", "real"); // real | missing | loggedout | offline
const shots = flag("shots", "/tmp/run-desktop");
const setup = !argv.includes("--no-setup");

if (!existsSync(join(DESKTOP, "dist"))) {
  console.error("No apps/desktop/dist. Run `bun run build` first.");
  process.exit(1);
}
await mkdir(shots, { recursive: true });

const profile = await mkdtemp(join(tmpdir(), "run-desktop-profile-"));
const home = await mkdtemp(join(tmpdir(), "run-desktop-home-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined),
);
Object.assign(env, {
  LANEWORK_TEST_USER_DATA: profile,
  LANEWORK_HOME: home,
  // A port nothing listens on: local mode must never need the control plane.
  LANEWORK_API_URL: "http://127.0.0.1:9",
  // Answers the native folder chooser (a test seam, dev builds only).
  LANEWORK_TEST_FOLDERS: folder,
});
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;

// `gh-login` flips this; until then the `loggedout` wrapper hides the login.
const loginFlag = join(profile, "gh-logged-in");
if (ghMode === "missing") env.LANEWORK_GH_PATH = join(profile, "no-such-gh");
if (ghMode === "offline") {
  // What gh prints when it cannot reach api.github.com.
  const wrapper = join(profile, "gh");
  await writeFile(
    wrapper,
    `#!/bin/sh\necho 'error connecting to api.github.com' >&2\necho 'check your internet connection or https://githubstatus.com' >&2\nexit 1\n`,
  );
  await chmod(wrapper, 0o755);
  env.LANEWORK_GH_PATH = wrapper;
}
if (ghMode === "loggedout") {
  const realGh = execFileSync("/bin/sh", ["-lc", "command -v gh"])
    .toString()
    .trim();
  const empty = join(profile, "gh-empty");
  await mkdir(empty, { recursive: true });
  const wrapper = join(profile, "gh");
  await writeFile(
    wrapper,
    `#!/bin/sh\nif [ -f "${loginFlag}" ]; then exec "${realGh}" "$@"; fi\nGH_CONFIG_DIR="${empty}" GH_TOKEN= GITHUB_TOKEN= exec "${realGh}" "$@"\n`,
  );
  await chmod(wrapper, 0o755);
  env.LANEWORK_GH_PATH = wrapper;
}

const app = await electron.launch({ args: [DESKTOP], env });
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

let count = 0;
const say = (...a) => console.log(...a);
const named = (text) => {
  const m = /^\/(.*)\/([a-z]*)$/.exec(text);
  return m ? new RegExp(m[1], m[2]) : text;
};

async function firstProject() {
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Create your first project" }).click();
  await page.getByLabel("New project name").fill("Lanework");
  await page.getByRole("button", { name: "Create project" }).click();
  await page
    .getByRole("button", { name: /^Switch project/ })
    .waitFor({ timeout: 15_000 });
  await page.goto("app://lanework/settings/workspaces");
  await page
    .getByRole("button", { name: "Source folders for Lanework" })
    .click();
  await page.getByRole("button", { name: /^Add folders/ }).click();
  await page.getByRole("button", { name: "Save folders" }).click();
  await page.getByText(folder, { exact: true }).first().waitFor();
  await page.goto("app://lanework/w/lanework/issues");
}

const COMMANDS = {
  async goto(path) {
    await page.goto(`app://lanework${path.startsWith("/") ? "" : "/"}${path}`);
    say("url", page.url());
  },
  async click(text) {
    await page.getByText(named(text)).first().click();
  },
  async button(name) {
    await page
      .getByRole("button", { name: named(name) })
      .first()
      .click();
  },
  async tab(name) {
    await page
      .getByRole("tab", { name: named(name) })
      .first()
      .click();
  },
  async fill(rest) {
    const [, label, value] = /^"([^"]+)"\s+(.*)$/.exec(rest) ?? [];
    if (!label) throw new Error('usage: fill "<label>" <value>');
    await page.getByLabel(label).fill(value);
  },
  async press(key) {
    await page.keyboard.press(key);
  },
  async wait(ms) {
    await page.waitForTimeout(Number(ms) || 1000);
  },
  async shot(name) {
    const file = join(
      shots,
      `${String(++count).padStart(2, "0")}-${name || "shot"}.png`,
    );
    await page.screenshot({ path: file });
    say("shot", file);
  },
  async text(after) {
    const all = await page.evaluate(() => document.body.innerText);
    const at = after ? all.lastIndexOf(after) : 0;
    say(at < 0 ? `(no "${after}" on screen)` : all.slice(at, at + 1500));
  },
  async eval(js) {
    say(JSON.stringify(await page.evaluate(js)));
  },
  async url() {
    say(page.url());
  },
  async errors() {
    say(JSON.stringify(errors));
  },
  async home() {
    say("home", home, "git/ exists:", existsSync(join(home, "git")));
  },
  async "gh-login"() {
    await writeFile(loginFlag, "");
    say("gh now answers as the real login");
  },
};

try {
  if (setup) await firstProject();
  say(`ready (folder ${folder}, gh ${ghMode}, shots ${shots})`);
} catch (error) {
  say("SETUP FAILED:", error.message.split("\n")[0]);
}

const lines = createInterface({ input: process.stdin });
for await (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const [name, ...rest] = line.split(" ");
  if (name === "quit") break;
  const run = COMMANDS[name];
  if (!run) {
    say(`unknown: ${name} (${Object.keys(COMMANDS).join(", ")}, quit)`);
    continue;
  }
  try {
    await run(rest.join(" "));
  } catch (error) {
    say(`FAILED ${name}:`, error.message.split("\n")[0]);
  }
}
await app.close();
