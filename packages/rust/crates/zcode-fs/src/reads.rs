//! Byte-level reads: text slices, binary ranges, and the two preview reads.
//!
//! Port of `fileService.ts:477-588` plus its two helpers (`:55-103`). The clamp
//! constants are the predecessor's, and the 25 MB binary-preview ceiling and the
//! 8 MB media-preview ceiling are **DoS controls, not tuning**: they bound what
//! a single RPC can pull across the process boundary and then base64-encode.
//! Both are preserved exactly, and their boundaries are covered by tests.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

use crate::containment::{self, Error, FsResult};

pub const DEFAULT_TEXT_READ_BYTES: u64 = 128 * 1024;
pub const MAX_TEXT_READ_BYTES: u64 = 256 * 1024;
pub const DEFAULT_MEDIA_PREVIEW_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_MEDIA_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;
pub const DEFAULT_BINARY_READ_BYTES: u64 = 256 * 1024;
pub const MAX_BINARY_READ_BYTES: u64 = 1024 * 1024;
/// Both the default and the ceiling, deliberately: a binary preview is a whole
/// file or nothing, because office parsers need the complete ZIP/OLE bytes and
/// cannot be served from a chunked read.
pub const DEFAULT_BINARY_PREVIEW_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_BINARY_PREVIEW_BYTES: u64 = 25 * 1024 * 1024;

pub const FILE_EXISTENCE_BATCH_LIMIT: usize = 15;

/// Extensions the predecessor mapped to an image media type, then the
/// audio/video table from `@zcode/shared`'s `MEDIA_PREVIEW_FORMATS`, then
/// `application/octet-stream`. That closed table is reproduced here rather than
/// delegated to `mime_guess`: a superset would answer `audio/ogg` for `.opus`
/// and `text/plain` for `.ts`, which is a behavior fork (invariant 3).
const IMAGE_EXTENSION_TO_MEDIA_TYPE: &[(&str, &str)] = &[
  (".apng", "image/apng"),
  (".avif", "image/avif"),
  (".bmp", "image/bmp"),
  (".gif", "image/gif"),
  (".ico", "image/x-icon"),
  (".jpeg", "image/jpeg"),
  (".jpg", "image/jpeg"),
  (".png", "image/png"),
  (".svg", "image/svg+xml"),
  (".webp", "image/webp"),
];

/// `getMediaPreviewFormat` from `@zcode/shared/media-preview.ts`, inlined because
/// the format table is part of this read's contract.
const MEDIA_PREVIEW_MEDIA_TYPES: &[(&str, &str)] = &[
  (".mp4", "video/mp4"),
  (".mov", "video/quicktime"),
  (".webm", "video/webm"),
  (".m4v", "video/x-m4v"),
  (".mp3", "audio/mpeg"),
  (".wav", "audio/wav"),
  (".m4a", "audio/mp4"),
  (".ogg", "audio/ogg"),
  (".opus", "audio/opus"),
  (".flac", "audio/flac"),
  (".weba", "audio/webm"),
];

const DEFAULT_MEDIA_TYPE: &str = "application/octet-stream";

/// `extname(path).toLowerCase()`.
fn lowercased_extension(path: &str) -> String {
  let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
  match name.rfind('.') {
    None | Some(0) => String::new(),
    Some(at) if at == name.len() - 1 => String::new(),
    Some(at) => name[at..].to_lowercase(),
  }
}

/// `inferMediaTypeFromPath` (`fileService.ts:79-85`).
pub fn infer_media_type(path: &str) -> String {
  let extension = lowercased_extension(path);
  if let Some((_, media_type)) = IMAGE_EXTENSION_TO_MEDIA_TYPE
    .iter()
    .find(|(candidate, _)| *candidate == extension)
  {
    return (*media_type).to_string();
  }
  // The shared table matches on `path.toLowerCase().endsWith(extension)`, which
  // also accepts a path whose *directory* ends with the extension.
  let lowered = path.to_lowercase();
  if let Some((_, media_type)) = MEDIA_PREVIEW_MEDIA_TYPES
    .iter()
    .find(|(candidate, _)| lowered.ends_with(candidate))
  {
    return (*media_type).to_string();
  }
  DEFAULT_MEDIA_TYPE.to_string()
}

/// `isProbablyBinary` (`fileService.ts:86-103`): any NUL byte is decisive;
/// otherwise more than 30% control characters other than tab/LF/FF/CR.
pub fn is_probably_binary(buffer: &[u8]) -> bool {
  if buffer.is_empty() {
    return false;
  }
  let mut suspicious = 0usize;
  for &value in buffer {
    if value == 0 {
      return true;
    }
    let is_common_whitespace = value == 9 || value == 10 || value == 12 || value == 13;
    let is_control_char =
      (1..=8).contains(&value) || (14..=31).contains(&value) || value == 127;
    if !is_common_whitespace && is_control_char {
      suspicious += 1;
    }
  }
  suspicious as f64 / buffer.len() as f64 > 0.3
}

/// `clampReadLength` & friends: a non-finite or absent length takes the default,
/// then the value is truncated and clamped into `[1, max]`. Note the floor is 1,
/// not 0 — `length: 0` still reads one byte, which is what the predecessor did.
pub fn clamp_bytes(value: Option<f64>, default: u64, max: u64) -> u64 {
  match value {
    Some(number) if number.is_finite() => number.trunc().clamp(1.0, max as f64) as u64,
    _ => default,
  }
}

/// `Math.max(0, Math.trunc(offset ?? 0))`, with a non-finite offset normalized to
/// 0 rather than propagated as NaN (the predecessor would have handed NaN to
/// `fs.read`, which is a crash, not a result).
pub fn offset_of(value: Option<f64>) -> u64 {
  match value {
    Some(number) if number.is_finite() => {
      let truncated = number.trunc();
      if truncated <= 0.0 {
        0
      } else {
        truncated as u64
      }
    }
    _ => 0,
  }
}

/// `File is too large to preview: <path>`.
fn too_large(path: &str) -> Error<String> {
  containment::reject(format!("File is too large to preview: {path}"))
}

/// A text slice, as `FileTextSlice`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextSlice {
  pub offset: u64,
  pub content: String,
  pub bytes_read: u64,
  pub total_bytes: u64,
  pub truncated: bool,
  pub is_binary: bool,
}

pub fn read_text_slice(
  canonical: &Path,
  requested: &str,
  size: u64,
  offset: Option<f64>,
  length: Option<f64>,
) -> FsResult<TextSlice> {
  let offset = offset_of(offset);
  if offset >= size {
    return Ok(TextSlice {
      offset,
      content: String::new(),
      bytes_read: 0,
      total_bytes: size,
      truncated: false,
      // The predecessor's early return never sniffed the content, so a binary
      // file read at EOF reports `isBinary: false`. Kept: callers use it to
      // decide whether `content` is displayable, and content is empty either way.
      is_binary: false,
    });
  }
  let target = clamp_bytes(length, DEFAULT_TEXT_READ_BYTES, MAX_TEXT_READ_BYTES);
  let wanted = target.min(size - offset);
  let chunk = read_exact_at(canonical, offset, wanted, requested)?;
  let is_binary = is_probably_binary(&chunk);
  Ok(TextSlice {
    offset,
    content: if is_binary {
      String::new()
    } else {
      // `from_utf8_lossy` and Node's `toString("utf-8")` both substitute U+FFFD
      // per malformed maximal subpart, so a binary chunk decoded as text is
      // byte-identical.
      String::from_utf8_lossy(&chunk).into_owned()
    },
    bytes_read: chunk.len() as u64,
    total_bytes: size,
    truncated: offset + (chunk.len() as u64) < size,
    is_binary,
  })
}

/// A byte range, as `readFileRange`'s top-level `Uint8Array`.
pub fn read_range(
  canonical: &Path,
  requested: &str,
  size: u64,
  offset: Option<f64>,
  length: Option<f64>,
) -> FsResult<Vec<u8>> {
  let offset = offset_of(offset);
  if offset >= size {
    return Ok(Vec::new());
  }
  let target = clamp_bytes(length, DEFAULT_BINARY_READ_BYTES, MAX_BINARY_READ_BYTES);
  let wanted = target.min(size - offset);
  read_exact_at(canonical, offset, wanted, requested)
}

/// Reads at most `wanted` bytes at `offset`. A short read is normal at EOF and
/// is reported as the actual byte count, never an error — the predecessor
/// surfaced `bytesRead` from the same call.
fn read_exact_at(
  canonical: &Path,
  offset: u64,
  wanted: u64,
  requested: &str,
) -> FsResult<Vec<u8>> {
  let mut file = std::fs::File::open(canonical)
    .map_err(|error| containment::syscall_error(&error, "open", requested))?;
  // Seek + read rather than `FileExt::read_at`: pread is Unix-only and this
  // crate ships to the same six targets as every other port. A short read at
  // EOF is normal and is reported as the actual byte count, so the seek buys
  // nothing that matters.
  file
    .seek(SeekFrom::Start(offset))
    .map_err(|error| containment::syscall_error(&error, "read", requested))?;
  let mut buffer = vec![0u8; wanted as usize];
  let read = file
    .read(&mut buffer)
    .map_err(|error| containment::syscall_error(&error, "read", requested))?;
  buffer.truncate(read);
  Ok(buffer)
}

/// A whole-file read for the two previews. The size gate runs first, so an
/// oversized file is rejected without ever being read into memory.
pub fn read_whole_for_preview(
  canonical: &Path,
  requested: &str,
  size: u64,
  max_bytes: u64,
) -> FsResult<Vec<u8>> {
  if size > max_bytes {
    return Err(too_large(requested));
  }
  let mut file = std::fs::File::open(canonical)
    .map_err(|error| containment::syscall_error(&error, "open", requested))?;
  let mut buffer = Vec::with_capacity(size as usize);
  file
    .read_to_end(&mut buffer)
    .map_err(|error| containment::syscall_error(&error, "read", requested))?;
  Ok(buffer)
}

pub fn encode_base64(bytes: &[u8]) -> String {
  BASE64.encode(bytes)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use std::path::PathBuf;

  fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zcode-fs-reads-{name}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create scratch");
    dir
  }

  fn write(name: &str, bytes: &[u8]) -> PathBuf {
    let path = scratch(name).join("fixture.bin");
    fs::write(&path, bytes).expect("write fixture");
    fs::canonicalize(&path).expect("canonical fixture")
  }

  #[test]
  fn media_type_inference_follows_the_predecessor_table() {
    assert_eq!(infer_media_type("/a/b.png"), "image/png");
    assert_eq!(infer_media_type("/a/b.PNG"), "image/png");
    assert_eq!(infer_media_type("/a/b.jpeg"), "image/jpeg");
    assert_eq!(infer_media_type("/a/b.mp4"), "video/mp4");
    assert_eq!(infer_media_type("/a/b.MOV"), "video/quicktime");
    assert_eq!(infer_media_type("/a/b.opus"), "audio/opus", "not audio/ogg");
    assert_eq!(infer_media_type("/a/b.weba"), "audio/webm");
    assert_eq!(infer_media_type("/a/b.m4v"), "video/x-m4v");
    assert_eq!(infer_media_type("/a/b.txt"), DEFAULT_MEDIA_TYPE);
    assert_eq!(infer_media_type("/a/b.war"), DEFAULT_MEDIA_TYPE);
    assert_eq!(infer_media_type("/a/b"), DEFAULT_MEDIA_TYPE);
  }

  #[test]
  fn binary_sniffing_matches_the_threshold() {
    assert!(!is_probably_binary(b""));
    assert!(!is_probably_binary(b"plain text\n"));
    assert!(is_probably_binary(b"has\0nul"));
    // 30% exactly is not binary (`> 0.3` is strict); 31% is.
    let thirty = vec![0x01u8; 30];
    let mut at_threshold = thirty.clone();
    at_threshold.extend(std::iter::repeat_n(b'a', 70));
    assert!(!is_probably_binary(&at_threshold));
    let mut over = vec![0x01u8; 31];
    over.extend(std::iter::repeat_n(b'a', 69));
    assert!(is_probably_binary(&over));
    // Tab/LF/FF/CR are whitespace, never "suspicious".
    assert!(!is_probably_binary(b"\t\n\x0c\r"));
  }

  #[test]
  fn length_clamps_are_inclusive_at_both_ends() {
    assert_eq!(clamp_bytes(None, DEFAULT_TEXT_READ_BYTES, MAX_TEXT_READ_BYTES), 128 * 1024);
    assert_eq!(clamp_bytes(Some(f64::NAN), 128, 256), 128);
    assert_eq!(clamp_bytes(Some(f64::INFINITY), 128, 256), 128);
    assert_eq!(clamp_bytes(Some(0.0), 128, 256), 1, "floor is 1, not 0");
    assert_eq!(clamp_bytes(Some(-9.0), 128, 256), 1);
    assert_eq!(clamp_bytes(Some(1.0), 128, 256), 1);
    assert_eq!(clamp_bytes(Some(256.0), 128, 256), 256);
    assert_eq!(clamp_bytes(Some(1e12), 128, 256), 256, "ceiling, not the request");
    assert_eq!(clamp_bytes(Some(9.9), 128, 256), 9, "truncated");
  }

  #[test]
  fn offsets_normalize_negative_and_non_finite_to_zero() {
    assert_eq!(offset_of(None), 0);
    assert_eq!(offset_of(Some(0.0)), 0);
    assert_eq!(offset_of(Some(-5.0)), 0);
    assert_eq!(offset_of(Some(f64::NAN)), 0);
    assert_eq!(offset_of(Some(3.9)), 3);
    assert_eq!(offset_of(Some(7.0)), 7);
  }

  #[test]
  fn text_slice_reads_the_window_and_flags_truncation() {
    let path = write("text-window", b"hello zcode\nsecond line\n");
    let size = 24;
    let slice = read_text_slice(&path, "alpha.txt", size, None, None).unwrap();
    assert_eq!(slice.content, "hello zcode\nsecond line\n");
    assert_eq!(slice.bytes_read, 24);
    assert!(!slice.truncated);
    assert!(!slice.is_binary);

    let windowed = read_text_slice(&path, "alpha.txt", size, Some(6.0), Some(6.0)).unwrap();
    assert_eq!(windowed.content, "zcode\n");
    assert_eq!(windowed.offset, 6);
    assert!(windowed.truncated);

    // length: 0 still reads one byte, matching the predecessor's floor of 1.
    let one = read_text_slice(&path, "alpha.txt", size, Some(0.0), Some(0.0)).unwrap();
    assert_eq!(one.content, "h");
    assert_eq!(one.bytes_read, 1);
  }

  #[test]
  fn text_slice_at_or_past_eof_is_empty_and_not_binary() {
    let path = write("text-eof", &[0u8, 0u8, 0u8, 0u8]);
    let at = read_text_slice(&path, "x", 4, Some(4.0), None).unwrap();
    assert_eq!(at.content, "");
    assert_eq!(at.bytes_read, 0);
    assert_eq!(at.offset, 4);
    assert!(!at.truncated);
    assert!(!at.is_binary, "the early return never sniffs");

    let past = read_text_slice(&path, "x", 4, Some(99.0), None).unwrap();
    assert_eq!(past.offset, 99);
    assert_eq!(past.bytes_read, 0);
  }

  #[test]
  fn text_slice_of_a_binary_file_returns_no_content() {
    let bytes = vec![0x50u8, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02];
    let path = write("text-binary", &bytes);
    let slice = read_text_slice(&path, "b.bin", bytes.len() as u64, None, None).unwrap();
    assert!(slice.is_binary);
    assert_eq!(slice.content, "");
    assert_eq!(slice.bytes_read, bytes.len() as u64);
  }

  #[test]
  fn invalid_utf8_decodes_to_replacement_characters() {
    let bytes = vec![0x61u8, 0xff, 0xfe, 0x62, 0x0a];
    let path = write("text-invalid", &bytes);
    let slice = read_text_slice(&path, "x", bytes.len() as u64, None, None).unwrap();
    assert_eq!(slice.content, "a\u{fffd}\u{fffd}b\n");
    assert!(!slice.is_binary);
  }

  #[test]
  fn range_reads_clamp_to_one_megabyte() {
    let bytes = vec![b'x'; 300 * 1024];
    let path = write("range-clamp", &bytes);
    let requested = 4.0 * 1024.0 * 1024.0;
    // The clamp is 1 MB, but the fixture is 300 KB, so the read stops at EOF.
    let range = read_range(&path, "x", bytes.len() as u64, Some(0.0), Some(requested)).unwrap();
    assert_eq!(range.len(), bytes.len(), "a 4MB request is clamped to the file size");
    assert_eq!(clamp_bytes(Some(requested), DEFAULT_BINARY_READ_BYTES, MAX_BINARY_READ_BYTES), MAX_BINARY_READ_BYTES);
    let small = read_range(&path, "x", bytes.len() as u64, Some(0.0), Some(0.0)).unwrap();
    assert_eq!(small.len(), 1);
    let eof = read_range(&path, "x", bytes.len() as u64, Some(1e9), Some(16.0)).unwrap();
    assert!(eof.is_empty());
  }

  #[test]
  fn preview_size_gate_is_exclusive_at_the_cap() {
    let path = write("preview-cap", &[b'a'; 16]);
    // size == max_bytes is allowed …
    assert!(read_whole_for_preview(&path, "x", 16, 16).is_ok());
    // … and one byte over is not, for either cap.
    assert_eq!(
      read_whole_for_preview(&path, "x", 17, 16).unwrap_err().reason,
      "File is too large to preview: x"
    );
    assert!(read_whole_for_preview(&path, "x", MAX_MEDIA_PREVIEW_BYTES, MAX_MEDIA_PREVIEW_BYTES).is_ok());
    assert!(read_whole_for_preview(&path, "x", MAX_MEDIA_PREVIEW_BYTES + 1, MAX_MEDIA_PREVIEW_BYTES).is_err());
    assert_eq!(MAX_BINARY_PREVIEW_BYTES, DEFAULT_BINARY_PREVIEW_BYTES);
    assert_eq!(MAX_BINARY_PREVIEW_BYTES, 25 * 1024 * 1024);
    assert_eq!(MAX_MEDIA_PREVIEW_BYTES, 8 * 1024 * 1024);
    assert_eq!(DEFAULT_MEDIA_PREVIEW_BYTES, 4 * 1024 * 1024);
  }

  #[test]
  fn base64_matches_node_buffer_to_string() {
    assert_eq!(encode_base64(b"hi"), "aGk=");
    assert_eq!(encode_base64(b""), "");
    assert_eq!(encode_base64(&[0u8, 0xff, 0xfe]), "AP/+");
  }

  #[test]
  fn existence_batch_limit_is_fifteen() {
    assert_eq!(FILE_EXISTENCE_BATCH_LIMIT, 15);
  }
}
