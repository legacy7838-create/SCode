use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// Protocol message types (must match ProtocolMessageType enum in protocol.ts)
#[napi]
pub const HEADER_SIZE: u32 = 13; // 1 + 4 + 4 + 4

// Protocol message type constants (must match TS exactly)
pub const MSG_TYPE_REGULAR: u8 = 0;
pub const MSG_TYPE_ACK: u8 = 1;
pub const MSG_TYPE_KEEP_ALIVE: u8 = 2;
pub const MSG_TYPE_DISCONNECT: u8 = 3;

/// Build a protocol message: 13-byte header + payload.
///
/// Header format:
/// ┌─────────┬──────────┬──────────┬──────────────┐
/// │ type(1) │  id(4)   │  ack(4)  │  length(4)   │
/// └─────────┴──────────┴──────────┴──────────────┘
///
/// `msg_type`: message type byte (Regular=1, Ack=3, KeepAlive=9, etc.)
/// `id`:       32-bit message sequence number (BE)
/// `ack`:      32-bit acknowledgement number (BE)
/// `data`:     payload bytes
#[napi]
pub fn write_protocol_message(msg_type: u32, id: u32, ack: u32, data: Buffer) -> Buffer {
    let mut result = Vec::with_capacity(13 + data.len());
    result.push(msg_type as u8);
    result.extend_from_slice(&id.to_be_bytes());
    result.extend_from_slice(&ack.to_be_bytes());
    result.extend_from_slice(&(data.len() as u32).to_be_bytes());
    result.extend_from_slice(&data);
    Buffer::from(result)
}

/// Parse a 13-byte protocol header at the given offset.
///
/// Returns `Some((msg_type, id, ack, body_length))` on success, `None` if there
/// are fewer than 13 bytes available at `offset`.
#[napi]
pub fn parse_protocol_header(data: Buffer, offset: u32) -> Option<ProtocolHeader> {
    let offset = offset as usize;
    if data.len() - offset < 13 {
        return None;
    }

    Some(ProtocolHeader {
        msg_type: data[offset] as u32,
        id: u32::from_be_bytes([
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
            data[offset + 4],
        ]),
        ack: u32::from_be_bytes([
            data[offset + 5],
            data[offset + 6],
            data[offset + 7],
            data[offset + 8],
        ]),
        body_length: u32::from_be_bytes([
            data[offset + 9],
            data[offset + 10],
            data[offset + 11],
            data[offset + 12],
        ]),
    })
}

#[napi(object)]
pub struct ProtocolHeader {
    pub msg_type: u32,
    pub id: u32,
    pub ack: u32,
    pub body_length: u32,
}

/// Process an incoming ACK number: drop all queued messages whose id <= ack.
///
/// `unack_ids`:     ordered list of queued message ids (oldest first).
/// `unack_lengths`: parallel list of payload byte lengths for each queued message.
/// `ack`:           the ack number received from the peer.
///
/// Returns the trimmed lists plus accounting deltas.
#[napi]
pub fn process_ack(
    unack_ids: Vec<u32>,
    unack_data_lengths: Vec<u32>,
    ack: u32,
) -> AckResult {
    let mut remaining_ids = Vec::new();
    let mut remaining_lengths = Vec::new();
    let mut unack_bytes_delta: i64 = 0;
    let mut dropped: u32 = 0;

    for (i, &id) in unack_ids.iter().enumerate() {
        if id <= ack {
            unack_bytes_delta -= unack_data_lengths[i] as i64;
            dropped += 1;
        } else {
            remaining_ids.push(id);
            remaining_lengths.push(unack_data_lengths[i]);
        }
    }

    AckResult {
        remaining_ids,
        remaining_lengths,
        dropped,
        unack_bytes_delta,
    }
}

#[napi(object)]
pub struct AckResult {
    pub remaining_ids: Vec<u32>,
    pub remaining_lengths: Vec<u32>,
    pub dropped: u32,
    pub unack_bytes_delta: i64,
}

/// Congestion check: crossing watermarks fires saturated/drained edges.
///
/// Returns the updated saturated state plus booleans for edge transitions
/// that the caller should use to fire events.
#[napi]
pub fn check_congestion(
    unack_bytes: u32,
    saturated: bool,
    high_watermark: u32,
    low_watermark: u32,
) -> CongestionResult {
    let mut new_saturated = saturated;
    let mut fire_saturated = false;
    let mut fire_drained = false;

    if !saturated && unack_bytes > high_watermark {
        new_saturated = true;
        fire_saturated = true;
    } else if saturated && unack_bytes <= low_watermark {
        new_saturated = false;
        fire_drained = true;
    }

    CongestionResult {
        saturated: new_saturated,
        fire_saturated,
        fire_drained,
    }
}

#[napi(object)]
pub struct CongestionResult {
    pub saturated: bool,
    pub fire_saturated: bool,
    pub fire_drained: bool,
}

/// Check if the replay buffer has exceeded its byte cap.
#[napi]
pub fn check_replay_overflow(unack_bytes: u32, max_bytes: u32) -> bool {
    unack_bytes > max_bytes
}

/// Check if the oldest queued message has exceeded the grace window.
///
/// `oldest_queued_at`: epoch ms when the oldest unack'd message was queued.
/// `now`:              current epoch ms.
/// `grace_ms`:         maximum allowed age in ms.
#[napi]
pub fn check_grace_window(oldest_queued_at: u32, now: u32, grace_ms: u32) -> bool {
    now.wrapping_sub(oldest_queued_at) > grace_ms
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_parse_roundtrip() {
        let data = b"hello world";
        let msg = write_protocol_message(
            MSG_TYPE_REGULAR as u32,
            42,
            10,
            Buffer::from(data.to_vec()),
        );
        assert_eq!(msg.len(), 13 + data.len());
        let header = parse_protocol_header(Buffer::from(msg.to_vec()), 0).unwrap();
        assert_eq!(header.msg_type, MSG_TYPE_REGULAR as u32);
        assert_eq!(header.id, 42);
        assert_eq!(header.ack, 10);
        assert_eq!(header.body_length, data.len() as u32);
    }

    #[test]
    fn parse_header_too_short() {
        let data = vec![0u8; 5];
        assert!(parse_protocol_header(Buffer::from(data), 0).is_none());
    }

    #[test]
    fn parse_header_with_offset() {
        let data = write_protocol_message(MSG_TYPE_ACK as u32, 1, 0, Buffer::from(vec![]));
        let header = parse_protocol_header(Buffer::from(data.to_vec()), 0).unwrap();
        assert_eq!(header.msg_type, MSG_TYPE_ACK as u32);
        assert_eq!(header.id, 1);
    }

    #[test]
    fn write_empty_body() {
        let msg = write_protocol_message(
            MSG_TYPE_KEEP_ALIVE as u32,
            0,
            0,
            Buffer::from(vec![]),
        );
        assert_eq!(msg.len(), 13);
        let header = parse_protocol_header(msg, 0).unwrap();
        assert_eq!(header.body_length, 0);
    }

    #[test]
    fn process_ack_drops_old() {
        let ids = vec![1, 2, 3, 4, 5];
        let lengths = vec![100, 200, 150, 300, 50];
        let result = process_ack(ids, lengths, 3);
        assert_eq!(result.dropped, 3);
        assert_eq!(result.remaining_ids, vec![4, 5]);
        assert_eq!(result.remaining_lengths, vec![300, 50]);
        assert_eq!(result.unack_bytes_delta, -450);
    }

    #[test]
    fn process_ack_no_match() {
        let ids = vec![10, 20];
        let lengths = vec![100, 200];
        let result = process_ack(ids, lengths, 5);
        assert_eq!(result.dropped, 0);
        assert_eq!(result.remaining_ids, vec![10, 20]);
    }

    #[test]
    fn check_congestion_enter_saturation() {
        let result = check_congestion(2_000_000, false, 1_000_000, 250_000);
        assert!(result.saturated);
        assert!(result.fire_saturated);
        assert!(!result.fire_drained);
    }

    #[test]
    fn check_congestion_exit_saturation() {
        let result = check_congestion(100_000, true, 1_000_000, 250_000);
        assert!(!result.saturated);
        assert!(!result.fire_saturated);
        assert!(result.fire_drained);
    }

    #[test]
    fn check_congestion_no_change() {
        let result = check_congestion(500_000, false, 1_000_000, 250_000);
        assert!(!result.saturated);
        assert!(!result.fire_saturated);
        assert!(!result.fire_drained);
    }

    #[test]
    fn replay_overflow_check() {
        assert!(check_replay_overflow(9_000_000, 8_000_000));
        assert!(!check_replay_overflow(7_000_000, 8_000_000));
    }

    #[test]
    fn grace_window_expired() {
        assert!(check_grace_window(1000, 50_000, 45_000));
    }

    #[test]
    fn grace_window_not_expired() {
        assert!(!check_grace_window(1000, 10_000, 45_000));
    }

    #[test]
    fn grace_window_wrapping() {
        assert!(check_grace_window(u32::MAX - 100, 100, 50));
    }
}
