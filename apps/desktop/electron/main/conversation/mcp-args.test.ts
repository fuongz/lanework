// Run with `bun test ./electron/main/conversation/mcp-args.test.ts`.
//
// A conductor's process runs its safe control tools without a permission
// prompt; `sessions_answer` and `conductors_create` still ask.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SETTINGS } from "../../../shared/conversation";
import { engineArgs } from "./engine";
import {
  CONDUCTOR_ALLOWED_TOOLS,
  CONTROL_SERVER,
  codexControlArgs,
} from "./mcp-args";

const session = "00000000-0000-4000-8000-000000000001";
const SAFE = [
  "sessions_start",
  "sessions_list",
  "sessions_read",
  "sessions_send",
  "sessions_access",
  "memory_read",
  "memory_append",
  "memory_write",
  "models_list",
];

/** The value after `flag`, or null when the flag is absent. */
function flagValue(args: string[], flag: string): string | null {
  const at = args.indexOf(flag);
  return at < 0 ? null : (args[at + 1] ?? null);
}

describe("the control tools a conductor runs without asking", () => {
  test("exactly the safe ones: never sessions_answer or conductors_create", () => {
    assert.deepEqual([...CONDUCTOR_ALLOWED_TOOLS], SAFE);
  });

  test("Claude: --allowedTools on a conductor's process with the control server", () => {
    const args = engineArgs(
      session,
      DEFAULT_SETTINGS,
      false,
      true,
      null,
      null,
      false,
      "/shim",
      null,
      true,
    );
    assert.equal(
      flagValue(args, "--allowedTools"),
      SAFE.map((tool) => `mcp__${CONTROL_SERVER}__${tool}`).join(","),
    );
    // The permission mode stands as chosen: the allow list only skips the
    // prompt for those tools.
    assert.equal(
      flagValue(args, "--permission-mode"),
      DEFAULT_SETTINGS.permission,
    );
  });

  test("Claude: none for a plain session, or without the control server", () => {
    const plain = engineArgs(
      session,
      DEFAULT_SETTINGS,
      false,
      true,
      null,
      null,
      false,
      "/shim",
    );
    assert.equal(plain.includes("--allowedTools"), false);
    const noServer = engineArgs(
      session,
      DEFAULT_SETTINGS,
      false,
      true,
      null,
      null,
      false,
      null,
      null,
      true,
    );
    assert.equal(noServer.includes("--allowedTools"), false);
  });

  test("Claude: a guarded conductor keeps its --disallowedTools beside it", () => {
    const args = engineArgs(
      session,
      DEFAULT_SETTINGS,
      false,
      true,
      null,
      null,
      true,
      "/shim",
      null,
      true,
    );
    assert.ok(flagValue(args, "--disallowedTools"));
    assert.ok(flagValue(args, "--allowedTools"));
    assert.equal(
      flagValue(args, "--allowedTools")?.includes("sessions_answer"),
      false,
    );
  });

  test("Codex: approval_mode approve per safe tool on a conductor's only", () => {
    const [, conductor] = codexControlArgs("/shim", true);
    for (const tool of SAFE)
      assert.ok(conductor?.includes(`${tool}={approval_mode="approve"}`), tool);
    assert.equal(conductor?.includes("sessions_answer"), false);
    assert.equal(conductor?.includes("conductors_create"), false);
    const [, plain] = codexControlArgs("/shim");
    assert.equal(plain?.includes("tools="), false);
  });
});
