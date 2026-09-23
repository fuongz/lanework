/**
 * Unwrap what Electron does to a main-process throw.
 *
 * `ipcRenderer.invoke` rejects with `Error invoking remote method 'x': Error:
 * <the real message>`. Main writes messages meant to be read by a person, and
 * that prefix is the one part of them nobody should ever see.
 *
 * ⚠️ The class name is stripped too, not just the literal word `Error`. Main
 * throws `GitHubError` on every GitHub path, and Electron serialises the class
 * name into the string — so the sentence reaching the screen read
 * `GitHubError: This connection is not allowed…`. One subclass was enough to
 * put a type name in front of a message written for a person.
 */
export function ipcMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  return raw.replace(
    /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/,
    "",
  );
}
