//! `lwk COMMAND ARGS...` for any COMMAND lwk has no tool for: `exec()`, as
//! the shell's `exec` would. lwk's process becomes the command, so `lwk git
//! status` is `git status` byte for byte: same argv, PATH lookup, terminal,
//! pid, signals and exit status (a signal death included).
//!
//! - Not found: `lwk: COMMAND: command not found`, exit 127; found but not
//!   runnable: `permission denied`, exit 126. The shell's codes.
//! - The command starts with SIGPIPE at its default and no signal blocked,
//!   as a shell starts it. Rust's runtime ignores SIGPIPE in lwk itself;
//!   `Command::exec` puts it back before the exec.

use std::ffi::{OsStr, OsString};
use std::os::unix::process::CommandExt;
use std::process::Command;

const ENOENT: i32 = 2;
const EACCES: i32 = 13;

/// Replace this process with `command args...`.
///
/// Returns the exit code only when the exec failed.
pub fn exec(command: &OsStr, args: &[OsString]) -> i32 {
    let error = Command::new(command).args(args).exec();
    let (why, code) = match error.raw_os_error() {
        Some(ENOENT) => ("command not found".to_owned(), 127),
        Some(EACCES) => ("permission denied".to_owned(), 126),
        _ => (error.to_string(), 126),
    };
    eprintln!("lwk: {}: {why}", command.to_string_lossy());
    code
}
