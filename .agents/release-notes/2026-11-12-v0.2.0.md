## Added

- Selection actions: select text in a message to **Ask about this**, **Explain** or **Mention** it.
- Reply and Mention quote passages in a tab above the composer; sent messages show their quotes on the bubble.
- **N sources** under an answer: the pages its web searches found, the pages it read and the links in its text.
- A **Sources** group in the details panel: a session's web searches by query, with their pages.
- The details panel opens on every chat, not only a conductor's.
- Favicons for well-known sites, fetched from the site's own `/favicon.ico` only.
- **Allow** and **Deny** on the dynamic island when an agent asks for permission while you are elsewhere.
- **Show all** for several pending permission requests.
- **Check for Updates…** in the app menu.
- **Initialize Git** on a folder that is not a repository.

## Changed

- Permission requests stack and are answered one at a time, the next one coming forward with its input open.
- OpenCode in Supervised no longer asks before read, glob, grep and list. Shell commands, edits and web tools still ask.
- Links in messages are badges with the site's mark and host.
- Selected text uses Lanework's colour.
- Details panel groups start folded, show a blue count while work runs, and appear at once when you come back to a chat.
- Softer composer and permission cards, pill buttons, and a destructive Stop for a running session.
- Versions are shown with a leading `v`.

## Fixed

- Changes no longer freezes with tens of thousands of untracked files: a large untracked folder is one row with its file count, and long lists draw only what is on screen.
- The rail's changed-lines count counts real changes only.
- The model and permission menus no longer float at the window's corner when a permission request appears.
- The chat no longer slides sideways when you return to one with its panel open.
- Prompt chips sit on the line of the text around them.
- No empty gap above the composer's field when there is no branch to show.

**Full Changelog**: https://github.com/fuongz/lanework/compare/v0.1.0...v0.2.0
