//! A reader for exactly one shape of JSON: the flat objects the agent's
//! control channel answers with.
//!
//! A whole JSON crate would be a strange dependency for reading six scalar
//! fields out of a document this program's sibling produced. What it must get
//! right is not being fooled by a *value* that happens to contain the text of
//! a key — `{"error":"no \"name\" given","name":"prod"}` — which is why the
//! scanner walks keys and values in order instead of searching for a substring.

/// Position just past the colon of top-level key `key`, or None.
fn seek(src: &str, key: &str) -> Option<usize> {
    let b = src.as_bytes();
    let mut i = 0;
    let mut depth = 0i32;
    while i < b.len() {
        match b[i] {
            b'{' | b'[' => {
                depth += 1;
                i += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                i += 1;
            }
            b'"' => {
                let (text, next) = read_string(src, i)?;
                i = next;
                // A string is a key only at depth 1 and when a colon follows.
                let mut j = i;
                while j < b.len() && (b[j] as char).is_ascii_whitespace() {
                    j += 1;
                }
                if depth == 1 && j < b.len() && b[j] == b':' {
                    if text == key {
                        return Some(j + 1);
                    }
                    // Skip the value so its contents are never mistaken for keys.
                    i = skip_value(src, j + 1)?;
                }
            }
            _ => i += 1,
        }
    }
    None
}

/// Reads the string starting at the quote at `at`; returns it and the index after it.
fn read_string(src: &str, at: usize) -> Option<(String, usize)> {
    let b = src.as_bytes();
    debug_assert_eq!(b[at], b'"');
    let mut out = String::new();
    let mut i = at + 1;
    while i < b.len() {
        match b[i] {
            b'"' => return Some((out, i + 1)),
            b'\\' => {
                i += 1;
                let c = *b.get(i)?;
                out.push(match c {
                    b'n' => '\n',
                    b't' => '\t',
                    b'r' => '\r',
                    b'b' => '\u{8}',
                    b'f' => '\u{c}',
                    b'u' => {
                        let hex = src.get(i + 1..i + 5)?;
                        let code = u32::from_str_radix(hex, 16).ok()?;
                        i += 4;
                        char::from_u32(code).unwrap_or('\u{fffd}')
                    }
                    other => other as char,
                });
                i += 1;
            }
            _ => {
                // Copy whole UTF-8 sequences, not bytes.
                let rest = &src[i..];
                let ch = rest.chars().next()?;
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    None
}

/// Index just past the value that starts at or after `from`.
fn skip_value(src: &str, from: usize) -> Option<usize> {
    let b = src.as_bytes();
    let mut i = from;
    while i < b.len() && (b[i] as char).is_ascii_whitespace() {
        i += 1;
    }
    match *b.get(i)? {
        b'"' => Some(read_string(src, i)?.1),
        b'{' | b'[' => {
            let mut depth = 0i32;
            while i < b.len() {
                match b[i] {
                    b'"' => i = read_string(src, i)?.1,
                    b'{' | b'[' => {
                        depth += 1;
                        i += 1;
                    }
                    b'}' | b']' => {
                        depth -= 1;
                        i += 1;
                        if depth == 0 {
                            return Some(i);
                        }
                    }
                    _ => i += 1,
                }
            }
            None
        }
        _ => {
            while i < b.len() && !matches!(b[i], b',' | b'}' | b']') {
                i += 1;
            }
            Some(i)
        }
    }
}

fn raw(src: &str, key: &str) -> Option<String> {
    let at = seek(src, key)?;
    let end = skip_value(src, at)?;
    Some(src[at..end].trim().to_string())
}

/// A string field. Returns None for a missing field or a `null`.
pub fn str_of(src: &str, key: &str) -> Option<String> {
    let at = seek(src, key)?;
    let b = src.as_bytes();
    let mut i = at;
    while i < b.len() && (b[i] as char).is_ascii_whitespace() {
        i += 1;
    }
    if *b.get(i)? != b'"' {
        return None;
    }
    Some(read_string(src, i)?.0)
}

pub fn bool_of(src: &str, key: &str) -> Option<bool> {
    match raw(src, key)?.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

pub fn num_of(src: &str, key: &str) -> Option<f64> {
    raw(src, key)?.parse().ok()
}

pub fn i64_of(src: &str, key: &str) -> Option<i64> {
    num_of(src, key).map(|n| n as i64)
}

/// Quote a string for a request we build by hand.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATUS: &str = r#"{"ok":true,"version":"0.9.0","pid":4321,"name":"Office PC",
        "connected":true,"registered":false,"sessions":3,"uptimeSec":91234,
        "logFile":"C:\\ProgramData\\RemoteTerminal\\logs\\agent.log","lastError":null}"#;

    #[test]
    fn reads_scalars() {
        assert_eq!(bool_of(STATUS, "ok"), Some(true));
        assert_eq!(bool_of(STATUS, "registered"), Some(false));
        assert_eq!(str_of(STATUS, "name").as_deref(), Some("Office PC"));
        assert_eq!(i64_of(STATUS, "sessions"), Some(3));
        assert_eq!(i64_of(STATUS, "uptimeSec"), Some(91234));
    }

    #[test]
    fn unescapes_windows_paths() {
        assert_eq!(
            str_of(STATUS, "logFile").as_deref(),
            Some(r"C:\ProgramData\RemoteTerminal\logs\agent.log")
        );
    }

    #[test]
    fn null_and_missing_read_as_absent() {
        assert_eq!(str_of(STATUS, "lastError"), None);
        assert_eq!(str_of(STATUS, "nothing"), None);
        assert_eq!(bool_of(STATUS, "nothing"), None);
    }

    #[test]
    fn a_value_is_never_mistaken_for_a_key() {
        let tricky = r#"{"error":"the \"name\" field is required","name":"real"}"#;
        assert_eq!(str_of(tricky, "name").as_deref(), Some("real"));
        assert_eq!(
            str_of(tricky, "error").as_deref(),
            Some("the \"name\" field is required")
        );
    }

    #[test]
    fn nested_objects_do_not_leak_their_keys() {
        let nested = r#"{"meta":{"code":"inner"},"code":"outer"}"#;
        assert_eq!(str_of(nested, "code").as_deref(), Some("outer"));
    }

    #[test]
    fn quote_escapes_what_a_path_contains() {
        assert_eq!(quote(r"C:\x"), r#""C:\\x""#);
        assert_eq!(quote("a\"b"), r#""a\"b""#);
    }
}
