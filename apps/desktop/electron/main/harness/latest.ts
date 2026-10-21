// The newest version of an agent CLI, from wherever its install method gets
// updates (FE-61): Homebrew for a cask or formula, npm for the rest.
import type { HarnessAgent, InstallMethod } from "../../../shared/harness";
import {
  brewNameOf,
  cleanVersion,
  NPM_PACKAGES,
  parseBrewOutdated,
} from "./rules";
import { afterMarker, runInLoginShell, type ShellOptions } from "./shell";

const NPM_REGISTRY = "https://registry.npmjs.org";

interface LatestOptions extends Partial<ShellOptions> {
  /** The npm registry; a spec points it somewhere unreachable. */
  registry?: string;
}

const BREW_MARKER = "__lanework_harness_brew__";

async function fromBrew(
  method: "brew-cask" | "brew-formula",
  realPath: string | null,
  installed: string | null,
  options: LatestOptions,
): Promise<string | null> {
  const name = brewNameOf(realPath);
  if (!name) return null;
  const cask = method === "brew-cask" ? " --cask" : "";
  // ⚠️ `brew` through the login shell: it is on the profile's PATH only. No
  // `brew` there → no marker → unknown, never an error. No auto-update:
  // `outdated` reads what brew already knows, it never refreshes taps.
  const { stdout } = await runInLoginShell(
    `command -v brew >/dev/null 2>&1 && printf '\\n%s\\n' '${BREW_MARKER}' && HOMEBREW_NO_AUTO_UPDATE=1 brew outdated --json=v2${cask} ${name} 2>/dev/null`,
    {
      shell: options.shell,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 20_000,
    },
  );
  const json = afterMarker(stdout, BREW_MARKER);
  return json === null
    ? null
    : parseBrewOutdated(
        json,
        method === "brew-cask" ? "cask" : "formula",
        name,
        installed,
      );
}

async function fromNpm(
  agent: HarnessAgent,
  options: LatestOptions,
): Promise<string | null> {
  const registry = (options.registry ?? NPM_REGISTRY).replace(/\/+$/, "");
  try {
    const response = await fetch(`${registry}/${NPM_PACKAGES[agent]}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown } | null;
    return cleanVersion(body?.version);
  } catch {
    return null;
  }
}

/**
 * The newest version this CLI's install method offers, or null when that is
 * not known — offline, no `brew`, a registry that answered nonsense, an
 * install the app cannot place. Never throws: an unknown latest only means no
 * island.
 *
 * ⚠️ Claude's native installer updates from the same releases npm publishes,
 * so `native` asks npm too.
 */
export async function latestVersion(
  agent: HarnessAgent,
  method: InstallMethod,
  realPath: string | null,
  installed: string | null,
  options: LatestOptions = {},
): Promise<string | null> {
  if (process.platform === "win32") return null;
  try {
    switch (method) {
      case "brew-cask":
      case "brew-formula":
        return await fromBrew(method, realPath, installed, options);
      case "native":
      case "npm":
        return await fromNpm(agent, options);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
