## Added

- **A page for each harness**: Settings → Harness lists Claude Code, Codex and OpenCode; open one for its card, a **Lanework** section (MCP, hooks, handoff), its models, sessions, status and resuming. **Check for updates** sits in the page header.
- **Your own model list per harness**: star models, reorder them (drag the handle or use the arrows, then **Reset order** if you change your mind), hide them or **Disable all**, see each one's id, and **add a custom model**. The composer's model picker follows your stars and order; **Manage models** opens the harness's page.
- **Disable, enable or remove an MCP server** from its **…** menu in Settings → MCP, after a confirmation. Only that entry in the CLI's config file changes. Removing a remote Codex server also signs it out. Servers a plugin brings, and Lanework's own entry, can't be changed here.
- **Font previews**: each font in Settings → Appearance shows a sample under it, in Lanework's own style (a chat with file chips, a colour and a link, code, a terminal).
- Favicons for **lanework.dev** links in chats.

## Changed

- **Settings is grouped around what it applies to**: App, Agents (Harness, Skills, MCP, Archived), **Code** (Projects) and Cloud. **Projects** lists your projects and opens the one you're in. A breadcrumb heads every page, and pages that apply to a project say which one.
- **Models moved into each harness's page**; the separate Models page is gone.
- **Theme is a row of window miniatures** beside the accent colour.
- **Keybindings are grouped** and list only Lanework's own shortcuts.
- **Skills has the issue list's search, filter (by harness) and refresh**, a header with the file's path, and a white background.
- **MCP** shows each CLI's logo on its group and highlights Lanework's own row.
- The composer sits closer to the footer, without its spinner.
- No rule under a picker's search field.

## Fixed

- Switching projects no longer files another project's chat in the tab strip.
- Opening a card on a local board no longer logs an activity error.

**Full Changelog**: https://github.com/fuongz/lanework/compare/v0.6.0...v0.7.0
