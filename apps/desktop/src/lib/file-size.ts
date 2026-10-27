// A file's size as a person reads it.

const UNITS = ["KB", "MB", "GB", "TB"];

/**
 * `512 B`, `2.3 KB`, `5.1 MB`: one decimal everywhere.
 *
 * NOTE: One formatter for every screen. An attachment and a file used to
 * round the same size differently ("5.11 MB" beside "5.1 MB").
 */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}
