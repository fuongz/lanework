# Lanework for Claude Code

The Lanework board inside Claude Code, for people who use the CLI without the
desktop app (INF-03):

- **MCP tools** — `list_boards`, `get_review`, `checkpoint`, … — from
  `https://mcp.lanework.dev/v1`.
- **A checkpoint after every turn.** A Stop hook leaves a summary of where
  Claude stopped on the card it was working on, so another agent (Codex,
  Claude on another machine, or in the cloud) can pick up with
  `resume <task id>`. It costs no model usage and removes secrets on your
  machine before anything is sent.

## Install

```
/plugin marketplace add fuongz/lw
/plugin install lanework@lanework
```

Then, once:

```
/mcp                  # sign the MCP server in (browser)
! lanework login      # sign this machine in for the hook (browser)
```

No browser on this machine (SSH)? `! lanework login --device` prints a code to
enter on any other device.

## Commands

| Command | What it does |
| --- | --- |
| `lanework login [--device]` | Sign this machine in. The credential goes to the macOS Keychain, or `~/.config/lanework/credential` (mode 0600) on Linux. |
| `lanework status` | Signed in? Where is the credential? Last checkpoint, and the log. |
| `lanework config push-wip on\|off` | Also push uncommitted work to `refs/lanework/wip/<task id>` so an agent elsewhere gets the code. **Off** by default. |
| `lanework logout` | Revoke this machine and forget the credential. |

## Notes

- Needs **Node.js 18+** on `PATH`. Without it the hook stays silent (and says
  so in `~/.cache/lanework/checkpoint/hook.log`); the commands tell you.
- If the Lanework **desktop app** already installed its hook
  (Settings → Agents), this plugin's hook stays quiet, so each turn is
  checkpointed once.
- `bin/lanework-checkpoint.cjs` is built from
  `apps/desktop/electron/hook/` by `bun run build:plugin` and committed —
  a plugin installs by clone. `bun run gate` fails if it falls behind.
