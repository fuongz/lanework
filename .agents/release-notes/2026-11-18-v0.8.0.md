## Added

- **Search in Files (⇧⌘F)**: search the text of a project's files in the tree pane, with match case and regex toggles and results grouped by file. Click a result to open the file scrolled to that line. A **Structural** mode matches code by its shape with ast-grep, e.g. `useEffect($A, [])`, across TypeScript/JavaScript, CSS, HTML, Python, Rust, Go and JSON.
- **Search inside past chats**: the Sessions search also finds a conversation by what was said in it, under **In conversations**, for Claude Code, Codex and OpenCode.
- **Faster, fuzzier ⌘P and @-mentions**: file names are matched by a native index that forgives typos and abbreviations (`convview` finds `conversation-view.tsx`), in a few milliseconds even on large repos.
- **lanework-kit**: fast, read-only code search for your agents, from the app. As an MCP server, turn it on per harness in **Settings → Harness → Lanework**. Or use the `lwk` command (`~/.lanew/bin/lwk`): `lwk find`, `lwk grep`, `lwk sg`, `lwk ls`, `lwk sessions`, and any other command runs unchanged (`lwk git status` is `git status`). An optional Claude Code hook (`lwk hook on`, off by default) turns plain `grep -rn "text" dir` calls into `lwk grep` and leaves everything else alone.
- Ripgrep now ships with the app, so search never depends on what is installed on your Mac.

## Changed

- **Menus and popovers have their glass back**: what is behind them is blurred again. The window frame is opaque for this.
- **Files, Changes/History and the Skills browser sit on white**, and the Changes/History header has a rule under it.
- **A shell command in a chat reads "Ran rg"** (or "Running rg") instead of the whole line; the full command is in its tooltip and panel.
- The local board's MCP tools now come from one shared contract with the cloud's, and `search_sessions` moved from the board server to lanework-kit.

## Fixed

- An invalid regex in a search now says so instead of showing no results.
- Folders that are not git repositories respect their `.gitignore` when listing and searching files.

**Full Changelog**: https://github.com/fuongz/lanework/compare/v0.7.0...v0.8.0
