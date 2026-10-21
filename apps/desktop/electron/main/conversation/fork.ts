// Fork a Claude conversation into a new one (FE-62/D7).
//
// ⚠️ The CLI's `--fork-session` only forks while it SENDS a prompt; a fork
// from the chat's menu sends nothing. So the transcript is copied to a new
// UUID beside it with every line's `sessionId` rewritten — what the CLI's
// own fork writes — and a title saying it is a fork. Nothing here imports
// Electron.
import { randomUUID } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Line, lines, readRange, tidy } from "../terminal/agent-sessions";
import { transcriptPath } from "./transcript";

/** The largest transcript forked. */
const FORK_MAX = 256 * 1024 * 1024;

function firstPrompt(rows: Line[]): string | null {
  for (const line of rows) {
    if (line.type !== "user" || line.isMeta || line.isSidechain) continue;
    const content = (line.message as { content?: unknown } | undefined)
      ?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as { type?: unknown; text?: unknown }[]).find(
              (part) => part?.type === "text",
            )?.text
          : null;
    if (typeof text === "string" && text.trim() && !text.trim().startsWith("<"))
      return tidy(text);
  }
  return null;
}

export async function forkConversation(
  home: string,
  folder: string,
  id: string,
): Promise<string> {
  const file = transcriptPath(home, folder, id);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error("That conversation has no transcript.");
  if (info.size > FORK_MAX)
    throw new Error("That conversation is too long to fork.");
  const rows = lines(await readRange(file, 0, info.size), { head: true });
  const fork = randomUUID();
  const out: string[] = [];
  let title: string | null = null;
  for (const row of rows) {
    if (row.type === "ai-title" && typeof row.aiTitle === "string")
      title = row.aiTitle;
    out.push(
      JSON.stringify("sessionId" in row ? { ...row, sessionId: fork } : row),
    );
  }
  const name = title ? tidy(title) : firstPrompt(rows);
  if (name)
    out.push(
      JSON.stringify({
        type: "ai-title",
        aiTitle: `${name} (fork)`,
        sessionId: fork,
      }),
    );
  await writeFile(join(dirname(file), `${fork}.jsonl`), `${out.join("\n")}\n`, {
    flag: "wx",
  });
  return fork;
}
