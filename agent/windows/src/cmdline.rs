//! Building a Win32 command line out of an argv, and taking one apart again.
//!
//! Windows passes a single string and lets the callee parse it, so an argument
//! containing a space, a quote or a trailing backslash has to be escaped the
//! way the C runtime expects to unescape it. `C:\Users\Ann Marie\` is an
//! ordinary path here, and it is exactly the shape that gets this wrong.

/// Quote one argument for `CreateProcessW`, using the CRT's rules.
pub fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"', '\n', '\u{b}']) {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        match ch {
            '\\' => {
                backslashes += 1;
                out.push('\\');
            }
            '"' => {
                // Backslashes before a quote are doubled, then the quote escaped.
                for _ in 0..backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push('\\');
                out.push('"');
            }
            other => {
                backslashes = 0;
                out.push(other);
            }
        }
    }
    // Backslashes before the closing quote are doubled too, or they would
    // escape it.
    for _ in 0..backslashes {
        out.push('\\');
    }
    out.push('"');
    out
}

/// Join an argv (program first) into a command line.
pub fn join<S: AsRef<str>>(args: &[S]) -> String {
    args.iter().map(|a| quote(a.as_ref())).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_arguments_are_left_alone() {
        assert_eq!(quote("pwsh.exe"), "pwsh.exe");
        assert_eq!(quote("-NoLogo"), "-NoLogo");
        assert_eq!(quote("-d"), "-d");
    }

    #[test]
    fn spaces_and_empties_get_quotes() {
        assert_eq!(quote(r"C:\Program Files\PowerShell\7\pwsh.exe"), r#""C:\Program Files\PowerShell\7\pwsh.exe""#);
        assert_eq!(quote(""), r#""""#);
        assert_eq!(quote("Ubuntu 22.04"), r#""Ubuntu 22.04""#);
    }

    #[test]
    fn a_trailing_backslash_does_not_escape_the_closing_quote() {
        // The classic: a directory argument that ends in a separator.
        assert_eq!(quote(r"C:\Users\Ann Marie\"), r#""C:\Users\Ann Marie\\""#);
    }

    #[test]
    fn embedded_quotes_survive() {
        assert_eq!(quote(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote(r#"a\"b"#), r#""a\\\"b""#);
    }

    #[test]
    fn join_puts_the_program_first() {
        let line = join(&[r"C:\Program Files\nodejs\node.exe", "-e", "console.log(1)"]);
        assert_eq!(line, r#""C:\Program Files\nodejs\node.exe" -e console.log(1)"#);
    }
}
