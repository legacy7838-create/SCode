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

pub mod agent_client;
pub mod agent_process;
pub mod broadcast_channel;
pub mod builtin_provider_config;
pub mod client_config;
pub mod client_scenes;
pub mod credential;
pub mod file_channel;
pub mod file_watcher;
pub mod git_channel;
pub mod git_checkpoint_channel;
pub mod host_capability;
pub mod media_preview_channel;
pub mod model_selection;
pub mod off_peak_task_channel;
pub mod onboarding_record;
pub mod paths;
pub mod prompt_attachment_channel;
pub use zcode_private_file as private_file;
pub mod provider_settings;
pub mod setting;
pub mod system;
pub mod workspace_index;
pub mod zcode_agent_channel;
pub mod zcode_protocol;
pub mod zcode_task_channel;

pub use client_config::ClientConfigService;
pub use client_scenes::ClientScenesService;
pub use credential::CredentialService;
pub use git_channel::GitService;
pub use git_checkpoint_channel::GitCheckpointService;
pub use broadcast_channel::BroadcastService;
pub use zcode_agent_channel::ZCodeAgentService;
pub use file_channel::FileService;
pub use file_watcher::FileWatcherService;
pub use media_preview_channel::MediaPreviewService;
pub use model_selection::ModelSelectionService;
pub use off_peak_task_channel::OffPeakTaskService;
pub use onboarding_record::OnboardingRecordService;
pub use provider_settings::ProviderSettingsService;
pub use prompt_attachment_channel::PromptAttachmentTransferService;
pub use setting::SettingService;
pub use system::SystemService;
pub use zcode_task_channel::ZCodeTaskService;
