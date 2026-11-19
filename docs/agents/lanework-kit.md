# Lanework Kit for agents (FE-152)

Fast, read-only code search that ships with the Lanework desktop app, from
[lanework-dev/kit](https://github.com/lanework-dev/kit). Two ways in:

- **`lanework-kit`**, an MCP server (stdio) the app registers next to the
  `lanework` board server in Claude Code, Codex and OpenCode. On by default;
  a switch per harness in **Settings → Harness → Lanework Kit**.
- **`lwk`**, a command-line tool at `~/.lanew/bin/lwk`.

Both answer through the app when it is running and on their own when it is
not. How it is wired: [architecture](../architecture/lanework-kit.md).

## When to use it instead of Grep/Glob

| Need | Use |
| --- | --- |
| A file whose name you half remember (typos, abbreviations: `convview`) | `find_files` / `lwk find` |
| Text across a large repo, `.gitignore` respected | `search_text` / `lwk grep` |
| Code by its shape, e.g. `useEffect($A, [])`, `fn $F($$$A)` | `search_structural` / `lwk sg` |
| Every file under a folder, `.gitignore` respected | `list_files` / `lwk ls` |
| A past chat (Claude Code, Codex, OpenCode) by what was said in it | `search_sessions` / `lwk sessions` |

For one known file or a one-off `grep` in a small folder, the harness's own
tools are just as good. An empty answer is complete: do not search again with
`grep` or `find` unless the question is about files `.gitignore` excludes.

## Tools and commands

| MCP tool | `lwk` | Input |
| --- | --- | --- |
| `find_files` | `lwk find <query>` | `query`, `path?`, `limit?`, `git?` |
| `search_text` | `lwk grep [-E] [-i] [-g glob] <query> [path]` | `query`, `regex?`, `case_sensitive?`, `globs?`, `path?`, `limit?`, `max_lines?` |
| `search_structural` | `lwk sg <pattern> [path]` | `pattern`, `lang?`, `globs?`, `path?`, `limit?`, `max_lines?` |
| `list_files` | `lwk ls [path]` | `path?`, `limit?` |
| `search_sessions` | `lwk sessions <query>` | `query`, `path?`, `limit?` |

`path` is a folder, or one file for `search_text` and `search_structural`
(`folder` is its older name). `limit` counts files. The contract (names,
inputs, limits, result shapes) is `contract/kit.json` in the kit repository.
`lwk … --json` prints the same shapes as the MCP tools. Exit codes: 0 found,
1 nothing found, 2 error.

`search_sessions` moved here from the `lanework` board server in FE-152: the
board server only manages boards and cards, the same tools locally and in the
cloud.

## Scope

Every call searches only the folder it runs in (the agent's project) or a
folder inside it. A path outside it, `../`, a symlink that leads out, or a
start from `$HOME` or `/` is refused.

## Anything else is the real command

`lwk` handles only the five commands above. Any other first word runs the
command itself, unchanged: `lwk git status` *is* `git status`, with the same
output and exit code.

## The rewrite hook (off by default)

`lwk hook on` adds a Claude Code `PreToolUse` hook that turns a plain
`grep -rn "literal" dir` into `lwk grep -F … dir`. It rewrites only commands
it fully understands and leaves everything else exactly as written:
regex escapes like `a\|b`, unknown flags, pipes, redirects, variables, `cd …
&&`. It never wraps a command twice, and it never approves a command: your own
permission rules still apply. `lwk hook off` removes it; `lwk hook status`
says which.

Why off: silently rewriting an agent's shell commands changes their meaning
when the two tools disagree (grep's basic regex vs ripgrep's), and the agent
cannot see why its command failed.
