// Where OpenCode's background service is, for the chat (FE-104): the user's
// own `opencode` is asked, as Monocode's `opencodeService.ts` does.
//
// - `opencode --version` must say 2.0.15 or newer: the chat speaks OpenCode
//   v2's `/api/*` only.
// - `opencode service status` prints the service's URL when it runs; else
//   `opencode service start` starts it, and `status` is asked again.
// - `opencode service get password` is its Basic auth password.
//
// Nothing here imports Electron.
//
// NOTE: The binary runs directly with fixed arguments, never through a shell.
// Only a loopback URL is taken from its output: the password goes nowhere
// else.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import type { ClaudeCli } from "./claude-cli";
import type { OpenCodeService } from "./opencode-client";

/** The oldest OpenCode the chat runs on. */
const MINIMUM = [2, 0, 15] as const;

/** What the chat says when OpenCode is older than {@link MINIMUM}. */
export const OPENCODE_TOO_OLD =
  "Chat needs OpenCode 2.0.15 or newer. Update it in Settings › Harness.";

/** How long a found service is trusted before the CLI is asked again. */
const TTL_MS = 5 * 60_000;
/** How long one `opencode` command may take. */
const EXEC_MS = 30_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** `opencode v2.2.0` → [2, 2, 0]; null when no version is in it. */
export function parseOpenCodeVersion(
  output: string,
): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output.replace(ANSI, ""));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `version` is at least {@link MINIMUM}. */
export function isSupportedOpenCode(version: readonly number[]): boolean {
  for (let at = 0; at < MINIMUM.length; at++) {
    const have = version[at] ?? 0;
    const want = MINIMUM[at] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
}

/** The service's URL in `opencode service status`'s output: loopback only. */
export function parseServiceUrl(output: string): string | null {
  for (const line of output.replace(ANSI, "").split("\n")) {
    const match = /^(https?:\/\/(?:127\.0\.0\.1|localhost):\d+)\/?$/i.exec(
      line.trim(),
    );
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Run `opencode <args>`; answers stdout and stderr together. */
type Exec = (cli: ClaudeCli, args: readonly string[]) => Promise<string>;

const run: Exec = (cli, args) =>
  new Promise((resolve, reject) => {
    execFile(
      cli.file,
      [...args],
      {
        cwd: homedir(),
        env: cli.env,
        timeout: EXEC_MS,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const text = `${stdout}${stderr}`;
        if (error) {
          const said = text.replace(ANSI, "").trim().split("\n").at(-1);
          reject(
            new Error(
              said
                ? `OpenCode ${args.join(" ")} failed: ${said.slice(0, 300)}`
                : `OpenCode ${args.join(" ")} failed.`,
            ),
          );
          return;
        }
        resolve(text);
      },
    );
  });

/**
 * OpenCode's service, found once and kept a while.
 *
 * @param cli The `opencode` binary; throws when it is not installed.
 * @param exec A test seam.
 */
export function createOpenCodeService(
  cli: () => Promise<ClaudeCli>,
  exec: Exec = run,
) {
  let cached: { at: number; service: OpenCodeService } | null = null;
  let running: Promise<OpenCodeService> | null = null;

  async function find(): Promise<OpenCodeService> {
    const binary = await cli();
    const version = parseOpenCodeVersion(await exec(binary, ["--version"]));
    if (!version || !isSupportedOpenCode(version))
      throw new Error(OPENCODE_TOO_OLD);
    let url = parseServiceUrl(
      await exec(binary, ["service", "status"]).catch(() => ""),
    );
    if (!url) {
      url = parseServiceUrl(await exec(binary, ["service", "start"]));
      url ??= parseServiceUrl(await exec(binary, ["service", "status"]));
    }
    if (!url)
      throw new Error("OpenCode's background service did not say where it is.");
    const password = (await exec(binary, ["service", "get", "password"]))
      .replace(ANSI, "")
      .trim();
    if (!password || /\s/.test(password))
      throw new Error("OpenCode's background service has no password.");
    return { url, password };
  }

  return {
    /**
     * The service, from the cache unless `fresh`.
     *
     * @throws When OpenCode is missing, too old, or its service cannot start.
     */
    async service(fresh = false): Promise<OpenCodeService> {
      if (!fresh && cached && Date.now() - cached.at < TTL_MS)
        return cached.service;
      running ??= find().finally(() => {
        running = null;
      });
      const service = await running;
      cached = { at: Date.now(), service };
      return service;
    },
    /** Forget the service: it moved, restarted, or changed its password. */
    forget(): void {
      cached = null;
    },
  };
}

export type OpenCodeServices = ReturnType<typeof createOpenCodeService>;
