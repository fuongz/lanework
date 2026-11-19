## Added

- **Lanework updates on the dynamic island**: when a newer version is out, the island offers it with **Download** or **Not now**, shows the download's progress, then **Restart now** or **Later**. Later installs it the next time you quit.
- **Settings → Storage**: the disk space Lanework uses on this Mac, by folder (settings and history, projects and boards, run workspaces, cache), with **Clear cache** and a way to show each folder in Finder.
- Nested lists in messages: items indented under an item are drawn inside it, and a numbered list keeps its first number, so a list written `3.`, `4.` counts from 3.
- A path to a folder in a message (an `.app` bundle, a build output) opens in Finder. A file still opens in Files.

## Changed

- Nothing downloads until you ask: Lanework checks for updates and offers them, and the download starts only when you press **Download**. Settings → About shows the same steps.
- **Update automatically** in Settings → About is now **Check automatically**.

## Fixed

- A conductor no longer keeps a red dot after you reset its conversation while a run it started was paused.
- A session that still leads a paused or active run now has **Stop** in its context menu, so its green dot can be turned off. Stopping asks first, because a stopped run cannot be resumed.

**Full Changelog**: https://github.com/fuongz/lanework/compare/v0.2.0...v0.3.0
