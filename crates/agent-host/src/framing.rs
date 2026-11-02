//! Newline-delimited frame reader with a hard per-line size limit.

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

#[derive(Debug)]
pub enum Frame {
    Line(String),
    /// A line exceeded the limit; its bytes were discarded.
    TooLong(usize),
    /// Line was not valid UTF-8.
    InvalidUtf8,
}

/// Reads one `\n`-terminated line, discarding (but reporting) oversized lines
/// without buffering them fully. Returns `Ok(None)` at EOF.
pub async fn read_frame<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max_len: usize,
) -> std::io::Result<Option<Frame>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut discarded: usize = 0;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            // EOF
            if buf.is_empty() && discarded == 0 {
                return Ok(None);
            }
            break;
        }
        let (chunk, found_newline) = match available.iter().position(|b| *b == b'\n') {
            Some(i) => (&available[..i], Some(i)),
            None => (available, None),
        };
        if discarded > 0 || buf.len() + chunk.len() > max_len {
            discarded += buf.len() + chunk.len();
            buf.clear();
        } else {
            buf.extend_from_slice(chunk);
        }
        let consumed = match found_newline {
            Some(i) => i + 1,
            None => available.len(),
        };
        reader.consume(consumed);
        if found_newline.is_some() {
            break;
        }
    }
    if discarded > 0 {
        return Ok(Some(Frame::TooLong(discarded)));
    }
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    match String::from_utf8(buf) {
        Ok(s) => Ok(Some(Frame::Line(s))),
        Err(_) => Ok(Some(Frame::InvalidUtf8)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn reads_lines_and_limits() {
        let data = format!("{{\"a\":1}}\n{}\nshort\r\nlast", "x".repeat(100));
        let mut r = BufReader::with_capacity(8, data.as_bytes());
        let f1 = read_frame(&mut r, 50).await.unwrap().unwrap();
        assert!(matches!(f1, Frame::Line(ref s) if s == "{\"a\":1}"));
        let f2 = read_frame(&mut r, 50).await.unwrap().unwrap();
        assert!(matches!(f2, Frame::TooLong(100)));
        let f3 = read_frame(&mut r, 50).await.unwrap().unwrap();
        assert!(matches!(f3, Frame::Line(ref s) if s == "short"));
        let f4 = read_frame(&mut r, 50).await.unwrap().unwrap();
        assert!(matches!(f4, Frame::Line(ref s) if s == "last"));
        assert!(read_frame(&mut r, 50).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn invalid_utf8() {
        let data: &[u8] = &[0xff, 0xfe, b'\n'];
        let mut r = BufReader::new(data);
        assert!(matches!(
            read_frame(&mut r, 50).await.unwrap().unwrap(),
            Frame::InvalidUtf8
        ));
    }
}
