// Run with `bun test apps/desktop/electron/hook`. What the checkpoint hook's
// `redact()` strips, and what it must leave alone (FE-78/D3).
//
// NOTE: Every fake secret is built by joining its prefix to filler at run
// time, so this file never holds a string a secret scanner (or the hook's own
// WIP check) mistakes for a real key.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { redact } from "./redact";

const fill = (n: number, c = "a") => c.repeat(n);
const join = (...parts: string[]) => parts.join("");

/** [label, text holding a secret, the secret itself]. */
const SECRETS: [string, string, string][] = [
  ["Stripe secret key", "", join("sk_", "live_", fill(24))],
  ["Stripe restricted key", "", join("rk_", "live_", fill(24))],
  ["Stripe test key", "", join("sk_", "test_", fill(24))],
  ["Stripe webhook secret", "", join("whsec_", fill(32))],
  ["GitLab PAT", "", join("glpat", "-", fill(20))],
  ["npm token", "", join("npm_", fill(36))],
  ["Hugging Face token", "", join("hf_", fill(34))],
  ["Slack bot token", "", join("xox", "b-", "1234567890-", fill(24))],
  ["Slack user token", "", join("xox", "p-", "1234567890-", fill(24))],
  ["GitHub PAT", "", join("gh", "p_", fill(36))],
  ["GitHub OAuth token", "", join("gh", "o_", fill(36))],
  ["GitHub app token", "", join("gh", "s_", fill(36))],
  ["GitHub fine-grained PAT", "", join("github", "_pat_", fill(40))],
  ["AWS access key id", "", join("AK", "IA", fill(16, "A"))],
  ["AWS session key id", "", join("AS", "IA", fill(16, "B"))],
  ["Google API key", "", join("AI", "za", fill(35))],
  ["OpenAI key", "", join("sk", "-proj-", fill(40))],
  ["Anthropic key", "", join("sk", "-ant-", "api03-", fill(40))],
  [
    "JWT",
    "",
    join(
      "ey",
      "JhbGciOiJIUzI1NiJ9",
      ".",
      "eyJzdWIiOiIxMjM0NSJ9",
      ".",
      fill(20),
    ),
  ],
  ["lanework machine secret", "", join("lw_", "mch_", fill(32))],
];

/** [label, text, the part that must disappear]. */
const IN_CONTEXT: [string, string, string][] = [
  [
    "Postgres URL",
    join("postgres://app:", "hunter2pass", "@db.internal:5432/app"),
    "hunter2pass",
  ],
  [
    "MongoDB URL",
    join("mongodb+srv://root:", "s3cretpw", "@cluster0.example.net/db"),
    "s3cretpw",
  ],
  [
    "token as a URL user",
    join("https://", "x", fill(30, "t"), "@github.com/acme/repo.git"),
    fill(30, "t"),
  ],
  ["curl -u", join("curl -u admin:", "pa55word", " https://h"), "pa55word"],
  [
    "curl --user",
    join("curl --user admin:", "pa55word", " https://h"),
    "pa55word",
  ],
  [
    "docker login -p",
    join("docker login -u me -p ", "dockerpw1", " registry.io"),
    "dockerpw1",
  ],
  ["mysql -pX", join("mysql -u root -p", "rootpw9", " app"), "rootpw9"],
  ["--password=", join("tool --password=", "pw12", " go"), "pw12"],
  ["--password value", join("tool --password ", "pw34", " go"), "pw34"],
  ["--token value", join("gh-cli --token ", "tok567", " x"), "tok567"],
  ["KEY=value", join("DB_PASSWORD=", "longvalue1"), "longvalue1"],
  ["JSON secret", join('"client_secret": "', "abcdef123", '"'), "abcdef123"],
  [
    "Authorization header",
    join("Authorization: token ", "abcdefgh12345"),
    "abcdefgh12345",
  ],
  ["Bearer", join("Bearer ", fill(24, "z")), fill(24, "z")],
  [
    "PEM block",
    join(
      "-----BEGIN ",
      "RSA PRIVATE KEY-----\n",
      fill(40, "M"),
      "\n-----END RSA PRIVATE KEY-----",
    ),
    fill(40, "M"),
  ],
  [
    "unterminated PEM block",
    join("-----BEGIN ", "OPENSSH PRIVATE KEY-----\n", fill(40, "N"), "\n"),
    fill(40, "N"),
  ],
  [
    "PGP block",
    join(
      "-----BEGIN ",
      "PGP PRIVATE KEY BLOCK-----\n\n",
      fill(40, "P"),
      "\n-----END PGP PRIVATE KEY BLOCK-----",
    ),
    fill(40, "P"),
  ],
];

/** Commands that look like they take `-p <secret>` and do not. */
const UNTOUCHED = [
  "mkdir -p x",
  "git log -p",
  "ssh -p 2222 h",
  "mysql -u root -p app",
  "docker login --password-stdin registry.io",
  "bun run build && bun run typecheck",
  "git push origin main",
  "ssh://git@github.com/acme/repo.git",
  "the auth flow and the token refresh",
];

describe("redact", () => {
  for (const [label, , secret] of SECRETS) {
    test(`strips a ${label}`, () => {
      const text = `before ${secret} after`;
      const out = redact(text);
      assert.notEqual(out, text);
      assert.ok(!out.includes(secret), out);
      assert.ok(out.startsWith("before ") && out.endsWith(" after"), out);
    });
  }

  for (const [label, text, secret] of IN_CONTEXT) {
    test(`strips the secret in a ${label}`, () => {
      const out = redact(text);
      assert.ok(!out.includes(secret), out);
    });
  }

  for (const text of UNTOUCHED) {
    test(`leaves "${text}" alone`, () => {
      assert.equal(redact(text), text);
    });
  }

  test("keeps the scheme of an Authorization header readable", () => {
    assert.equal(
      redact(`curl -H "Authorization: Bearer ${fill(24, "q")}"`),
      'curl -H "Authorization: Bearer [REDACTED]"',
    );
  });
});
