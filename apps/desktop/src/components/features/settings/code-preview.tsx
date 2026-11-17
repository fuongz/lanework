import { cn } from "#/lib/utils";

type Kind = "kw" | "id" | "type" | "prop" | "str" | "num" | "plain";

/** Tokens as a light and a dark syntax theme colour them. */
const TOKEN: Record<Kind, string> = {
  kw: "text-indigo-600 dark:text-indigo-400",
  id: "text-orange-700 dark:text-orange-300",
  type: "text-purple-600 dark:text-purple-400",
  prop: "text-amber-700 dark:text-amber-300",
  str: "text-green-700 dark:text-green-400",
  num: "text-blue-600 dark:text-blue-400",
  plain: "",
};

type Line = Array<[Kind, string]>;

const OPEN: Line = [
  ["kw", "function "],
  ["id", "ModelPanel"],
  ["plain", "() {"],
];
const CLOSE: Line = [["plain", "}"]];

// The picker's stars moving into preferences (FE-146), as a diff.
const BEFORE: Line[] = [
  OPEN,
  [
    ["plain", "  "],
    ["kw", "const "],
    ["plain", "["],
    ["prop", "favorites"],
    ["plain", "] = "],
    ["id", "useState"],
    ["plain", "("],
    ["prop", "readFavorites"],
    ["plain", ");"],
  ],
  [
    ["plain", "  "],
    ["kw", "const "],
    ["prop", "limit"],
    ["plain", " = "],
    ["num", "12"],
    ["plain", ";"],
  ],
  [
    ["plain", "  "],
    ["kw", "return "],
    ["str", '"favorites"'],
    ["plain", ";"],
  ],
  CLOSE,
];
const AFTER: Line[] = [
  OPEN,
  [
    ["plain", "  "],
    ["kw", "const "],
    ["prop", "favorites"],
    ["plain", " = "],
    ["id", "usePreferences"],
    ["plain", "(…);"],
  ],
  [
    ["plain", "  "],
    ["kw", "const "],
    ["prop", "limit"],
    ["plain", " = "],
    ["num", "24"],
    ["plain", ";"],
  ],
  [
    ["plain", "  "],
    ["kw", "return "],
    ["str", '"favourites"'],
    ["plain", ";"],
  ],
  CLOSE,
];

/** Lines 2–4 are the change, on both sides. */
const CHANGED = new Set([1, 2, 3]);

function Pane({ lines, side }: { lines: Line[]; side: "removed" | "added" }) {
  return (
    <div className="min-w-0 py-2">
      {lines.map((line, index) => {
        const changed = CHANGED.has(index);
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sample — the line number is its identity.
            key={index}
            className={cn(
              "flex border-l-[3px] border-transparent",
              changed &&
                (side === "removed"
                  ? "border-red-600 bg-red-500/10 dark:border-red-500 dark:bg-red-500/15"
                  : "border-emerald-600 bg-emerald-500/10 dark:border-emerald-500 dark:bg-emerald-500/15"),
            )}
          >
            <span className="text-muted-foreground w-10 shrink-0 pr-4 text-right tabular-nums select-none">
              {index + 1}
            </span>
            <span className="min-w-0 truncate whitespace-pre">
              {line.map(([kind, text], at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens of a fixed line never reorder.
                <span key={at} className={TOKEN[kind]}>
                  {text}
                </span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A two-sided diff, drawn in the code font as it is picked.
 *
 * Static markup, not `@pierre/diffs`. It is a sample of the same five lines
 * every time, and a highlighter with a shadow root would cost more than the
 * page it sits on.
 */
export function CodePreview() {
  return (
    <figure aria-label="Code font preview" className="m-0">
      {/* A plain box, not a card: it sits inside the Code font's row. */}
      <div className="border-border grid grid-cols-2 gap-3 overflow-hidden rounded-lg border font-mono text-[12.5px] leading-[1.7] [font-weight:var(--code-font-weight)]">
        <Pane lines={BEFORE} side="removed" />
        <Pane lines={AFTER} side="added" />
      </div>
    </figure>
  );
}
