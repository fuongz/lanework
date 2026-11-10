// Claude's models as the user's own `claude` lists them (FE-135): the
// `models` of its stream-json `initialize` answer, which names each one's
// effort levels and fast mode too. Asked of a CLI started for nothing else
// (no MCP servers, no session saved) and stopped once it answers; no model
// is called.
//
// The answer is kept in a file, keyed by the binary's real path (each
// version installs to a folder of its own) and read again a day later. Until
// a first answer, and whenever asking fails, the picker keeps the list fixed
// in code (`CLAUDE_MODELS`).
//
// NOTE: Ids are checked against `CLAUDE_MODEL_ID` before they may become
// `--model`'s value: the cache is a file anyone could write.
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import {
  type AgentModel,
  CLAUDE_MODEL_ID,
  EFFORTS,
  type Effort,
} from "../../../shared/conversation";
import type { ClaudeCli } from "./claude-cli";

/** How long an answer is trusted when the binary has not changed. */
const FRESH_MS = 24 * 60 * 60_000;
/** How long the CLI may take to answer `initialize`. */
const ASK_MS = 20_000;
/** The most of its output read: the answer is a few tens of kilobytes. */
const OUTPUT_MAX = 4 * 1024 * 1024;

interface CacheFile {
  /** The binary's real path when it answered. */
  binary: string;
  at: number;
  models: AgentModel[];
}

/** One entry of the CLI's `models`, as far as it is used. */
interface ListedModel {
  value?: unknown;
  resolvedModel?: unknown;
  displayName?: unknown;
  supportsEffort?: unknown;
  supportedEffortLevels?: unknown;
  supportsFastMode?: unknown;
}

/**
 * The CLI's `models` as the picker's.
 *
 * - The id is the model it resolves to, so a stored choice stays one model.
 * - An alias (`opus`, `fable`) is the current generation; a model listed by
 *   its full id is an older one, under the divider.
 * - `default` is not a model of its own: it marks the one it resolves to.
 * - Effort levels are the CLI's, in its order; none when it takes none.
 *
 * @returns null when no entry is usable.
 */
export function claudeModelsOf(value: unknown): AgentModel[] | null {
  if (!Array.isArray(value)) return null;
  const list = value as ListedModel[];
  const resolved = (entry: ListedModel) =>
    typeof entry?.resolvedModel === "string" && entry.resolvedModel
      ? entry.resolvedModel
      : typeof entry?.value === "string"
        ? entry.value
        : null;
  const preferred = resolved(
    list.find((entry) => entry?.value === "default") ?? {},
  );
  const out: AgentModel[] = [];
  for (const entry of list) {
    if (!entry || entry.value === "default") continue;
    const id = resolved(entry);
    if (!id || !CLAUDE_MODEL_ID.test(id) || out.some((m) => m.id === id))
      continue;
    const label =
      typeof entry.displayName === "string" && entry.displayName.trim()
        ? entry.displayName.trim().slice(0, 60)
        : id;
    const efforts =
      entry.supportsEffort === true &&
      Array.isArray(entry.supportedEffortLevels)
        ? EFFORTS.filter((level: Effort) =>
            (entry.supportedEffortLevels as unknown[]).includes(level),
          )
        : [];
    out.push({
      id,
      label,
      agent: "claude",
      ...(entry.value === id ? { legacy: true } : {}),
      ...(id === preferred ? { preferred: true } : {}),
      efforts,
      fast: entry.supportsFastMode === true,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Ask `cli` for its models over stream-json, in an empty folder.
 *
 * @throws When it does not answer within {@link ASK_MS}, or answers no
 *   usable list.
 */
function askCli(cli: ClaudeCli): Promise<AgentModel[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      cli.file,
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--strict-mcp-config",
      ],
      { cwd: tmpdir(), env: cli.env, stdio: ["pipe", "pipe", "ignore"] },
    );
    let out = "";
    let done = false;
    const finish = (result: AgentModel[] | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error("Claude did not list its models in time")),
      ASK_MS,
    );
    child.once("error", (error) => finish(error));
    child.once("close", () =>
      finish(new Error("Claude stopped before listing its models")),
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (out.length > OUTPUT_MAX)
        return finish(new Error("Claude's answer was too long"));
      let at = out.indexOf("\n");
      while (at !== -1) {
        const line = out.slice(0, at);
        out = out.slice(at + 1);
        at = out.indexOf("\n");
        if (!line.includes('"control_response"')) continue;
        try {
          const response = JSON.parse(line)?.response;
          if (response?.request_id !== "models") continue;
          const models = claudeModelsOf(response?.response?.models);
          finish(models ?? new Error("Claude listed no usable model"));
        } catch {
          // Not this line.
        }
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.write(
      `${JSON.stringify({
        type: "control_request",
        request_id: "models",
        request: { subtype: "initialize" },
      })}\n`,
    );
  });
}

/** The cache file's answer, every entry checked again; null when none. */
function cachedOf(value: unknown): CacheFile | null {
  const file = value as Partial<CacheFile> | null;
  if (!file || typeof file.binary !== "string" || typeof file.at !== "number")
    return null;
  if (!Array.isArray(file.models)) return null;
  // Every entry checked again, as one from the CLI is.
  const models: AgentModel[] = [];
  for (const entry of file.models as Partial<AgentModel>[]) {
    const id = entry?.id;
    if (
      typeof id !== "string" ||
      !CLAUDE_MODEL_ID.test(id) ||
      models.some((m) => m.id === id)
    )
      continue;
    const label =
      typeof entry.label === "string" && entry.label.trim()
        ? entry.label.trim().slice(0, 60)
        : id;
    const levels: unknown[] = Array.isArray(entry.efforts) ? entry.efforts : [];
    models.push({
      id,
      label,
      agent: "claude",
      ...(entry.legacy === true ? { legacy: true } : {}),
      ...(entry.preferred === true ? { preferred: true } : {}),
      efforts: EFFORTS.filter((level) => levels.includes(level)),
      fast: entry.fast === true,
    });
  }
  return models.length > 0
    ? { binary: file.binary, at: file.at, models }
    : null;
}

/**
 * Claude's model list: the cached answer at once, asked again of the CLI
 * when its binary changed or the answer is a day old.
 *
 * `read()` never waits on the CLI: it hands what is known (null before any
 * answer) and starts one ask in the background; `onChange` hears of a new
 * list. `known()` reads the cache file only, for startup.
 */
export function createClaudeModels({
  file,
  cli,
  onChange,
}: {
  /** Where the answer is kept. */
  file: string;
  cli: () => Promise<ClaudeCli>;
  onChange: (models: AgentModel[]) => void;
}) {
  let current: CacheFile | null = null;
  let asking: Promise<void> | null = null;

  const known = async (): Promise<AgentModel[] | null> => {
    if (!current) {
      const raw = await readFile(file, "utf8").catch(() => null);
      try {
        current = raw ? cachedOf(JSON.parse(raw)) : null;
      } catch {
        current = null;
      }
    }
    return current?.models ?? null;
  };

  const refresh = async (): Promise<void> => {
    const found = await cli();
    const binary = await realpath(found.file).catch(() => found.file);
    if (current?.binary === binary && Date.now() - current.at < FRESH_MS)
      return;
    const models = await askCli(found);
    const changed =
      JSON.stringify(models) !== JSON.stringify(current?.models ?? null);
    current = { binary, at: Date.now(), models };
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(current), "utf8");
    if (changed) onChange(models);
  };

  return {
    known,
    /** What is known now; asks the CLI again in the background if due. */
    async read(): Promise<AgentModel[] | null> {
      const models = await known();
      if (!asking)
        asking = refresh()
          .catch((error: unknown) =>
            console.warn("Unable to read Claude's models", error),
          )
          .finally(() => {
            asking = null;
          });
      return models;
    },
  };
}
