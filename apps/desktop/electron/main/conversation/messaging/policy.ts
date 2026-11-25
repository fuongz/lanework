// Who may message whom, and how often (PD-06/D2, D4). Nothing here imports
// Electron: the question to the user and the file are main's (deps).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Endpoint } from "./gateway";
import { MessagingError } from "./gateway";

/** The most messages one pair exchanges in an hour, one way (D4). */
export const MESSAGES_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;

/** The user's answer to the first message of a pair (D2). */
export type Consent = "once" | "always" | "deny";

export interface MessagingPolicyDeps {
  /** Where the pairs the user always allows are kept. */
  file: string;
  /** Ask the user about the first message from `from` to `to`. */
  ask: (from: Endpoint, to: Endpoint, preview: string) => Promise<Consent>;
  now?: () => number;
}

/** A pair's key, one way: the heads, which outlive a switch of agent. */
const pairOf = (from: Endpoint, to: Endpoint) =>
  `${from.project}\0${from.head}\0${to.head}`;

export function createMessagingPolicy(deps: MessagingPolicyDeps) {
  const now = deps.now ?? Date.now;
  let allowed: Set<string> | null = null;
  const sent = new Map<string, number[]>();
  /** One question per pair at a time: a second message waits on it. */
  const asking = new Map<string, Promise<Consent>>();

  async function load(): Promise<Set<string>> {
    if (allowed) return allowed;
    try {
      const value = JSON.parse(await readFile(deps.file, "utf8")) as {
        pairs?: unknown;
      };
      allowed = new Set(
        Array.isArray(value.pairs)
          ? value.pairs.filter(
              (pair): pair is string => typeof pair === "string",
            )
          : [],
      );
    } catch {
      allowed = new Set();
    }
    return allowed;
  }

  async function save(pairs: Set<string>): Promise<void> {
    await mkdir(dirname(deps.file), { recursive: true });
    const temp = `${deps.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ v: 1, pairs: [...pairs] }));
    await rename(temp, deps.file);
  }

  return {
    /**
     * Let the message through, or refuse it: over the hourly limit (D4), or
     * the user did not allow the pair (D2, asked on its first message).
     *
     * @throws {MessagingError} With what the sender is told.
     */
    async admit(from: Endpoint, to: Endpoint, preview: string): Promise<void> {
      const key = pairOf(from, to);
      const recent = (sent.get(key) ?? []).filter((at) => now() - at < HOUR_MS);
      if (recent.length >= MESSAGES_PER_HOUR)
        throw new MessagingError(
          `${MESSAGES_PER_HOUR} messages to ${to.name} in the last hour already: wait, or ask the user.`,
        );
      const pairs = await load();
      if (!pairs.has(key)) {
        let answer = asking.get(key);
        if (!answer) {
          answer = deps.ask(from, to, preview);
          asking.set(key, answer);
          void answer.finally(() => asking.delete(key)).catch(() => {});
        }
        const consent = await answer;
        if (consent === "deny")
          throw new MessagingError(
            `The user did not allow ${from.name} to message ${to.name}.`,
          );
        if (consent === "always" && !pairs.has(key)) {
          pairs.add(key);
          await save(pairs).catch(() => {});
        }
      }
      recent.push(now());
      sent.set(key, recent);
    },
  };
}
