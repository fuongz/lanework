import type { TerminalAgent } from "../../../shared/terminal";
import { notify } from "../notifications";

/**
 * Tell the user an agent's run finished.
 *
 * A click opens its conversation; a tab running it is where that chat sends
 * the window anyway.
 *
 * @param tab The Lanework tab running the conversation, if one is. On screen
 *   it is the same conversation, so a focused window on it is not told.
 */
export function notifyAgentCompleted(
  agent: TerminalAgent,
  project: { slug: string; name: string },
  conversation: string,
  tab: string | null,
): void {
  void notify({
    kind: "sessions",
    title: `${agent === "claude" ? "Claude" : "Codex"} finished`,
    body: `Run completed in ${project.name}.`,
    target: { kind: "session", slug: project.slug, conversation },
    onScreen: tab
      ? [`/w/${encodeURIComponent(project.slug)}/agents/${tab}`]
      : [],
  });
}
