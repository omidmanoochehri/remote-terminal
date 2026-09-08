//! The little protocol the agent speaks to `remote-terminal-shell.exe`.
//!
//! The launcher's stdout is the terminal's output, raw, exactly as a PTY would
//! give it. Its stdin has to carry two different things — keystrokes and the
//! occasional resize — so it is framed:
//!
//! ```text
//!   0x01  len:u32le  payload      bytes for the shell
//!   0x02  cols:u16le rows:u16le   the window changed size
//! ```
//!
//! Little-endian because both ends are Windows, and length-prefixed because a
//! phone can paste a megabyte into a terminal and the frame has to survive
//! being split across reads.
//!
//! The encoder lives in `agent/lib/win-user-pty.js`; keep the two in step.

/// The maximum payload a single data frame may claim. The agent caps input
/// well below this; a larger length means the stream is out of sync, and
/// carrying on would feed the shell garbage.
pub const MAX_PAYLOAD: usize = 4 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    Data(Vec<u8>),
    Resize(u16, u16),
    /// The stream is not a frame stream. The caller stops reading.
    Corrupt(&'static str),
}

/// Reassembles frames from however the pipe happens to deliver bytes.
#[derive(Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn new() -> FrameReader {
        FrameReader { buf: Vec::new() }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// The next complete frame, or `None` while one is still arriving.
    pub fn next(&mut self) -> Option<Frame> {
        match self.buf.first() {
            None => None,
            Some(1) => {
                if self.buf.len() < 5 {
                    return None;
                }
                let len = u32::from_le_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]) as usize;
                if len > MAX_PAYLOAD {
                    return Some(Frame::Corrupt("data frame is impossibly long"));
                }
                if self.buf.len() < 5 + len {
                    return None;
                }
                let payload = self.buf[5..5 + len].to_vec();
                self.buf.drain(..5 + len);
                Some(Frame::Data(payload))
            }
            Some(2) => {
                if self.buf.len() < 5 {
                    return None;
                }
                let cols = u16::from_le_bytes([self.buf[1], self.buf[2]]);
                let rows = u16::from_le_bytes([self.buf[3], self.buf[4]]);
                self.buf.drain(..5);
                Some(Frame::Resize(cols, rows))
            }
            Some(_) => Some(Frame::Corrupt("unknown frame type")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(payload: &[u8]) -> Vec<u8> {
        let mut v = vec![1u8];
        v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        v.extend_from_slice(payload);
        v
    }

    fn resize(cols: u16, rows: u16) -> Vec<u8> {
        let mut v = vec![2u8];
        v.extend_from_slice(&cols.to_le_bytes());
        v.extend_from_slice(&rows.to_le_bytes());
        v
    }

    #[test]
    fn reads_frames_back_to_back() {
        let mut r = FrameReader::new();
        r.push(&data(b"ls\r"));
        r.push(&resize(120, 40));
        r.push(&data(b""));
        assert_eq!(r.next(), Some(Frame::Data(b"ls\r".to_vec())));
        assert_eq!(r.next(), Some(Frame::Resize(120, 40)));
        assert_eq!(r.next(), Some(Frame::Data(Vec::new())));
        assert_eq!(r.next(), None);
    }

    #[test]
    fn a_frame_split_across_reads_is_reassembled() {
        // A paste arrives in whatever pieces the pipe felt like; nothing may be
        // emitted until the whole payload is in hand.
        let whole = data("héllo wörld".as_bytes());
        let mut r = FrameReader::new();
        for byte in &whole[..whole.len() - 1] {
            r.push(std::slice::from_ref(byte));
            assert_eq!(r.next(), None);
        }
        r.push(&whole[whole.len() - 1..]);
        assert_eq!(r.next(), Some(Frame::Data("héllo wörld".as_bytes().to_vec())));
    }

    #[test]
    fn a_resize_split_across_reads_is_reassembled() {
        let mut r = FrameReader::new();
        r.push(&[2u8, 80]);
        assert_eq!(r.next(), None);
        r.push(&[0, 24, 0]);
        assert_eq!(r.next(), Some(Frame::Resize(80, 24)));
    }

    #[test]
    fn desync_is_reported_rather_than_fed_to_the_shell() {
        let mut r = FrameReader::new();
        r.push(b"hello");
        assert!(matches!(r.next(), Some(Frame::Corrupt(_))));

        let mut long = FrameReader::new();
        long.push(&[1u8]);
        long.push(&u32::MAX.to_le_bytes());
        assert!(matches!(long.next(), Some(Frame::Corrupt(_))));
    }

    #[test]
    fn a_big_paste_survives_in_one_frame() {
        let big = vec![b'x'; 512 * 1024];
        let mut r = FrameReader::new();
        r.push(&data(&big));
        assert_eq!(r.next(), Some(Frame::Data(big)));
    }
}
