import { Navigate } from "@tanstack/react-router";
import { MEMORY_INDEX } from "#/../shared/memory";
import { MemoryMessage } from "#/components/shared/memory/memory-message";
import { useSettingsProject } from "#/components/shared/settings/project-picker";
import { memoryEntry, useMemory } from "#/stores/memory";

/**
 * The Memory screen with no file open.
 *
 * Opens the index, which is where Claude starts too; without one, says what
 * to do.
 */
export function MemoryPick() {
  const slug = useSettingsProject();
  const list = useMemory((state) => (state.slug === slug ? state.list : null));
  if (memoryEntry(list, MEMORY_INDEX))
    return (
      <Navigate
        to="/settings/memory/$file"
        params={{ file: MEMORY_INDEX }}
        search={{ project: slug }}
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
