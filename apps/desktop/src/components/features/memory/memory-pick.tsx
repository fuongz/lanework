import { Navigate, useParams } from "@tanstack/react-router";
import { MEMORY_INDEX } from "#/../shared/memory";
import { MemoryMessage } from "#/components/shared/memory/memory-message";
import { memoryEntry, useMemory } from "#/stores/memory";

/**
 * Memory with none open: the index, which is where Claude starts too — or,
 * without one, a word on what to do.
 */
export function MemoryPick() {
  const { slug } = useParams({ from: "/_app/w/$slug/memory/" });
  const list = useMemory((state) => (state.slug === slug ? state.list : null));
  if (memoryEntry(list, MEMORY_INDEX))
    return (
      <Navigate
        to="/w/$slug/memory/$file"
        params={{ slug, file: MEMORY_INDEX }}
        replace
      />
    );
  return (
    <MemoryMessage
      title="Pick a memory"
      description="Choose one on the left to read what Claude saved."
    />
  );
}
