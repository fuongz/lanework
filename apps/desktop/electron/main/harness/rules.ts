// Harness updates (FE-61): the pure rules — what a `--version` line says,
// how a CLI was installed, and which command updates it. No Electron, no
// child processes, so a spec drives them directly.
import { posix } from "node:path";
import type { HarnessAgent, InstallMethod } from "../../../shared/harness";

/** Where `latest` comes from for a CLI installed with npm or natively. */
export const NPM_PACKAGES: Record<HarnessAgent, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

const VERSION = /\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?/;

/**
 * The version in a CLI's `--version` output: `2.1.301 (Claude Code)` and
 * `codex-cli 0.163.0` both read as their dotted number. Null when the output
 * carries none.
 */
export function parseVersion(output: string | null | undefined): string | null {
  if (!output) return null;
  for (const line of output.split(/\r?\n/)) {
    const match = VERSION.exec(line);
    if (match) return match[0];
  }
  return null;
}

/** A version that came from outside (a registry, brew) and may be shown. */
export function cleanVersion(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = VERSION.exec(value.trim());
  return match && match.index === 0 ? match[0] : null;
}

/**
 * What `command -v` printed, as a file path.
 *
 * ⚠️ Claude's own installer has put `claude` in `.zshrc` as an ALIAS, and
 * `command -v` then prints the alias, not a path: `alias claude=/Users/…`
 * (zsh, bash). Its first word is the binary. A function or a builtin has no
 * file at all and reads as null.
 */
export function commandPath(output: string, home: string): string | null {
  let value = output.trim();
  if (!value) return null;
  const alias = /^alias\s+[^=]+=(.*)$/.exec(value);
  if (alias) {
    value = (alias[1] ?? "").trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    )
      value = value.slice(1, -1).trim();
    value = value.split(/\s+/)[0] ?? "";
  }
  if (value === "~") value = home;
  else if (value.startsWith("~/")) value = posix.join(home, value.slice(2));
  else if (value.startsWith("$HOME/"))
    value = posix.join(home, value.slice("$HOME/".length));
  return value.startsWith("/") ? value : null;
}

const under = (path: string, dir: string) =>
  path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/**
 * How a CLI was installed, read from where its binary REALLY lives (links
 * resolved).
 *
 * ⚠️ The resolved path, never the one on PATH: Homebrew links every binary
 * into `/opt/homebrew/bin` whether it came from a cask or a formula, and
 * Claude's native installer links `~/.local/bin/claude` to a versioned file.
 * Only where the link lands tells them apart.
 */
export function installMethodOf(
  agent: HarnessAgent,
  realPath: string | null,
  home: string,
): InstallMethod {
  if (!realPath) return "unknown";
  // ⚠️ Before `/node_modules/`: the older "local" Claude install keeps its
  // own node_modules under ~/.claude/local, and `claude update` — not
  // `npm i -g` — is what updates it.
  if (
    agent === "claude" &&
    [".local/share/claude", ".local/bin", ".claude/local"].some((dir) =>
      under(realPath, posix.join(home, dir)),
    )
  )
    return "native";
  if (realPath.includes("/Caskroom/")) return "brew-cask";
  if (realPath.includes("/Cellar/")) return "brew-formula";
  if (realPath.includes("/node_modules/")) return "npm";
  return "unknown";
}

/** A name Homebrew could have given a cask or formula; nothing a shell reads. */
const BREW_NAME = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,99}$/;

/** The cask or formula a Homebrew path belongs to: `…/Caskroom/codex/…` → `codex`. */
export function brewNameOf(realPath: string | null): string | null {
  if (!realPath) return null;
  const match = /\/(?:Caskroom|Cellar)\/([^/]+)\//.exec(realPath);
  const name = match?.[1];
  return name && BREW_NAME.test(name) ? name : null;
}

/**
 * The command that updates a CLI, from how it was installed. Null when the
 * app cannot tell, and then there is no Update button.
 *
 * ⚠️ Built here from fixed words and a validated brew name, never from
 * anything a renderer sent: this string is run in the user's shell.
 */
export function updateCommandOf(
  agent: HarnessAgent,
  method: InstallMethod,
  realPath: string | null,
): string | null {
  switch (method) {
    case "native":
      return agent === "claude" ? "claude update" : null;
    case "brew-cask": {
      const name = brewNameOf(realPath);
      return name ? `brew upgrade --cask ${name}` : null;
    }
    case "brew-formula": {
      const name = brewNameOf(realPath);
      return name ? `brew upgrade ${name}` : null;
    }
    case "npm":
      return `npm i -g ${NPM_PACKAGES[agent]}@latest`;
    default:
      return null;
  }
}

/**
 * The newest version `brew outdated --json=v2 [--cask] <name>` reports.
 *
 * ⚠️ An EMPTY list is an answer, not a failure: brew lists only what is
 * outdated, so nothing listed means the installed version is the latest.
 * Output that is not that JSON reads as null (unknown).
 */
export function parseBrewOutdated(
  output: string,
  kind: "cask" | "formula",
  name: string,
  installed: string | null,
): string | null {
  let json: unknown;
  try {
    json = JSON.parse(output.trim());
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const list = (json as Record<string, unknown>)[
    kind === "cask" ? "casks" : "formulae"
  ];
  if (!Array.isArray(list)) return null;
  const entry = list.find(
    (item): item is Record<string, unknown> =>
      !!item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).name === name,
  );
  if (!entry) return list.length === 0 ? installed : null;
  return cleanVersion(entry.current_version);
}

/** Terminal colours and cursor moves, which a CLI's error output is full of. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)|[@-Z\\\\-_])`,
  "g",
);

/**
 * Why an update failed, in a few lines: the end of its stderr — where a CLI
 * puts the reason — or of stdout when stderr is empty, or the exit status.
 */
export function failureMessage(
  stderr: string,
  stdout: string,
  code: number | null,
  maxLines = 4,
): string {
  const tail = (text: string) =>
    text
      .replace(ANSI, "")
      .split(/\r?\n|\r/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .slice(-maxLines)
      .join("\n")
      .slice(-600);
  return (
    tail(stderr) ||
    tail(stdout) ||
    (code === null
      ? "The update did not finish in time."
      : `The update exited with status ${code}.`)
  );
}

/** One word for a POSIX shell, whatever is in it. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `.command` file Terminal runs for "Open in Terminal": the update
 * command, then a shell so the window stays open on its output.
 *
 * ⚠️ zsh or bash as the interpreter, login AND interactive, like the probe:
 * the profile is what puts `brew`, `npm` and an aliased `claude` on PATH. A
 * fish or nu user still gets zsh here — this script is POSIX syntax.
 */
export function terminalScript(shellFile: string, command: string): string {
  const name = posix.basename(shellFile);
  const interpreter = ["zsh", "bash"].includes(name) ? shellFile : "/bin/zsh";
  return [
    `#!${interpreter} -il`,
    "# Written by Lanework to update an agent CLI (FE-61).",
    `printf '%s\\n\\n' ${shQuote(`$ ${command}`)}`,
    command,
    "code=$?",
    `printf '\\n%s\\n' "Lanework: the update exited with status $code."`,
    `exec "\${SHELL:-${interpreter}}" -l`,
    "",
  ].join("\n");
}
