// The pty host's sessions, driven directly under Node with real shells
// (FE-19 V1). No Electron: `sessions.ts` is transport-agnostic so the rules
// that matter — what a late viewer is shown, what a shell may inherit, how
// many a project gets — are tested where they live.
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createAgentProbe } from "../electron/main/terminal/agents";
import { createSessions } from "../electron/main/terminal/sessions";
import type { TerminalHostMessage } from "../shared/terminal";

/** A plain `/bin/sh`: no login profile, so nothing but the test prints. */
const SH = { file: "/bin/sh", args: [] as string[] };

function viewer() {
  const messages: TerminalHostMessage[] = [];
  return {
    sub: { send: (message: TerminalHostMessage) => messages.push(message) },
    messages,
    /** Everything drawn so far: the snapshot, then the live output. */
    text: () =>
      messages
        .map((message) =>
          message.t === "snapshot" || message.t === "data" ? message.data : "",
        )
        .join(""),
  };
}

async function folder(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "lanew-term-")));
}

test.skip(process.platform === "win32", "These drive a POSIX shell.");

test("a real shell starts in the project folder and echoes what it is given", async () => {
  const sessions = createSessions({ shell: SH });
  try {
    const cwd = await folder();
    const session = sessions.spawn({
      project: "ws",
      cwd,
      cols: 80,
      rows: 24,
    });
    expect(session).toMatchObject({ project: "ws", shell: "sh", cwd });
    expect(session.pid).toBeGreaterThan(0);
    const view = viewer();
    sessions.attach(view.sub, session.id, 80, 24);
    sessions.input(session.id, "pwd; echo lanework-$((6*7))\n");
    await expect.poll(view.text).toContain("lanework-42");
    expect(view.text()).toContain(cwd);
    // The first thing a viewer is sent is the snapshot, exactly once.
    expect(view.messages[0]?.t).toBe("snapshot");
    expect(view.messages.filter((m) => m.t === "snapshot")).toHaveLength(1);
  } finally {
    sessions.killAll();
  }
});

test("attach resizes the shell before anything is drawn", async () => {
  const sessions = createSessions({ shell: SH });
  try {
    const session = sessions.spawn({
      project: "ws",
      cwd: await folder(),
      cols: 80,
      rows: 24,
    });
    const view = viewer();
    sessions.attach(view.sub, session.id, 132, 41);
    sessions.input(session.id, "stty size\n");
    await expect.poll(view.text).toMatch(/\b41 132\b/);
    // Clamped, not trusted.
    sessions.resize(session.id, 99_999, -5);
    sessions.input(session.id, "stty size\n");
    await expect.poll(view.text).toMatch(/\b1 1000\b/);
  } finally {
    sessions.killAll();
  }
});

test("a viewer that comes back later is shown the screen, with nothing lost or doubled", async () => {
  const sessions = createSessions({ shell: SH });
  try {
    const session = sessions.spawn({
      project: "ws",
      cwd: await folder(),
      cols: 80,
      rows: 24,
    });
    // Output that nobody is watching — the project was switched away from.
    const away = viewer();
    sessions.attach(away.sub, session.id, 80, 24);
    sessions.input(
      session.id,
      "i=1; while [ $i -le 400 ]; do printf 'line-%03d\\n' $i; i=$((i+1)); done; sleep 0.3; i=401; while [ $i -le 600 ]; do printf 'line-%03d\\n' $i; i=$((i+1)); sleep 0.002; done\n",
    );
    await expect.poll(away.text).toContain("line-400");
    sessions.detach(away.sub, session.id);

    // Coming back mid-stream: the snapshot, then the rest of it live.
    const back = viewer();
    sessions.attach(back.sub, session.id, 80, 24);
    await expect.poll(back.text, { timeout: 10_000 }).toContain("line-600");
    const drawn = back.text();
    for (const n of [1, 250, 400, 401, 500, 600]) {
      const line = `line-${String(n).padStart(3, "0")}`;
      // Exactly once: in the snapshot or in the stream, never both.
      expect(drawn.split(line).length - 1, line).toBe(1);
    }
  } finally {
    sessions.killAll();
  }
});

test("a shell never sees the app's own environment", async () => {
  const sessions = createSessions({
    shell: SH,
    env: {
      ...process.env,
      LANEWORK_HOME: "/secret/home",
      LANEWORK_API_URL: "https://example.test",
      ELECTRON_RUN_AS_NODE: "1",
    },
  });
  try {
    const session = sessions.spawn({
      project: "ws",
      cwd: await folder(),
      cols: 200,
      rows: 24,
    });
    const view = viewer();
    sessions.attach(view.sub, session.id, 200, 24);
    sessions.input(
      session.id,
      'echo "app=$(env | grep -c -E "^(LANEWORK|ELECTRON)_")" "term=$TERM"\n',
    );
    await expect.poll(view.text).toContain("app=0 term=xterm-256color");
  } finally {
    sessions.killAll();
  }
});

test("a project holds at most 8 terminals, and closing one makes room", async () => {
  const sessions = createSessions({ shell: SH });
  try {
    const cwd = await folder();
    const spawn = (project: string) =>
      sessions.spawn({ project, cwd, cols: 80, rows: 24 });
    const first = spawn("a");
    for (let i = 1; i < 8; i++) spawn("a");
    expect(() => spawn("a")).toThrow(/at most 8 terminals/);
    // Another project has its own allowance.
    expect(spawn("b").project).toBe("b");
    expect(sessions.kill(first.id)).toBe(true);
    expect(spawn("a").project).toBe("a");
    expect(sessions.list("a")).toHaveLength(8);
    expect(sessions.list("b")).toHaveLength(1);
  } finally {
    sessions.killAll();
  }
});

test("a project's tabs stay in the order they were dragged into", async () => {
  const sessions = createSessions({ shell: SH });
  try {
    const cwd = await folder();
    const spawn = (project: string) =>
      sessions.spawn({ project, cwd, cols: 80, rows: 24 });
    const ids = (project: string) =>
      sessions.list(project).map((session) => session.id);
    const a = spawn("ws").id;
    const b = spawn("ws").id;
    const c = spawn("ws").id;
    const elsewhere = spawn("other").id;
    const changed: string[] = [];
    sessions.onChanged((project) => changed.push(project));

    expect(sessions.reorder("ws", [c, a, b])).toBe(true);
    expect(ids("ws")).toEqual([c, a, b]);
    // Every window re-lists from the host, so it has to say the list changed.
    expect(changed).toEqual(["ws"]);

    // An id it does not know, one named twice, another project's tab: all
    // ignored. The ones left out keep their order, after the ones named.
    expect(sessions.reorder("ws", [b, "nope", b, elsewhere])).toBe(true);
    expect(ids("ws")).toEqual([b, c, a]);
    expect(ids("other")).toEqual([elsewhere]);

    // A terminal started later goes at the end of the NEW order.
    const d = spawn("ws").id;
    expect(ids("ws")).toEqual([b, c, a, d]);
    // Not a list: refused, and nothing moves.
    expect(sessions.reorder("ws", "nope")).toBe(false);
    expect(ids("ws")).toEqual([b, c, a, d]);
  } finally {
    sessions.killAll();
  }
});

test("an agent tab types its CLI once a view is attached — never before, never twice", async () => {
  const sessions = createSessions({
    // A shell that takes a moment to reach its prompt, the way a login shell
    // reading a profile does: typed any earlier, the line would be echoed
    // ahead of the prompt and drawn again behind it.
    shell: { file: "/bin/sh", args: ["-c", "sleep 0.6; exec /bin/sh"] },
    // The CLI's name is replaced so the test needs no Claude installed; the
    // printed marker is not the typed line, so the echo cannot fake it.
    agentCommand: (agent) => `printf '%s-%s\\n' ${agent} started`,
  });
  try {
    const session = sessions.spawn({
      project: "ws",
      cwd: await folder(),
      cols: 80,
      rows: 24,
      kind: "claude",
    });
    expect(session.kind).toBe("claude");
    // Nobody watching: nothing typed, however long it waits — the CLI would
    // ask a terminal for its colours and get no answer.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const view = viewer();
    sessions.attach(view.sub, session.id, 80, 24);
    await expect.poll(view.text).toContain("claude-started");
    const snapshot = view.messages.find((m) => m.t === "snapshot");
    expect(snapshot?.t === "snapshot" ? snapshot.data : "").not.toContain(
      "claude-started",
    );
    // ⚠️ The shell getting ready is held back (FE-26): the typed line, the
    // prompt, the launch mark — none of it reaches a view. Only the CLI does.
    expect(view.text()).not.toContain("claude started");
    expect(view.text()).not.toContain("7771");
    expect(view.text().split("claude-started").length - 1).toBe(1);

    // A second view is shown it, and it is not typed again.
    const again = viewer();
    sessions.attach(again.sub, session.id, 80, 24);
    await expect.poll(again.text).toContain("claude-started");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(view.text().split("claude-started").length - 1).toBe(1);
  } finally {
    sessions.killAll();
  }
});

test("an agent whose CLI never starts shows what its shell said, instead of hiding it", async () => {
  const sessions = createSessions({
    // Says something and exits before any prompt: the launch never runs.
    shell: { file: "/bin/sh", args: ["-c", "echo profile-broke; exit 3"] },
    agentCommand: (agent) => agent,
  });
  try {
    const session = sessions.spawn({
      project: "ws",
      cwd: await folder(),
      cols: 80,
      rows: 24,
      kind: "claude",
    });
    const view = viewer();
    sessions.attach(view.sub, session.id, 80, 24);
    await expect.poll(view.text).toContain("profile-broke");
  } finally {
    sessions.killAll();
  }
});

test("a kind it does not know opens a plain shell, and types nothing", async () => {
  const typed: string[] = [];
  const sessions = createSessions({
    shell: SH,
    agentCommand: (agent) => {
      typed.push(agent);
      return agent;
    },
  });
  try {
    const session = sessions.spawn({
      project: "ws",
      cwd: await folder(),
      cols: 80,
      rows: 24,
      kind: "rm -rf ~",
    });
    expect(session.kind).toBe("shell");
    sessions.attach(viewer().sub, session.id, 80, 24);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(typed).toEqual([]);
  } finally {
    sessions.killAll();
  }
});

test("+ offers an agent only when the user's shell can find its CLI", async () => {
  const bin = await folder();
  await writeFile(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // `HOME` is the empty folder, so no profile of the developer's is read.
  const probe = createAgentProbe({
    shell: SH,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin },
  });
  expect(await probe()).toEqual(["claude"]);

  const none = createAgentProbe({
    shell: SH,
    env: { PATH: "/usr/bin:/bin", HOME: bin },
  });
  expect(await none()).toEqual([]);

  // A shell that cannot even start offers nothing, rather than failing.
  const broken = createAgentProbe({
    shell: { file: join(bin, "no-such-shell"), args: [] },
    env: { PATH: "/usr/bin:/bin", HOME: bin },
  });
  expect(await broken()).toEqual([]);
});

test("a shell that exits keeps its tab, and says so to whoever comes back", async () => {
  const sessions = createSessions({ shell: SH });
  try {
    const session = sessions.spawn({
      project: "ws",
      cwd: await folder(),
      cols: 80,
      rows: 24,
    });
    const view = viewer();
    sessions.attach(view.sub, session.id, 80, 24);
    sessions.input(session.id, "exit 3\n");
    await expect
      .poll(() => view.messages.find((m) => m.t === "exit"))
      .toMatchObject({ t: "exit", code: 3 });
    expect(sessions.list("ws")[0]?.exit).toEqual({ code: 3, signal: null });
    expect(sessions.liveCount()).toBe(0);

    const later = viewer();
    sessions.attach(later.sub, session.id, 80, 24);
    await expect.poll(later.text).toContain("[Process exited with code 3]");
  } finally {
    sessions.killAll();
  }
});

test("closing a terminal stops its shell and forgets it", async () => {
  const sessions = createSessions({ shell: SH });
  try {
    const session = sessions.spawn({
      project: "ws",
      cwd: await folder(),
      cols: 80,
      rows: 24,
    });
    expect(sessions.liveCount()).toBe(1);
    expect(sessions.kill(session.id)).toBe(true);
    expect(sessions.list("ws")).toEqual([]);
    await expect
      .poll(() => {
        try {
          process.kill(session.pid, 0);
          return "alive";
        } catch {
          return "gone";
        }
      })
      .toBe("gone");
    expect(sessions.kill(session.id)).toBe(false);
  } finally {
    sessions.killAll();
  }
});

test("a late viewer gets the program's SGR mouse encoding back, or its wheel reaches nobody", async () => {
  const sessions = createSessions({ shell: SH });
  try {
    const session = sessions.spawn({
      project: "ws",
      cwd: await folder(),
      cols: 80,
      rows: 24,
    });
    const first = viewer();
    sessions.attach(first.sub, session.id, 80, 24);
    // What a full-screen TUI asks for: drag tracking, SGR encoding.
    sessions.input(
      session.id,
      "printf '\\033[?1002h\\033[?1006h'; echo mouse-$((6*7))\n",
    );
    await expect.poll(first.text).toContain("mouse-42");
    sessions.detach(first.sub, session.id);

    const late = viewer();
    sessions.attach(late.sub, session.id, 80, 24);
    await expect.poll(() => late.messages[0]?.t).toBe("snapshot");
    expect(late.text()).toContain("\x1b[?1002h");
    expect(late.text()).toContain("\x1b[?1006h");

    // Turned off again: a snapshot no longer asks for it.
    sessions.input(session.id, "printf '\\033[?1006l'; echo off-$((6*7))\n");
    await expect.poll(late.text).toContain("off-42");
    const after = viewer();
    sessions.attach(after.sub, session.id, 80, 24);
    await expect.poll(() => after.messages[0]?.t).toBe("snapshot");
    expect(after.text()).not.toContain("\x1b[?1006h");
  } finally {
    sessions.killAll();
  }
});
