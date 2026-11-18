//! The JS kit, for when the app is not there to answer, and for `lwk hook`:
//! lwk exec()s the app's own Node on the bundled `standalone.cjs`
//! (`electron/lwk/cli.ts`) with the same arguments.
//!
//! ```text
//! ELECTRON_RUN_AS_NODE=1 <app executable> <dist/electron/lwk/standalone.cjs> ARGS...
//! ```
//!
//! - The script sits beside lwk's own folder: `dist/electron/bin/lwk-<arch>`
//!   → `dist/electron/lwk/standalone.cjs`, both unpacked from the asar.
//! - The Node: `LWK_NODE` when set; packaged, the app's executable,
//!   `<App>.app/Contents/MacOS/<it>`, found from lwk's own path under
//!   `Contents/Resources/app.asar.unpacked/`; otherwise (a dev build)
//!   `node` on PATH.
//! - `LWK_SELF` tells the script which lwk ran it: `lwk hook on` writes
//!   that path into the settings when `~/.lanew/bin/lwk` is not installed.

use std::ffi::{OsStr, OsString};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The app executable of the `.app` bundle lwk was packaged in, if any.
fn app_executable(me: &Path) -> Option<PathBuf> {
    let unpacked = me
        .ancestors()
        .find(|dir| dir.file_name() == Some(OsStr::new("app.asar.unpacked")))?;
    let contents = unpacked.parent()?.parent()?;
    if contents.file_name() != Some(OsStr::new("Contents")) {
        return None;
    }
    let bundle_name = contents.parent()?.file_stem().map(OsStr::to_os_string);
    let macos = contents.join("MacOS");
    let executables: Vec<PathBuf> = std::fs::read_dir(&macos)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            std::fs::metadata(path)
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
        .collect();
    match executables.as_slice() {
        [only] => Some(only.clone()),
        // More than one: the one named after the bundle, as Info.plist's
        // CFBundleExecutable is by electron-builder.
        _ => executables
            .into_iter()
            .find(|path| path.file_name().map(OsStr::to_os_string) == bundle_name),
    }
}

/// The Node that runs the JS kit.
fn runtime(me: &Path) -> PathBuf {
    if let Some(node) = std::env::var_os("LWK_NODE").filter(|node| !node.is_empty()) {
        return PathBuf::from(node);
    }
    app_executable(me).unwrap_or_else(|| PathBuf::from("node"))
}

/// exec() the JS kit with `command args...`. Returns the exit code only
/// when that failed.
pub fn exec_standalone(command: &OsStr, args: &[OsString]) -> i32 {
    let name = command.to_string_lossy();
    let Some(me) = crate::paths::self_path() else {
        eprintln!("lwk {name}: cannot find lwk's own path.");
        return 2;
    };
    let script = me
        .parent()
        .and_then(Path::parent)
        .map(|electron| electron.join("lwk").join("standalone.cjs"))
        .filter(|script| script.is_file());
    let Some(script) = script else {
        eprintln!(
            "lwk {name}: the kit's script is missing beside {}; rebuild the app (bun run build).",
            me.display()
        );
        return 2;
    };
    let node = runtime(&me);
    let error = Command::new(&node)
        .arg(&script)
        .arg(command)
        .args(args)
        .env("ELECTRON_RUN_AS_NODE", "1")
        .env("LWK_SELF", &me)
        .exec();
    eprintln!(
        "lwk {name}: {} could not run the kit: {error}",
        node.display()
    );
    2
}
