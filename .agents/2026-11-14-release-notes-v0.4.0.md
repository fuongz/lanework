## Added

- **Sign in to Claude from the island**: when Claude refuses a turn because you are not signed in, the island offers to sign in right there.
- **The run panel reads as a checklist**: a run's tasks are grouped into the steps they run in (Step 1, Step 2…), each with a square status mark, its id and its title. Open a task to see its files and actions under it.

## Changed

- **Stop on a conductor stops everything it left running**: its conversations, the sessions it started and the run it leads. The dialog lists what will stop first, and Stop shows whenever something is still running, even between turns. The project switcher no longer shows agents running after you stop it.
- **⌘W on a chat with a live agent asks first**, then stops the agent.
- The **untrusted folder** notice and its **Trust this folder** button now sit in a tab on the message box, beside the message queue.
- A run that finished without problems no longer lists its tasks twice: the summary at its top shows only when something failed or needs you.

**Full Changelog**: https://github.com/fuongz/lanework/compare/v0.3.0...v0.4.0
