//! `lwk`: Lanework's search kit for coding agents, on the command line
//! (FE-152).
//!
//! ```text
//! lwk find QUERY [FOLDER]        find_files         (kit.rs)
//! lwk grep QUERY [FOLDER]        search_text
//! lwk sg PATTERN [FOLDER]        search_structural
//! lwk ls [FOLDER]                list_files
//! lwk sessions QUERY [FOLDER]    search_sessions
//! lwk rewrite                    Claude Code's PreToolUse hook (rewrite.rs)
//! lwk hook on|off|status         that hook in ~/.claude/settings.json
//! lwk help | version
//! lwk ANYTHING ELSE ...          exec()s ANYTHING ELSE (passthrough.rs)
//! ```
//!
//! - The kit's tools run in the app, over its socket (`kit.rs`): the warm
//!   fff index and the natives. With no app to answer, lwk execs the app's
//!   own Node on the bundled JS kit (`fallback.rs`,
//!   `electron/lwk/cli.ts`), which runs them in the working folder.
//! - `lwk hook` is rare and edits a file the app's safe writer owns: it
//!   always goes to the JS kit.
//! - Anything else is the command it names: lwk exec()s it, so it IS that
//!   command from then on (same pid, terminal, signals and exit code).
//!
//! Built by `scripts/build-lwk.mjs` into `dist/electron/bin/lwk-<arch>`,
//! beside the bundled `rg-<arch>`, and linked from `~/.lanew/bin/lwk` at
//! launch (`electron/main/agent-setup/lwk-install.ts`).

mod fallback;
mod jsonjs;
mod kit;
mod passthrough;
mod paths;
mod rewrite;

use std::ffi::OsString;
use std::io::Write;
use std::process::exit;

/// The app's version, stamped by `build-lwk.mjs`; "dev" for a bare `cargo
/// build`.
const VERSION: &str = match option_env!("LWK_VERSION") {
    Some(version) => version,
    None => "dev",
};

const HELP: &str = "lwk: Lanework's search kit for coding agents.

Usage:
  lwk find QUERY [FOLDER]       Fuzzy-find files by path, best first
  lwk grep QUERY [FOLDER]       Search file contents (a literal unless -E)
  lwk sg PATTERN [FOLDER]       Search code by syntax (ast-grep pattern)
  lwk ls [FOLDER]               List the files rg would search
  lwk sessions QUERY [FOLDER]   Search Claude Code, Codex and OpenCode sessions
  lwk hook on|off|status        Claude Code hook that runs plain grep -r as lwk
  lwk COMMAND [ARGS...]         Run any other command unchanged

Options:
  --json                Print the tool's JSON answer
  --limit N             How many results (files, paths or sessions)
  -E, --regex           grep: QUERY is a regex (ripgrep syntax)
  -F, --fixed-strings   grep: QUERY is a literal (the default)
  -i, --ignore-case     grep: ignore case (the default)
  -s, --case-sensitive  grep: match case
  -g, --glob GLOB       grep: only files matching GLOB; a leading ! excludes
  --lang LANG           sg: the pattern's language

.gitignore is respected and hidden files are skipped. FOLDER defaults to
the working folder, and must be inside it unless the Lanework app is running
and the folder belongs to the same project. Exit code: 0 found, 1 nothing
found, 2 error.
";

/// Write `text` to stdout whole. A closed pipe (`lwk ls | head`) is not an
/// error worth a word: what was wanted has been read.
pub fn out(text: &str) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(text.as_bytes());
    let _ = stdout.flush();
}

fn main() {
    let mut argv = std::env::args_os().skip(1);
    let Some(first) = argv.next() else {
        out(HELP);
        exit(0);
    };
    let rest: Vec<OsString> = argv.collect();
    let code = match first.to_str() {
        Some("help" | "--help" | "-h") => {
            out(HELP);
            0
        }
        Some("version" | "--version" | "-V") => {
            out(&format!("lwk {VERSION}\n"));
            0
        }
        Some(command @ ("find" | "grep" | "sg" | "ls" | "sessions")) => kit::run(command, &rest),
        Some("rewrite") => rewrite::run_hook(),
        Some("hook") => fallback::exec_standalone(&first, &rest),
        // Returns only when the command could not be run.
        _ => passthrough::exec(&first, &rest),
    };
    exit(code);
}
