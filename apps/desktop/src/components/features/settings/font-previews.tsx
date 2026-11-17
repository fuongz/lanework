import type { ReactNode } from "react";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import { chatLink } from "#/components/shared/conversation/turn-view.link-chip";

/** The box each font's sample sits in, under its row. */
const BOX =
  "border-border rounded-lg border px-4 py-3 text-[14px] leading-relaxed";

/**
 * The interface font, as an agent's reply reads in it: files, a colour and
 * a link drawn by the chat's own markdown, so the chips are the app's
 * (FE-145). The reply's font is pinned to the UI font here, whatever the
 * content font is.
 */
export function UiFontPreview() {
  return (
    <figure
      aria-label="Interface font preview"
      className={`${BOX} m-0 [--content-font-weight:var(--ui-font-weight)] [--content-font:var(--ui-font)]`}
    >
      <MarkdownBody
        variant="chat"
        link={chatLink}
        source="Updated `appearance-section.tsx` and added `theme-toggle.tsx`. The accent is now `#2563eb`, and the notes are on https://lanework.dev."
      />
    </figure>
  );
}

/** The content font: a card's title, a line and its checklist. */
export function ContentFontPreview() {
  return (
    <figure
      aria-label="Content font preview"
      className={`${BOX} font-content m-0 flex flex-col gap-1.5 [font-weight:var(--content-font-weight)]`}
    >
      <span className="text-[15px] font-semibold">
        Each harness owns its models
      </span>
      <span className="text-muted-foreground">
        Settings lists a CLI's models on its own page: star one to put it first
        in the picker, drag it to set the order.
      </span>
      <ul className="m-0 list-disc pl-5">
        <li>The picker follows the stars and the order.</li>
        <li>A hidden model keeps running the chats already on it.</li>
      </ul>
    </figure>
  );
}

type Tone = "host" | "path" | "branch" | "dirty" | "dim" | "green" | "plain";
const TONE: Record<Tone, string> = {
  host: "font-bold text-emerald-600 dark:text-emerald-400",
  path: "text-sky-700 dark:text-sky-300",
  branch: "text-emerald-700 dark:text-emerald-300",
  dirty: "text-rose-600 dark:text-rose-400",
  dim: "text-muted-foreground",
  green: "text-emerald-700 dark:text-emerald-300",
  plain: "",
};

/** One line: its spans, and a size pushed to the right edge. */
type TerminalLine = { spans: Array<[Tone, string]>; size?: string };

const TERMINAL: TerminalLine[] = [
  {
    spans: [
      ["host", "you@macbook"],
      ["plain", ":"],
      ["path", "~/projects/lanework"],
    ],
  },
  {
    spans: [
      ["branch", "main "],
      ["dirty", "× "],
      ["plain", "$ bun run gate"],
    ],
  },
  { spans: [["dim", "$ bun run --cwd apps/desktop build"]] },
  {
    spans: [
      ["green", "vite v8.2.2 building client environment for production..."],
    ],
  },
  { spans: [["green", "✓ 8312 modules transformed."]] },
  { spans: [["plain", "computing gzip size..."]] },
  {
    spans: [
      ["dim", "dist/client/assets/"],
      ["green", "inter-latin-wght-normal.woff2"],
    ],
    size: "48.25 kB",
  },
  {
    spans: [
      ["dim", "dist/client/assets/"],
      ["green", "index-CBcvBZtf.js"],
    ],
    size: "1,204.11 kB",
  },
];

/**
 * The terminal, in the code font, as a shell prompt and a build read in it:
 * the prompt's host and folder, the branch, the commands run, the output and
 * its sizes on the right.
 */
export function TerminalPreview(): ReactNode {
  return (
    <figure
      aria-label="Terminal preview"
      className="border-border m-0 overflow-hidden rounded-lg border bg-black/[0.03] px-4 py-3 font-mono text-[12.5px] leading-[1.6] [font-weight:var(--code-font-weight)] dark:bg-black/40"
    >
      {TERMINAL.map((line, at) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sample.
          key={at}
          className="flex min-w-0 gap-6 whitespace-pre"
        >
          <span className="min-w-0 flex-1 truncate">
            {line.spans.map(([tone, text], index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens never reorder.
              <span key={index} className={TONE[tone]}>
                {text}
              </span>
            ))}
          </span>
          {line.size && (
            <span className="text-muted-foreground shrink-0 font-bold tabular-nums">
              {line.size}
            </span>
          )}
        </div>
      ))}
    </figure>
  );
}
