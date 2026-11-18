//! JSON and values as JavaScript writes and reads them, so what lwk prints
//! is byte for byte what the JS kit (`electron/lwk/`) prints.
//!
//! - [`stringify`] is `JSON.stringify`: numbers in JavaScript's form (`1`,
//!   not serde's `1.0`; `1e+21`), strings escaped the same way.
//! - [`template`] is a value in a template literal (`${value}`).
//! - [`number`] is `Number(text)`.

use serde_json::Value;

/// `Number.prototype.toString()` for `x`.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // Rust's `{:e}` gives the shortest digits that read back as `x`, the
    // same digits JavaScript picks; only the layout differs.
    let scientific = format!("{:e}", x.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e_sign = if e >= 0 { "+" } else { "-" };
        let head = &digits[..1];
        let tail = &digits[1..];
        if tail.is_empty() {
            format!("{head}e{e_sign}{}", e.abs())
        } else {
            format!("{head}.{tail}e{e_sign}{}", e.abs())
        }
    };
    format!("{sign}{body}")
}

/// A JSON number as JavaScript holds it: a double.
fn as_f64(number: &serde_json::Number) -> f64 {
    number.as_f64().unwrap_or(f64::NAN)
}

/// `JSON.stringify(value)`, compact, appended to `out`.
pub fn stringify_into(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let x = as_f64(n);
            // JSON.stringify writes a non-finite number as null.
            if x.is_finite() {
                out.push_str(&number_to_string(x));
            } else {
                out.push_str("null");
            }
        }
        // serde escapes as JSON.stringify does: `"`, `\`, \b \f \n \r \t,
        // other control characters as lowercase \u00xx, nothing else.
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                stringify_into(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                stringify_into(item, out);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    stringify_into(value, &mut out);
    out
}

/// `${value}` in a template literal; a missing value is `undefined`.
pub fn template(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_to_string(as_f64(n)),
        Some(Value::String(s)) => s.clone(),
        // Array.prototype.toString: items joined by commas, null and
        // undefined as nothing.
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => template(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

/// JavaScript's truthiness.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => {
            let x = as_f64(n);
            x != 0.0 && !x.is_nan()
        }
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// The whitespace `Number()` trims: ECMAScript's WhiteSpace and
/// LineTerminator.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Whether `s` is a StrDecimalLiteral without its sign and without
/// `Infinity`: digits, an optional fraction, an optional exponent.
fn decimal_literal(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut digits = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == bytes.len()
}

/// `Number(text)`: None for NaN.
pub fn number(text: &str) -> Option<f64> {
    let s = text.trim_matches(js_space);
    if s.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = s.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return None;
            }
            return Some(digits.chars().fold(0.0, |acc, c| {
                acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            }));
        }
    }
    let (negative, unsigned) = match s.as_bytes()[0] {
        b'+' => (false, &s[1..]),
        b'-' => (true, &s[1..]),
        _ => (false, s),
    };
    let magnitude = if unsigned == "Infinity" {
        f64::INFINITY
    } else if decimal_literal(unsigned) {
        unsigned.parse::<f64>().ok()?
    } else {
        return None;
    };
    Some(if negative { -magnitude } else { magnitude })
}
