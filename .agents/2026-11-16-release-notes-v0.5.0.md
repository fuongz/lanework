## Added

- **A slimmer message box**: one row while the prompt is short (+, your words, then the mic), with the branch, model, access and context under it. Once you type, the mic becomes **Send**; at two lines the box stacks, words above and controls below.
- **Image attachments as thumbnails**: hover for the × on the corner, click to see the image large.
- **The + menu** lists Add photos & files and **Slash commands**, one line each.
- **Prompts written in markdown** are shown as markdown in the chat.
- **Colour values** in replies show a large swatch on hover, with Copy.
- **The Sessions panel opens a group as a page** (Changes, Commits, Sources…), with Back at its top; a worker's chat now fills its panel too.
- **One overall status** at the top of a proposal or a run: Waiting for you, In progress, Needs you, In review, Done, Failed.

## Changed

- **Proposals and runs share one task row**: the task, a status badge (Working, Review, Done, Read only), the model and the time, with a thread down each step. Open chat appears when you hover a worker.
- **Working, Review, Done**: a finished task reads Review until its lead takes it, then Done.
- **One colour per status** everywhere a task is shown: blue working, amber waiting on someone, green done, red failed, grey not started or stopped.
- **Usage turns yellow at 75%, orange at 90% and red when spent.**
- **Max effort warns** that it uses 3.5× or more.
- **Auto access** has a new icon; **Stop** is a filled square everywhere.
- The dictation language is set in **Settings → Dictation** only.
- Smoother motion in the chat: the Sessions panel slides, folds do not jump while a reply streams, islands enter more gently.

## Fixed

- Sessions and conductors carry over when a project moves to the cloud, and migrated local boards leave the project list.

**Full Changelog**: https://github.com/fuongz/lanework/compare/v0.4.0...v0.5.0
