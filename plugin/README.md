# lanework — Claude Code plugin

Drive your repo's `.agents/reviews` Kanban board through an **AI-Driven Development
Lifecycle**, right inside Claude Code. This plugin bundles:

- the **lanework MCP server** (`npx @phake/lanework mcp`), and
- **`/lanework:*` slash commands** that call its tools.

## Commands

| Command | Does |
| --- | --- |
| `/lanework:create <title>` | Inception — create a new review checklist (a `todo` card) of decisions. |
| `/lanework:status [filter]` | Board lifecycle status + suggested next actions. |
| `/lanework:review [filter]` | List reviews (by column/tag/assignee) and open one. |
| `/lanework:advance <card> [to]` | Advance a card todo → processing → done (or a named status). |
| `/lanework:tick <card> :: <item>` | Check/uncheck a checklist item, with an optional note. |

The MCP tools themselves (`create_review`, `set_status`, `toggle_item`, `lifecycle_status`,
`list_reviews`, `get_review`, `update_review`, `board_summary`, `cost_estimate`,
`save_review`) are also callable directly once the plugin is installed.

Each command pre-authorizes the lanework MCP tools it uses via `allowed-tools`, so they run
without a permission prompt. (Both the `mcp__lanework__*` and plugin-scoped
`mcp__plugin_lanework_lanework__*` names are listed, to match whichever your Claude Code
version uses.) The commands are also model-invocable, so the agent can drive the lifecycle
on its own — add `disable-model-invocation: true` to a command's frontmatter if you'd rather
it only run when you type it.

## Install

From the lanework marketplace (this repo):

```bash
claude plugin marketplace add fuongz/lanework
claude plugin install lanework@lanework
```

Then restart Claude Code in the repo you want to board, and type `/lanework:` to see the
commands. The MCP server boots automatically and operates on that repo's `.agents/reviews`.

## How the MCP server is launched

`.mcp.json` runs `bin/mcp.mjs`, a small launcher that **prefers this repo's local build**
(`apps/local/dist-local/`) and **falls back to the published `npx @phake/lanework`** when the
build isn't present. So a fresh clone runs the latest code, while end users who only installed
the plugin get the published package. It boards `CLAUDE_PROJECT_DIR` (the repo you're in).

## Try it locally (dev)

From a clone of this repo, **build once** so the launcher finds the local server, then point
Claude Code at the plugin:

```bash
bun install
bun run --cwd apps/local build      # produces apps/local/dist-local (used by the launcher)
claude --plugin-dir ./plugin        # restart CC; then type /lanework:
```

`/lanework:status` should now call the MCP tool with no permission prompt. If the tools
don't appear, **restart Claude Code** — MCP servers connect at session start, so a `.mcp.json`
change needs a fresh session.

Quick alternative (no plugin, just the server) for a one-off check:

```bash
claude mcp add lanework -- node "$(pwd)/apps/local/cli.mjs" mcp --no-dashboard
```

## Publishing (for end users)

End users get the MCP server via the published npm package, so cut a release first:

```bash
cd apps/local && npm publish        # publish @phake/lanework@0.2.0 (with the mcp lifecycle tools)
```

Until `@phake/lanework` ≥ 0.2.0 is published, plugin installs (which have no local build) fall
back to the older package and the lifecycle tools won't appear.
