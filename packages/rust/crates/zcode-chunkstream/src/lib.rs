//! zcode-chunkstream — TCP fragmentation reassembly (Rust port).
//!
//! Port of `packages/rpc/src/protocol.ts` `ChunkStream` class to Rust.
//!
//! Handles TCP sticky-packet reassembly: accumulates incoming byte fragments
//! and serves up a requested number of bytes on demand via peek/skip/read.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

// ============================================================================
// Core ChunkStream
// ============================================================================

/// A single contiguous buffer for TCP byte stream reassembly.
///
/// Unlike the TypeScript original (which kept an array of `VSBuffer` chunks),
/// this implementation stores everything in one `Vec<u8>` with a `read_pos`
/// cursor. This avoids per-read iteration, reduces allocations, and improves
/// cache locality.
pub struct ChunkStream {
    buffer: Vec<u8>,
    read_pos: usize,
}

impl ChunkStream {
    pub fn new() -> Self {
        Self {
            buffer: Vec::new(),
            read_pos: 0,
        }
    }

    /// Number of readable bytes currently buffered.
    pub fn byte_length(&self) -> usize {
        self.buffer.len() - self.read_pos
    }

    /// Append raw bytes to the stream.
    pub fn accept_chunk(&mut self, chunk: Vec<u8>) {
        self.buffer.extend_from_slice(&chunk);
    }

    /// Copy `byte_count` bytes from the front of the stream WITHOUT consuming them.
    /// Returns `None` when fewer than `byte_count` bytes are available.
    pub fn peek(&self, byte_count: usize) -> Option<Vec<u8>> {
        let available = self.byte_length();
        if available < byte_count {
            return None;
        }
        let end = self.read_pos + byte_count;
        Some(self.buffer[self.read_pos..end].to_vec())
    }

    /// Discard `byte_count` bytes from the front of the stream.
    /// Returns `Err(())` when fewer than `byte_count` bytes are available.
    pub fn skip(&mut self, byte_count: usize) -> Result<(), ()> {
        if self.byte_length() < byte_count {
            return Err(());
        }
        self.read_pos += byte_count;
        // Compact when consumed data exceeds half the buffer.
        if self.read_pos > self.buffer.len() / 2 {
            self.buffer.drain(..self.read_pos);
            self.read_pos = 0;
        }
        Ok(())
    }

    /// Extract and consume the first `byte_count` bytes.
    /// Returns `None` when fewer than `byte_count` bytes are available.
    pub fn read(&mut self, byte_count: usize) -> Option<Vec<u8>> {
        let available = self.byte_length();
        if available < byte_count {
            return None;
        }
        let end = self.read_pos + byte_count;
        let result = self.buffer[self.read_pos..end].to_vec();
        self.read_pos += byte_count;
        // Compact when consumed data exceeds half the buffer.
        if self.read_pos > self.buffer.len() / 2 {
            self.buffer.drain(..self.read_pos);
            self.read_pos = 0;
        }
        Some(result)
    }
}

// ============================================================================
// NAPI exports
// ============================================================================

/// Factory function — creates a new ChunkStream wrapped in a handle.
#[napi]
pub fn create_chunk_stream() -> ChunkStreamHandle {
    ChunkStreamHandle {
        inner: ChunkStream::new(),
    }
}

/// NAPI-ergonomic handle around the core `ChunkStream`.
#[napi]
pub struct ChunkStreamHandle {
    inner: ChunkStream,
}

#[napi]
impl ChunkStreamHandle {
    /// Number of readable bytes currently buffered.
    #[napi]
    pub fn byte_length(&self) -> u32 {
        self.inner.byte_length() as u32
    }

    /// Append raw bytes to the stream.
    #[napi]
    pub fn accept_chunk(&mut self, chunk: Buffer) {
        self.inner.accept_chunk(chunk.to_vec());
    }

    /// Peek `byte_count` bytes without consuming.  Returns null when not enough.
    #[napi]
    pub fn peek(&self, byte_count: u32) -> Option<Buffer> {
        self.inner
            .peek(byte_count as usize)
            .map(|bytes| Buffer::from(bytes))
    }

    /// Discard `byte_count` bytes.  Returns false on insufficient data.
    #[napi]
    pub fn skip(&mut self, byte_count: u32) -> bool {
        self.inner.skip(byte_count as usize).is_ok()
    }

    /// Read and consume `byte_count` bytes.  Returns null when not enough.
    #[napi]
    pub fn read(&mut self, byte_count: u32) -> Option<Buffer> {
        self.inner
            .read(byte_count as usize)
            .map(|bytes| Buffer::from(bytes))
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accept_chunk_increases_byte_length() {
        let mut cs = ChunkStream::new();
        assert_eq!(cs.byte_length(), 0);

        cs.accept_chunk(vec![1, 2, 3]);
        assert_eq!(cs.byte_length(), 3);

        cs.accept_chunk(vec![4, 5]);
        assert_eq!(cs.byte_length(), 5);
    }

    #[test]
    fn peek_returns_none_when_not_enough_bytes() {
        let mut cs = ChunkStream::new();
        cs.accept_chunk(vec![1, 2, 3]);
        assert_eq!(cs.peek(4), None);
        assert_eq!(cs.peek(100), None);
    }

    #[test]
    fn peek_returns_data_without_consuming() {
        let mut cs = ChunkStream::new();
        cs.accept_chunk(vec![10, 20, 30, 40, 50]);

        let peeked = cs.peek(3).unwrap();
        assert_eq!(peeked, vec![10, 20, 30]);

        // Byte length unchanged — peek doesn't consume.
        assert_eq!(cs.byte_length(), 5);

        // Second peek returns same data.
        let peeked2 = cs.peek(3).unwrap();
        assert_eq!(peeked2, vec![10, 20, 30]);
    }

    #[test]
    fn peek_exactly_available_bytes() {
        let mut cs = ChunkStream::new();
        cs.accept_chunk(vec![1, 2, 3]);
        assert_eq!(cs.peek(3), Some(vec![1, 2, 3]));
        assert_eq!(cs.byte_length(), 3);
    }

    #[test]
    fn skip_discards_bytes() {
        let mut cs = ChunkStream::new();
        cs.accept_chunk(vec![10, 20, 30, 40, 50]);

        assert!(cs.skip(2).is_ok());
        assert_eq!(cs.byte_length(), 3);
        assert_eq!(cs.peek(3), Some(vec![30, 40, 50]));
    }

    #[test]
    fn skip_returns_err_when_insufficient() {
        let mut cs = ChunkStream::new();
        cs.accept_chunk(vec![1, 2, 3]);
        assert!(cs.skip(4).is_err());
        // Original data untouched.
        assert_eq!(cs.byte_length(), 3);
    }

    #[test]
    fn read_returns_data_and_consumes() {
        let mut cs = ChunkStream::new();
        cs.accept_chunk(vec![10, 20, 30, 40, 50]);

        let data = cs.read(3).unwrap();
        assert_eq!(data, vec![10, 20, 30]);
        assert_eq!(cs.byte_length(), 2);

        let rest = cs.read(2).unwrap();
        assert_eq!(rest, vec![40, 50]);
        assert_eq!(cs.byte_length(), 0);
    }

    #[test]
    fn read_returns_none_when_not_enough() {
        let mut cs = ChunkStream::new();
        cs.accept_chunk(vec![1, 2, 3]);
        assert_eq!(cs.read(4), None);
        assert_eq!(cs.byte_length(), 3);
    }

    #[test]
    fn multiple_chunks_reassembled_correctly() {
        let mut cs = ChunkStream::new();

        cs.accept_chunk(vec![1, 2, 3]);
        cs.accept_chunk(vec![4, 5, 6]);
        cs.accept_chunk(vec![7, 8, 9]);

        assert_eq!(cs.byte_length(), 9);

        // Peek across chunk boundaries.
        assert_eq!(cs.peek(5), Some(vec![1, 2, 3, 4, 5]));
        assert_eq!(cs.byte_length(), 9); // not consumed

        // Read across all three chunks.
        let data = cs.read(9).unwrap();
        assert_eq!(data, vec![1, 2, 3, 4, 5, 6, 7, 8, 9]);
        assert_eq!(cs.byte_length(), 0);
    }

    #[test]
    fn large_messages_across_many_chunks() {
        let mut cs = ChunkStream::new();
        let chunk_size: usize = 1024;
        let num_chunks: usize = 100;
        let total: usize = chunk_size * num_chunks;

        for i in 0..num_chunks {
            let byte = (i & 0xFF) as u8;
            cs.accept_chunk(vec![byte; chunk_size]);
        }

        assert_eq!(cs.byte_length(), total);

        // Read everything in one shot.
        let data = cs.read(total).unwrap();
        assert_eq!(data.len(), total);

        // Verify content: each 1024-byte block holds the chunk index mod 256.
        for (i, chunk_start) in (0..total).step_by(chunk_size).enumerate() {
            let expected = (i & 0xFF) as u8;
            assert!(
                data[chunk_start..chunk_start + chunk_size]
                    .iter()
                    .all(|&b| b == expected),
                "chunk {i} mismatch"
            );
        }

        assert_eq!(cs.byte_length(), 0);
    }

    #[test]
    fn read_partial_then_read_remaining() {
        let mut cs = ChunkStream::new();
        cs.accept_chunk(vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

        let first = cs.read(3).unwrap();
        assert_eq!(first, vec![0, 1, 2]);

        // Peek what remains — should not consume.
        assert_eq!(cs.peek(4), Some(vec![3, 4, 5, 6]));
        assert_eq!(cs.byte_length(), 7);

        let second = cs.read(7).unwrap();
        assert_eq!(second, vec![3, 4, 5, 6, 7, 8, 9]);
        assert_eq!(cs.byte_length(), 0);
    }

    #[test]
    fn skip_then_accept_then_read() {
        let mut cs = ChunkStream::new();
        cs.accept_chunk(vec![1, 2, 3, 4, 5]);
        cs.skip(3).unwrap();
        assert_eq!(cs.byte_length(), 2);

        cs.accept_chunk(vec![6, 7, 8]);
        assert_eq!(cs.byte_length(), 5);

        let data = cs.read(5).unwrap();
        assert_eq!(data, vec![4, 5, 6, 7, 8]);
    }

    #[test]
    fn skip_exact_then_read_exact() {
        let mut cs = ChunkStream::new();
        cs.accept_chunk(vec![10, 20, 30]);
        cs.skip(3).unwrap();
        assert_eq!(cs.byte_length(), 0);

        cs.accept_chunk(vec![40]);
        assert_eq!(cs.read(1), Some(vec![40]));
        assert_eq!(cs.byte_length(), 0);
    }

    #[test]
    fn empty_stream_operations() {
        let mut cs = ChunkStream::new();
        assert_eq!(cs.byte_length(), 0);
        assert_eq!(cs.peek(0), Some(vec![]));
        assert_eq!(cs.read(0), Some(vec![]));
        assert!(cs.skip(0).is_ok());
    }

    #[test]
    fn peek_zero_bytes() {
        let mut cs = ChunkStream::new();
        cs.accept_chunk(vec![1, 2, 3]);
        assert_eq!(cs.peek(0), Some(vec![]));
    }

    #[test]
    fn compaction_after_heavy_read() {
        let mut cs = ChunkStream::new();

        // Accept a large chunk, then read most of it to trigger compaction.
        cs.accept_chunk(vec![0; 10_000]);
        cs.read(8000).unwrap();

        // After compaction, read_pos should be reset.
        assert_eq!(cs.byte_length(), 2000);

        // Verify remaining bytes are correct.
        let rest = cs.read(2000).unwrap();
        assert_eq!(rest, vec![0; 2000]);
        assert_eq!(cs.byte_length(), 0);
    }

    #[test]
    fn interleaved_peek_read_skip() {
        let mut cs = ChunkStream::new();
        cs.accept_chunk(vec![1, 2, 3, 4, 5, 6, 7, 8]);

        // Peek 3 — no consume
        assert_eq!(cs.peek(3), Some(vec![1, 2, 3]));

        // Skip 2 — consume first two bytes
        cs.skip(2).unwrap();
        assert_eq!(cs.byte_length(), 6);

        // Peek 3 — should now start from byte 3
        assert_eq!(cs.peek(3), Some(vec![3, 4, 5]));

        // Read 4 — consume bytes 3..7
        let data = cs.read(4).unwrap();
        assert_eq!(data, vec![3, 4, 5, 6]);
        assert_eq!(cs.byte_length(), 2);

        // Read remaining
        let rest = cs.read(2).unwrap();
        assert_eq!(rest, vec![7, 8]);
        assert_eq!(cs.byte_length(), 0);
    }

    #[test]
    fn single_byte_chunks() {
        let mut cs = ChunkStream::new();
        for i in 0..10u8 {
            cs.accept_chunk(vec![i]);
        }
        assert_eq!(cs.byte_length(), 10);

        let data = cs.read(10).unwrap();
        assert_eq!(data, vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }

    #[test]
    fn napi_handle_factory() {
        let handle = create_chunk_stream();
        assert_eq!(handle.byte_length(), 0);
    }
}
