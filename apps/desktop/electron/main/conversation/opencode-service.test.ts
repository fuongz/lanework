// Run with `bun test ./electron/main/conversation/opencode-service.test.ts`.
//
// Listing models never starts OpenCode's background service: only a chat
// on OpenCode does.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClaudeCli } from "./claude-cli";
import { openCodeModelsOfIds } from "./opencode-models";
import {
  createOpenCodeService,
  listOpenCodeModelIds,
  OPENCODE_NOT_RUNNING,
} from "./opencode-service";

const cli = async () => ({ file: "opencode", env: {} }) as unknown as ClaudeCli;

/** An `opencode` whose service is down until `service start` runs. */
function fakeOpenCode() {
  const calls: string[] = [];
  let up = false;
  const exec = async (_cli: ClaudeCli, args: readonly string[]) => {
    const line = args.join(" ");
    calls.push(line);
    if (line === "--version") return "opencode v2.3.2";
    if (line === "service status")
      return up ? "http://127.0.0.1:4096" : "not running";
    if (line === "service start") {
      up = true;
      return "http://127.0.0.1:4096";
    }
    if (line === "service get password") return "secret";
    if (line === "models --standalone")
      return "opencode-go/beam-free\nopencode/claude-opus-5-5\nnot a model line\n";
    throw new Error(`unexpected ${line}`);
  };
  return { calls, exec };
}

describe("OpenCode's background service", () => {
  test("is not started when the caller says not to", async () => {
    const { calls, exec } = fakeOpenCode();
    const service = createOpenCodeService(cli, exec);
    await assert.rejects(service.service(false, { start: false }), {
      message: OPENCODE_NOT_RUNNING,
    });
    assert.ok(!calls.includes("service start"));
  });

  test("is started for a chat, as before", async () => {
    const { calls, exec } = fakeOpenCode();
    const service = createOpenCodeService(cli, exec);
    const found = await service.service();
    assert.equal(found.url, "http://127.0.0.1:4096");
    assert.ok(calls.includes("service start"));
  });

  test("models are listed without it, by a private server", async () => {
    const { calls, exec } = fakeOpenCode();
    const ids = await listOpenCodeModelIds(cli, exec);
    assert.deepEqual(ids, [
      "opencode-go/beam-free",
      "opencode/claude-opus-5-5",
    ]);
    assert.ok(!calls.includes("service start"));
    assert.deepEqual(openCodeModelsOfIds(ids)[0], {
      id: "opencode-go/beam-free",
      label: "beam-free",
      agent: "opencode",
      group: "opencode-go",
    });
  });
});
