//! `lwk find|grep|sg|ls|sessions`: the flags, the call to the app's kit
//! socket, and the output. The JS kit (`electron/lwk/commands.ts`) is the
//! same command for when no app answers, and both print the same bytes.
//!
//! - Flags mirror the tools' inputs (`KIT_TOOLS`, packages/protocol); the
//!   kit checks them, so a bad value fails with the kit's own words.
//! - `--json` prints the tool's answer as the MCP server does. Otherwise one
//!   line per hit: `path:line: text` for grep and sg, a path for find and
//!   ls, a heading and its snippets per session.
//! - Paths are relative to the folder searched, and prefixed with FOLDER as
//!   it was typed when there is one, as grep and rg print them.
//! - Exit code: 0 found, 1 nothing found (ls: 0 always), 2 an error. A cut
//!   answer says so on stderr.
//!
//! The socket (`electron/main/kit-socket.ts` has the wire format): no socket
//! file, a refused or slow connect (over [`CONNECT`]), a connection closed
//! before the answer, an answer that is not JSON, or an app too busy to take
//! the call, and lwk hands the same argv to the JS kit (`fallback.rs`). An
//! error the app answered is final: running the call again would only
//! repeat it. Every kit tool only reads, so a call run twice is harmless.

use crate::{fallback, jsonjs, out, paths};
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long a connect may take before lwk runs the tool without the app.
const CONNECT: Duration = Duration::from_millis(150);
/// The longest a call may take; the kit's own searches stop well before.
const ANSWER: Duration = Duration::from_secs(60);

/// The error codes the kit answers with (`KitErrorCode`).
const KNOWN_CODES: [&str; 8] = [
    "invalid",
    "scope",
    "not_found",
    "unavailable",
    "timeout",
    "aborted",
    "busy",
    "internal",
];

/// A command's tool, as the socket names it.
fn tool(command: &str) -> &'static str {
    match command {
        "find" => "find_files",
        "grep" => "search_text",
        "sg" => "search_structural",
        "ls" => "list_files",
        _ => "search_sessions",
    }
}

/// The input a flag of `command` sets, or None when it has no such flag.
fn flag(command: &str, name: &str) -> Option<&'static str> {
    if name == "--limit" {
        return Some("limit");
    }
    match (command, name) {
        ("grep", "-E" | "--regex") => Some("regex"),
        ("grep", "-F" | "--fixed-strings") => Some("fixed"),
        ("grep", "-i" | "--ignore-case") => Some("ignore_case"),
        ("grep", "-s" | "--case-sensitive") => Some("case_sensitive"),
        ("grep", "-g" | "--glob") => Some("globs"),
        ("sg", "--lang") => Some("lang"),
        _ => None,
    }
}

/// Flags that take a value.
fn valued(name: &str) -> bool {
    matches!(name, "-g" | "--glob" | "--lang" | "--limit")
}

struct Parsed {
    params: Map<String, Value>,
    /// FOLDER as typed, to prefix the paths printed.
    folder: Option<String>,
    json: bool,
}

/// `--limit`'s value as `Number()` reads it; a bad number goes to the kit
/// as it was typed, to be refused in the kit's words.
fn limit_value(text: &str) -> Value {
    match jsonjs::number(text) {
        Some(x) if x.is_finite() => {
            if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
                Value::from(x as i64)
            } else {
                serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
            }
        }
        _ => Value::String(text.to_owned()),
    }
}

/// `lwk COMMAND ARGS` as the tool's params, or the message for a bad one.
fn parse(command: &str, args: &[String]) -> Result<Parsed, String> {
    let mut positional: Vec<String> = Vec::new();
    let mut params = Map::new();
    let mut json = false;
    let mut literal = false;
    let mut i = 0;
    while i < args.len() {
        let raw = &args[i];
        i += 1;
        if literal || raw == "-" || !raw.starts_with('-') {
            positional.push(raw.clone());
            continue;
        }
        if raw == "--" {
            literal = true;
            continue;
        }
        let mut name = raw.as_str();
        let mut value: Option<String> = None;
        if raw.starts_with("--") {
            if let Some(eq) = raw.find('=') {
                value = Some(raw[eq + 1..].to_owned());
                name = &raw[..eq];
            }
        }
        if name == "--json" {
            json = true;
            continue;
        }
        let Some(input) = flag(command, name) else {
            return Err(format!("unknown option {name}. See lwk help."));
        };
        if valued(name) {
            if value.is_none() {
                value = args.get(i).cloned();
                i += 1;
            }
            if value.is_none() {
                return Err(format!("{name} needs a value."));
            }
        } else if value.is_some() {
            return Err(format!("{name} takes no value."));
        }
        let value = value.unwrap_or_default();
        match input {
            "limit" => {
                params.insert("limit".into(), limit_value(&value));
            }
            "globs" => {
                let globs = params
                    .entry("globs")
                    .or_insert_with(|| Value::Array(Vec::new()));
                if let Value::Array(list) = globs {
                    list.push(Value::String(value));
                }
            }
            "lang" => {
                params.insert("lang".into(), Value::String(value));
            }
            "regex" => {
                params.insert("regex".into(), Value::Bool(true));
            }
            "fixed" => {
                params.insert("regex".into(), Value::Bool(false));
            }
            "ignore_case" => {
                params.insert("case_sensitive".into(), Value::Bool(false));
            }
            _ => {
                params.insert("case_sensitive".into(), Value::Bool(true));
            }
        }
    }
    let wants_query = command != "ls";
    let max = if wants_query { 2 } else { 1 };
    if positional.len() > max || (wants_query && positional.is_empty()) {
        let query = match (wants_query, command) {
            (false, _) => "",
            (true, "sg") => "PATTERN ",
            (true, _) => "QUERY ",
        };
        return Err(format!("Usage: lwk {command} {query}[FOLDER]"));
    }
    let mut positional = positional.into_iter();
    if wants_query {
        let key = if command == "sg" { "pattern" } else { "query" };
        params.insert(
            key.into(),
            Value::String(positional.next().unwrap_or_default()),
        );
    }
    let folder = positional.next();
    if let Some(folder) = &folder {
        params.insert("folder".into(), Value::String(folder.clone()));
    }
    Ok(Parsed {
        params,
        folder,
        json,
    })
}

/// What the app said.
enum Answer {
    /// No app to answer: run the tool without it.
    Absent,
    /// The app's error for this call: its message.
    Failed(String),
    /// The app's result, as it came; None when the answer had none.
    Result(Option<Box<RawValue>>),
}

/// Connect to `path`, giving up after [`CONNECT`].
///
/// NOTE: On a thread, as std has no connect timeout for a unix socket. A
/// connect that hangs past it is left behind: lwk goes on to exec() the JS
/// kit or exits, and the thread goes with the process.
fn connect(path: &Path) -> Option<UnixStream> {
    let (sender, receiver) = mpsc::channel();
    let path: PathBuf = path.to_owned();
    std::thread::spawn(move || {
        let _ = sender.send(UnixStream::connect(path));
    });
    receiver.recv_timeout(CONNECT).ok()?.ok()
}

/// Call `method` in the running app, from `cwd`.
fn call_app(method: &str, params: &Map<String, Value>, cwd: &str) -> Answer {
    let path = paths::app_home().join("run").join("kit.sock");
    if !path.exists() {
        return Answer::Absent;
    }
    let Some(mut stream) = connect(&path) else {
        return Answer::Absent;
    };
    let mut call_params = params.clone();
    call_params.insert("cwd".into(), Value::String(cwd.to_owned()));
    let mut request = Map::new();
    request.insert("id".into(), Value::from(1));
    request.insert("method".into(), Value::String(method.to_owned()));
    request.insert("params".into(), Value::Object(call_params));
    let mut line = Value::Object(request).to_string();
    line.push('\n');
    if stream.write_all(line.as_bytes()).is_err() {
        return Answer::Absent;
    }

    let deadline = Instant::now() + ANSWER;
    let mut buffered: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    let end = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || stream.set_read_timeout(Some(left)).is_err() {
            return Answer::Failed("The app did not answer.".into());
        }
        match stream.read(&mut chunk) {
            // Closed before answering: the app quit mid-call.
            Ok(0) => return Answer::Absent,
            Ok(read) => {
                let from = buffered.len();
                buffered.extend_from_slice(&chunk[..read]);
                if let Some(at) = buffered[from..].iter().position(|b| *b == b'\n') {
                    break from + at;
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                return Answer::Failed("The app did not answer.".into());
            }
            Err(_) => return Answer::Absent,
        }
    };
    let text = String::from_utf8_lossy(&buffered[..end]);
    let Ok(mut answer) = serde_json::from_str::<HashMap<String, Box<RawValue>>>(&text) else {
        return Answer::Absent;
    };
    let error: Option<Value> = answer
        .get("error")
        .and_then(|raw| serde_json::from_str(raw.get()).ok());
    if !jsonjs::truthy(error.as_ref()) {
        return Answer::Result(answer.remove("result"));
    }
    let error = error.unwrap_or(Value::Null);
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .filter(|code| KNOWN_CODES.contains(code))
        .unwrap_or("internal");
    // Busy is the app's load, not this call's fault: run it without the app.
    if code == "busy" {
        return Answer::Absent;
    }
    let message = match error.get("message") {
        None | Some(Value::Null) => String::new(),
        message => jsonjs::template(message),
    };
    Answer::Failed(message)
}

/// `path` as printed: under FOLDER as typed, when one was.
fn shown(path: Option<&Value>, folder: Option<&str>) -> String {
    let path = jsonjs::template(path);
    match folder {
        None => path,
        Some(folder) => paths::join(folder, &path),
    }
}

/// Say on stderr that the answer was cut, and how to see more.
fn note_cut(what: &str) {
    eprintln!("lwk: stopped at the {what} limit; pass --limit N for more, or narrow the folder.");
}

/// Print the app's answer to `tool`. Returns the exit code, or None for an
/// answer not of the tool's shape.
fn print(tool: &str, raw: &RawValue, parsed: &Parsed) -> Option<i32> {
    let result: Value = serde_json::from_str(raw.get()).ok()?;
    let folder = parsed.folder.as_deref();
    let json = parsed.json;
    match tool {
        "find_files" => {
            let files = result.as_array()?;
            if json {
                out(&format!("{{\"files\":{}}}\n", raw.get()));
            } else if !files.is_empty() {
                let lines: Vec<String> = files
                    .iter()
                    .map(|hit| shown(hit.get("path"), folder))
                    .collect();
                out(&format!("{}\n", lines.join("\n")));
            }
            Some(if files.is_empty() { 1 } else { 0 })
        }
        "search_text" | "search_structural" => {
            let matches = result.as_array()?;
            if json {
                out(&format!("{{\"matches\":{}}}\n", raw.get()));
            } else {
                let mut lines: Vec<String> = Vec::new();
                for file in matches {
                    let path = shown(file.get("path"), folder);
                    for line in file.get("lines")?.as_array()? {
                        lines.push(format!(
                            "{path}:{}: {}",
                            jsonjs::template(line.get("line")),
                            jsonjs::template(line.get("text")),
                        ));
                    }
                }
                if !lines.is_empty() {
                    out(&format!("{}\n", lines.join("\n")));
                }
            }
            let cut = matches.last().and_then(|last| last.get("truncated"));
            if jsonjs::truthy(cut) && !json {
                note_cut("file");
            }
            Some(if matches.is_empty() { 1 } else { 0 })
        }
        "list_files" => {
            let files = result.get("files")?.as_array()?;
            if json {
                out(&format!("{}\n", raw.get()));
            } else if !files.is_empty() {
                let lines: Vec<String> =
                    files.iter().map(|path| shown(Some(path), folder)).collect();
                out(&format!("{}\n", lines.join("\n")));
            }
            if jsonjs::truthy(result.get("truncated")) && !json {
                note_cut("path");
            }
            Some(0)
        }
        _ => {
            let sessions = result.as_array()?;
            if json {
                out(&format!("{{\"sessions\":{}}}\n", raw.get()));
            } else {
                let mut blocks: Vec<String> = Vec::new();
                for session in sessions {
                    let mut block = [
                        session.get("harness"),
                        session.get("sessionId"),
                        session.get("at"),
                        session.get("title"),
                    ]
                    .map(jsonjs::template)
                    .join(" ");
                    for line in session.get("lines")?.as_array()? {
                        block.push_str(&format!(
                            "\n  {}: {}",
                            jsonjs::template(line.get("line")),
                            jsonjs::template(line.get("text")),
                        ));
                    }
                    blocks.push(block);
                }
                if !blocks.is_empty() {
                    out(&format!("{}\n", blocks.join("\n\n")));
                }
            }
            Some(if sessions.is_empty() { 1 } else { 0 })
        }
    }
}

/// Run `lwk COMMAND ARGS`. Returns the exit code; exec()s the JS kit when
/// no app answers.
pub fn run(command: &str, args: &[OsString]) -> i32 {
    let text: Vec<String> = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let parsed = match parse(command, &text) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("lwk {command}: {message}");
            return 2;
        }
    };
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd.to_string_lossy().into_owned(),
        Err(error) => {
            eprintln!("lwk {command}: {error}");
            return 2;
        }
    };
    let tool = tool(command);
    match call_app(tool, &parsed.params, &cwd) {
        Answer::Absent => fallback::exec_standalone(command.as_ref(), args),
        Answer::Failed(message) => {
            eprintln!("lwk {command}: {message}");
            2
        }
        Answer::Result(raw) => match raw.as_deref().and_then(|raw| print(tool, raw, &parsed)) {
            Some(code) => code,
            None => {
                eprintln!("lwk {command}: the app's answer was not understood.");
                2
            }
        },
    }
}
