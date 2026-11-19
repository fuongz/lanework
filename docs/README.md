# Docs

Start with the row that fits you. Every page is short and links onward.

| You are | Read |
| --- | --- |
| New to the code | [How Lanework works](architecture/overview.md), then [development](development.md) |
| Changing a feature | The page under `architecture/` for it, and the [standards](#standards) |
| Shipping a release | [Releasing](releasing.md) |
| An agent working in this repo | [AGENTS.md](../AGENTS.md), then [agents/](#for-agents-working-in-this-repo) |

## Guides

- [Development](development.md): run, build, commands, folder layout, adding code.
- [Releasing](releasing.md): version names, Preview builds, release notes, the release workflow.

## Architecture

- [How Lanework works](architecture/overview.md): the app, the board, the agents and how they connect.
- [Lanework Kit](architecture/lanework-kit.md): code search for agents, on `lwk`.
- [Dictation](architecture/dictation.md): speech to text in the composer.

## Standards

Rules the gate or review holds the code to.

- [Process boundaries](standards/process-boundaries.md): what main, preload, renderer and plain Node may import.
- [Frontend app layout](standards/frontend-app-layout.md): where renderer files go.
- [Loading states](standards/loading-states.md): skeletons, not sentences.

## For agents working in this repo

- [Board lanes](agents/lanes.md) and [streams](agents/streams.md): how cards move and split.
- [The checkpoint hook](agents/checkpoint-hook.md): the progress an agent leaves after each turn.
- [Lanework Kit for agents](agents/lanework-kit.md): when to search with it, and how.
- [Task-id history](agents/id-history.md): old card ids after the board moves.

## Archive

- [design/](design/): dated design sketches, kept as they were.
- [Release notes](../.agents/release-notes/), one file per version.

## Keeping docs tidy

- One topic, one page. Link to a page rather than repeating it.
- English, short sentences, present tense. Card ids (FE-152) only where they help find the history.
- A new page goes in the folder above that fits it, and gets a line here.
