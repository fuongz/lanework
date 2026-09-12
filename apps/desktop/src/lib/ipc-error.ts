/**
 * Unwrap what Electron does to a main-process throw.
 *
 * `ipcRenderer.invoke` rejects with `Error invoking remote method 'x': Error:
 * <the real message>`. Main writes messages meant to be read by a person, and
 * that prefix is the one part of them nobody should ever see.
 */
export function ipcMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  return raw.replace(
    /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,
    "",
  );
}
