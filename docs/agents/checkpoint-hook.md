# The checkpoint hook

One script, `apps/desktop/electron/hook/lanework-checkpoint.ts`, leaves a
checkpoint on the card a session is working (BE-17), so another agent can
resume it. Root `AGENTS.md` § "Checkpoints and resuming a card" covers what a
checkpoint is and how to resume one; this page covers where the hook is
installed and when it runs.

## Where it is installed

| Install | File | Events |
| --- | --- | --- |
| Desktop app, Claude Code (Settings → Agents) | `~/.claude/settings.json` | `Stop`, `PreCompact`, `SessionStart` (matcher `compact`) |
| Desktop app, Codex | `~/.codex/hooks.json` | `Stop` |
| Desktop app, OpenCode | `~/.config/opencode/plugins/` | `session.idle` |
| Plugin, Claude Code (INF-03) | `plugins/lanework/hooks/hooks.json` | `Stop`, `PreCompact`, `SessionStart` (matcher `compact`) |

Every app entry runs the same command, `'<app home>/hooks/lanework-checkpoint'
--agent claude-code|codex`. The plugin's hook stands down whenever the app's
is in `~/.claude/settings.json`, for every event, so one compaction is never
checkpointed twice.

An app install from before FE-117 (Stop only) gets the two compaction entries
on the next launch, once. An entry you remove after that stays removed; turning
the switch off and on again puts all three back.

## When it runs and what it does

| Event | Output to the session | What it does |
| --- | --- | --- |
| `Stop` | none | A checkpoint from the transcript, in a detached worker. Skipped when nothing changed within a minute. |
| `PreCompact` | none | The same checkpoint, never skipped, its summary starting `[pre-compact, manual]` or `[pre-compact, auto]`. Leaves a marker for the next `SessionStart`. |
| `SessionStart`, source `compact` | one reminder, or none | Takes the marker; if the session is bound to a card, asks the model to record its next step. |

`nextStep` comes only from the model, through the MCP `checkpoint` tool. The
riskiest moment to lose it is compaction, so after one the hook adds this to
the model's context, through `hookSpecificOutput.additionalContext`:

> Lanework: the context was just compacted while you were working FE-117.
> Before continuing, call the lanework `checkpoint` tool for card FE-117 with
> `next_step` (and a `summary` of where the work stands).

- **Bound to a card** means what it means on Stop: the last card a lanework
  tool was called with in this session, or the id `create_review` returned,
  else a task id the user typed. No card, no reminder.
- **Once per compaction**: `PreCompact` writes
  `~/.cache/lanework/checkpoint/compact-<sha256(session)>.json`; the
  `SessionStart` that follows renames it away before reading it. No marker (no
  `PreCompact` seen, another run took it, or older than 15 minutes) means
  silence.
- **Prompt cache** (INF-07): the reminder is a fixed template, only the task
  id varies, and the id must look like one (`FE-117`). Compaction rebuilds the
  context anyway. Nothing is ever printed on `Stop` or `PreCompact`; Claude
  Code would append `PreCompact` stdout to the compaction instructions.

Failures, the pre-compact checkpoints and the reminders are logged to
`~/.cache/lanework/checkpoint/hook.log`, never to the session.

## Credentials, approval and the WIP ref

The app rewrites `~/.lanew/hooks/lanework-checkpoint` on each launch and runs it
under its own Node, so no bun is needed. The hook costs no model quota, redacts
secrets on the machine, and uses the app's machine credential from the Keychain
(revoking the machine revokes the hook).

Codex runs a new hook only after you approve it in Codex, once (`/hooks`); the
app never approves it for you. Hooks are on by default in current Codex — only
`[features] hooks = false` in `~/.codex/config.toml` turns them off.

A second switch in Settings → Agents, off by default, also force-pushes the
uncommitted working tree (tracked changes plus untracked, non-ignored files) to
`refs/lanework/wip/<task-id>` — a ref on no branch; your branch, index and
history are never touched.

## The plugin (INF-03)

Without the app, Claude Code users install the plugin (`plugins/lanework/`):
`/plugin marketplace add fuongz/lanework`, `/plugin install lanework@lanework`,
then `! lanework login`. Its bundle, `plugins/lanework/bin/lanework-checkpoint.cjs`,
is committed — rebuild it with `bun run build:plugin` after changing the hook;
`bun run gate` fails when it is stale. This repo carries no copy of the hook of
its own — two installs would checkpoint every turn twice.

## Codex (FE-117/D5)

Codex 0.165 lists `PreCompact`, `PostCompact` and `SessionStart` (source
`compact`) among its hook events, with the same input shape as Claude Code.
The app still installs Codex's `Stop` hook only. Each new entry needs its own
approval in Codex (`/hooks`), which Settings does not track, and nothing
documents that Codex starts a `compact` session after it compacts. The hook
script already handles both events if they are ever registered.
