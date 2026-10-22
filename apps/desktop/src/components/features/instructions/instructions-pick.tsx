import { Navigate } from "@tanstack/react-router";
import { useSettingsProject } from "#/components/shared/settings/project-picker";

/**
 * Instructions with nothing open: everything Claude reads, in order, which
 * is also where a conversation starts (FE-37/D4).
 */
export function InstructionsPick() {
  const slug = useSettingsProject();
  return (
    <Navigate
      to="/settings/instructions/effective/$agent"
      params={{ agent: "claude" }}
      search={{ project: slug }}
      replace
    />
  );
}
