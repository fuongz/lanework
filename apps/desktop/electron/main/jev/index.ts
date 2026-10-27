import { randomUUID } from "node:crypto";
import type {
  JevConfig,
  JevMainHandlers,
  JevState,
  JudgeLogEntry,
  JudgeRequest,
  JudgeResult,
} from "../../../shared/orchestration";
import { jevChannels } from "../../../shared/orchestration";
import { broadcast } from "../ipc";
import { JudgeError, judgeFor } from "./judge";
import {
  appendLog,
  hasKey,
  keyCarriesOver,
  readConfig,
  readKey,
  readLog,
  settleLog,
  writeConfig,
  writeKey,
} from "./store";

// Jev in main (FE-87, W3): the config and key, the one `ask` every caller
// goes through, and the shadow log.
//
// `ask` never throws. A provider that fails or times out answers
// `source: "error"`, which callers treat like an unsure answer: the lead
// decides. Every answer, of every source, is logged, so `settle` can record
// what was done in the end and Settings can compare Jev with the lead.
//
// NOTE: The API key lives in `store.ts` and is read per call. It is never
// broadcast, returned, logged, or put in any process's env.

async function state(): Promise<JevState> {
  const config = await readConfig();
  return { config, hasKey: await hasKey(config) };
}

async function changed(): Promise<JevState> {
  const next = await state();
  broadcast(jevChannels.changed, next);
  return next;
}

/**
 * Whether the caller may act: enforce mode, a real answer, and `p` at or
 * above the point's threshold. Shadow never acts.
 */
function isDecided(
  config: JevConfig,
  request: JudgeRequest,
  source: JudgeResult["source"],
  p: number,
): boolean {
  const point = config.points[request.point];
  return source === "judge" && point.mode === "enforce" && p >= point.threshold;
}

async function ask(request: JudgeRequest): Promise<JudgeResult> {
  const config = await readConfig();
  const mode = config.points[request.point].mode;
  let choice: string | null = null;
  let p = 0;
  let source: JudgeResult["source"] = "off";
  let error: string | null = null;

  if (config.provider) {
    try {
      const judge = judgeFor({
        provider: config.provider,
        endpoint: config.endpoint,
        model: config.model,
        key: await readKey(config),
      });
      const answer = await judge.ask(
        request.question,
        request.options,
        request.context,
      );
      if (!request.options.includes(answer.choice))
        throw new JudgeError("The judge answered outside the options.");
      choice = answer.choice;
      p = answer.p;
      source = "judge";
    } catch (failure) {
      source = "error";
      error =
        failure instanceof JudgeError
          ? failure.message
          : "The judge failed unexpectedly.";
    }
  }

  const decided = isDecided(config, request, source, p);
  const entry: JudgeLogEntry = {
    id: randomUUID(),
    at: Date.now(),
    point: request.point,
    question: request.question,
    options: request.options,
    choice,
    p,
    mode,
    decided,
    // Jev's own choice is the outcome when it acted; otherwise the lead's,
    // recorded later through `settle`.
    outcome: decided ? choice : null,
  };
  // A log that cannot be written must not cost the caller its answer.
  await appendLog(entry).catch(() => {});
  return {
    point: request.point,
    choice,
    p,
    mode,
    decided,
    source,
    error,
    logId: entry.id,
  };
}

export const jevMain: JevMainHandlers = {
  get: state,
  set: async (config) => {
    // Another provider or endpoint origin: the key was not typed for it
    // (FE-89/D10). Forget it before the new config can be read.
    if (!keyCarriesOver(await readConfig(), config))
      await writeKey(null, config);
    await writeConfig(config);
    return changed();
  },
  setKey: async (key) => {
    await writeKey(key, await readConfig());
    return changed();
  },
  ask,
  log: readLog,
  settle: async (logId, outcome) => {
    await settleLog(logId, outcome).catch(() => {});
  },
};
