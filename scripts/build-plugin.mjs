// Build the Claude Code plugin's hook bundle (INF-03).
//
//   node scripts/build-plugin.mjs           write plugins/lanework/bin/lanework-checkpoint.cjs
//   node scripts/build-plugin.mjs --check   fail if that file is not what the source builds to
//
// ⚠️ The bundle is COMMITTED, the one build output in this repo that is. A
// Claude Code plugin is installed by cloning its marketplace repo — there is no
// install step that could build it — so what is in git is what users run. The
// `--check` in `bun run gate` is what keeps it from drifting behind
// `apps/desktop/electron/hook/`, the source the desktop app bundles too.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE = "apps/desktop/electron/hook/lanework-checkpoint.ts";
const TARGET = "plugins/lanework/bin/lanework-checkpoint.cjs";

// INF-06 (SS-08): bun's bundler output changes between releases, so a bundle
// built on another bun differs byte for byte from the committed one. Building
// or checking on any bun but the one `packageManager` pins would either fail
// `--check` spuriously or commit a bundle from an unpinned toolchain.
function assertBunVersion() {
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
}

function build(outfile) {
  // Node, not bun: the plugin runs under whatever `node` the user has
  // (INF-03/D3), and a CommonJS bundle loads on every Node from 18 up.
  execFileSync(
    "bun",
    ["build", SOURCE, "--target=node", "--format=cjs", `--outfile=${outfile}`],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

assertBunVersion();

if (process.argv.includes("--check")) {
  const dir = mkdtempSync(join(tmpdir(), "lanework-plugin-"));
  try {
    const fresh = join(dir, "lanework-checkpoint.cjs");
    build(fresh);
    let committed = "";
    try {
      committed = readFileSync(TARGET, "utf8");
    } catch {
      // Missing counts as stale.
    }
    if (readFileSync(fresh, "utf8") !== committed) {
      console.error(
        `${TARGET} is out of date with ${SOURCE}. Run: bun run build:plugin`,
      );
      process.exit(1);
    }
    console.log(`plugin bundle OK — ${TARGET}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  build(TARGET);
  console.log(`wrote ${TARGET}`);
}
