// Run with `bun test apps/desktop/electron/main/harness`.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { codexAccountOf } from "./codex-account";

const token = (claims: unknown) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

describe("Codex account", () => {
  test("email, the default organization and the plan come from the id_token", () => {
    const account = codexAccountOf({
      OPENAI_API_KEY: "sk-must-not-matter",
      tokens: {
        access_token: "secret",
        id_token: token({
          email: "me@example.com",
          "https://api.openai.com/auth": {
            chatgpt_plan_type: "Plus",
            organizations: [
              { id: "a", title: "Other", is_default: false },
              { id: "b", title: "Hiip", is_default: true },
            ],
          },
        }),
      },
    });
    assert.deepEqual(account, {
      agent: "codex",
      signedIn: true,
      email: "me@example.com",
      org: "Hiip",
      plan: "plus",
    });
  });

  test("no organization reads as Personal", () => {
    const account = codexAccountOf({
      tokens: { id_token: token({ email: "me@example.com" }) },
    });
    assert.equal(account.org, "Personal");
    assert.equal(account.plan, null);
  });

  test("no tokens, or a token that is not a JWT, is signed out", () => {
    for (const json of [
      null,
      {},
      { tokens: {} },
      { tokens: { id_token: "x" } },
    ])
      assert.equal(codexAccountOf(json).signedIn, false);
  });
});
