import { SettingsCard } from "#/components/shared/settings/settings-page";
import { cn } from "#/lib/utils";

/**
 * A two-sided diff, drawn in the code font as it is picked (FE-21).
 *
 * ⚠️ Static markup, not `@pierre/diffs`. It is a sample the reader looks at
 * while choosing — the same five lines every time — and mounting a highlighter
 * and a shadow root to draw them would cost more than the page it sits on.
 */

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
  ["kw", "const "],
  ["id", "themePreview"],
  ["plain", ": "],
  ["type", "ThemeConfig"],
  ["plain", " = {"],
];
const CLOSE: Line = [["plain", "};"]];

const field = (name: string, value: Line[number]): Line => [
  ["plain", "  "],
  ["prop", name],
  ["plain", ": "],
  value,
  ["plain", ","],
];

const BEFORE: Line[] = [
  OPEN,
  field("surface", ["str", '"sidebar"']),
  field("accent", ["str", '"#2563eb"']),
  field("contrast", ["num", "42"]),
  CLOSE,
];
const AFTER: Line[] = [
  OPEN,
  field("surface", ["str", '"sidebar-elevated"']),
  field("accent", ["str", '"#0ea5e9"']),
  field("contrast", ["num", "68"]),
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

export function CodePreview() {
  return (
    <figure aria-label="Code font preview" className="m-0">
      <SettingsCard className="font-mono grid grid-cols-2 gap-3 overflow-hidden text-[12.5px] leading-[1.7] divide-y-0 [font-weight:var(--code-font-weight)]">
        <Pane lines={BEFORE} side="removed" />
        <Pane lines={AFTER} side="added" />
      </SettingsCard>
    </figure>
  );
}
