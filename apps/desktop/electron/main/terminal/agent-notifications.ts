import type { TerminalAgent } from "../../../shared/terminal";
import { notify } from "../notifications";

/**
 * An agent's run finished (FE-70). A click opens its conversation; a tab
 * running it is where that chat sends the window anyway.
 *
 * `tab` is the Lanework tab running the conversation, if one is — on screen
 * that is the same conversation, so a focused window on it is not told.
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
