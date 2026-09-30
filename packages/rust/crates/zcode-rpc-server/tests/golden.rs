//! Byte-for-byte compatibility with the TypeScript implementation.
//!
//! `tests/golden-vectors.json` is generated from the real `packages/rpc` code by
//! `scripts/gen-rpc-golden.ts`. These tests assert the Rust port produces and
//! consumes exactly the same bytes. A mismatch means the UI would fail to talk
//! to the Rust host at runtime, so this is the gate that keeps the port honest —
//! a Rust-side "reasonable looking" encoding is not enough.

use serde_json::Value as JsonValue;
use zcode_codec::serialization::{deserialize, serialize, serialize_option};
use zcode_codec::vql::{VqlReader, VqlWriter};
use zcode_rpc_server::frame::write_frame;
use zcode_rpc_server::message::{decode_request, encode_request, RequestType};
use zcode_rpc_server::FrameStream;

fn vectors() -> JsonValue {
    let raw = include_str!("golden-vectors.json");
    serde_json::from_str(raw).expect("golden-vectors.json must be valid JSON")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(value: &str) -> Vec<u8> {
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).expect("valid hex"))
        .collect()
}

/// Serialize a value exactly as the TS `serialize()` does, so the encoding can
/// be compared to the recorded vector.
fn ser(value: &JsonValue) -> Vec<u8> {
    let mut writer = VqlWriter::new();
    serialize(&mut writer, value).expect("serialize");
    writer.into_bytes()
}

/// Serialize using the undefined/null-aware path the envelope builders use.
fn ser_option(value: Option<&JsonValue>) -> Vec<u8> {
    let mut writer = VqlWriter::new();
    serialize_option(&mut writer, value).expect("serialize");
    writer.into_bytes()
}

#[test]
fn serialize_matches_typescript_byte_for_byte() {
    let cases = vectors();
    let expected = cases["serialize"].as_object().expect("serialize section");

    // JS `undefined` is not representable in serde_json, so it is asserted
    // separately below; every other vector is compared directly.
    for (name, vector) in expected {
        if name == "undefined" {
            continue;
        }
        let want = vector.as_str().expect("hex string");
        let want_bytes = unhex(want);
        // `null` must go through the undefined/null-aware path: plain
        // `serialize` collapses Null to the `Undefined` tag, which is right for
        // its own contract but wrong for a wire value TS sent as explicit `null`.
        let got_bytes = if name == "null" {
            ser_option(Some(&cases["_roundTripSerialize"][name]))
        } else {
            ser(&cases["_roundTripSerialize"][name])
        };
        assert_eq!(
            hex(&got_bytes),
            want,
            "serialize mismatch for `{name}`: TS={want} Rust={}",
            hex(&got_bytes)
        );
        assert_eq!(got_bytes, want_bytes, "byte compare for `{name}`");
    }
}

#[test]
fn undefined_is_a_single_zero_tag() {
    // `serialize(undefined)` -> DataType.Undefined (0) and nothing else. Rust has
    // no `undefined`, so Null is the stand-in; this pins that it produces the
    // same single byte rather than JSON `null` ("nul" + length).
    assert_eq!(ser(&JsonValue::Null), vec![0u8]);
    let mut reader = VqlReader::new(&[0u8]);
    assert!(deserialize(&mut reader).expect("decode").is_null());
}

#[test]
fn request_envelopes_match_typescript_byte_for_byte() {
    let cases = vectors();
    let requests = cases["requests"].as_object().expect("requests section");

    // Each entry: (RequestType, id, channel, method, arg-json-or-null)
    let spec: Vec<(&str, RequestType, u32, Option<(&str, &str)>, JsonValue)> = vec![
        (
            "promiseStringArg",
            RequestType::Promise,
            0,
            Some(("setting", "get")),
            JsonValue::String("someKey".into()),
        ),
        (
            "promiseNoArg",
            RequestType::Promise,
            1,
            Some(("system", "info")),
            JsonValue::Null,
        ),
        (
            "promiseObjectArg",
            RequestType::Promise,
            42,
            Some(("git", "refresh")),
            serde_json::json!({ "workspacePath": "/tmp/x", "recursive": true }),
        ),
        (
            "promiseArrayArg",
            RequestType::Promise,
            4_294_967_295,
            Some(("file", "read")),
            serde_json::json!(["/a", "/b", 3]),
        ),
        (
            "eventListen",
            RequestType::EventListen,
            7,
            Some(("broadcast", "onMessage")),
            JsonValue::Null,
        ),
        (
            "eventListenWithArg",
            RequestType::EventListen,
            8,
            Some(("zcode-agent", "onDidChangeFrame")),
            serde_json::json!({ "limit": 20 }),
        ),
        ("promiseCancel", RequestType::PromiseCancel, 5, None, JsonValue::Null),
        ("eventDispose", RequestType::EventDispose, 6, None, JsonValue::Null),
    ];

    for (name, request_type, id, target, arg) in spec {
        let want = requests[name].as_str().expect("hex string");
        let (channel, method) = match target {
            Some((c, m)) => (Some(c), Some(m)),
            None => (None, None),
        };
        let arg_ref = if arg.is_null() { None } else { Some(&arg) };
        let got = encode_request(request_type, id, channel, method, arg_ref)
            .unwrap_or_else(|e| panic!("encode {name}: {e}"));
        assert_eq!(
            hex(&got),
            want,
            "request envelope mismatch for `{name}`"
        );
    }
}

#[test]
fn transport_framing_matches_typescript_byte_for_byte() {
    let cases = vectors();
    let framing = cases["framing"].as_object().expect("framing section");

    for name in ["smallPayload", "largerPayload", "emptyPayload"] {
        let want = framing[name].as_str().expect("hex string");
        // Rebuild the frame from the exact payload the generator framed.
        let payload = payload_for(name);
        let got = write_frame(zcode_rpc_server::MessageType::Regular, 0, 0, &payload);
        assert_eq!(hex(&got), want, "framing mismatch for `{name}`");
    }
}

fn payload_for(name: &str) -> Vec<u8> {
    let cases = vectors();
    let key = match name {
        "smallPayload" => "smallPayloadBody",
        "largerPayload" => "largerPayloadBody",
        "emptyPayload" => "emptyPayloadBody",
        other => panic!("unknown framing vector {other}"),
    };
    unhex(cases["framing"][key].as_str().expect("hex string"))
}

#[test]
fn decoding_a_typescript_request_recovers_the_same_fields() {
    let cases = vectors();
    for (name, expected) in [
        ("promiseStringArg", ("setting", "get", 0u32)),
        ("promiseObjectArg", ("git", "refresh", 42)),
        ("eventListen", ("broadcast", "onMessage", 7)),
    ] {
        let bytes = unhex(cases["requests"][name].as_str().expect("hex"));
        let request = decode_request(&bytes).unwrap_or_else(|e| panic!("decode {name}: {e}"));
        assert_eq!(request.channel(), expected.0, "{name} channel");
        assert_eq!(request.method(), expected.1, "{name} method");
        assert_eq!(request.id, expected.2, "{name} id");
    }
}

#[test]
fn a_typescript_framed_frame_is_read_back_by_the_rust_stream() {
    let cases = vectors();
    let framed = unhex(cases["framing"]["largerPayload"].as_str().expect("hex"));
    let mut stream = FrameStream::new();
    let frames = stream.accept(&framed).expect("accept");
    assert_eq!(frames.len(), 1);
    // The payload of the frame must itself be a decodable request envelope.
    let request = decode_request(&frames[0].payload).expect("inner envelope");
    assert_eq!(request.channel(), "file");
    assert_eq!(request.method(), "read");
}

/// Decode a structured argument produced by the TypeScript client and check the
/// nested containers survive. `system.probeIntranet` is the real case: a list of
/// objects, which is the first argument shape with nesting in it.
///
/// This exists because a flat-object test passed while the nested case silently
/// lost its value on the live path.
#[test]
fn a_nested_argument_round_trips_from_typescript_bytes() {
    let cases = vectors();
    let hex = cases["requests"]["probeIntranetPositional"]
        .as_str()
        .expect("hex string");
    let request = decode_request(&unhex(hex)).expect("decode");

    assert_eq!(request.channel(), "system");
    assert_eq!(request.method(), "probeIntranet");
    let payload = request.arg.expect("the argument must not be lost");
    let arg = &payload
        .as_array()
        .expect("positional list")
        .first()
        .cloned()
        .expect("one argument");

    let targets = arg["targets"].as_array().expect("targets array");
    assert_eq!(targets.len(), 1, "the nested list must survive");
    assert_eq!(targets[0]["host"], "127.0.0.1");
    assert_eq!(targets[0]["port"], 1);
    assert_eq!(targets[0]["timeoutMs"], 150);
    assert_eq!(arg["attempts"], 1);
}

#[test]
fn a_deeply_nested_argument_round_trips_from_typescript_bytes() {
    let cases = vectors();
    let hex = cases["requests"]["deepNestedArg"].as_str().expect("hex string");
    let request = decode_request(&unhex(hex)).expect("decode");
    let arg = request.arg.expect("argument");
    assert_eq!(arg["a"]["b"]["c"][1], "two");
    assert_eq!(arg["a"]["b"]["c"][3], JsonValue::Null);
    assert_eq!(arg["d"][1][0], 3);
}

/// The positional-argument contract, pinned end to end.
///
/// `ProxyChannel.toService` sends `[...methodArgs]`, so even a one-argument call
/// arrives wrapped in an array, and a zero-argument call arrives as an empty
/// array. The server spreads it back with `Function.apply`. An implementation
/// that treats the payload as "the argument" therefore receives an array where an
/// object was expected — which is silent: the call succeeds and returns
/// "nothing to probe". These two tests are the guard against that regression.
#[test]
fn a_positional_argument_arrives_as_a_list() {
    let cases = vectors();
    let hex = cases["requests"]["probeIntranetPositional"]
        .as_str()
        .expect("hex string");
    let request = decode_request(&unhex(hex)).expect("decode");

    let payload = request.arg.expect("argument payload");
    let args = payload.as_array().expect("the payload must be a list");

    assert_eq!(args.len(), 1, "a one-argument call carries one entry");
    let first = &args[0];
    assert_eq!(first["targets"][0]["host"], "127.0.0.1");
    assert_eq!(first["attempts"], 1);
}

#[test]
fn a_zero_argument_call_arrives_as_an_empty_list() {
    let cases = vectors();
    let hex = cases["requests"]["zeroArgCall"].as_str().expect("hex string");
    let request = decode_request(&unhex(hex)).expect("decode");
    let payload = request.arg.expect("argument payload");
    let args = payload.as_array().expect("the payload must be a list");
    assert!(args.is_empty(), "a zero-argument call carries no entries");
}
