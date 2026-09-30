//! Transport framing — the Rust port of `SocketProtocol` from
//! `packages/rpc/src/protocol.ts`.
//!
//! The wire frame is a fixed 13-byte header followed by the payload:
//!
//! ```text
//! ┌─────────┬──────────┬──────────┬──────────────┐
//! │ type(1) │  id(4)   │ ack(4)   │  length(4)   │
//! └─────────┴──────────┴──────────┴──────────────┘
//! ```
//!
//! All multi-byte integers are big-endian. Only `Regular` frames carry a
//! payload the channel layer cares about; the other message types exist for the
//! persistent (ACK/reconnect) protocol, which the in-process server does not use.
//!
//! The streaming socket is not message-oriented: one `write` can arrive split
//! across many reads, and several frames can arrive coalesced into one read.
//! `ChunkStream` therefore buffers fragments and only releases a frame once its
//! header *and* body have both arrived. Consuming the header early would lose
//! the length of a still-incomplete body, and the caller would then wait forever
//! for a frame that can no longer be located.

use std::collections::VecDeque;

/// Header size: 1 byte type + 4 byte id + 4 byte ack + 4 byte length.
pub const HEADER_SIZE: usize = 13;

/// Mirrors `ProtocolMessageType` in `packages/rpc/src/protocol.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MessageType {
    None = 0,
    Regular = 1,
    Control = 2,
    Ack = 3,
    Disconnect = 5,
    ReplayRequest = 6,
    Pause = 7,
    Resume = 8,
    KeepAlive = 9,
}

impl MessageType {
    fn from_u8(value: u8) -> Option<Self> {
        Some(match value {
            0 => Self::None,
            1 => Self::Regular,
            2 => Self::Control,
            3 => Self::Ack,
            5 => Self::Disconnect,
            6 => Self::ReplayRequest,
            7 => Self::Pause,
            8 => Self::Resume,
            9 => Self::KeepAlive,
            _ => return None,
        })
    }
}

/// One decoded frame.
#[derive(Debug, Clone)]
pub struct Frame {
    pub message_type: MessageType,
    pub id: u32,
    pub ack: u32,
    pub payload: Vec<u8>,
}

/// Errors raised while decoding the transport frame.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FrameError {
    /// The declared payload length exceeds the cap, so the peer is either
    /// corrupt or hostile. Refusing early avoids buffering without bound.
    #[error("frame length {0} exceeds the {1} byte limit")]
    LengthTooLarge(u32, usize),
    /// The type byte is not a value the protocol defines.
    #[error("unknown protocol message type: {0}")]
    UnknownMessageType(u8),
}

/// Upper bound for a single frame's payload (16 MiB).
///
/// Mirrors `MAX_FRAME_BYTES`-style guarding on the JS side: a length field is
/// peer-controlled, so it is validated before any allocation.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Encode one frame, mirroring `writeProtocolMessage`.
pub fn write_frame(message_type: MessageType, id: u32, ack: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_SIZE + payload.len());
    out.push(message_type as u8);
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(&ack.to_be_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Encode a `Regular` frame, which is the only kind the channel layer emits.
pub fn write_regular(payload: &[u8]) -> Vec<u8> {
    write_frame(MessageType::Regular, 0, 0, payload)
}

/// Reassembles a byte stream into frames.
///
/// Port of `ChunkStream` + `SocketProtocol.readMessages` in
/// `packages/rpc/src/protocol.ts`.
#[derive(Debug, Default)]
pub struct FrameStream {
    buffer: VecDeque<u8>,
}

impl FrameStream {
    pub fn new() -> Self {
        Self {
            buffer: VecDeque::new(),
        }
    }

    /// Bytes currently buffered but not yet framed.
    pub fn buffered(&self) -> usize {
        self.buffer.len()
    }

    /// Append received bytes, then drain as many complete frames as possible.
    ///
    /// A frame is only emitted once its whole payload is present, so a
    /// truncated body stays buffered until the rest arrives.
    pub fn accept(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, FrameError> {
        self.buffer.extend(bytes.iter().copied());
        let mut frames = Vec::new();
        loop {
            let Some(frame) = self.take_frame()? else {
                break;
            };
            frames.push(frame);
        }
        Ok(frames)
    }

    fn take_frame(&mut self) -> Result<Option<Frame>, FrameError> {
        if self.buffer.len() < HEADER_SIZE {
            return Ok(None);
        }

        let header: [u8; HEADER_SIZE] = self
            .buffer
            .iter()
            .take(HEADER_SIZE)
            .copied()
            .collect::<Vec<_>>()
            .try_into()
            .expect("length checked above");

        let Some(message_type) = MessageType::from_u8(header[0]) else {
            return Err(FrameError::UnknownMessageType(header[0]));
        };
        let id = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);
        let ack = u32::from_be_bytes([header[5], header[6], header[7], header[8]]);
        let length = u32::from_be_bytes([header[9], header[10], header[11], header[12]]) as usize;

        if length > MAX_FRAME_BYTES {
            return Err(FrameError::LengthTooLarge(length as u32, MAX_FRAME_BYTES));
        }

        // Wait for the body too — never consume a header whose payload is
        // still in flight.
        if self.buffer.len() < HEADER_SIZE + length {
            return Ok(None);
        }

        self.buffer.drain(..HEADER_SIZE);
        let payload: Vec<u8> = self.buffer.drain(..length).collect();

        Ok(Some(Frame {
            message_type,
            id,
            ack,
            payload,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_is_thirteen_bytes_big_endian() {
        let framed = write_frame(MessageType::Regular, 0x0102_0304, 0x0a0b_0c0d, &[1, 2, 3]);
        assert_eq!(framed.len(), HEADER_SIZE + 3);
        assert_eq!(framed[0], 1, "type");
        assert_eq!(&framed[1..5], &[0x01, 0x02, 0x03, 0x04], "id big-endian");
        assert_eq!(&framed[5..9], &[0x0a, 0x0b, 0x0c, 0x0d], "ack big-endian");
        assert_eq!(&framed[9..13], &[0, 0, 0, 3], "length big-endian");
        assert_eq!(&framed[13..], &[1, 2, 3]);
    }

    #[test]
    fn round_trips_a_single_frame() {
        let payload = vec![9, 8, 7];
        let mut stream = FrameStream::new();
        let frames = stream.accept(&write_regular(&payload)).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].message_type, MessageType::Regular);
        assert_eq!(frames[0].payload, payload);
    }

    #[test]
    fn reassembles_a_frame_split_byte_by_byte() {
        let payload: Vec<u8> = (0..=255u8).collect();
        let framed = write_regular(&payload);
        let mut stream = FrameStream::new();

        // Every byte arrives alone; the frame must not appear until the last one.
        for (index, byte) in framed.iter().enumerate() {
            let frames = stream.accept(&[*byte]).unwrap();
            if index + 1 < framed.len() {
                assert!(frames.is_empty(), "frame emitted before it was complete");
            } else {
                assert_eq!(frames.len(), 1, "frame should complete on the final byte");
                assert_eq!(frames[0].payload, payload);
            }
        }
        assert_eq!(stream.buffered(), 0);
    }

    #[test]
    fn splits_several_frames_coalesced_into_one_chunk() {
        let mut wire = write_regular(b"first");
        wire.extend(write_regular(b"second"));
        wire.extend(write_regular(b"third"));

        let mut stream = FrameStream::new();
        let frames = stream.accept(&wire).unwrap();
        let payloads: Vec<_> = frames.iter().map(|f| f.payload.clone()).collect();
        assert_eq!(payloads, vec![b"first".to_vec(), b"second".to_vec(), b"third".to_vec()]);
    }

    #[test]
    fn holds_an_incomplete_body_until_it_arrives() {
        let framed = write_regular(&[1, 2, 3, 4, 5]);
        let mut stream = FrameStream::new();

        // Header plus only part of the body.
        let frames = stream.accept(&framed[..HEADER_SIZE + 2]).unwrap();
        assert!(frames.is_empty(), "must not emit a truncated frame");
        assert_eq!(stream.buffered(), HEADER_SIZE + 2);

        let frames = stream.accept(&framed[HEADER_SIZE + 2..]).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].payload, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn zero_length_regular_frame_yields_empty_payload() {
        let mut stream = FrameStream::new();
        let frames = stream.accept(&write_regular(&[])).unwrap();
        assert_eq!(frames.len(), 1);
        assert!(frames[0].payload.is_empty());
    }

    #[test]
    fn rejects_an_unknown_message_type() {
        let mut bad = write_regular(b"x");
        bad[0] = 42;
        let mut stream = FrameStream::new();
        assert_eq!(
            stream.accept(&bad).unwrap_err(),
            FrameError::UnknownMessageType(42)
        );
    }

    #[test]
    fn rejects_an_oversized_declared_length_before_allocating() {
        // Declare a huge length but send no body; must be refused, not buffered.
        let mut header = Vec::new();
        header.push(1);
        header.extend_from_slice(&0u32.to_be_bytes());
        header.extend_from_slice(&0u32.to_be_bytes());
        header.extend_from_slice(&(u32::MAX).to_be_bytes());

        let mut stream = FrameStream::new();
        assert_eq!(
            stream.accept(&header).unwrap_err(),
            FrameError::LengthTooLarge(u32::MAX, MAX_FRAME_BYTES)
        );
        assert_eq!(stream.buffered(), HEADER_SIZE, "nothing beyond the header kept");
    }
}
