import { useEffect } from "react";
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
