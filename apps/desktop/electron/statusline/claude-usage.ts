import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { claudeQuotaOf } from "../main/terminal/claude-usage";

/** A process-only statusLine wrapper. Original stdin/stdout remain unchanged. */
async function main() {
  const [file, original] = process.argv.slice(2);
  if (!file) return;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) return;
    chunks.push(Buffer.from(chunk));
  }
  const input = Buffer.concat(chunks);
  try {
    const quota = claudeQuotaOf(JSON.parse(input.toString("utf8")));
    if (quota) {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(quota), { mode: 0o600 });
      await rename(temporary, file);
    }
  } catch {
    /* Bad/missing rate_limits or unavailable cache never breaks Claude. */
  }
  if (original) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn("/bin/sh", ["-c", original], {
      env,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("close", () => clearTimeout(timer));
    child.once("error", () => clearTimeout(timer));
  }
}
void main().catch(() => {});
