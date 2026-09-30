use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// Allocate a zeroed buffer of the given size.
#[napi]
pub fn alloc(byte_length: u32) -> Buffer {
    Buffer::from(vec![0u8; byte_length as usize])
}

/// Concatenate multiple buffers into one.
///
/// The result is exactly `total_length` bytes when it is supplied, otherwise the sum of the
/// input lengths. Inputs beyond the end are clipped instead of growing the result, so the
/// output length never depends on whether the caller's budget was large enough.
#[napi]
pub fn concat(buffers: Vec<Buffer>, total_length: Option<u32>) -> Buffer {
    let sum: usize = buffers.iter().map(|b| b.len()).sum();
    let len = total_length.map(|v| v as usize).unwrap_or(sum);
    let mut result = vec![0u8; len];
    let mut offset = 0usize;
    for buf in &buffers {
        if offset >= len {
            break;
        }
        let take = std::cmp::min(buf.len(), len - offset);
        result[offset..offset + take].copy_from_slice(&buf[..take]);
        offset += take;
    }
    Buffer::from(result)
}

/// Slice a buffer from start to end (exclusive).
///
/// Out-of-range indices are clamped, matching `Uint8Array.prototype.slice`: a JS caller must
/// never be able to abort the process through this binding.
#[napi]
pub fn slice(buffer: Buffer, start: u32, end: Option<u32>) -> Buffer {
    let len = buffer.len();
    let begin = std::cmp::min(start as usize, len);
    let finish = std::cmp::min(end.unwrap_or(len as u32) as usize, len).max(begin);
    Buffer::from(buffer[begin..finish].to_vec())
}

/// Copy source bytes into target at the given offset.
#[napi]
pub fn copy_into(target: Buffer, source: Buffer, offset: u32) -> Buffer {
    let mut result = target.to_vec();
    let offset = offset as usize;
    if offset + source.len() > result.len() {
        result.resize(offset + source.len(), 0);
    }
    result[offset..offset + source.len()].copy_from_slice(&source);
    Buffer::from(result)
}

/// Read a big-endian u32 from a buffer at the given offset.
///
/// Bytes past the end read as 0, matching `Uint8Array` indexing in the previous JavaScript
/// implementation. Indexing out of range must never panic: a Rust panic in a napi call aborts
/// the whole process, and this runs while parsing protocol headers.
#[napi]
pub fn read_uint32_be(buffer: Buffer, offset: u32) -> u32 {
    let byte = |i: usize| buffer.get(i).copied().unwrap_or(0);
    let o = offset as usize;
    u32::from_be_bytes([byte(o), byte(o + 1), byte(o + 2), byte(o + 3)])
}

/// Write a big-endian u32 into a buffer at the given offset.
///
/// Writes in place and never grows the buffer: the caller's buffer is already sized (this backs
/// `VSBuffer.writeUInt32BE`), and a differing length would make the native and TypeScript
/// bindings disagree about the resulting wire bytes.
#[napi]
pub fn write_uint32_be(mut buffer: Buffer, value: u32, offset: u32) -> Buffer {
    let o = offset as usize;
    let bytes = value.to_be_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if o + index < buffer.len() {
            buffer[o + index] = *byte;
        }
    }
    buffer
}

/// Encode a string to UTF-8 bytes.
#[napi]
pub fn string_to_bytes(s: String) -> Buffer {
    Buffer::from(s.into_bytes())
}

/// Decode UTF-8 bytes to a string.
#[napi]
pub fn bytes_to_string(buffer: Buffer) -> Option<String> {
    String::from_utf8(buffer.to_vec()).ok()
}