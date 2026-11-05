import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRepo } from "./ids";

// FE-121: the create dialog groups picked folders by this key, so two clones
// of one repo must land on one row however their remotes are spelled.

test("SSH, HTTPS and .git variants of one repo share a key", () => {
  const key = "github.com/acme/app";
  for (const remote of [
    "git@github.com:acme/app.git",
    "git@github.com:Acme/App",
    "https://github.com/acme/app.git",
    "https://github.com/acme/app/",
    "ssh://git@github.com/acme/app.git",
    "ssh://git@github.com:22/acme/app",
    "https://user:secret-token@github.com/acme/app.git",
  ])
    assert.equal(normalizeRepo(remote), key, remote);
});

test("credentials never survive into the key", () => {
  assert.equal(
    normalizeRepo("https://x-access-token:ghp_abc@github.com/acme/app"),
    "github.com/acme/app",
  );
});

test("anything that is not host/owner/name is refused", () => {
  for (const remote of [
    "",
    "/srv/git/app.git",
    "file:///srv/git/app.git",
    "https://github.com/acme",
    "../app",
  ])
    assert.equal(normalizeRepo(remote), null, remote);
});
