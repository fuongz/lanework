/**
 * Reads `?file=<id>` on Settings › Config files and Settings › Skills.
 *
 * The open file, by the id main handed out with the list — never a path.
 */
export function fileSearch(search: Record<string, unknown>): { file?: string } {
  return typeof search.file === "string" && search.file.length <= 300
    ? { file: search.file }
    : {};
}
