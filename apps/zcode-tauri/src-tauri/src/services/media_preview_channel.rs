//! `media-preview` channel — inline audio/video preview.
//!
//! Replaces the `@zcode/server` `media-preview` channel (`IMediaPreviewService`).
//! The TS `prepare` picks a branch: a platform with local-URL authorization
//! returns `local-url`; otherwise it inlines the file as base64 when small
//! enough. The Tauri desktop host has no local-URL authorize (that is the
//! web-remote surface), so this serves the `inline` branch: validate the media
//! format/kind, stat the file through the shared containment, and inline the
//! bytes (bounded by `inlineMaxBytes`). A file over the bound is a loud error,
//! never a truncated preview.

use serde::Serialize;
use serde_json::Value as JsonValue;
use zcode_fs::containment::Roots;
use zcode_fs::reads;
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

use crate::services::paths;

/// `MEDIA_PREVIEW_FORMATS`, matching `@zcode/shared/media-preview`.
const FORMATS: &[(&str, &str, &str)] = &[
    (".mp4", "video", "video/mp4"),
    (".mov", "video", "video/quicktime"),
    (".webm", "video", "video/webm"),
    (".m4v", "video", "video/x-m4v"),
    (".mp3", "audio", "audio/mpeg"),
    (".wav", "audio", "audio/wav"),
    (".m4a", "audio", "audio/mp4"),
    (".ogg", "audio", "audio/ogg"),
    (".opus", "audio", "audio/opus"),
    (".flac", "audio", "audio/flac"),
    (".weba", "audio", "audio/webm"),
];

/// The default inline bound, matching the TS `inlineMaxBytes`.
const INLINE_MAX_BYTES: u64 = 8 * 1024 * 1024;

fn media_preview_format(path: &str) -> Option<(&'static str, &'static str)> {
    let normalized = path.replace('\\', "/").to_lowercase();
    FORMATS
        .iter()
        .find(|(extension, _, _)| normalized.ends_with(extension))
        .map(|(_, kind, media_type)| (*kind, *media_type))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InlinePreview {
    kind: String,
    data_base64: String,
    media_type: String,
    path: String,
    size: u64,
}

pub struct MediaPreviewService {
    roots: Vec<String>,
}

impl MediaPreviewService {
    pub fn new() -> Self {
        Self {
            roots: vec![
                paths::homedir(),
                paths::data_base_dir().to_string_lossy().into_owned(),
                paths::app_config_dir().to_string_lossy().into_owned(),
            ],
        }
    }

    fn prepare_inline(&self, path: &str, expected_kind: &str) -> Result<InlinePreview, HandlerError> {
        let Some((kind, media_type)) = media_preview_format(path) else {
            return Err(HandlerError::message(format!(
                "Unsupported media preview format: {path}"
            )));
        };
        if kind != expected_kind {
            return Err(HandlerError::message(format!(
                "Unsupported media preview format: {path}"
            )));
        }
        // Containment: resolve through the allowlist, then stat + read.
        let canonical = Roots::from_raw(&self.roots)
            .resolve(path, "stat")
            .map_err(|error| HandlerError::message(error.reason))?;
        let size = std::fs::metadata(&canonical)
            .map_err(|error| HandlerError::message(format!("Path is not a media file: {path} ({error})")))?
            .len();
        if size > INLINE_MAX_BYTES {
            return Err(HandlerError::message(format!(
                "Media file is too large for inline preview: {path}"
            )));
        }
        let bytes = reads::read_whole_for_preview(&canonical, path, size, INLINE_MAX_BYTES)
            .map_err(|error| HandlerError::message(error.reason))?;
        Ok(InlinePreview {
            kind: "inline".to_string(),
            data_base64: reads::encode_base64(&bytes),
            media_type: media_type.to_string(),
            path: path.to_string(),
            size,
        })
    }
}

impl Default for MediaPreviewService {
    fn default() -> Self {
        Self::new()
    }
}

impl ChannelHandler for MediaPreviewService {
    fn call(&self, _ctx: &str, method: &str, args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        let params = args.first().cloned().unwrap_or(JsonValue::Null);
        match method {
            "prepare" => {
                let path = params
                    .get("path")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| HandlerError::message("media-preview.prepare requires a `path`"))?;
                let expected_kind = params
                    .get("expectedKind")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| HandlerError::message("media-preview.prepare requires an `expectedKind`"))?;
                let preview = self.prepare_inline(path, expected_kind)?;
                serde_json::to_value(&preview).map_err(handler_error)
            }
            "refreshPlaybackUrl" | "release" => {
                // The host-range-url surface (playback URL refresh / release) is
                // the web-remote preview mode, not the desktop inline mode; it is
                // refused rather than returning a fabricated URL.
                Err(HandlerError::message(format!(
                    "media-preview.{method} is the host-range-url preview surface and is not \
                     served by the desktop inline host"
                )))
            }
            other => Err(HandlerError::message(format!(
                "media-preview.{other} is not implemented by the Rust host"
            ))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        _event: &str,
        _arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>> {
        None
    }
}

fn handler_error(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::message(error.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_audio_file_prepares_an_inline_base64_preview() {
        // Containment only admits allowlist roots (home / data base dir); the
        // probe file must live under one, so this uses the homedir root.
        let dir = std::path::Path::new(&paths::homedir())
            .join(format!("zcode-media-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("clip.mp3");
        std::fs::write(&file, b"ID3fakeaudio").unwrap();

        let service = MediaPreviewService::new();
        let preview = service
            .prepare_inline(&file.to_string_lossy(), "audio")
            .expect("inline audio preview");
        assert_eq!(preview.kind, "inline");
        assert_eq!(preview.media_type, "audio/mpeg");
        assert_eq!(preview.size, 12);
        assert!(!preview.data_base64.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_kind_mismatch_or_unknown_format_is_a_loud_error() {
        let service = MediaPreviewService::new();
        // Unknown format.
        assert!(service.prepare_inline("/tmp/x.txt", "audio").is_err());
        // Known format but wrong expected kind.
        assert!(service.prepare_inline("/tmp/x.mp3", "video").is_err());
    }
}
