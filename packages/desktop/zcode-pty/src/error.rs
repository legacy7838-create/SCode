//! Error mapping so the addon surfaces the same operator-facing text the old JS service threw.

use napi::bindgen_prelude::Error;

/// Convert a generic failure into a `napi::Error` carrying a readable reason.
pub fn to_napi_error<E: std::fmt::Display>(err: E) -> Error {
    Error::from_reason(err.to_string())
}
