//! Paths as the app and Node name them.
//!
//! - [`app_home`] is `electron/main/paths.ts`'s `appHomeDir()`.
//! - [`join`] and [`resolve`] are Node's `path.join` and `path.resolve`
//!   (POSIX): lexical, `..` folded before any symlink is followed. lwk prints
//!   and checks paths exactly as the JS kit does.

use std::path::PathBuf;

/// The user's home, as Node's `os.homedir()` finds it: `$HOME`, else the
/// password database.
pub fn home_dir() -> Option<PathBuf> {
    match std::env::var_os("HOME") {
        Some(home) if !home.is_empty() => Some(PathBuf::from(home)),
        #[allow(deprecated)]
        _ => std::env::home_dir(),
    }
}

/// The app home: `LANEWORK_HOME`, else `~/.lanew`.
pub fn app_home() -> PathBuf {
    match std::env::var_os("LANEWORK_HOME") {
        Some(home) if !home.is_empty() => PathBuf::from(home),
        _ => home_dir().unwrap_or_default().join(".lanew"),
    }
}

/// The path this binary runs from, symlinks resolved (`~/.lanew/bin/lwk`
/// is one).
pub fn self_path() -> Option<PathBuf> {
    std::env::current_exe().and_then(std::fs::canonicalize).ok()
}

/// Node's `normalizeString`: `path`'s segments with `.` dropped and `..`
/// folded; a `..` with nothing left to fold is kept when `above_root`.
fn normalize_segments(path: &str, above_root: bool) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if above_root {
                    parts.push("..");
                }
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

/// Node's `path.posix.normalize`.
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut body = normalize_segments(path, !absolute);
    if body.is_empty() {
        if absolute {
            return "/".to_owned();
        }
        return if trailing { "./" } else { "." }.to_owned();
    }
    if trailing {
        body.push('/');
    }
    if absolute {
        format!("/{body}")
    } else {
        body
    }
}

/// Node's `path.posix.join(a, b)`.
pub fn join(a: &str, b: &str) -> String {
    let joined = match (a.is_empty(), b.is_empty()) {
        (true, true) => return ".".to_owned(),
        (false, true) => a.to_owned(),
        (true, false) => b.to_owned(),
        (false, false) => format!("{a}/{b}"),
    };
    normalize(&joined)
}

/// Node's `path.posix.resolve(base, path)` for an absolute `base`.
pub fn resolve(base: &str, path: &str) -> String {
    let joined = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{base}/{path}")
    };
    format!("/{}", normalize_segments(&joined, false))
}
