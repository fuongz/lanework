// The CLI versions the last probe found, for the code that turns off what an
// older CLI lacks (FE-168/D2). Nothing here imports Electron, so the engines
// (and their specs) may read it.
import { belowMinimum, type HarnessAgent } from "../../../shared/harness";

const versions = new Map<HarnessAgent, string | null>();

/** What the harness probe found for `agent`; null when it could not tell. */
export function noteVersion(agent: HarnessAgent, version: string | null): void {
  versions.set(agent, version);
}

/**
 * Whether `agent`'s CLI is older than Lanework's floor, as the last probe
 * found it. False before a probe answered, or when its version could not
 * be read (D4): that is no reason to turn anything off.
 */
export function belowMinimumNow(agent: HarnessAgent): boolean {
  return belowMinimum(agent, versions.get(agent) ?? null);
}
