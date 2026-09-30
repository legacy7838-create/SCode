//! Ported service channels.
//!
//! Each module here is a Rust implementation of one channel from
//! `packages/services`, registered against the in-process RPC registry so the UI
//! gets it from the host instead of from `@zcode/server`.
//!
//! The contract is byte-level: the JSON shapes, defaults, and normalisation rules
//! are transcribed from the TypeScript original rather than redesigned, because
//! the UI parses these values directly. Where a rule exists to clamp untrusted
//! input (probe timeouts, attempt counts) it is kept identical, including the
//! silent fallbacks.

pub mod credential;
pub mod paths;
pub mod private_file;
pub mod setting;
pub mod system;

pub use credential::CredentialService;
pub use setting::SettingService;
pub use system::SystemService;
