//! `lwk rewrite`: Claude Code's PreToolUse hook for Bash. It turns a plain
//! recursive grep for a literal into `lwk grep`, which respects .gitignore,
//! skips binaries and uses the app's ripgrep. Off unless the user turns it
//! on (`lwk hook on`, `electron/lwk/hook.ts`). Native because, on, it runs
//! before every Bash call.
//!
//! Rewrites ONLY a command whose every token is understood; anything else
//! passes through untouched. Passing through is printing nothing and exiting
//! 0, which Claude Code reads as "no change". Every failure here (bad JSON,
//! an unreadable folder) passes through too: the hook never blocks a call.
//!
//! ```text
//! Accepted                                Becomes
//! grep -rn "TODO" src                     lwk grep -F -s --limit 200 -- TODO src
//! grep -rni 'fooBar' .                    lwk grep -F -i --limit 200 -- fooBar .
//! grep -rnF 'a.b(' src                    lwk grep -F -s --limit 200 -- 'a.b(' src
//! grep -r -n -I "x" src/                  lwk grep -F -s --limit 200 -- x src/
//! grep -rn --include='*.ts' useState app  lwk grep -F -s --limit 200 -g '*.ts' -- useState app
//!
//! Refused (passed through)                Why
//! grep -n "a\|b" file.ts                  a backslash (BRE); not recursive
//! grep -rn "a.b" src                      `.` is a regex outside -F
//! grep -rn '^import' src                  `^`, likewise `$ * [ ]`
//! grep -rE "a|b" src, grep -rnw x src     an option outside the list below
//! grep -rn foo src | head                 a pipe; likewise ; & < > ( ) and newlines
//! grep -rn "$X" src, grep -rn `x` src     an expansion
//! grep -rn foo *.ts, grep -rn foo ~/x     an unquoted glob or ~
//! grep -rn foo                            no folder named
//! grep -rn foo a b, grep -rn foo f.ts     two operands; a file, not a folder
//! grep -rn foo ../other, /abs/elsewhere   a folder outside the working one
//! grep -rn foo node_modules/x, .github    a folder .gitignore or hidden skips
//! cd x && grep ..., FOO=1 grep ...        grep is not the first word
//! /usr/bin/grep ..., lwk grep ...         not `grep` (and never twice)
//! ```
//!
//! Options understood: -r --recursive (required), -n --line-number, -H,
//! -I, -F --fixed-strings, -i --ignore-case, and --include=GLOB (a file
//! name glob: letters, digits, `. _ - * ?`). Short ones may be combined
//! (`-rniF`). The working folder may be neither `/` nor the home folder.
//!
//! The answer is Claude Code's PreToolUse JSON with `updatedInput` and no
//! `permissionDecision`: the rewritten command goes through the user's own
//! permission rules, never approved here. `updatedInput` is the tool input
//! as it came, its `command` replaced in place.
//!
//! NOTE: What still differs from grep, by design: .gitignore'd, hidden and
//! binary files are skipped, a line prints as `path:line: text`, and the
//! answer stops at 200 files (said on stderr).

use crate::{jsonjs, out, paths};
use serde_json::{Map, Value};
use std::io::Read;
use std::path::{Component, PathBuf};

/// The hook's input is a small JSON object; more than this is not one.
const INPUT_MAX: usize = 1024 * 1024;

/// Folders a search never sees into: ignored, generated or vendored.
const SKIPPED_DIRS: [&str; 7] = [
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    "coverage",
];

/// A character a bare (unquoted) word may hold and mean only itself.
fn bare(c: char) -> bool {
    c.is_ascii_alphanumeric() || "_./:@%+,=-".contains(c)
}

/// Whether `pattern` holds what a BRE treats as more than itself.
fn bre_meta(pattern: &str) -> bool {
    pattern.contains(['\\', '.', '[', ']', '*', '^', '$'])
}

/// A file name glob `--include` may take.
fn include_glob(glob: &str) -> bool {
    !glob.is_empty()
        && glob
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._*?-".contains(c))
}

/// `command` split into words, the way `sh` would, or None when the shell
/// would do more than split it: expand, glob, redirect, pipe or chain.
fn split_words(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut i = 0;
    while i < command.len() {
        let c = command[i..].chars().next()?;
        match c {
            ' ' | '\t' => {
                if let Some(done) = word.take() {
                    words.push(done);
                }
                i += 1;
            }
            '\'' => {
                let end = i + 1 + command[i + 1..].find('\'')?;
                word.get_or_insert_with(String::new)
                    .push_str(&command[i + 1..end]);
                i = end + 1;
            }
            '"' => {
                let end = i + 1 + command[i + 1..].find('"')?;
                let inner = &command[i + 1..end];
                // `$`, backquote and backslash are live inside double
                // quotes; `!` too in an interactive bash.
                if inner.contains(['$', '`', '\\', '!']) {
                    return None;
                }
                word.get_or_insert_with(String::new).push_str(inner);
                i = end + 1;
            }
            c if bare(c) => {
                word.get_or_insert_with(String::new).push(c);
                i += 1;
            }
            _ => return None,
        }
    }
    if let Some(done) = word {
        words.push(done);
    }
    Some(words)
}

/// `value` for `sh`: bare when it is plain, single-quoted otherwise.
fn quote(value: &str) -> String {
    if !value.is_empty() && value.chars().all(bare) {
        return value.to_owned();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

struct Grep {
    pattern: String,
    folder: String,
    ignore_case: bool,
    includes: Vec<String>,
}

/// `words` (after `grep`) read as a grep this hook understands, or None.
fn read_grep(words: &[String]) -> Option<Grep> {
    let mut recursive = false;
    let mut fixed = false;
    let mut ignore_case = false;
    let mut includes = Vec::new();
    let mut operands: Vec<&str> = Vec::new();
    for word in words {
        if !operands.is_empty() || !word.starts_with('-') || word == "-" {
            if word.starts_with('-') {
                return None;
            }
            operands.push(word);
            continue;
        }
        if word.starts_with("--") {
            match word.as_str() {
                "--recursive" => recursive = true,
                "--line-number" => {}
                "--fixed-strings" => fixed = true,
                "--ignore-case" => ignore_case = true,
                _ => {
                    let glob = word.strip_prefix("--include=")?;
                    if !include_glob(glob) {
                        return None;
                    }
                    includes.push(glob.to_owned());
                }
            }
            continue;
        }
        for letter in word[1..].chars() {
            match letter {
                'r' => recursive = true,
                'F' => fixed = true,
                'i' => ignore_case = true,
                'n' | 'H' | 'I' => {}
                _ => return None,
            }
        }
    }
    let [pattern, folder] = operands.as_slice() else {
        return None;
    };
    if !recursive || pattern.is_empty() || (!fixed && bre_meta(pattern)) {
        return None;
    }
    Some(Grep {
        pattern: (*pattern).to_owned(),
        folder: (*folder).to_owned(),
        ignore_case,
        includes,
    })
}

/// Whether lwk searches `folder` (from `cwd`) exactly as grep would choose
/// it: a real folder inside the working one, none of it skipped by name.
fn plain_folder(folder: &str, cwd: &str) -> bool {
    let check = || -> Option<bool> {
        // Node's realpathSync folds `..` lexically before it resolves.
        let root = std::fs::canonicalize(paths::resolve("/", cwd)).ok()?;
        let home = std::fs::canonicalize(paths::home_dir()?).ok()?;
        if root.parent().is_none() || root == home {
            return Some(false);
        }
        let real = std::fs::canonicalize(paths::resolve(cwd, folder)).ok()?;
        if !std::fs::metadata(&real).ok()?.is_dir() {
            return Some(false);
        }
        let Ok(rel) = real.strip_prefix(&root) else {
            return Some(false);
        };
        Some(rel.components().all(|part| match part {
            Component::Normal(name) => {
                let name = name.to_string_lossy();
                !name.starts_with('.') && !SKIPPED_DIRS.contains(&name.as_ref())
            }
            _ => false,
        }))
    };
    check().unwrap_or(false)
}

/// `command` as lwk runs it, or None to leave it alone.
///
/// `cwd` is where the command would run (absolute); `lwk` is how to call
/// lwk, its absolute path.
fn rewrite_command(command: &str, cwd: &str, lwk: &str) -> Option<String> {
    if !cwd.starts_with('/') {
        return None;
    }
    let words = split_words(command)?;
    if words.first().map(String::as_str) != Some("grep") {
        return None;
    }
    let grep = read_grep(&words[1..])?;
    if !plain_folder(&grep.folder, cwd) {
        return None;
    }
    let mut parts = vec![
        quote(lwk),
        "grep".to_owned(),
        "-F".to_owned(),
        if grep.ignore_case { "-i" } else { "-s" }.to_owned(),
        "--limit".to_owned(),
        "200".to_owned(),
    ];
    for glob in &grep.includes {
        parts.push("-g".to_owned());
        parts.push(quote(glob));
    }
    parts.push("--".to_owned());
    parts.push(quote(&grep.pattern));
    parts.push(quote(&grep.folder));
    Some(parts.join(" "))
}

/// The lwk a rewritten command runs: the installed link, else this binary.
fn lwk_path() -> Option<PathBuf> {
    let installed = paths::app_home().join("bin").join("lwk");
    if installed.exists() {
        return Some(installed);
    }
    paths::self_path()
}

/// The hook's answer for `input`, or None to leave the call alone.
fn answer(input: &[u8]) -> Option<String> {
    if input.len() > INPUT_MAX {
        return None;
    }
    let input: Value = serde_json::from_str(&String::from_utf8_lossy(input)).ok()?;
    let input = input.as_object()?;
    if input.get("hook_event_name")?.as_str()? != "PreToolUse"
        || input.get("tool_name")?.as_str()? != "Bash"
    {
        return None;
    }
    let tool_input: &Map<String, Value> = input.get("tool_input")?.as_object()?;
    let command = tool_input.get("command")?.as_str()?;
    let cwd = match input.get("cwd") {
        Some(Value::String(cwd)) => cwd.clone(),
        _ => std::env::current_dir().ok()?.to_string_lossy().into_owned(),
    };
    let lwk = lwk_path()?;
    let rewritten = rewrite_command(command, &cwd, &lwk.to_string_lossy())?;
    let mut updated = tool_input.clone();
    updated.insert("command".into(), Value::String(rewritten));
    let mut specific = Map::new();
    specific.insert("hookEventName".into(), Value::String("PreToolUse".into()));
    specific.insert("updatedInput".into(), Value::Object(updated));
    let mut output = Map::new();
    output.insert("hookSpecificOutput".into(), Value::Object(specific));
    Some(format!("{}\n", jsonjs::stringify(&Value::Object(output))))
}

/// Read Claude Code's PreToolUse input on stdin and print the rewrite, if
/// there is one. Returns 0, always: a hook that fails must not block the
/// call.
pub fn run_hook() -> i32 {
    let mut input = Vec::new();
    if std::io::stdin().read_to_end(&mut input).is_ok() {
        if let Some(answer) = answer(&input) {
            out(&answer);
        }
    }
    0
}
