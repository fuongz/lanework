// Run with `bun test apps/desktop/electron/hook`. The hook's offline path
// (FE-52/D9): a repo whose origin maps to a local board gets its checkpoint
// written into the SQLite file, with no credential and no network.
//
// It runs the hook's `worker` step (what the detached worker does after the
// Stop hook hands it stdin) on the source under this runtime. When
// `bun run build` has made it, it also runs it on the built bundle under
// Electron's own Node, the way Settings → Agents installs it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { openLocalStore } from "../local-store/index";
import { localBoardFor } from "./local-board";

const REMOTE = "https://example.com/acme/widgets.git";
const SOURCE = join(import.meta.dirname, "lanework-checkpoint.ts");
const BUNDLE = join(
  import.meta.dirname,
  "../../dist/electron/hook/lanework-checkpoint.cjs",
);

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "lanework-hook-local-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function repo(name: string, remote: string): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  run("init", "-q");
  run("remote", "add", "origin", remote);
  writeFileSync(join(root, "a.txt"), "hello\n");
  return root;
}

/**
 * Write a Claude transcript in which the session talked to the board about
 * `card`.
 *
 * @returns The transcript's path.
 */
function transcript(name: string, card: string): string {
  const file = join(dir, `${name}.jsonl`);
  const lines = [
    {
      type: "user",
      message: { content: `please work ${card}` },
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mcp__lanework__get_review",
            input: { board_id: "x", card },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }],
      },
    },
    {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Finished the first step offline." }],
      },
    },
  ];
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

type Runner = { name: string; command: string; args: string[]; env: object };

function runners(): Runner[] {
  const list: Runner[] = [
    { name: "source", command: process.execPath, args: [SOURCE], env: {} },
  ];
  if (existsSync(BUNDLE)) {
    const electron = createRequire(import.meta.url)("electron") as string;
    list.push({
      name: "bundle",
      command: electron,
      args: [BUNDLE],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  }
  return list;
}

/**
 * Run the worker once.
 *
 * @returns The hook log, empty when nothing was logged.
 */
function work(
  runner: Runner,
  home: string,
  root: string,
  transcriptPath: string,
  session: string,
): string {
  const state = join(home, ".cache", "lanework", "checkpoint");
  mkdirSync(state, { recursive: true });
  const input = join(state, `input-${session}.json`);
  writeFileSync(
    input,
    JSON.stringify({
      session_id: session,
      transcript_path: transcriptPath,
      cwd: root,
    }),
  );
  const result = spawnSync(
    runner.command,
    [...runner.args, "--agent", "claude-code", "worker", input],
    {
      env: {
        ...process.env,
        ...runner.env,
        HOME: home,
        LANEWORK_HOME: join(home, ".lanew"),
        // No credential anywhere: the cloud path must not be what wrote.
        LANEWORK_HOOK_SECRET_FILE: join(home, "no-credential"),
        LANEWORK_API_URL: "http://127.0.0.1:9",
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "the hook never prints to the session");
  const log = join(state, "hook.log");
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

describe("checkpoint hook, local board", () => {
  for (const runner of runners()) {
    test(`${runner.name}: writes the checkpoint into SQLite`, () => {
      const home = mkdtempSync(join(dir, `home-${runner.name}-`));
      const root = repo(`repo-${runner.name}`, REMOTE);
      const store = openLocalStore({
        path: join(home, ".lanew", "data.sqlite"),
      });
      const project = store.createProject({
        name: "acme/widgets",
        repo: "git@example.com:acme/widgets",
      });
      const card = store.createWorkItem(project.id, {
        title: "Offline",
        categoryKey: "frontend",
      });
      assert.equal(card.taskId, "FE-01");
      const version = store.dataVersion();
      store.close();

      const log = work(
        runner,
        home,
        root,
        transcript(runner.name, "FE-01"),
        "s1",
      );
      assert.doesNotMatch(log, /no credential/);

      const after = openLocalStore({
        path: join(home, ".lanew", "data.sqlite"),
      });
      try {
        const { checkpoints, latest } = after.listCheckpoints("FE-01", {
          project: project.id,
        });
        assert.equal(checkpoints.length, 1, log);
        assert.equal(latest?.agent, "claude-code");
        assert.match(latest?.summary ?? "", /Finished the first step offline/);
        assert.equal(latest?.request, "please work FE-01");
        assert.equal(latest?.git?.wipRef, null, "no push without the opt-in");
        assert.ok(after.dataVersion() > version, "the app's poll sees it");
      } finally {
        after.close();
      }
    });
  }

  test("a board already moved to the cloud is not local", () => {
    const path = join(dir, "moved.sqlite");
    const store = openLocalStore({ path });
    const project = store.createProject({ name: "moved", repo: REMOTE });
    store.updateProject(project.id, { cloudId: "cloud-1" });
    store.close();
    assert.equal(localBoardFor(REMOTE, path), null);
    const other = openLocalStore({ path: join(dir, "kept.sqlite") });
    other.createProject({ name: "kept", repo: REMOTE });
    other.close();
    const board = localBoardFor(REMOTE, join(dir, "kept.sqlite"));
    assert.ok(board);
    board.store.close();
  });

  test("no local file: the hook creates none and stays on the cloud path", () => {
    const [runner] = runners();
    assert.ok(runner);
    const home = mkdtempSync(join(dir, "home-none-"));
    const root = repo("repo-none", REMOTE);
    const log = work(runner, home, root, transcript("none", "FE-01"), "s2");
    assert.equal(existsSync(join(home, ".lanew", "data.sqlite")), false);
    assert.match(log, /no credential/);
  });
});
