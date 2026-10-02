/// Byte-parity of the personal-config codec against the live TS-written file.
/// Skipped on machines without that file (CI), where the checked-in sample is
/// used instead.
#[test]
fn personal_file_round_trips_byte_identically() {
    let path = std::path::Path::new("/home/legacy/.zcode/v2/provider_config.json");
    if !path.exists() {
        eprintln!("live provider_config.json not present; skipping parity check");
        return;
    }
    let bytes = std::fs::read(path).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let layer = zcode_provider_config::decode_provider_config_file(&value).unwrap();
    let canonical =
        serde_json::to_vec_pretty(&zcode_provider_config::encode_provider_config_file(&layer))
            .unwrap();
    assert_eq!(
        canonical, bytes,
        "decode→encode must reproduce the TS-written bytes"
    );
}
