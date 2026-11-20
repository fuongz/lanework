// Build the Claude Code plugin's hook bundle (INF-03) into the plugin's own
// repository, github.com/lanework-dev/plugins. The hook's source stays here,
// in apps/desktop/electron/hook/, because the desktop app bundles it too.
//
//   bun run build:plugin [--out <plugins checkout>]                 write the bundle and its stamp
//   node scripts/build-plugin.mjs --out <plugins checkout> --check   fail if the bundle is not what this tree builds
//
// <plugins checkout> is a clone of lanework-dev/plugins; it defaults to
// $LANEWORK_PLUGINS_DIR, then ../lanework-dev/plugins (so `bun run
// build:plugin` works when the two clones sit side by side). The bundle is COMMITTED there: a Claude Code plugin
// is installed by cloning its marketplace repo, with no step that could build
// it, so what is in git is what users run. Next to it, `build.json` names the
// commit of this repo it was built from; the plugins repo's CI checks out that
// commit and runs `--check`, so the bundle can be traced to its source.
//
// The build refuses a working tree with changes to the desktop app or the
// lockfile (`--allow-dirty` overrides it, for a local try only): a stamp must
// name a commit the bundle can be rebuilt from.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SOURCE = "apps/desktop/electron/hook/lanework-checkpoint.ts";
const BUNDLE = "plugins/lanework/bin/lanework-checkpoint.cjs";
const STAMP = "plugins/lanework/build.json";
const REPO = "github.com/fuongz/lanework";
/** What the bundle is built from: the app (hook + shared code) and its deps. */
const INPUTS = ["apps/desktop", "package.json", "bun.lock"];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
function option(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

// INF-06 (SS-08): bun's bundler output changes between releases, so a bundle
// built on another bun differs byte for byte from the committed one.
function pinnedBun() {
  const pinned = JSON.parse(
    readFileSync("package.json", "utf8"),
  ).packageManager?.match(/^bun@(.+)$/)?.[1];
  if (!pinned) {
    console.error('package.json has no "packageManager": "bun@<version>".');
    process.exit(1);
  }
  const actual = execFileSync("bun", ["--version"], {
    encoding: "utf8",
  }).trim();
  if (actual !== pinned) {
    console.error(
      `The plugin bundle is built with bun ${pinned} (package.json packageManager); this is bun ${actual}. Install bun ${pinned} and put it first on PATH.`,
    );
    process.exit(1);
  }
  return pinned;
}

function build(outfile) {
  // Node, not bun: the plugin runs under whatever `node` the user has
  // (INF-03/D3), and a CommonJS bundle loads on every Node from 18 up.
  execFileSync(
    "bun",
    ["build", SOURCE, "--target=node", "--format=cjs", `--outfile=${outfile}`],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  // It runs on plain Node, where `require("electron")` fails.
  if (
    /\brequire\(\s*["']electron["']\s*\)/.test(readFileSync(outfile, "utf8"))
  ) {
    console.error(
      `${SOURCE} pulls in electron; the plugin runs on plain Node.`,
    );
    process.exit(1);
  }
}

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

const SIBLING = "../lanework-dev/plugins";
const outArg =
  option("--out") ??
  process.env.LANEWORK_PLUGINS_DIR ??
  (existsSync(SIBLING) ? SIBLING : undefined);
if (!outArg) {
  console.error(
    "Where is the plugins repo? Pass --out <clone of lanework-dev/plugins> or set LANEWORK_PLUGINS_DIR.",
  );
  process.exit(1);
}
const out = resolve(outArg);
if (!existsSync(join(out, ".claude-plugin/marketplace.json"))) {
  console.error(`${out} is not a clone of lanework-dev/plugins.`);
  process.exit(1);
}
const bundlePath = join(out, BUNDLE);
const stampPath = join(out, STAMP);

const bun = pinnedBun();

if (flag("--check")) {
  const dir = mkdtempSync(join(tmpdir(), "lanework-plugin-"));
  try {
    const fresh = join(dir, "lanework-checkpoint.cjs");
    build(fresh);
    const committed = existsSync(bundlePath)
      ? readFileSync(bundlePath, "utf8")
      : "";
    if (readFileSync(fresh, "utf8") !== committed) {
      console.error(
        `${BUNDLE} is not what ${SOURCE} builds to at this commit. Rebuild it: node scripts/build-plugin.mjs --out <plugins checkout>`,
      );
      process.exit(1);
    }
    console.log(`plugin bundle OK: ${bundlePath}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  const dirty = git("status", "--short", "--", ...INPUTS);
  if (dirty && !flag("--allow-dirty")) {
    console.error(
      `Commit these first, so the stamp names a commit the bundle builds from (or pass --allow-dirty for a local try):\n${dirty}`,
    );
    process.exit(1);
  }
  mkdirSync(dirname(bundlePath), { recursive: true });
  build(bundlePath);
  const stamp = {
    source: REPO,
    commit: git("rev-parse", "HEAD"),
    bun,
    ...(dirty ? { dirty: true } : {}),
  };
  writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
  console.log(`wrote ${bundlePath}\nwrote ${stampPath} (${stamp.commit})`);
}
