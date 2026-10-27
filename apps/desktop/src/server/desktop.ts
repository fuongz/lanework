import type { DesktopApi } from "../../shared/desktop";

// The renderer's one way into main: the preload's `window.desktop`.
//
// NOTE: The boundary in this app is IPC, not a server function. Main exposes
// one object per domain on `window.desktop`, and this file is the seam in
// front of it. A renamed surface in `shared/desktop.ts` is fixed here, and a
// dev or test fake has one place to go.

/** The domains on `window.desktop`: every member that is an object, not a call. */
export type DesktopSurfaceKey = {
  [K in keyof DesktopApi]-?: NonNullable<DesktopApi[K]> extends (
    ...args: never[]
  ) => unknown
    ? never
    : K;
}[keyof DesktopApi];

/**
 * One of main's surfaces, or undefined in a window with no preload (a plain
 * browser tab, a test page).
 */
export function findDesktopSurface<K extends DesktopSurfaceKey>(
  key: K,
): DesktopApi[K] | undefined {
  return window.desktop?.[key];
}

/**
 * One of main's surfaces.
 *
 * @throws when this window has no preload, with the sentence a store shows as
 *   its error.
 */
export function desktopSurface<K extends DesktopSurfaceKey>(
  key: K,
): NonNullable<DesktopApi[K]> {
  const surface = findDesktopSurface(key);
  if (!surface)
    throw new Error("This window is not connected to the desktop app.");
  return surface;
}
