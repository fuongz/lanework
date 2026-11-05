# The checkpoint Stop hook (BE-17)

The root [AGENTS.md](../../AGENTS.md) ("Checkpoints and resuming a card")
points here for how the automatic checkpoint is installed and behaves.

Claude Code and Codex checkpoint by themselves after every turn, through
the Stop hook the desktop app installs: **Settings → Agents**, one switch
per CLI (FE-28, FE-29). It goes into `~/.claude/settings.json` and
`~/.codex/hooks.json`, so every repo gets it, and both run one script the
app rewrites on each launch, `~/.lanew/hooks/lanework-checkpoint`, under the
app's own Node — no bun needed. Codex runs a new hook only after you approve
it in Codex, once (`/hooks`); the app never approves it for you. Hooks are
on by default in current Codex — only `[features] hooks = false` in
`~/.codex/config.toml` turns them off. It costs no model
quota, redacts secrets on the machine, and uses the app's machine credential
from the Keychain (revoking the machine revokes the hook). A second switch,
off by default, also force-pushes the uncommitted working tree (tracked
changes plus untracked, non-ignored files) to `refs/lanework/wip/<task-id>`
— a ref on no branch; your branch, index and history are never touched.
Failures go to `~/.cache/lanework/checkpoint/hook.log`, never to the session.
The source is `apps/desktop/electron/hook/lanework-checkpoint.ts`.

Without the app, Claude Code users install the **plugin** (INF-03,
`plugins/lanework/`): `/plugin marketplace add fuongz/lanework`,
`/plugin install lanework@lanework`, then `! lanework login`. The plugin's
hook stays quiet when the app's hook is installed. Its bundle,
`plugins/lanework/bin/lanework-checkpoint.cjs`, is committed — rebuild it
with `bun run build:plugin` after changing the hook; `bun run gate` fails
when it is stale. This repo no longer carries its own
copy of the hook — two installs would checkpoint every turn twice.
