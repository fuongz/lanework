// Run with `bun test ./electron/main/git/repo-trust.test.ts`.
//
// A trust answer belongs to the repository, not the folder (FE-182): a
// subfolder or a linked worktree of a trusted repository reads without
// asking, a changed set of findings asks again, and answers an earlier
// version kept by folder path still count. These run real git in a temp repo.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  type RememberedTrust,
  scanRepoTrust,
  TrustStore,
  trustFingerprint,
} from "./repo-trust";

let base: string;
let repo: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

/** A fresh repository whose local config names a git-lfs-style filter. */
function makeRepo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "filter.lfs.clean", "git-lfs clean -- %f");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "lanew-trust-")));
  repo = makeRepo("repo");
  mkdirSync(join(repo, "videos", "one"), { recursive: true });
  mkdirSync(join(repo, "videos", "two"), { recursive: true });
});
after(() => rmSync(base, { recursive: true, force: true }));

describe("TrustStore, per repository", () => {
  test("a trusted repository reads without asking from a new subfolder", async () => {
    const store = new TrustStore();
    const first = await store.decide(repo);
    assert.equal(first.kind, "ask");
    if (first.kind !== "ask") return;
    store.set(repo, "trusted", first.scan);
    assert.equal((await store.decide(join(repo, "videos", "one"))).kind, "run");
    assert.equal((await store.decide(join(repo, "videos", "two"))).kind, "run");
  });

  test("an answer given in a subfolder holds for the whole repository", async () => {
    const store = new TrustStore();
    const sub = join(repo, "videos", "one");
    const first = await store.decide(sub);
    if (first.kind !== "ask") throw new Error("expected a question");
    store.set(sub, "trusted", first.scan);
    assert.equal((await store.decide(repo)).kind, "run");
    assert.equal((await store.decide(join(repo, "videos", "two"))).kind, "run");
  });

  test("a linked worktree shares the repository's answer", async () => {
    const store = new TrustStore();
    const first = await store.decide(repo);
    if (first.kind !== "ask") throw new Error("expected a question");
    store.set(repo, "trusted", first.scan);
    const linked = join(base, "linked");
    git(repo, "worktree", "add", "-q", "-b", "linked", linked);
    assert.equal((await store.decide(linked)).kind, "run");
  });

  test("'Don't run' is remembered for the whole repository", async () => {
    const store = new TrustStore();
    const first = await store.decide(repo);
    if (first.kind !== "ask") throw new Error("expected a question");
    store.set(repo, "restricted", first.scan);
    assert.equal(
      (await store.decide(join(repo, "videos", "one"))).kind,
      "restricted",
    );
  });

  test("a hook added after the answer asks again", async () => {
    const dir = makeRepo("hooked");
    const store = new TrustStore();
    const first = await store.decide(dir);
    if (first.kind !== "ask") throw new Error("expected a question");
    store.set(dir, "trusted", first.scan);
    assert.equal((await store.decide(dir)).kind, "run");
    const hook = join(dir, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    chmodSync(hook, 0o755);
    assert.equal((await store.decide(dir)).kind, "ask");
  });

  test("another repository with the same findings still asks", async () => {
    const store = new TrustStore();
    const first = await store.decide(repo);
    if (first.kind !== "ask") throw new Error("expected a question");
    store.set(repo, "trusted", first.scan);
    assert.equal((await store.decide(makeRepo("other"))).kind, "ask");
  });

  test("a worktree with config of its own asks once and keeps the main answer", async () => {
    const dir = makeRepo("worktrees");
    const store = new TrustStore();
    const main = await store.decide(dir);
    if (main.kind !== "ask") throw new Error("expected a question");
    store.set(dir, "trusted", main.scan);

    git(dir, "config", "extensions.worktreeConfig", "true");
    const linked = join(base, "worktrees-linked");
    git(dir, "worktree", "add", "-q", "-b", "wt", linked);
    git(linked, "config", "--worktree", "filter.extra.clean", "cat");

    const asked = await store.decide(linked);
    assert.equal(asked.kind, "ask");
    if (asked.kind !== "ask") return;
    store.set(linked, "trusted", asked.scan);

    assert.equal((await store.decide(linked)).kind, "run");
    assert.equal((await store.decide(dir)).kind, "run");
  });

  test("forget makes the repository ask again from any folder", async () => {
    const store = new TrustStore();
    const first = await store.decide(repo);
    if (first.kind !== "ask") throw new Error("expected a question");
    store.set(repo, "trusted", first.scan);
    const sub = join(repo, "videos", "one");
    store.forget(sub, await scanRepoTrust(sub));
    assert.equal((await store.decide(repo)).kind, "ask");
  });
});

describe("TrustStore, answers kept by folder before FE-182", () => {
  test("the repository root's old answer answers a new subfolder and is filed under the repository", async () => {
    const scan = await scanRepoTrust(repo);
    const old: Record<string, RememberedTrust> = {
      [repo]: {
        answer: "trusted",
        fingerprint: trustFingerprint(scan.findings),
      },
    };
    let saved: Record<string, RememberedTrust> = {};
    const store = new TrustStore(old, (all) => {
      saved = all;
    });
    assert.equal((await store.decide(join(repo, "videos", "two"))).kind, "run");
    assert.ok(
      Object.keys(saved).some((key) => key.startsWith("repo:")),
      "the answer is filed under the repository",
    );
  });

  test("a folder's own old answer still answers that folder", async () => {
    const sub = join(repo, "videos", "one");
    const scan = await scanRepoTrust(sub);
    const store = new TrustStore({
      [sub]: {
        answer: "trusted",
        fingerprint: trustFingerprint(scan.findings),
      },
    });
    assert.equal((await store.decide(sub)).kind, "run");
    assert.equal((await store.decide(join(repo, "videos", "two"))).kind, "run");
  });

  test("an old answer for other findings does not answer", async () => {
    const store = new TrustStore({
      [repo]: { answer: "trusted", fingerprint: "config:filter.other=x" },
    });
    assert.equal((await store.decide(repo)).kind, "ask");
  });

  test("forget also drops an old folder-path answer", async () => {
    const scan = await scanRepoTrust(repo);
    const store = new TrustStore({
      [repo]: {
        answer: "trusted",
        fingerprint: trustFingerprint(scan.findings),
      },
    });
    store.forget(repo, scan);
    assert.equal((await store.decide(repo)).kind, "ask");
  });

  test("keys filed under a repository survive a reload unchanged", async () => {
    const store = new TrustStore();
    const first = await store.decide(repo);
    if (first.kind !== "ask") throw new Error("expected a question");
    store.set(repo, "trusted", first.scan);
    const again = new TrustStore(store.toJSON());
    assert.equal((await again.decide(join(repo, "videos", "one"))).kind, "run");
  });
});
