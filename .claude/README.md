# .claude

Claude Code's project folder. Committed unless noted.

| Path | What it holds |
| --- | --- |
| `settings.json` | Project settings: the hooks below and the `lanework` plugin. |
| `settings.local.json` | Your own settings for this checkout. Git-ignored. |
| `hooks/` | Hook scripts `settings.json` runs. `no-full-suite.sh` blocks a whole-suite Playwright run. |
| `skills/<name>/` | Skills, one folder each (Claude Code reads only this level). |
| `skillsets/<owner>-<repo>.json` | Where vendored skills came from: repo, path, commit or hash. Update a vendored skill by copying it again from there. |
| `tools/<name>/` | Small reusable scripts; each `TOOL.md` names its `runtime` and `entrypoint` (AGENTS.md, "Reusable scripts"). |
| `worktrees/` | Claude Code's own worktrees. Git-ignored. |

## Skills

| Skill | Source |
| --- | --- |
| `better-accessibility`, `better-colors`, `better-interface`, `better-layout`, `better-typography`, `better-ui`, `better-writing`, `break`, `explain-interface`, `interface-review`, `variant` | `jakubkrehel/skills` ([skillset](skillsets/jakubkrehel-skills.json)) |
| `trees` | `pierrecomputer/pierre` ([skillset](skillsets/pierrecomputer-pierre.json)) |
| `run-desktop` | This repo: launch and drive the built desktop app. |
