// INF-10 (docs/agents/versioning.md): `mise run release:bump <patch|minor|major>`.
// Moves apps/desktop/package.json to the next release version, commits only
// that file as `chore(release): vX.Y.Z` and tags it `vX.Y.Z`. It never
// pushes: `git push origin main vX.Y.Z` is what starts the release workflow,
// and that stays a person's call.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const part = process.argv[2];
if (!["patch", "minor", "major"].includes(part)) {
  fail("Usage: release:bump <patch|minor|major>");
}

const pkgPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);
// Every git call runs from the repo root, so the root-relative path below
// means the same thing whatever directory mise starts the task in.
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: dirname(pkgPath),
  encoding: "utf8",
}).trim();
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const pkgRel = relative(root, pkgPath);

if (git("status", "--porcelain", "--", pkgRel)) {
  fail(`${pkgRel} has uncommitted changes: commit or stash them first.`);
}
if (git("diff", "--cached", "--name-only")) {
  fail(
    "Something is already staged: the release commit holds package.json alone.",
  );
}

const text = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(text);
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!match) fail(`package.json version ${pkg.version} is not X.Y.Z.`);
let [major, minor, patch] = match.slice(1).map(Number);
if (part === "major") [major, minor, patch] = [major + 1, 0, 0];
if (part === "minor") [minor, patch] = [minor + 1, 0];
if (part === "patch") patch += 1;
const next = `${major}.${minor}.${patch}`;
const tag = `v${next}`;

if (git("tag", "--list", tag)) fail(`Tag ${tag} already exists.`);

// Replace the one field in place so the file keeps its formatting.
const updated = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
writeFileSync(pkgPath, updated);

git("add", "--", pkgRel);
git("commit", "-m", `chore(release): ${tag}`);
git("tag", "-a", tag, "-m", tag);

console.log(`${pkg.version} -> ${next}: committed and tagged ${tag}.`);
console.log(`Release it with: git push origin HEAD ${tag}`);
