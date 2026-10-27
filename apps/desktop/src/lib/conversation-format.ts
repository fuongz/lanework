import type { ToolCall, ToolKind, Turn } from "#/../shared/conversation";

/** `68`, `25.3k`, `2.9m` — a token count as the Usage tooltip says it (D7). */
export function compact(value: number): string {
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, "");
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${trim(value / 1000)}k`;
  return `${trim(value / 1_000_000)}m`;
}

/** `9:32` — when a message was written, in the person's own clock. */
export function clock(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The first non-empty line of `text`, without markdown's leading marks. */
export function firstLine(text: string): string {
  return textLines(text, 1)[0] ?? "";
}

/** Up to `max` of `text`'s lines, as `firstLine` cleans one. */
export function textLines(text: string, max: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/, "")
      .replace(/[*`]/g, "")
      .trim();
    if (line) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/** The text of an assistant turn, its text blocks joined: what Copy copies. */
export function turnText(turn: Turn): string {
  if (turn.role === "user") return turn.text;
  return turn.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

/** The last segment of a path: `links.mjs`. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

const IMAGE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif|heic)$/i;

export function isImagePath(path: string | null): boolean {
  return !!path && IMAGE.test(path);
}

/**
 * Saves `text` as a `.md` file through the browser's own download — no IPC,
 * no folder named by the page (D7).
 */
export function downloadMarkdown(text: string, name: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name.endsWith(".md") ? name : `${name}.md`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name from the first words of `text`: `fix-the-login-form.md`. */
export function fileNameFor(text: string, fallback: string): string {
  const slug = firstLine(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `${slug || fallback}.md`;
}

const plural = (n: number, one: string, many: string) =>
  n === 1 ? one : `${n} ${many}`;

/**
 * A folded group's title (D6): `Edited links.mjs, ran 3 commands, read 3
 * files`, its kinds in the order they were first called. A sentence, not a
 * list joined by "·".
 */
export function groupTitle(calls: ToolCall[]): string {
  const byKind = new Map<ToolKind, ToolCall[]>();
  for (const call of calls) {
    const list = byKind.get(call.kind);
    if (list) list.push(call);
    else byKind.set(call.kind, [call]);
  }
  const parts: string[] = [];
  for (const [kind, list] of byKind) {
    const n = list.length;
    const files = new Set(
      list.map((call) => call.filePath).filter((path) => path !== null),
    );
    const only = files.size === 1 ? baseName([...files][0] ?? "") : null;
    switch (kind) {
      case "edit":
        parts.push(only ? `Edited ${only}` : `Edited ${files.size || n} files`);
        break;
      case "command":
        parts.push(`Ran ${plural(n, "a command", "commands")}`);
        break;
      case "read":
        parts.push(only ? `Read ${only}` : `Read ${files.size || n} files`);
        break;
      case "search":
        parts.push(`Searched ${plural(n, "once", "times")}`);
        break;
      case "fetch":
        parts.push(`Fetched ${plural(n, "a page", "pages")}`);
        break;
      case "agent":
        parts.push(`Ran ${plural(n, "a sub-agent", "sub-agents")}`);
        break;
      case "mcp":
        parts.push(
          n === 1
            ? `Called ${mcpName(list[0]?.tool ?? "")}`
            : `Called ${n} MCP tools`,
        );
        break;
      default:
        parts.push(
          n === 1 ? `Used ${list[0]?.tool ?? "a tool"}` : `Used ${n} tools`,
        );
    }
  }
  return parts
    .map((part, index) =>
      index === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1),
    )
    .join(", ");
}

/** `mcp__lanework__get_review` → `get_review`. */
export function mcpName(tool: string): string {
  const parts = tool.split("__");
  return parts.length >= 3 ? parts.slice(2).join("__") : tool;
}
