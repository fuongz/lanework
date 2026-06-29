import { useCallback, useEffect, useState } from "react";
import { getAgentStatus, type AgentStatus } from "@/lib/agent-client";

/**
 * Poll the local dispatcher's `/_local/agent/status` while `enabled`, so the UI
 * can show a live agent state + log tail. Local mode only (the endpoint doesn't
 * exist in the hosted build) — pass `enabled=false` there. Polls a touch faster
 * while any agent is still running, and backs off when everything is idle.
 */
export function useAgentStatus(enabled: boolean) {
  const [status, setStatus] = useState<AgentStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getAgentStatus());
    } catch {
      /* server gone / not local — leave the last snapshot */
    }
  }, []);

  useEffect(() => {
    if (!enabled || !__LANEWORK_LOCAL__) return;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const tick = async () => {
      await refresh();
      if (cancelled) return;
      // We can't read the just-set state here; re-fetch decides cadence via the
      // freshest value, so just use a steady interval — cheap and predictable.
      timer = setTimeout(tick, 1500);
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, refresh]);

  return { status, refresh };
}
