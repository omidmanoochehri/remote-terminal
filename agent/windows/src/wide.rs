//! UTF-16 helpers. Every Win32 call here is the W variant, because a machine
//! name or a path may contain anything a user can type.

use std::ffi::OsStr;
use std::os::windows::ffi::{OsStrExt, OsStringExt};

/// A NUL-terminated UTF-16 buffer. Keep the returned Vec alive for the call.
pub fn w(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

/// Read back a NUL-terminated UTF-16 buffer Windows filled in.
pub fn from_w(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    std::ffi::OsString::from_wide(&buf[..end])
        .to_string_lossy()
        .into_owned()
}

/// Copy a string into a fixed-size UTF-16 array field, truncating safely.
/// Win32 structs are full of these ([u16; 128] tooltips and the like).
pub fn fill(dst: &mut [u16], s: &str) {
    let src: Vec<u16> = s.encode_utf16().collect();
    let n = src.len().min(dst.len().saturating_sub(1));
    dst[..n].copy_from_slice(&src[..n]);
    dst[n] = 0;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_utf16() {
        let buf = w("Büro-PC");
        assert_eq!(*buf.last().unwrap(), 0);
        assert_eq!(from_w(&buf), "Büro-PC");
    }

    #[test]
    fn fill_truncates_and_always_terminates() {
        let mut dst = [0u16; 5];
        fill(&mut dst, "abcdefgh");
        assert_eq!(from_w(&dst), "abcd");
        fill(&mut dst, "ab");
        assert_eq!(from_w(&dst), "ab");
    }
}
