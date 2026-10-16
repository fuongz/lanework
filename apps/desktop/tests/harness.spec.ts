// FE-61: which version of Claude Code and Codex this machine runs, and how
// each one is updated. The rules are driven directly under Node (V1); the
// island runs in the app against a stand-in Codex (V3).
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import {
  brewNameOf,
  cleanVersion,
  commandPath,
  failureMessage,
  installMethodOf,
  parseBrewOutdated,
  parseVersion,
  shQuote,
  terminalScript,
  updateCommandOf,
} from "../electron/main/harness/rules";
import { compareVersions } from "../shared/harness";
import { launchEnv, removeProfile, seedCredential } from "./auth-fixtures";

const home = "/Users/someone";

test.describe("harness rules", () => {
  test("reads the version out of each CLI's --version", () => {
    expect(parseVersion("2.1.301 (Claude Code)\n")).toBe("2.1.301");
    expect(parseVersion("codex-cli 0.163.0")).toBe("0.163.0");
    expect(parseVersion("codex-cli 0.164.0-alpha.2\n")).toBe("0.164.0-alpha.2");
    // A profile line without a version before the answer is skipped.
    expect(parseVersion("welcome back\n2.1.301 (Claude Code)")).toBe("2.1.301");
    expect(parseVersion("command not found")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  test("keeps only a clean version from outside", () => {
    expect(cleanVersion("2.1.302")).toBe("2.1.302");
    expect(cleanVersion(" 0.163.0 ")).toBe("0.163.0");
    expect(cleanVersion("latest")).toBeNull();
    expect(cleanVersion("x1.2.3")).toBeNull();
    expect(cleanVersion(42)).toBeNull();
    expect(cleanVersion("1.2.3".repeat(20))).toBeNull();
  });

  test("compares versions numerically, pre-releases first", () => {
    expect(compareVersions("2.1.302", "2.1.301")).toBeGreaterThan(0);
    expect(compareVersions("2.1.301", "2.1.301")).toBe(0);
    expect(compareVersions("0.99.0", "0.163.0")).toBeLessThan(0);
    expect(compareVersions("2.10.0", "2.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0);
  });

  test("turns what command -v printed into a path", () => {
    expect(commandPath("/Users/someone/.local/bin/claude\n", home)).toBe(
      "/Users/someone/.local/bin/claude",
    );
    expect(
      commandPath("alias claude=/Users/someone/.claude/local/claude", home),
    ).toBe("/Users/someone/.claude/local/claude");
    expect(commandPath("alias claude='~/.claude/local/claude'", home)).toBe(
      "/Users/someone/.claude/local/claude",
    );
    expect(commandPath("claude", home)).toBeNull();
    expect(commandPath("", home)).toBeNull();
  });

  test("tells the install method from where the binary really lives", () => {
    expect(
      installMethodOf(
        "claude",
        `${home}/.local/share/claude/versions/2.1.301`,
        home,
      ),
    ).toBe("native");
    expect(installMethodOf("claude", `${home}/.local/bin/claude`, home)).toBe(
      "native",
    );
    expect(
      installMethodOf("claude", `${home}/.claude/local/claude`, home),
    ).toBe("native");
    expect(
      installMethodOf(
        "codex",
        "/opt/homebrew/Caskroom/codex/0.163.0/bin/codex",
        home,
      ),
    ).toBe("brew-cask");
    expect(
      installMethodOf(
        "codex",
        "/opt/homebrew/Cellar/codex/0.163.0/bin/codex",
        home,
      ),
    ).toBe("brew-formula");
    expect(
      installMethodOf(
        "codex",
        "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
        home,
      ),
    ).toBe("npm");
    expect(
      installMethodOf(
        "claude",
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
        home,
      ),
    ).toBe("npm");
    // ~/.local/bin is Claude's native installer, not anyone else's.
    expect(installMethodOf("codex", `${home}/.local/bin/codex`, home)).toBe(
      "unknown",
    );
    expect(installMethodOf("codex", "/usr/local/bin/codex", home)).toBe(
      "unknown",
    );
    expect(installMethodOf("claude", null, home)).toBe("unknown");
  });

  test("picks the update command from the install method", () => {
    expect(updateCommandOf("claude", "native", null)).toBe("claude update");
    expect(
      updateCommandOf(
        "codex",
        "brew-cask",
        "/opt/homebrew/Caskroom/codex/0.163.0/bin/codex",
      ),
    ).toBe("brew upgrade --cask codex");
    expect(
      updateCommandOf(
        "codex",
        "brew-formula",
        "/opt/homebrew/Cellar/codex/0.163.0/bin/codex",
      ),
    ).toBe("brew upgrade codex");
    expect(updateCommandOf("claude", "npm", null)).toBe(
      "npm i -g @anthropic-ai/claude-code@latest",
    );
    expect(updateCommandOf("codex", "npm", null)).toBe(
      "npm i -g @openai/codex@latest",
    );
    // No way to tell → no command, no Update button.
    expect(
      updateCommandOf("claude", "unknown", "/somewhere/claude"),
    ).toBeNull();
    expect(updateCommandOf("codex", "native", null)).toBeNull();
    // A brew name a shell would read is refused, not quoted.
    expect(
      updateCommandOf("codex", "brew-cask", "/opt/homebrew/Caskroom/a;rm/1/x"),
    ).toBeNull();
    expect(brewNameOf("/opt/homebrew/Caskroom/codex/0.163.0/bin/codex")).toBe(
      "codex",
    );
  });

  test("reads the latest version out of brew outdated", () => {
    const outdated = JSON.stringify({
      formulae: [],
      casks: [
        {
          name: "codex",
          installed_versions: ["0.163.0"],
          current_version: "0.164.0",
        },
      ],
    });
    expect(parseBrewOutdated(outdated, "cask", "codex", "0.163.0")).toBe(
      "0.164.0",
    );
    // Nothing outdated: the installed version is the latest.
    expect(
      parseBrewOutdated(
        '{"formulae":[],"casks":[]}',
        "cask",
        "codex",
        "0.163.0",
      ),
    ).toBe("0.163.0");
    expect(
      parseBrewOutdated(
        JSON.stringify({
          formulae: [{ name: "codex", current_version: "0.170.1" }],
          casks: [],
        }),
        "formula",
        "codex",
        "0.163.0",
      ),
    ).toBe("0.170.1");
    expect(
      parseBrewOutdated("Error: no such cask", "cask", "codex", "1.0.0"),
    ).toBeNull();
  });

  test("says why an update failed in its last lines", () => {
    expect(
      failureMessage(
        "\u001b[31mnpm error\u001b[0m code EACCES\nnpm error path /usr/local\n",
        "",
        243,
      ),
    ).toBe("npm error code EACCES\nnpm error path /usr/local");
    expect(failureMessage("", "only stdout\n", 1)).toBe("only stdout");
    expect(failureMessage("", "", 2)).toBe("The update exited with status 2.");
    expect(failureMessage("", "", null)).toBe(
      "The update did not finish in time.",
    );
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    expect(failureMessage(long, "", 1)).toBe(
      "line 16\nline 17\nline 18\nline 19",
    );
  });

  test("writes a Terminal script that runs only the chosen command", () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    const script = terminalScript("/bin/zsh", "brew upgrade --cask codex");
    expect(script.startsWith("#!/bin/zsh -il\n")).toBe(true);
    expect(script).toContain("\nbrew upgrade --cask codex\n");
    // A shell that is not POSIX still gets a POSIX interpreter.
    expect(
      terminalScript("/opt/homebrew/bin/fish", "claude update").startsWith(
        "#!/bin/zsh -il\n",
      ),
    ).toBe(true);
  });
});

/**
 * A Codex stand-in at 0.162.1 whose `update` moves it to 0.163.0 — or fails,
 * the way npm does without permission — and an enrolled, offline app around
 * it. Main asks no network and no brew in a test run.
 */
async function openWithCodex(options: { fail: boolean }) {
  const profile = await mkdtemp(join(tmpdir(), "lanework-harness-"));
  const home = join(profile, "home");
  await seedCredential(home);
  const version = join(profile, "codex-version");
  await writeFile(version, "0.162.1");
  const codex = join(profile, "codex-stand-in.sh");
  await writeFile(
    codex,
    `#!/bin/sh
case "$1" in
  --version) printf 'codex-cli %s\\n' "$(cat '${version}')";;
  update) sleep 1; ${
    options.fail
      ? "echo 'npm error code EACCES' >&2; exit 243"
      : `printf '0.163.0' > '${version}'`
  };;
esac
`,
    { mode: 0o755 },
  );
  const app = await electron.launch({
    args: [process.cwd()],
    env: {
      ...launchEnv({ profile, home }),
      LANEWORK_TERMINAL_SHELL: "/bin/sh",
      LANEWORK_CODEX_BIN: codex,
      LANEWORK_HARNESS_METHOD_CODEX: "npm",
      LANEWORK_HARNESS_LATEST_CODEX: "0.163.0",
    },
  });
  const page = await app.firstWindow();
  return {
    app,
    page,
    profile,
    cleanup: async () => {
      await app.close();
      await removeProfile(profile);
    },
  };
}

test.describe("harness island", () => {
  test("offers the update folded, opens on hover, and updates", async () => {
    const { page, cleanup } = await openWithCodex({ fail: false });
    try {
      const island = page.getByTestId("harness-island");
      // Folded first (D10): it never opens by itself.
      await expect(island).toHaveAttribute("data-view", "pill", {
        timeout: 20_000,
      });
      await expect(island).toHaveAttribute("data-state", "available");
      await expect(island).toContainText("Codex");
      await expect(island).toContainText("0.163.0");

      await island.hover();
      await expect(island).toHaveAttribute("data-view", "panel");
      const row = page.getByTestId("harness-row-codex");
      await expect(row).toContainText("0.162.1");
      await row.getByRole("button", { name: "Update" }).click();
      await expect(island).toHaveAttribute("data-state", "updating");
      await expect(island).toHaveAttribute("data-state", "done", {
        timeout: 15_000,
      });
      // Done shows for a moment, then the island is gone.
      await expect(island).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await cleanup();
    }
  });

  test("a failed update offers Terminal, and × skips the version", async () => {
    const { page, profile, cleanup } = await openWithCodex({ fail: true });
    try {
      const island = page.getByTestId("harness-island");
      await expect(island).toHaveAttribute("data-state", "available", {
        timeout: 20_000,
      });
      await island.click();
      await page
        .getByTestId("harness-row-codex")
        .getByRole("button", { name: "Update" })
        .click();
      await expect(island).toHaveAttribute("data-state", "failed", {
        timeout: 15_000,
      });
      await expect(island).toContainText("EACCES");

      // Under test main writes the script but never opens Terminal.
      await page.getByRole("button", { name: "Open in terminal" }).click();
      const script = join(profile, "harness", "update-codex.command");
      await expect
        .poll(async () => (await stat(script).catch(() => null))?.mode)
        .toBeTruthy();
      expect(((await stat(script)).mode & 0o777).toString(8)).toBe("700");
      expect(await readFile(script, "utf8")).toContain("update");

      await page
        .getByRole("button", { name: "Dismiss these versions" })
        .click();
      await expect(island).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });
});
