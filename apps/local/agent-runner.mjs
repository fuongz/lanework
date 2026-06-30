// Agent dispatcher for the local board (Phase 1).
//
// Spawns a headless Claude Code agent to work on one review card, in its own git
// worktree/branch so parallel agents never collide. The agent edits code in the
// worktree (its cwd) but its lanework MCP server points at the MAIN checkout, so
// its `toggle_item` / `set_status` calls land in the `.agents/reviews/` the board
// is watching — the work happens in the worktree, the status shows on the board.
//
// State lives in an in-memory registry keyed by the card's repo-relative path.
// server.mjs is a single long-lived process, so a Map is sufficient — no DB.
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const execFileP = promisify(execFile);

// The fs data layer (bundled from packages/shared/src/lib/local-fs.ts), same
// module the MCP server uses — gives us the lifecycle helpers + the project root.
const libUrl = new URL("./dist-local/reviews-lib.mjs", import.meta.url).href;
const { getLocalCardContent, localRoot, getCostEstimateForDir, recordAgentRun } = await import(libUrl);

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));

// ── Config (all overridable via env) ─────────────────────────────────────────
const MAX_CONCURRENT = Number(process.env.LANEWORK_AGENT_MAX) || 4;
const MAX_TURNS = Number(process.env.LANEWORK_AGENT_MAX_TURNS) || 40;
const TIMEOUT_MS = Number(process.env.LANEWORK_AGENT_TIMEOUT_MS) || 20 * 60 * 1000;
// bypassPermissions: the agent runs unattended in an isolated worktree, so it
// must never block on a permission prompt. Override to `acceptEdits` for a
// stricter posture (it will then stall on shell commands outside the safe set).
const PERMISSION_MODE = process.env.LANEWORK_AGENT_PERMISSION_MODE || "bypassPermissions";
const AGENT_BIN = process.env.LANEWORK_AGENT_BIN || "claude";
const LOG_TAIL = 200; // ring-buffer size for the status endpoint

/** path → { state, pid, branch, worktree, startedAt, endedAt, exitCode, log } */
const registry = new Map();

function log(...args) {
  console.error("[lanework-agent]", ...args);
}

function isReviewPath(p) {
  return typeof p === "string" && p.startsWith(".agents/reviews/") && p.endsWith(".md") && !p.includes("..");
}

/** Stable, filesystem-safe id for a card path: drop the prefix, kebab the rest. */
function slugFor(repoPath) {
  return repoPath
    .slice(".agents/reviews/".length)
    .replace(/\.md$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function activeCount() {
  let n = 0;
  for (const e of registry.values()) if (e.state === "running") n++;
  return n;
}

/**
 * Public snapshot of the registry for GET /_local/agent/status. Per agent we also
 * price its run by reading the worktree's Claude Code transcript (best-effort — the
 * client turns the token counts into a cost estimate). Async because of that read.
 */
export async function agentStatus() {
  const agents = {};
  for (const [path, e] of registry) {
    let usage = null;
    try {
      const cost = await getCostEstimateForDir(e.worktree);
      if (cost.available && cost.models.length) usage = cost.models;
    } catch {
      /* no transcript yet / unreadable — leave usage null */
    }
    agents[path] = {
      state: e.state,
      mode: e.mode,
      branch: e.branch,
      worktree: e.worktree,
      pid: e.pid ?? null,
      startedAt: e.startedAt,
      endedAt: e.endedAt ?? null,
      exitCode: e.exitCode ?? null,
      usage,
      log: e.log.slice(-40),
    };
  }
  return { active: activeCount(), max: MAX_CONCURRENT, agents };
}

/** Prompt handed to the agent — built from the card's own markdown. */
function buildPrompt(repoPath, cardMarkdown) {
  return [
    "You are an autonomous coding agent working in a dedicated git worktree (your",
    "current directory). Implement the work described in the review card below.",
    "",
    "Rules:",
    `- The card lives at \`${repoPath}\` in the main checkout. Report progress with the`,
    "  lanework MCP tools: call `toggle_item` (match each item by its text) as you",
    "  complete each checklist item, and `set_status` to `done` when everything is",
    `  finished and verified. Always pass path \`${repoPath}\`.`,
    "- Do NOT edit anything under `.agents/` directly — only via the MCP tools.",
    "- Make your code changes here in the worktree and commit them to this branch",
    "  with clear messages. Do not push.",
    "- If you cannot complete the work, stop and leave a brief explanation.",
    "",
    "--- Review card ---",
    cardMarkdown,
  ].join("\n");
}

/** Planning prompt — investigate the repo and write the card's checklist (no code). */
function buildPlanPrompt(repoPath, cardMarkdown) {
  return [
    "You are a planning/investigation agent (read-only). A new review card was just",
    `created at \`${repoPath}\` with only a title. Investigate THIS repository to`,
    "understand what the task below would involve, then write a focused review",
    "checklist into the card. Steps:",
    `- First call the lanework MCP \`get_review\` tool with path \`${repoPath}\` to read`,
    "  the current file, so you preserve its YAML frontmatter exactly.",
    `- Then call the lanework \`save_review\` tool (path \`${repoPath}\`) writing: the`,
    "  unchanged frontmatter, a `# Review: <title>` heading, a 1–2 sentence context",
    "  paragraph, and a `## Decisions` section of 5–10 `- [ ]` items capturing the key",
    "  choices/steps a human should approve before implementation.",
    "- Do NOT modify any code or other files — only the card, and only via the MCP tools.",
    `- When the checklist is written, call \`set_status\` (path \`${repoPath}\`, status \`todo\`)`,
    "  so a human can review it.",
    "",
    "--- Task ---",
    cardMarkdown,
  ].join("\n");
}

async function git(root, args) {
  return execFileP("git", ["-C", root, ...args]);
}

/** Best-effort teardown of a worktree, its branch, and the temp MCP config. */
async function pruneWorktree(root, entry) {
  await git(root, ["worktree", "remove", "--force", entry.worktree]).catch(() => {});
  await git(root, ["branch", "-D", entry.branch]).catch(() => {});
  await rm(entry.mcpConfigPath, { force: true }).catch(() => {});
}

/** git stdout as trimmed text (empty string on failure). */
async function gitText(root, args) {
  return git(root, args).then((r) => r.stdout.trim(), () => "");
}

/**
 * Pick a free branch/worktree slot for a card. Re-running a card whose previous
 * (finished) branch is still around — e.g. dragging a Done card back into Running
 * without merging it — gets a fresh suffixed name (`<slug>-2`, `-3`, …) instead of
 * erroring, so a prior attempt's unmerged work is never silently destroyed.
 */
async function allocateSlot(root, baseSlug) {
  for (let i = 1; i < 100; i++) {
    const slug = i === 1 ? baseSlug : `${baseSlug}-${i}`;
    const branch = `lanework/${slug}`;
    const worktree = join(root, ".lanework", "worktrees", slug);
    const branchExists = await git(root, ["rev-parse", "--verify", "--quiet", branch]).then(
      () => true,
      () => false,
    );
    if (!branchExists && !existsSync(worktree)) return { slug, branch, worktree };
  }
  throw new Error(`too many existing branches for ${baseSlug} — clean some up`);
}

/**
 * Dispatch an agent for one card. Sets the card to `running`, creates a worktree,
 * and spawns the headless agent. Resolves once the process is launched (the agent
 * runs on in the background and reports back through the MCP tools).
 */
export async function runAgent(repoPath, mode = "implement") {
  if (!isReviewPath(repoPath)) throw new Error("path must be under .agents/reviews/ and end in .md");
  if (mode !== "implement" && mode !== "plan") throw new Error(`unknown agent mode: ${mode}`);

  const existing = registry.get(repoPath);
  if (existing?.state === "running") throw new Error("an agent is already running for this card");
  if (activeCount() >= MAX_CONCURRENT) {
    throw new Error(`concurrency cap reached (${MAX_CONCURRENT} agents running) — wait or stop one`);
  }

  const root = resolve(localRoot());

  // Read the card before we mutate anything, so a bad path fails fast.
  const cardMarkdown = await getLocalCardContent(repoPath);

  // A fresh, non-colliding branch/worktree. Re-running a finished card reuses a new
  // suffixed slot rather than erroring on the leftover branch (which we keep). The
  // registry holds one entry per card, so this re-run's entry replaces the prior
  // finished one — the old branch survives on disk, just untracked in the UI.
  await mkdir(join(root, ".lanework", "worktrees"), { recursive: true });
  const { slug, branch, worktree } = await allocateSlot(root, slugFor(repoPath));

  // Worktree + branch off current HEAD.
  await git(root, ["worktree", "add", worktree, "-b", branch]);

  // MCP config: a lanework stdio server pointed at the MAIN checkout, so the
  // agent's status writes land on the board the user is watching (not the worktree).
  const mcpConfigPath = join(root, ".lanework", `${slug}.mcp.json`);
  await writeFile(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        lanework: {
          type: "stdio",
          command: process.execPath,
          args: [CLI, "mcp", "--no-dashboard", root],
        },
      },
    }),
    "utf8",
  );

  // The card keeps its current column; "running" is surfaced as a live badge from
  // this registry (see /_local/agent/status), not a persisted status. The agent
  // advances the card itself (set_status → done, or → todo for a plan run).

  const args = [
    "-p",
    "--mcp-config",
    mcpConfigPath,
    "--permission-mode",
    PERMISSION_MODE,
    "--allowedTools",
    "mcp__lanework__*",
    "--max-turns",
    String(MAX_TURNS),
    mode === "plan" ? buildPlanPrompt(repoPath, cardMarkdown) : buildPrompt(repoPath, cardMarkdown),
  ];

  const entry = {
    state: "running",
    mode,
    branch,
    worktree,
    mcpConfigPath,
    startedAt: new Date().toISOString(),
    log: [],
    pid: null,
    child: null,
    timer: null,
  };
  registry.set(repoPath, entry);

  const child = spawn(AGENT_BIN, args, { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
  entry.child = child;
  entry.pid = child.pid;

  const append = (buf) => {
    for (const line of buf.toString().split("\n")) {
      if (line.trim()) entry.log.push(line);
    }
    if (entry.log.length > LOG_TAIL) entry.log.splice(0, entry.log.length - LOG_TAIL);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  entry.timer = setTimeout(() => {
    log(`timeout after ${TIMEOUT_MS}ms — killing agent for ${repoPath}`);
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }, TIMEOUT_MS);

  child.on("error", (e) => {
    clearTimeout(entry.timer);
    entry.state = "failed";
    entry.endedAt = new Date().toISOString();
    entry.log.push(`spawn error: ${e.message}`);
    log(`failed to spawn ${AGENT_BIN}:`, e.message);
  });

  child.on("exit", (code, signal) => {
    clearTimeout(entry.timer);
    entry.endedAt = new Date().toISOString();
    entry.exitCode = code;
    entry.pid = null;
    entry.child = null;
    entry.state = code === 0 ? "done" : "failed";
    const result = entry.stopping ? "stopped" : entry.state;
    log(`agent for ${repoPath} exited (code=${code} signal=${signal}) → ${entry.state}`);
    // Record what the run cost (tokens/runtime/$) back into the card, then do any
    // mode-specific cleanup. Best-effort — telemetry must never block teardown.
    recordAgentRun({
      repoPath,
      worktree: entry.worktree,
      mode: entry.mode,
      result,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
    })
      .catch((e) => log(`couldn't record run telemetry for ${repoPath}: ${e.message}`))
      .finally(() => {
        // A successful PLAN run produces no code (only the card's checklist), so
        // there's nothing to merge — auto-clean its worktree/branch and drop it from
        // the registry. The IMPLEMENT flow keeps the entry so the user can review/merge
        // the branch; on failure (either mode) we keep it too, so the log + Discard remain.
        if (code === 0 && entry.mode === "plan") {
          pruneWorktree(resolve(localRoot()), entry)
            .catch(() => {})
            .finally(() => registry.delete(repoPath));
        }
      });
  });

  log(`dispatched agent for ${repoPath} on ${branch} (pid ${child.pid})`);
  return { ok: true, branch, worktree, pid: child.pid };
}

/**
 * Merge a finished agent's branch into the current checkout, then prune its
 * worktree/branch (the "merge & clean" control). Refuses while the agent is still
 * running or when the main working tree is dirty — both would risk losing work.
 * On a merge conflict it aborts the merge and reports, leaving the branch intact.
 */
export async function mergeAgent(repoPath) {
  if (!isReviewPath(repoPath)) throw new Error("path must be under .agents/reviews/ and end in .md");
  const entry = registry.get(repoPath);
  if (!entry) throw new Error("no agent branch for this card");
  if (entry.state === "running") throw new Error("agent is still running — stop or wait for it first");

  const root = resolve(localRoot());
  const dirty = await gitText(root, ["status", "--porcelain"]);
  if (dirty) throw new Error("the working tree has uncommitted changes — commit or stash them first");

  try {
    await git(root, ["merge", "--no-ff", entry.branch, "-m", `lanework: merge ${entry.branch}`]);
  } catch (e) {
    await git(root, ["merge", "--abort"]).catch(() => {});
    throw new Error(`merge failed (conflicts?) — aborted, branch ${entry.branch} left intact: ${e.message}`);
  }

  await pruneWorktree(root, entry);
  registry.delete(repoPath);
  log(`merged ${entry.branch} into current checkout and cleaned up`);
  return { ok: true, merged: true, branch: entry.branch };
}

/** Stop a running agent and prune its worktree + branch + config. */
export async function stopAgent(repoPath) {
  if (!isReviewPath(repoPath)) throw new Error("path must be under .agents/reviews/ and end in .md");
  const entry = registry.get(repoPath);
  if (!entry) return { ok: true, note: "no agent for this card" };

  if (entry.child && entry.state === "running") {
    clearTimeout(entry.timer);
    // Flag the run as user-stopped so the exit handler records it as "stopped"
    // (not "failed") in the card's run telemetry.
    entry.stopping = true;
    try {
      entry.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  // Best-effort cleanup — never throw on teardown.
  await pruneWorktree(resolve(localRoot()), entry);
  registry.delete(repoPath);
  log(`stopped agent for ${repoPath}; pruned ${entry.branch}`);
  return { ok: true };
}
