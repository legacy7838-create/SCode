//! VQL (Variable-Length Quantity) encoding/decoding.
//!
//! Format: 7 bits per byte, high bit = more bytes follow.
//! - 0 → [0x00]
//! - 127 → [0x7F]
//! - 128 → [0x80, 0x01]

use crate::CodecError;

// ============================================================================
// VqlReader — reads VQL integers and raw bytes from a byte slice
// ============================================================================

/// A cursor over a borrowed byte slice that can decode VQL-encoded integers
/// and read raw bytes, matching the TS `readIntVQL` + `IReader` behavior.
pub struct VqlReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> VqlReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    /// Step the cursor back by one byte.
    ///
    /// Used when a type tag has already been consumed to make a dispatch
    /// decision, and the full decoder has to read that same tag again.
    pub fn rewind_one(&mut self) {
        self.pos = self.pos.saturating_sub(1);
    }

    /// Read a VQL-encoded u32 (7 bits per byte, high bit = continuation).
    pub fn read_vql(&mut self) -> Result<u32, CodecError> {
        let mut value: u32 = 0;
        for n in (0..).step_by(7) {
            let byte = self.read_u8()?;
            value |= ((byte & 0x7F) as u32) << n;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        unreachable!()
    }

    /// Read exactly `len` bytes (zero-copy borrow).
    pub fn read_bytes(&mut self, len: usize) -> Result<&'a [u8], CodecError> {
        if self.pos + len > self.data.len() {
            return Err(CodecError::UnexpectedEof);
        }
        let slice = &self.data[self.pos..self.pos + len];
        self.pos += len;
        Ok(slice)
    }

    /// Read a single byte.
    pub fn read_u8(&mut self) -> Result<u8, CodecError> {
        if self.pos >= self.data.len() {
            return Err(CodecError::UnexpectedEof);
        }
        let byte = self.data[self.pos];
        self.pos += 1;
        Ok(byte)
    }

    /// Bytes remaining in the buffer.
    pub fn remaining(&self) -> usize {
        self.data.len() - self.pos
    }

    /// Current read position.
    pub fn position(&self) -> usize {
        self.pos
    }
}

// ============================================================================
// VqlWriter — accumulates VQL-encoded integers and raw bytes
// ============================================================================

/// An in-memory buffer that encodes VQL integers and appends raw bytes,
/// matching the TS `writeInt32VQL` + `IWriter` + `BufferWriter` behavior.
pub struct VqlWriter {
    buf: Vec<u8>,
}

impl VqlWriter {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Write a value as VQL-encoded bytes.
    /// 0 → [0x00], 127 → [0x7F], 128 → [0x80, 0x01]
    pub fn write_vql(&mut self, value: u32) {
        if value == 0 {
            self.buf.push(0x00);
            return;
        }
        // First pass: count bytes needed
        let mut tmp = value;
        let mut len = 0u32;
        while tmp != 0 {
            len += 1;
            tmp >>= 7;
        }
        // Second pass: encode (LSB first, high bit = continuation)
        let mut remaining = value;
        for i in 0..len {
            let mut byte = (remaining & 0x7F) as u8;
            remaining >>= 7;
            if i + 1 < len {
                byte |= 0x80;
            }
            self.buf.push(byte);
        }
    }

    /// Append raw bytes.
    pub fn write_bytes(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Append a single byte.
    pub fn write_u8(&mut self, byte: u8) {
        self.buf.push(byte);
    }

    /// Consume the writer, returning the accumulated bytes.
    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    /// Borrow the accumulated bytes.
    pub fn bytes(&self) -> &[u8] {
        &self.buf
    }

    /// Current length of the buffer.
    pub fn len(&self) -> usize {
        self.buf.len()
    }
}

impl Default for VqlWriter {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // --- VQL round-trip ---

    #[test]
    fn vql_zero() {
        let mut w = VqlWriter::new();
        w.write_vql(0);
        assert_eq!(w.bytes(), &[0x00]);

        let mut r = VqlReader::new(w.bytes());
        assert_eq!(r.read_vql().unwrap(), 0);
    }

    #[test]
    fn vql_127() {
        let mut w = VqlWriter::new();
        w.write_vql(127);
        assert_eq!(w.bytes(), &[0x7F]);

        let mut r = VqlReader::new(w.bytes());
        assert_eq!(r.read_vql().unwrap(), 127);
    }

    #[test]
    fn vql_128() {
        let mut w = VqlWriter::new();
        w.write_vql(128);
        assert_eq!(w.bytes(), &[0x80, 0x01]);

        let mut r = VqlReader::new(w.bytes());
        assert_eq!(r.read_vql().unwrap(), 128);
    }

    #[test]
    fn vql_max_u32() {
        let mut w = VqlWriter::new();
        w.write_vql(u32::MAX);
        let mut r = VqlReader::new(w.bytes());
        assert_eq!(r.read_vql().unwrap(), u32::MAX);
    }

    #[test]
    fn vql_sequential_round_trips() {
        let values = [0, 1, 127, 128, 255, 256, 16383, 16384, 2097151, 2097152, 268435455, 268435456, u32::MAX];
        let mut w = VqlWriter::new();
        for &v in &values {
            w.write_vql(v);
        }
        let mut r = VqlReader::new(w.bytes());
        for &v in &values {
            assert_eq!(r.read_vql().unwrap(), v);
        }
        assert_eq!(r.remaining(), 0);
    }

    // --- byte reading ---

    #[test]
    fn read_bytes_and_u8() {
        let data = [0x41, 0x42, 0x43, 0x44];
        let mut r = VqlReader::new(&data);
        assert_eq!(r.read_u8().unwrap(), 0x41);
        assert_eq!(r.read_bytes(2).unwrap(), &[0x42, 0x43]);
        assert_eq!(r.read_u8().unwrap(), 0x44);
        assert_eq!(r.remaining(), 0);
    }

    #[test]
    fn read_bytes_eof() {
        let data = [0x01];
        let mut r = VqlReader::new(&data);
        assert!(r.read_bytes(2).is_err());
    }

    #[test]
    fn read_u8_eof() {
        let data: [u8; 0] = [];
        let mut r = VqlReader::new(&data);
        assert!(r.read_u8().is_err());
    }

    // --- Writer helpers ---

    #[test]
    fn writer_into_bytes() {
        let mut w = VqlWriter::new();
        w.write_u8(0xFF);
        w.write_bytes(&[0x01, 0x02]);
        let b = w.into_bytes();
        assert_eq!(b, &[0xFF, 0x01, 0x02]);
    }

    #[test]
    fn writer_len() {
        let mut w = VqlWriter::new();
        assert_eq!(w.len(), 0);
        w.write_vql(128);
        assert_eq!(w.len(), 2);
    }
}
