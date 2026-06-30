import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";

/**
 * Local-mode live reload: subscribe to the launcher's `/_local/events` SSE
 * stream and re-run route loaders whenever a `.agents/reviews` file changes, so
 * the board updates as your agent writes review files. No-op (and fully
 * dead-code-eliminated) in the Cloudflare build, where `__LANEWORK_LOCAL__` is
 * statically false and there is no watcher.
 */
export function useLocalLiveReload() {
  const router = useRouter();
  useEffect(() => {
    if (!__LANEWORK_LOCAL__ || typeof window === "undefined") return;
    const es = new EventSource("/_local/events");
    let timer: ReturnType<typeof setTimeout>;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.invalidate(), 100); // coalesce bursts
    };
    es.addEventListener("change", onChange);
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [router]);
}

/**
 * Local-mode live "tick": a counter that increments whenever a `.agents/reviews`
 * file changes (same SSE stream as the reload hook). Components key effects on it
 * to re-read state that route invalidation doesn't refresh — e.g. the review
 * dialog re-fetching its open card's body so an agent run's telemetry shows up
 * without reopening. Stays at 0 (and is dead-code-eliminated) in the cloud build.
 */
export function useLocalLiveTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!__LANEWORK_LOCAL__ || typeof window === "undefined") return;
    const es = new EventSource("/_local/events");
    let timer: ReturnType<typeof setTimeout>;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setTick((t) => t + 1), 100); // coalesce bursts
    };
    es.addEventListener("change", onChange);
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, []);
  return tick;
}
