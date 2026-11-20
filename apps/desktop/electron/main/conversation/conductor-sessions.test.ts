// Run with `bun test ./electron/main/conversation/conductor-sessions.test.ts`.
//
// A conductor's sessions are read-only to the user unless it lets them in
// (`userAccess` on `sessions.start`, `sessions.access` later). The parser
// mirrors the contract; only the conductor that started a session may change
// who works in it, and only it answers that session's permissions while the
// user has no access.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { CONTROL_TOOLS } from "@lanework/contracts";
import {
  isSessionAction,
  parseSessionInput,
  SESSION_ACTIONS,
  type SessionCall,
  sessionFields,
} from "../../../shared/conductor-sessions";
import type {
  PermissionAnswer,
  PermissionRequest,
} from "../../../shared/conversation";
import { ControlInputError, PROMPT_MAX } from "../../../shared/orchestration";
import { isManaged, userMayAct, userMayActOn } from "../../../shared/terminal";
import {
  ConductorSessions,
  type ConductorSessionsDeps,
  type SessionEngines,
  waitingOf,
} from "./conductor-sessions";

const dir = mkdtempSync(join(tmpdir(), "conductor-sessions-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The message a refused parse or call throws. */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ControlInputError, String(error));
    return error.message;
  }
  assert.fail("not refused");
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ControlInputError, String(error));
    return error.message;
  }
  assert.fail("not refused");
}

describe("the parser mirrors the contract", () => {
  test("every conductor tool of the contract is a session action, with its fields", () => {
    const tools = CONTROL_TOOLS.filter((tool) => isSessionAction(tool.action));
    assert.ok(tools.some((tool) => tool.action === "sessions.access"));
    for (const tool of tools) {
      assert.ok(isSessionAction(tool.action));
      assert.deepEqual(
        [...sessionFields(tool.action)].sort(),
        Object.keys(tool.properties).sort(),
        tool.action,
      );
    }
    for (const tool of CONTROL_TOOLS.filter(
      (entry) => entry.role === "conductor",
    ))
      assert.ok(
        (SESSION_ACTIONS as readonly string[]).includes(tool.action),
        tool.action,
      );
  });

  test("sessions.start: userAccess defaults to false, takes only a boolean", () => {
    const base = { title: "Audit", prompt: "Read the code." };
    const off = parseSessionInput("sessions.start", base) as Extract<
      SessionCall,
      { action: "sessions.start" }
    >;
    assert.equal(off.input.userAccess, false);
    assert.equal(off.input.notifyOnComplete, true);
    const on = parseSessionInput("sessions.start", {
      ...base,
      userAccess: true,
    }) as Extract<SessionCall, { action: "sessions.start" }>;
    assert.equal(on.input.userAccess, true);
    assert.match(
      refusal(() =>
        parseSessionInput("sessions.start", { ...base, userAccess: "yes" }),
      ),
      /userAccess must be true or false/,
    );
  });

  test("sessions.access: both fields required, nothing else taken", () => {
    assert.deepEqual(
      parseSessionInput("sessions.access", {
        sessionId: id(1),
        userAccess: false,
      }),
      {
        action: "sessions.access",
        input: { sessionId: id(1), userAccess: false },
      },
    );
    assert.match(
      refusal(() => parseSessionInput("sessions.access", { sessionId: id(1) })),
      /userAccess must be true or false/,
    );
    assert.match(
      refusal(() => parseSessionInput("sessions.access", { userAccess: true })),
      /sessionId/,
    );
    assert.match(
      refusal(() =>
        parseSessionInput("sessions.access", {
          sessionId: "not-a-session",
          userAccess: true,
        }),
      ),
      /sessionId/,
    );
    refusal(() =>
      parseSessionInput("sessions.access", {
        sessionId: id(1),
        userAccess: true,
        title: "extra",
      }),
    );
  });
});

describe("sessions.answer's parser", () => {
  const parse = (input: Record<string, unknown>) =>
    parseSessionInput("sessions.answer", input) as Extract<
      SessionCall,
      { action: "sessions.answer" }
    >;

  test("takes sessionId, requestId and allow; a deny keeps its reason", () => {
    assert.deepEqual(
      parse({ sessionId: id(1), requestId: "req-1", allow: true }).input,
      { sessionId: id(1), requestId: "req-1", allow: true },
    );
    assert.deepEqual(
      parse({
        sessionId: id(1),
        requestId: "req-1",
        allow: false,
        message: "  Not in scope  ",
      }).input,
      {
        sessionId: id(1),
        requestId: "req-1",
        allow: false,
        message: "Not in scope",
      },
    );
  });

  test("an allow's message is taken but dropped", () => {
    assert.deepEqual(
      parse({
        sessionId: id(1),
        requestId: "req-1",
        allow: true,
        message: "fine",
      }).input,
      { sessionId: id(1), requestId: "req-1", allow: true },
    );
  });

  test("allow is required and a boolean", () => {
    assert.match(
      refusal(() => parse({ sessionId: id(1), requestId: "req-1" })),
      /allow must be true or false/,
    );
    assert.match(
      refusal(() =>
        parse({ sessionId: id(1), requestId: "req-1", allow: "yes" }),
      ),
      /allow must be true or false/,
    );
  });

  test("refuses a bad sessionId, requestId or message, and extra fields", () => {
    assert.match(
      refusal(() =>
        parse({ sessionId: "nope", requestId: "req-1", allow: false }),
      ),
      /sessionId/,
    );
    assert.match(
      refusal(() => parse({ sessionId: id(1), allow: false })),
      /requestId/,
    );
    assert.match(
      refusal(() =>
        parse({ sessionId: id(1), requestId: "a b", allow: false }),
      ),
      /requestId/,
    );
    assert.match(
      refusal(() =>
        parse({
          sessionId: id(1),
          requestId: "req-1",
          allow: false,
          message: "x".repeat(PROMPT_MAX + 1),
        }),
      ),
      /message is longer than/,
    );
    assert.match(
      refusal(() =>
        parse({
          sessionId: id(1),
          requestId: "req-1",
          allow: false,
          message: 3,
        }),
      ),
      /message must be a string/,
    );
    refusal(() =>
      parse({
        sessionId: id(1),
        requestId: "req-1",
        allow: true,
        mode: "auto",
      }),
    );
  });
});

describe("waitingOf", () => {
  const request = (over: Partial<PermissionRequest>): PermissionRequest => ({
    id: "req-1",
    tool: "Bash",
    summary: "Run the tests",
    input: "{}",
    suggestMode: null,
    questions: null,
    ...over,
  });

  test("a tool's request asks its summary, on one line", () => {
    assert.deepEqual(waitingOf(request({ summary: "Run\n  the tests" })), {
      requestId: "req-1",
      tool: "Bash",
      ask: "Run the tests",
    });
  });

  test("a question asks its first question", () => {
    const ask = waitingOf(
      request({
        tool: "AskUserQuestion",
        questions: [
          {
            question: "Which branch?",
            header: "Branch",
            options: [],
            multiSelect: false,
          },
        ],
      }),
    ).ask;
    assert.equal(ask, "Question: Which branch?");
  });

  test("secrets are redacted and the ask is capped", () => {
    const secret = `curl -H "Authorization: Bearer ${"q".repeat(24)}"`;
    assert.ok(!waitingOf(request({ summary: secret })).ask.includes("qqqq"));
    const long = waitingOf(request({ summary: "a".repeat(1000) })).ask;
    assert.equal(long.length, 300);
    assert.ok(long.endsWith("…"));
  });
});

describe("userMayAct", () => {
  test("only a conductor's session without access is closed to the user", () => {
    assert.equal(userMayAct(undefined), true);
    assert.equal(userMayAct(null), true);
    assert.equal(
      userMayAct({ conductor: "lead-a", project: "p", userAccess: true }),
      true,
    );
    assert.equal(
      userMayAct({ conductor: "lead-a", project: "p", userAccess: false }),
      false,
    );
  });
});

describe("the managed rule (one for main and the page)", () => {
  const closed = { conductor: "lead-a", project: "p", userAccess: false };
  const open = { ...closed, userAccess: true };

  test("managed only while its conductor is kept and gave no access", () => {
    assert.equal(
      isManaged(closed, () => true),
      true,
    );
    // Its conductor deleted: the session is the user's again.
    assert.equal(
      isManaged(closed, () => false),
      false,
    );
    assert.equal(
      isManaged(open, () => true),
      false,
    );
    assert.equal(
      isManaged(null, () => true),
      false,
    );
  });

  test("the page goes by main's managed flag, launchedBy alone only without it", () => {
    // A row whose conductor is gone: main says it is the user's.
    assert.equal(userMayActOn({ launchedBy: closed, managed: false }), true);
    assert.equal(userMayActOn({ launchedBy: closed, managed: true }), false);
    // No flag (not said yet): taken as managed, as main takes a conductor
    // it cannot look up.
    assert.equal(userMayActOn({ launchedBy: closed }), false);
    assert.equal(userMayActOn({ launchedBy: open }), true);
    assert.equal(userMayActOn({}), true);
    assert.equal(userMayActOn(null), true);
    assert.equal(userMayActOn(undefined), true);
  });
});

describe("sessions.access", () => {
  // Conversation 101 is lead-a's own, 102 lead-b's. Lead-a started session
  // 1, lead-b session 2.
  const conversations: Record<string, string> = {
    [id(101)]: "lead-a",
    [id(102)]: "lead-b",
  };
  const file = join(dir, "conductor-sessions.json");
  const launch = (session: number, conductor: number, lead: string) => ({
    project: "p",
    conductor: id(conductor),
    conductorAgent: "claude",
    conductorId: lead,
    session: id(session),
    agent: "claude",
    title: `Session ${session}`,
    model: "claude-sonnet-4-5",
    createdAt: 1,
  });
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      launches: [launch(1, 101, "lead-a"), launch(2, 102, "lead-b")],
    }),
  );
  const access = new Map<string, boolean>();
  const engines = {
    pending: () => ({ agent: "claude", turns: [], working: false }),
    // Nothing waits: taking access back finds nothing to tell.
    permissions: () => [],
  } as unknown as SessionEngines;
  // Only what `sessions.access` reaches: the rest is never called.
  const deps: Pick<
    ConductorSessionsDeps,
    | "engines"
    | "folderOf"
    | "agentOf"
    | "conductorOf"
    | "setUserAccess"
    | "file"
  > = {
    engines: () => engines,
    folderOf: async () => dir,
    agentOf: async () => "claude",
    conductorOf: async (_project, _agent, conversation) =>
      conversations[conversation] ?? null,
    setUserAccess: (_agent, session, userAccess) => {
      if (session !== id(1) && session !== id(2)) return false;
      access.set(session, userAccess);
      return true;
    },
    file,
  };
  const sessions = new ConductorSessions(deps as ConductorSessionsDeps);
  const caller = (conversation: number) => ({
    project: "p",
    conversation: () => id(conversation),
  });
  let request = 0;
  const call = (conversation: number, session: number, userAccess: boolean) =>
    sessions.call(
      caller(conversation),
      {
        action: "sessions.access",
        input: { sessionId: id(session), userAccess },
      },
      `req-${++request}`,
    );

  test("the conductor that started it lets the user in, and takes it back", async () => {
    assert.deepEqual(await call(101, 1, true), {
      sessionId: id(1),
      title: "Session 1",
      userAccess: true,
    });
    assert.equal(access.get(id(1)), true);
    assert.deepEqual(await call(101, 1, false), {
      sessionId: id(1),
      title: "Session 1",
      userAccess: false,
    });
    assert.equal(access.get(id(1)), false);
  });

  test("another conductor is refused, and nothing changes", async () => {
    access.clear();
    assert.match(
      await refusalOf(call(102, 1, true)),
      /not one you started, so who may work in it is not yours to change/,
    );
    assert.equal(access.has(id(1)), false);
  });

  test("a conversation that is no conductor's is refused", async () => {
    assert.match(
      await refusalOf(call(103, 1, true)),
      /Only a conductor's own conversation/,
    );
    assert.equal(access.has(id(1)), false);
  });
});

describe("sessions.answer", () => {
  // Conversation 201 is lead-a's own, 202 lead-b's. Lead-a started sessions
  // 11 (no access) and 12 (the user has access); session 13 is the newest of
  // session 11's thread (an in-place handoff).
  const conversations: Record<string, string> = {
    [id(201)]: "lead-a",
    [id(202)]: "lead-b",
  };
  const file = join(dir, "conductor-sessions-answer.json");
  const launch = (session: number) => ({
    project: "p",
    conductor: id(201),
    conductorAgent: "claude",
    conductorId: "lead-a",
    session: id(session),
    agent: "claude",
    title: `Session ${session}`,
    model: "claude-sonnet-4-5",
    createdAt: 1,
  });
  writeFileSync(
    file,
    JSON.stringify({ v: 1, launches: [launch(11), launch(12)] }),
  );
  const tool = (requestId: string): PermissionRequest => ({
    id: requestId,
    tool: "Bash",
    summary: "Run the tests",
    input: "{}",
    suggestMode: null,
    questions: null,
  });
  const question: PermissionRequest = {
    ...tool("ask-1"),
    tool: "AskUserQuestion",
    questions: [
      { question: "Which?", header: "Pick", options: [], multiSelect: false },
    ],
  };
  /** Pending requests by native session. */
  const pending = new Map<string, PermissionRequest[]>();
  const answered: {
    conversation: string;
    id: string;
    answer: PermissionAnswer;
  }[] = [];
  const engines = {
    pending: () => ({ agent: "claude", turns: [], working: true }),
    state: async () => ({ state: "running" }),
    permissions: (_project: string, conversation: string) =>
      pending.get(conversation) ?? [],
    answer: (
      _project: string,
      conversation: string,
      requestId: string,
      answer: PermissionAnswer,
    ) => {
      const list = pending.get(conversation) ?? [];
      if (!list.some((entry) => entry.id === requestId))
        throw new Error("That request was already answered.");
      pending.set(
        conversation,
        list.filter((entry) => entry.id !== requestId),
      );
      answered.push({ conversation, id: requestId, answer });
    },
  } as unknown as SessionEngines;
  const deps: Pick<
    ConductorSessionsDeps,
    | "engines"
    | "folderOf"
    | "agentOf"
    | "read"
    | "conductorOf"
    | "userMayAct"
    | "newestOf"
    | "file"
  > = {
    engines: () => engines,
    folderOf: async () => dir,
    agentOf: async () => "claude",
    read: async () => {
      throw new Error("no transcript");
    },
    conductorOf: async (_project, _agent, conversation) =>
      conversations[conversation] ?? null,
    userMayAct: async (session) => session === id(12),
    newestOf: (session) => (session === id(11) ? id(13) : session),
    file,
  };
  const sessions = new ConductorSessions(deps as ConductorSessionsDeps);
  let request = 0;
  const call = (
    conversation: number,
    input: {
      sessionId: string;
      requestId: string;
      allow: boolean;
      message?: string;
    },
  ) =>
    sessions.call(
      { project: "p", conversation: () => id(conversation) },
      { action: "sessions.answer", input },
      `answer-${++request}`,
    );

  test("sessions.read lists what the newest session waits on", async () => {
    pending.set(id(13), [tool("req-1")]);
    const read = (await sessions.call(
      { project: "p", conversation: () => id(201) },
      {
        action: "sessions.read",
        input: { sessionId: id(11), limit: 2, maxChars: 1500 },
      },
      `read-${++request}`,
    )) as { status: string; waiting: unknown[] };
    assert.equal(read.status, "waiting");
    assert.deepEqual(read.waiting, [
      { requestId: "req-1", tool: "Bash", ask: "Run the tests" },
    ]);
  });

  test("the conductor that started it allows, on the thread's newest session", async () => {
    pending.set(id(13), [tool("req-1")]);
    answered.length = 0;
    assert.deepEqual(
      await call(201, { sessionId: id(11), requestId: "req-1", allow: true }),
      {
        sessionId: id(11),
        title: "Session 11",
        requestId: "req-1",
        allow: true,
      },
    );
    assert.deepEqual(answered, [
      { conversation: id(13), id: "req-1", answer: { behavior: "allow" } },
    ]);
  });

  test("a deny carries the conductor's reason", async () => {
    pending.set(id(13), [tool("req-2")]);
    answered.length = 0;
    await call(201, {
      sessionId: id(11),
      requestId: "req-2",
      allow: false,
      message: "Not in scope",
    });
    assert.deepEqual(answered[0]?.answer, {
      behavior: "deny",
      message: "Not in scope",
    });
  });

  test("another conductor is refused, and nothing is answered", async () => {
    pending.set(id(13), [tool("req-3")]);
    answered.length = 0;
    assert.match(
      await refusalOf(
        call(202, { sessionId: id(11), requestId: "req-3", allow: true }),
      ),
      /not one you started, so its permissions are not yours to answer/,
    );
    assert.equal(answered.length, 0);
  });

  test("refused when the user has access", async () => {
    pending.set(id(12), [tool("req-4")]);
    answered.length = 0;
    assert.match(
      await refusalOf(
        call(201, { sessionId: id(12), requestId: "req-4", allow: true }),
      ),
      /The user has access to session .* and answers its permissions themselves/,
    );
    assert.equal(answered.length, 0);
  });

  test("an unknown or answered request is refused", async () => {
    pending.set(id(13), [tool("req-5")]);
    assert.match(
      await refusalOf(
        call(201, { sessionId: id(11), requestId: "nope", allow: true }),
      ),
      /does not wait on request nope: it was answered, or its turn ended/,
    );
    await call(201, { sessionId: id(11), requestId: "req-5", allow: true });
    assert.match(
      await refusalOf(
        call(201, { sessionId: id(11), requestId: "req-5", allow: false }),
      ),
      /does not wait on request req-5/,
    );
  });

  test("a question cannot be allowed, only denied", async () => {
    pending.set(id(13), [question]);
    answered.length = 0;
    assert.match(
      await refusalOf(
        call(201, { sessionId: id(11), requestId: "ask-1", allow: true }),
      ),
      /is a question .* Deny it .* or give the user access with sessions.access/,
    );
    assert.equal(answered.length, 0);
    await call(201, { sessionId: id(11), requestId: "ask-1", allow: false });
    assert.equal(answered[0]?.answer.behavior, "deny");
  });
});

describe("a session waiting on a permission", () => {
  // Lead-a's conversation 301 started session 21, watched (notifyOnComplete)
  // and running; session 22 is the newest of its thread. Session 23 is
  // watched too, but the user has access to it.
  const file = join(dir, "conductor-sessions-notify.json");
  const launch = (session: number) => ({
    project: "p",
    conductor: id(301),
    conductorAgent: "claude",
    conductorId: "lead-a",
    session: id(session),
    agent: "claude",
    title: `Session ${session}`,
    model: "claude-sonnet-4-5",
    createdAt: 1,
    notify: { started: true, since: Date.now() },
  });
  writeFileSync(
    file,
    JSON.stringify({ v: 1, launches: [launch(21), launch(23)] }),
  );
  const request: PermissionRequest = {
    id: "req-1",
    tool: "Bash",
    summary: "Run the tests",
    input: "{}",
    suggestMode: null,
    questions: null,
  };
  const pending = new Map<string, PermissionRequest[]>();
  const sent: { conversation: string; text: string }[] = [];
  const engines = {
    pending: () => null,
    settingsOf: () => null,
    // The conductor is idle; its sessions run.
    state: async (_project: string, conversation: string) => ({
      state: conversation === id(301) ? "idle" : "running",
    }),
    permissions: (_project: string, conversation: string) =>
      pending.get(conversation) ?? [],
    send: async (
      _project: string,
      conversation: string,
      _folder: string,
      out: { content: { text: string }[] },
    ) => {
      sent.push({ conversation, text: out.content[0]?.text ?? "" });
      return { state: "running" };
    },
  } as unknown as SessionEngines;
  const deps: Partial<ConductorSessionsDeps> = {
    engines: () => engines,
    folderOf: async () => dir,
    agentOf: async () => "claude",
    read: async () => {
      throw new Error("no transcript");
    },
    storedSettings: async () => null,
    conductorOf: async (_project, _agent, conversation) =>
      conversation === id(301) ? "lead-a" : null,
    memory: { record: async () => {} } as never,
    userMayAct: async (session) => session === id(23),
    headOf: (session) => (session === id(22) ? id(21) : session),
    newestOf: (session) => (session === id(21) ? id(22) : session),
    file,
  };
  const sessions = new ConductorSessions(deps as ConductorSessionsDeps);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  test("its conductor is told once per request, naming the session", async () => {
    await sessions.restore();
    pending.set(id(22), [request]);
    sessions.onEvent({
      type: "permission",
      project: "p",
      conversation: id(22),
      request,
    });
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.conversation, id(301));
    assert.match(sent[0]?.text ?? "", /<lanework_sessions>/);
    assert.match(
      sent[0]?.text ?? "",
      new RegExp(`${id(21)} "Session 21": waits on a permission request`),
    );
    assert.match(sent[0]?.text ?? "", /sessions_read .* sessions_answer/);
    // The same request again, as a reload re-emits it: not told twice.
    sessions.onEvent({
      type: "permission",
      project: "p",
      conversation: id(22),
      request,
    });
    await settle();
    assert.equal(sent.length, 1);
  });

  test("not told when the user has access and answers it", async () => {
    sent.length = 0;
    pending.set(id(23), [{ ...request, id: "req-2" }]);
    sessions.onEvent({
      type: "permission",
      project: "p",
      conversation: id(23),
      request: { ...request, id: "req-2" },
    });
    await settle();
    assert.equal(sent.length, 0);
  });
});

describe("a permission nobody watches for, and access that changes", () => {
  // Lead-a's conversation 401 started sessions 31 and 32, neither watched
  // (notifyOnComplete false): only its turn's end goes unreported.
  const file = join(dir, "conductor-sessions-unwatched.json");
  const launch = (session: number) => ({
    project: "p",
    conductor: id(401),
    conductorAgent: "claude",
    conductorId: "lead-a",
    session: id(session),
    agent: "claude",
    title: `Session ${session}`,
    model: "claude-sonnet-4-5",
    createdAt: 1,
  });
  writeFileSync(
    file,
    JSON.stringify({ v: 1, launches: [launch(31), launch(32)] }),
  );
  const ask = (requestId: string): PermissionRequest => ({
    id: requestId,
    tool: "Bash",
    summary: "Run the tests",
    input: "{}",
    suggestMode: null,
    questions: null,
  });
  const pending = new Map<string, PermissionRequest[]>();
  const access = new Map<string, boolean>();
  const changed: { session: string; userAccess: boolean }[] = [];
  const sent: { conversation: string; text: string }[] = [];
  let busy = false;
  const engines = {
    pending: () => null,
    settingsOf: () => null,
    state: async (_project: string, conversation: string) => ({
      state: conversation === id(401) ? (busy ? "running" : "idle") : "running",
    }),
    permissions: (_project: string, conversation: string) =>
      pending.get(conversation) ?? [],
    send: async (
      _project: string,
      conversation: string,
      _folder: string,
      out: { content: { text: string }[] },
    ) => {
      sent.push({ conversation, text: out.content[0]?.text ?? "" });
      return { state: "running" };
    },
  } as unknown as SessionEngines;
  const deps: Partial<ConductorSessionsDeps> = {
    engines: () => engines,
    folderOf: async () => dir,
    agentOf: async () => "claude",
    read: async () => {
      throw new Error("no transcript");
    },
    storedSettings: async () => null,
    conductorOf: async (_project, _agent, conversation) =>
      conversation === id(401) ? "lead-a" : null,
    memory: { record: async () => {} } as never,
    userMayAct: async (session) => access.get(session) === true,
    setUserAccess: (_agent, session, userAccess) => {
      access.set(session, userAccess);
      return true;
    },
    accessChanged: (_project, session, userAccess) => {
      changed.push({ session, userAccess });
    },
    file,
  };
  const sessions = new ConductorSessions(deps as ConductorSessionsDeps);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  let call = 0;
  const setAccess = (session: number, userAccess: boolean) =>
    sessions.call(
      { project: "p", conversation: () => id(401) },
      {
        action: "sessions.access",
        input: { sessionId: id(session), userAccess },
      },
      `access-${++call}`,
    );
  const asked = (session: number, request: PermissionRequest) => {
    pending.set(id(session), [...(pending.get(id(session)) ?? []), request]);
    sessions.onEvent({
      type: "permission",
      project: "p",
      conversation: id(session),
      request,
    });
  };
  const conductorIdle = () => {
    busy = false;
    sessions.onEvent({
      type: "state",
      project: "p",
      conversation: id(401),
      engine: { state: "idle" },
    } as never);
  };

  test("an unwatched session's request reaches its conductor, once", async () => {
    await sessions.restore();
    asked(31, ask("req-a"));
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.conversation, id(401));
    assert.match(
      sent[0]?.text ?? "",
      new RegExp(`${id(31)} "Session 31": waits on a permission request`),
    );
    asked(31, ask("req-a"));
    await settle();
    assert.equal(sent.length, 1);
  });

  test("a request the user could answer is told once access is taken back", async () => {
    sent.length = 0;
    access.set(id(32), true);
    asked(32, ask("req-b"));
    await settle();
    // The user answers it: the conductor hears nothing.
    assert.equal(sent.length, 0);
    await setAccess(32, false);
    await settle();
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? "", new RegExp(`${id(32)} "Session 32"`));
    assert.deepEqual(changed.at(-1), { session: id(32), userAccess: false });
    // Told now: neither the event again nor another revoke tells it twice.
    asked(32, ask("req-b"));
    await setAccess(32, false);
    await settle();
    assert.equal(sent.length, 1);
  });

  test("a report dropped because the user was let in is not counted as told", async () => {
    sent.length = 0;
    pending.clear();
    access.set(id(32), false);
    // The conductor is busy: the report waits in line.
    busy = true;
    asked(32, ask("req-c"));
    await settle();
    assert.equal(sent.length, 0);
    await setAccess(32, true);
    assert.deepEqual(changed.at(-1), { session: id(32), userAccess: true });
    // At its next idle the user may answer it: the report is dropped.
    conductorIdle();
    await settle();
    assert.equal(sent.length, 0);
    // Taken back while it still waits: told now, the first time.
    await setAccess(32, false);
    await settle();
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? "", new RegExp(`${id(32)} "Session 32"`));
  });
});
