//! `onboarding-record` channel — the local onboarding completion record.
//!
//! Transcribed from `packages/services/src/onboarding/onboardingRecordService.ts`
//! against the zod schemas in `packages/shared/src/onboardingRecord.ts`. The file
//! is `{appConfigDir}/onboarding-record.json`, which the Node host keeps writing
//! until rung 9, so the bytes have to be the bytes the TS writer produced:
//! `docs/specs/rust-native-server.md` rung 2.
//!
//! Three properties of the original are load-bearing and are reproduced rather
//! than simplified:
//!
//! 1. **zod objects strip, they do not reject.** An unknown key in a file written
//!    by a newer build is dropped on read and never comes back on write.
//! 2. **Every key is required.** `.nullable()` accepts an explicit `null`, *not* a
//!    missing key — `parse` fails on `{"occupation": …}` without `userId`, and a
//!    failed parse makes the whole file "missing". `Option<T>` would accept a
//!    missing key as `None` and silently disagree, so each field is read as a
//!    `JsonValue` first and rejected when it is absent.
//! 3. **Key order is the schema's, not the caller's.** `JSON.stringify(file,
//!    null, 2)` emits `userId, occupation, interfaceMode, …` because zod rebuilds
//!    the object from its shape, so a caller that spread its fields in another
//!    order still produced this file. The `Serialize` impls below declare the
//!    fields in that order for the same reason.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

use crate::services::credential::CredentialService;
use crate::services::paths;
use crate::services::private_file::{atomic_write_private_text_file, with_file_lock};
use crate::services::zcode_task_channel::ZCodeTaskService;

/// The record sits next to `setting.json`, following `dataBaseDir`
/// (`onboardingRecordService.ts:19`).
const RECORD_FILE_NAME: &str = "onboarding-record.json";
/// `ACTIVE_PROVIDER_KEY` in `oauth/repo/oauthCredentialRepo.ts`.
const ACTIVE_PROVIDER_KEY: &str = "oauth:active_provider";
/// The one provider that stores `user_info` as the raw backend `data.user`.
const ZAI_PROVIDER_ID: &str = "zai";
/// `appSettingsOccupationEnum` (`packages/shared/src/validationAppSettings.ts:14`).
/// The record's `occupation` is an open string — the list keeps evolving and old
/// records must not fail validation — so this is only the narrowing applied when
/// a record is written back into settings.
const OCCUPATIONS: [&str; 14] = [
    "office",
    "developer",
    "independent",
    "infrastructure",
    "product",
    "design",
    "student",
    "creator",
    "operations",
    "marketing",
    "finance",
    "accounting",
    "legal",
    "other",
];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/// `z.literal("pending")`. The stored state is a reservation for a future
/// server upload; a record claiming any other state fails validation, which in
/// turn makes the file read as missing — exactly as zod does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UploadState {
    Pending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionStatus {
    Dismissed,
    ExistingLocalUser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionReason {
    UserClosed,
    ExistingLocalTask,
}

/// One onboarding answer. Field order is the zod shape order (see module docs).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    #[serde(rename = "userId")]
    pub user_id: Option<String>,
    pub occupation: Option<String>,
    #[serde(rename = "interfaceMode")]
    pub interface_mode: Option<String>,
    #[serde(rename = "proactiveSuggestionsEnabled")]
    pub proactive_suggestions_enabled: Option<bool>,
    #[serde(rename = "completedAt")]
    pub completed_at: String,
    #[serde(rename = "uploadState")]
    pub upload_state: UploadState,
}

/// The raw shape every field is read as: `JsonValue` is what makes an *absent*
/// key an error (`serde`'s `missing_field` only collapses to `None` for
/// `Option<T>`), while an explicit `null` still reaches the validator below.
#[derive(Deserialize)]
struct EntryRaw {
    #[serde(rename = "userId")]
    user_id: JsonValue,
    occupation: JsonValue,
    #[serde(rename = "interfaceMode")]
    interface_mode: JsonValue,
    #[serde(rename = "proactiveSuggestionsEnabled")]
    proactive_suggestions_enabled: JsonValue,
    #[serde(rename = "completedAt")]
    completed_at: JsonValue,
    #[serde(rename = "uploadState")]
    upload_state: JsonValue,
}

impl TryFrom<EntryRaw> for Entry {
    type Error = String;

    fn try_from(raw: EntryRaw) -> Result<Self, Self::Error> {
        Ok(Self {
            user_id: nullable_non_empty_string(raw.user_id, "userId")?,
            occupation: nullable_non_empty_string(raw.occupation, "occupation")?,
            interface_mode: nullable_interface_mode(raw.interface_mode)?,
            proactive_suggestions_enabled: nullable_bool(
                raw.proactive_suggestions_enabled,
                "proactiveSuggestionsEnabled",
            )?,
            completed_at: non_empty_string(raw.completed_at, "completedAt")?,
            upload_state: pending_upload_state(raw.upload_state)?,
        })
    }
}

impl<'de> Deserialize<'de> for Entry {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = EntryRaw::deserialize(deserializer)?;
        Entry::try_from(raw).map_err(<D::Error as serde::de::Error>::custom)
    }
}

/// One trigger decision (`dismissed` / `existing_local_user`). Field order is
/// the zod shape order.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Decision {
    #[serde(rename = "userId")]
    pub user_id: Option<String>,
    pub status: DecisionStatus,
    pub reason: DecisionReason,
    #[serde(rename = "decidedAt")]
    pub decided_at: String,
}

#[derive(Deserialize)]
struct DecisionRaw {
    #[serde(rename = "userId")]
    user_id: JsonValue,
    status: JsonValue,
    reason: JsonValue,
    #[serde(rename = "decidedAt")]
    decided_at: JsonValue,
}

impl TryFrom<DecisionRaw> for Decision {
    type Error = String;

    fn try_from(raw: DecisionRaw) -> Result<Self, Self::Error> {
        let status = match raw.status.as_str() {
            Some("dismissed") => DecisionStatus::Dismissed,
            Some("existing_local_user") => DecisionStatus::ExistingLocalUser,
            _ => {
                return Err(invalid(
                    "status",
                    "`dismissed` or `existing_local_user`",
                ))
            }
        };
        let reason = match raw.reason.as_str() {
            Some("user_closed") => DecisionReason::UserClosed,
            Some("existing_local_task") => DecisionReason::ExistingLocalTask,
            _ => return Err(invalid("reason", "`user_closed` or `existing_local_task`")),
        };
        Ok(Self {
            user_id: nullable_non_empty_string(raw.user_id, "userId")?,
            status,
            reason,
            decided_at: non_empty_string(raw.decided_at, "decidedAt")?,
        })
    }
}

impl<'de> Deserialize<'de> for Decision {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = DecisionRaw::deserialize(deserializer)?;
        Decision::try_from(raw).map_err(<D::Error as serde::de::Error>::custom)
    }
}

/// The record file, always normalised to v2 (`version` is written as `2` even
/// when the file on disk was v1). Field order is the zod shape order of both
/// v1 and v2, so the transform's `{...file, version: 2, decisions: []}` and a
/// native v2 file serialise identically.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecordFile {
    pub version: u32,
    #[serde(rename = "deviceMid")]
    pub device_mid: String,
    pub entries: Vec<Entry>,
    pub decisions: Vec<Decision>,
}

impl RecordFile {
    /// `createFile(deviceMid)` — what the TS writes when there is no readable
    /// file yet (including when the previous one was corrupt).
    fn new(device_mid: &str) -> Self {
        Self {
            version: 2,
            device_mid: device_mid.to_owned(),
            entries: Vec::new(),
            decisions: Vec::new(),
        }
    }
}

/// `syncSettingsFromRecord`'s patch. Declared as a struct so the key order is
/// the object literal's, not a JSON map's.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SettingsSyncPatch {
    #[serde(rename = "onboardingOccupation")]
    pub onboarding_occupation: String,
    #[serde(rename = "proactiveSuggestionsEnabled")]
    pub proactive_suggestions_enabled: bool,
}

// ---------------------------------------------------------------------------
// Validation helpers (the zod rules, spelled out)
// ---------------------------------------------------------------------------

fn invalid(field: &str, expected: &str) -> String {
    format!("invalid onboarding record: `{field}` must be {expected}")
}

fn missing(field: &str) -> String {
    format!("invalid onboarding record: missing `{field}`")
}

/// `z.string().min(1).nullable()`: the key is required, `null` is a value, and
/// an empty string fails.
fn nullable_non_empty_string(value: JsonValue, field: &str) -> Result<Option<String>, String> {
    match value {
        JsonValue::Null => Ok(None),
        JsonValue::String(text) if !text.is_empty() => Ok(Some(text)),
        JsonValue::String(_) => Err(invalid(field, "a non-empty string or null")),
        _ => Err(invalid(field, "a string or null")),
    }
}

fn non_empty_string(value: JsonValue, field: &str) -> Result<String, String> {
    nullable_non_empty_string(value, field)?.ok_or_else(|| invalid(field, "a non-empty string"))
}

fn nullable_bool(value: JsonValue, field: &str) -> Result<Option<bool>, String> {
    match value {
        JsonValue::Null => Ok(None),
        JsonValue::Bool(flag) => Ok(Some(flag)),
        _ => Err(invalid(field, "a boolean or null")),
    }
}

/// `z.enum(["coding", "office"]).nullable()`.
fn nullable_interface_mode(value: JsonValue) -> Result<Option<String>, String> {
    match value {
        JsonValue::Null => Ok(None),
        JsonValue::String(mode) if mode == "coding" || mode == "office" => Ok(Some(mode)),
        _ => Err(invalid("interfaceMode", "`coding`, `office` or null")),
    }
}

fn pending_upload_state(value: JsonValue) -> Result<UploadState, String> {
    match value {
        JsonValue::String(state) if state == "pending" => Ok(UploadState::Pending),
        _ => Err(invalid("uploadState", "\"pending\"")),
    }
}

/// `z.literal(1)` / `z.literal(2)` accept a JSON number equal to it, so `1.0`
/// counts; a string or a bool does not.
fn integral_u32(value: Option<&JsonValue>) -> Option<u32> {
    match value? {
        JsonValue::Number(number) => {
            if let Some(integer) = number.as_u64() {
                return u32::try_from(integer).ok();
            }
            let float = number.as_f64()?;
            if float.fract() == 0.0 && float >= 0.0 && float <= f64::from(u32::MAX) {
                Some(float as u32)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn required_field(object: &JsonMap<String, JsonValue>, field: &str) -> Result<String, String> {
    match object.get(field) {
        Some(value) => non_empty_string(value.clone(), field),
        None => Err(missing(field)),
    }
}

fn required_entries(object: &JsonMap<String, JsonValue>, field: &str) -> Result<Vec<Entry>, String> {
    let value = object.get(field).ok_or_else(|| missing(field))?;
    let array = value.as_array().ok_or_else(|| invalid(field, "an array"))?;
    array
        .iter()
        .map(|item| {
            serde_json::from_value::<Entry>(item.clone())
                .map_err(|error| format!("invalid onboarding record: {error}"))
        })
        .collect()
}

fn required_decisions(
    object: &JsonMap<String, JsonValue>,
    field: &str,
) -> Result<Vec<Decision>, String> {
    let value = object.get(field).ok_or_else(|| missing(field))?;
    let array = value.as_array().ok_or_else(|| invalid(field, "an array"))?;
    array
        .iter()
        .map(|item| {
            serde_json::from_value::<Decision>(item.clone())
                .map_err(|error| format!("invalid onboarding record: {error}"))
        })
        .collect()
}

/// `z.union([v1, v2]).transform(…)`.
///
/// The `version` literal is what discriminates, so trying v1 first and v2
/// second is the same decision as the union's first-match-wins order: a v2 file
/// fails v1 on the literal, and a version the schemas do not know fails both.
/// A v1 file has no `decisions` — the transform appends `[]`, and a `decisions`
/// key present on a v1 file is dropped, because zod's v1 object strips it.
fn parse_record_file(raw: &str) -> Result<RecordFile, String> {
    let value: JsonValue =
        serde_json::from_str(raw).map_err(|error| format!("invalid onboarding record: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| invalid("record", "an object"))?;
    let version = integral_u32(object.get("version"));
    match version {
        Some(1) => Ok(RecordFile {
            version: 2,
            device_mid: required_field(object, "deviceMid")?,
            entries: required_entries(object, "entries")?,
            decisions: Vec::new(),
        }),
        Some(2) => Ok(RecordFile {
            version: 2,
            device_mid: required_field(object, "deviceMid")?,
            entries: required_entries(object, "entries")?,
            decisions: required_decisions(object, "decisions")?,
        }),
        other => Err(match other {
            Some(version) => format!("invalid onboarding record: unsupported version {version}"),
            None => missing("version"),
        }),
    }
}

// ---------------------------------------------------------------------------
// userId: `oauthCredentialRepo.loadActiveUserProfile()?.id ?? null`
// ---------------------------------------------------------------------------

/// Read the signed-in user's id out of the credential store.
///
/// A credential that cannot be decrypted is "not signed in" here, with a
/// warning. The original additionally clears the whole OAuth session (and, via
/// `onCorruptOAuthSessionCleared`, the derived model-provider keys); that clear
/// belongs to the oauth plane (rung 7) and doing it half-way — without the
/// derived keys — would be a worse divergence than deferring it. The value this
/// function returns is the same either way.
fn active_user_id(credentials: &CredentialService) -> Option<String> {
    let provider = match credentials.load_string(ACTIVE_PROVIDER_KEY) {
        Ok(provider) => provider,
        Err(error) => {
            tracing::warn!(
                %error,
                "cannot decrypt the active oauth provider; treating the user as signed out"
            );
            return None;
        }
    };
    // `if (!provider) return null` — an empty stored value is falsy in JS.
    let provider = provider.filter(|value| !value.is_empty())?;
    let key = format!("oauth:{provider}:user_info");
    let raw = match credentials.load_string(&key) {
        Ok(raw) => raw,
        Err(error) => {
            tracing::warn!(
                %error,
                "cannot decrypt the active oauth user profile; treating the user as signed out"
            );
            return None;
        }
    };
    let raw = raw.filter(|value| !value.is_empty())?;
    parse_user_id(&raw, &provider)
}

fn parse_user_id(raw: &str, provider: &str) -> Option<String> {
    // `JSON.parse` failure is caught in the original and yields null.
    let value: JsonValue = serde_json::from_str(raw).ok()?;
    let JsonValue::Object(map) = value else {
        return None;
    };
    // The normalized profile shape `loadUserProfileFromKey` accepts first.
    if matches!(
        (map.get("id"), map.get("username"), map.get("displayName")),
        (Some(JsonValue::String(_)), Some(JsonValue::String(_)), Some(JsonValue::String(_)))
    ) {
        if let Some(JsonValue::String(id)) = map.get("id") {
            return Some(id.clone());
        }
    }
    // `zai` persists the raw backend `data.user`, whose display fields map from
    // `user_id` / `name` / `avatar`. Only `.id` is needed for this channel; the
    // display mapping is part of the oauth plane (rung 7).
    if provider == ZAI_PROVIDER_ID {
        return zai_user_id(&map);
    }
    None
}

/// `toOAuthUserProfileFromRawZaiUser`, reduced to the id it can return.
fn zai_user_id(map: &JsonMap<String, JsonValue>) -> Option<String> {
    let id = map
        .get("user_id")
        .and_then(JsonValue::as_str)
        .unwrap_or("unknown");
    let name = map
        .get("name")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .trim();
    let email = map.get("email").and_then(JsonValue::as_str).unwrap_or("");
    if name.is_empty() && email.is_empty() && id == "unknown" {
        return None;
    }
    Some(id.to_owned())
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type UserIdLoader = Box<dyn Fn() -> Option<String> + Send + Sync>;
type LocalTaskProbe = Box<dyn Fn() -> Result<bool, String> + Send + Sync>;

pub struct OnboardingRecordService {
    /// The TS `writeQueue`: one read-modify-write at a time in this process, so
    /// a concurrent `appendRecord` and `shouldOnboard` cannot both read the old
    /// file and lose one of the two writes. Other processes are covered by the
    /// directory lock taken in [`Self::write_record`].
    write_queue: Mutex<()>,
    record_file: PathBuf,
    load_user_id: UserIdLoader,
    has_existing_local_task: LocalTaskProbe,
}

impl OnboardingRecordService {
    /// Build the production service over the two stores the channel depends on.
    ///
    /// Both are passed in already built and are shared with their own channels
    /// (`credential`, `zcode-task`): one credential instance and one task-index
    /// connection in the process, never a second reader with its own state.
    pub fn new(
        credentials: Arc<CredentialService>,
        task_index: Arc<ZCodeTaskService>,
    ) -> Result<Self, String> {
        Ok(Self::with_dependencies(
            paths::app_config_dir().join(RECORD_FILE_NAME),
            Box::new(move || active_user_id(&credentials)),
            Box::new(move || task_index.has_any_task()),
        ))
    }

    /// Test seam: explicit file path and injected answers.
    pub(crate) fn with_dependencies(
        record_file: PathBuf,
        load_user_id: UserIdLoader,
        has_existing_local_task: LocalTaskProbe,
    ) -> Self {
        Self {
            write_queue: Mutex::new(()),
            record_file,
            load_user_id,
            has_existing_local_task,
        }
    }

    /// Read the record. `None` for "no file", "unreadable", and "does not
    /// validate" alike — the original logs a warning and treats all three as
    /// "never recorded", and the next write rebuilds the file from scratch.
    fn read_record(&self) -> Option<RecordFile> {
        let raw = match std::fs::read_to_string(&self.record_file) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => {
                tracing::warn!(%error, path = %self.record_file.display(), "read onboarding record failed");
                return None;
            }
        };
        match parse_record_file(&raw) {
            Ok(file) => Some(file),
            Err(error) => {
                tracing::warn!(
                    %error,
                    "invalid onboarding record json, treating as missing"
                );
                None
            }
        }
    }

    /// Replace the file so a reader sees the old bytes or the new ones, never a
    /// partial write, under the same cross-process lock the original takes.
    fn write_record(&self, file: &RecordFile) -> Result<(), HandlerError> {
        let body = serde_json::to_string_pretty(file)
            .map_err(|error| HandlerError::message(format!("cannot serialise record: {error}")))?;
        with_file_lock(&self.record_file, || {
            atomic_write_private_text_file(&self.record_file, &body)
        })
        .map_err(HandlerError::message)
    }

    fn lock_queue(&self) -> Result<MutexGuard<'_, ()>, HandlerError> {
        self.write_queue
            .lock()
            .map_err(|_| HandlerError::message("onboarding record write queue poisoned"))
    }

    fn has_identity_record(file: &RecordFile, user_id: &Option<String>) -> bool {
        file.entries.iter().any(|entry| &entry.user_id == user_id)
            || file.decisions.iter().any(|decision| &decision.user_id == user_id)
    }

    /// Build and validate a decision the way `onboardingDecisionSchema.parse`
    /// does — including rejecting an empty `userId`, which is reachable when a
    /// stored profile carries `id: ""`.
    fn validated_decision(
        user_id: &Option<String>,
        status: DecisionStatus,
        reason: DecisionReason,
    ) -> Result<Decision, HandlerError> {
        serde_json::from_value(json!({
            "userId": user_id,
            "status": status,
            "reason": reason,
            "decidedAt": now_iso(),
        }))
        .map_err(|error| HandlerError::message(format!("invalid onboarding decision: {error}")))
    }

    /// `appendRecord(deviceMid, entry)`.
    fn append_record(&self, device_mid: &str, entry_value: &JsonValue) -> Result<(), HandlerError> {
        let user_id = (self.load_user_id)();
        let _guard = self.lock_queue()?;
        let existing = self.read_record();
        let mut file = match existing {
            Some(existing) => {
                // deviceMid is the device anchor: the file's own value wins and a
                // mismatch only warns, because keeping it is what makes the device
                // association stable.
                if existing.device_mid != device_mid {
                    tracing::warn!(
                        existing = %existing.device_mid,
                        incoming = %device_mid,
                        "deviceMid mismatch, keep existing"
                    );
                }
                existing
            }
            None => RecordFile::new(device_mid),
        };

        // `record = { userId, ...entry, uploadState: "pending" }`: the caller's
        // own `userId`, if it sent one, wins over the resolved one, and
        // `uploadState` is always reset to `pending`.
        let mut merged = JsonMap::new();
        merged.insert(
            "userId".to_owned(),
            user_id
                .clone()
                .map(JsonValue::String)
                .unwrap_or(JsonValue::Null),
        );
        if let JsonValue::Object(fields) = entry_value {
            for (key, value) in fields {
                merged.insert(key.clone(), value.clone());
            }
        }
        merged.insert("uploadState".to_owned(), json!("pending"));
        let entry = serde_json::from_value::<Entry>(JsonValue::Object(merged))
            .map_err(|error| HandlerError::message(format!("invalid onboarding entry: {error}")))?;

        // At most one record per userId: a repeat completion overwrites rather
        // than appends, and the replaced answer is cleared of its decision.
        match file.entries.iter().position(|item| item.user_id == user_id) {
            Some(index) => file.entries[index] = entry,
            None => file.entries.push(entry),
        }
        file.decisions.retain(|decision| decision.user_id != user_id);
        self.write_record(&file)
    }

    /// `claimAnonymousRecord()`: the anonymous entry is *rewritten* in place for
    /// the signed-in user, never copied — one onboarding action must not become
    /// two records. Idempotent: logged out, or when the user already has one.
    fn claim_anonymous_record(&self) -> Result<(), HandlerError> {
        // `if (!userId) return;` — an empty id is falsy in JS and logs nothing.
        let user_id = (self.load_user_id)();
        let Some(user_id) = user_id.filter(|value| !value.is_empty()) else {
            return Ok(());
        };
        let _guard = self.lock_queue()?;
        let Some(mut file) = self.read_record() else {
            return Ok(());
        };
        if Self::has_identity_record(&file, &Some(user_id.clone())) {
            return Ok(());
        }
        // Old versions could hold duplicate files, so take the LAST anonymous
        // entry, and stop after the first handover.
        let mut handover = None;
        for index in (0..file.entries.len()).rev() {
            if file.entries[index].user_id.is_none() {
                file.entries[index].user_id = Some(user_id.clone());
                handover = Some(());
                break;
            }
        }
        if handover.is_none() {
            for index in (0..file.decisions.len()).rev() {
                if file.decisions[index].user_id.is_none() {
                    file.decisions[index].user_id = Some(user_id.clone());
                    handover = Some(());
                    break;
                }
            }
        }
        if handover.is_some() {
            self.write_record(&file)?;
        }
        Ok(())
    }

    /// `shouldOnboard(deviceMid)` — true when this user has no record yet.
    fn should_onboard(&self, device_mid: &str) -> Result<bool, HandlerError> {
        let user_id = (self.load_user_id)();
        if let Some(file) = self.read_record() {
            if Self::has_identity_record(&file, &user_id) {
                return Ok(false);
            }
        }
        let has_task = (self.has_existing_local_task)().map_err(HandlerError::message)?;
        if !has_task {
            return Ok(true);
        }
        // An existing profile with no record: record the decision once, so a
        // fresh user is not onboarded over an already-used workspace.
        let _guard = self.lock_queue()?;
        let mut current = self
            .read_record()
            .unwrap_or_else(|| RecordFile::new(device_mid));
        if Self::has_identity_record(&current, &user_id) {
            return Ok(false);
        }
        current.decisions.push(Self::validated_decision(
            &user_id,
            DecisionStatus::ExistingLocalUser,
            DecisionReason::ExistingLocalTask,
        )?);
        self.write_record(&current)?;
        Ok(false)
    }

    /// `dismissOnboarding(deviceMid)` — persists the close; a completed answer
    /// is never overwritten by a dismissal.
    fn dismiss_onboarding(&self, device_mid: &str) -> Result<(), HandlerError> {
        let user_id = (self.load_user_id)();
        let _guard = self.lock_queue()?;
        let mut file = self
            .read_record()
            .unwrap_or_else(|| RecordFile::new(device_mid));
        if file.entries.iter().any(|entry| entry.user_id == user_id) {
            return Ok(());
        }
        let decision = Self::validated_decision(
            &user_id,
            DecisionStatus::Dismissed,
            DecisionReason::UserClosed,
        )?;
        match file
            .decisions
            .iter()
            .position(|item| item.user_id == user_id)
        {
            Some(index) => file.decisions[index] = decision,
            None => file.decisions.push(decision),
        }
        self.write_record(&file)
    }

    /// `getLatestEntry()` — the last entry for this user (overwrite semantics
    /// mean at most one, but duplicates from old files read as "last wins").
    fn get_latest_entry(&self, user_id: &Option<String>) -> Option<Entry> {
        let file = self.read_record()?;
        let mut latest = None;
        for entry in &file.entries {
            if &entry.user_id == user_id {
                latest = Some(entry.clone());
            }
        }
        latest
    }

    /// `syncSettingsFromRecord()` — the patch settings is back-filled with.
    fn sync_settings_from_record(
        &self,
        user_id: &Option<String>,
    ) -> Result<Option<SettingsSyncPatch>, HandlerError> {
        let file = match self.read_record() {
            Some(file) => file,
            None => return Ok(None),
        };
        let mut latest = None;
        for entry in &file.entries {
            if &entry.user_id == user_id {
                latest = Some(entry.clone());
            }
        }
        let Some(latest) = latest else {
            return Ok(None);
        };
        Ok(Some(SettingsSyncPatch {
            // The record's occupation is an open string; settings' is an enum.
            // An unknown or null value back-fills to `other`, matching the
            // recommendation-pool fallback for a skipped page.
            onboarding_occupation: latest
                .occupation
                .as_deref()
                .filter(|value| OCCUPATIONS.contains(value))
                .unwrap_or("other")
                .to_owned(),
            proactive_suggestions_enabled: latest.proactive_suggestions_enabled.unwrap_or(false),
        }))
    }

    /// `updateRecordPreferences(patch)` — a manual settings edit is written back
    /// so switching accounts cannot resurrect a turned-off preference.
    fn update_record_preferences(
        &self,
        user_id: &Option<String>,
        patch: &JsonValue,
    ) -> Result<(), HandlerError> {
        let fields = patch
            .as_object()
            .ok_or_else(|| HandlerError::message("updateRecordPreferences requires an object"))?;
        let _guard = self.lock_queue()?;
        let Some(mut file) = self.read_record() else {
            return Ok(());
        };
        let Some(index) = file
            .entries
            .iter()
            .rposition(|entry| &entry.user_id == user_id)
        else {
            return Ok(());
        };
        // `{ ...entry, ...patch }`, re-validated: keys outside the schema are
        // stripped by zod, and a `null` preference is a legal value.
        let mut merged = serde_json::to_value(&file.entries[index])
            .map_err(|error| HandlerError::message(format!("cannot read entry: {error}")))?;
        if let JsonValue::Object(map) = &mut merged {
            for (key, value) in fields {
                map.insert(key.clone(), value.clone());
            }
        }
        file.entries[index] = serde_json::from_value(merged)
            .map_err(|error| HandlerError::message(format!("invalid onboarding entry: {error}")))?;
        self.write_record(&file)
    }

    fn clear_records(&self) -> Result<(), HandlerError> {
        let _guard = self.lock_queue()?;
        match std::fs::remove_file(&self.record_file) {
            Ok(()) => Ok(()),
            // `rm(…, { force: true })` swallows a missing file.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(HandlerError::message(format!(
                "cannot delete {}: {error}",
                self.record_file.display()
            ))),
        }
    }
}

impl ChannelHandler for OnboardingRecordService {
    fn call(&self, _ctx: &str, method: &str, args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        // Positional arguments, per `ChannelHandler::call`.
        let first = args.first();
        match method {
            "appendRecord" => {
                let device_mid = required_str(first, "deviceMid")?;
                let entry = args.get(1).cloned().unwrap_or(JsonValue::Null);
                self.append_record(device_mid, &entry)?;
                // `Promise<void>`.
                Ok(JsonValue::Null)
            }
            "shouldOnboard" => {
                let device_mid = required_str(first, "deviceMid")?;
                Ok(JsonValue::Bool(self.should_onboard(device_mid)?))
            }
            "dismissOnboarding" => {
                let device_mid = required_str(first, "deviceMid")?;
                self.dismiss_onboarding(device_mid)?;
                Ok(JsonValue::Null)
            }
            "claimAnonymousRecord" => {
                self.claim_anonymous_record()?;
                Ok(JsonValue::Null)
            }
            "getLatestEntry" => {
                let user_id = (self.load_user_id)();
                Ok(serde_json::to_value(self.get_latest_entry(&user_id))
                    .map_err(json_error)?)
            }
            "syncSettingsFromRecord" => {
                let user_id = (self.load_user_id)();
                Ok(
                    serde_json::to_value(self.sync_settings_from_record(&user_id)?)
                        .map_err(json_error)?,
                )
            }
            "updateRecordPreferences" => {
                let user_id = (self.load_user_id)();
                let patch = first.cloned().unwrap_or(JsonValue::Null);
                self.update_record_preferences(&user_id, &patch)?;
                Ok(JsonValue::Null)
            }
            "getRecords" => {
                Ok(serde_json::to_value(self.read_record()).map_err(json_error)?)
            }
            "clearRecords" => {
                self.clear_records()?;
                Ok(JsonValue::Null)
            }
            other => Err(HandlerError::message(format!(
                "onboarding-record.{other} is not implemented by the Rust host"
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

fn required_str<'a>(value: Option<&'a JsonValue>, field: &str) -> Result<&'a str, HandlerError> {
    value.and_then(JsonValue::as_str).ok_or_else(|| {
        HandlerError::message(format!(
            "onboarding-record requires a string `{field}` as its first argument"
        ))
    })
}

/// `HandlerError::message` takes `Into<String>`, which a serialisation error is
/// not; every failure that crosses the wire is a message anyway.
fn json_error(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::message(error.to_string())
}

/// `new Date().toISOString()` — UTC, millisecond precision, `Z` suffix.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRecord {
        dir: PathBuf,
        path: PathBuf,
    }

    impl TempRecord {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("zcode-onboarding-{}-{}", tag, std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp dir");
            let path = dir.join(RECORD_FILE_NAME);
            Self { dir, path }
        }
    }

    impl Drop for TempRecord {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn service(record: &TempRecord, user_id: Option<&str>, has_task: bool) -> OnboardingRecordService {
        let owned = user_id.map(str::to_owned);
        OnboardingRecordService::with_dependencies(
            record.path.clone(),
            Box::new(move || owned.clone()),
            Box::new(move || Ok(has_task)),
        )
    }

    fn entry(occupation: &str) -> JsonValue {
        json!({
            "occupation": occupation,
            "interfaceMode": "coding",
            "proactiveSuggestionsEnabled": false,
            "completedAt": "2026-10-04T09:12:33.512Z",
        })
    }

    /// Produced by the real zod schemas (`onboardingRecordFileSchema.parse` +
    /// `JSON.stringify(_, null, 2)`), with unknown keys stripped and the shape
    /// order applied. If this ever stops matching byte for byte, the Rust writer
    /// is churning a file the Node host also owns.
    const TS_FIXTURE: &str = r#"{
  "version": 2,
  "deviceMid": "dev-8f21c0a4",
  "entries": [
    {
      "userId": "u_2f91",
      "occupation": "developer",
      "interfaceMode": "coding",
      "proactiveSuggestionsEnabled": true,
      "completedAt": "2026-10-04T09:12:33.512Z",
      "uploadState": "pending"
    },
    {
      "userId": null,
      "occupation": null,
      "interfaceMode": null,
      "proactiveSuggestionsEnabled": null,
      "completedAt": "2026-10-04T09:12:40.001Z",
      "uploadState": "pending"
    }
  ],
  "decisions": [
    {
      "userId": null,
      "status": "dismissed",
      "reason": "user_closed",
      "decidedAt": "2026-10-01T02:03:04.005Z"
    }
  ]
}"#;

    #[test]
    fn decodes_and_reencodes_the_ts_written_file_byte_for_byte() {
        let file = parse_record_file(TS_FIXTURE).expect("the TS file must validate");
        assert_eq!(file.version, 2);
        assert_eq!(file.entries.len(), 2);
        assert_eq!(file.decisions.len(), 1);
        let encoded = serde_json::to_string_pretty(&file).expect("encode");
        assert_eq!(encoded, TS_FIXTURE, "the bytes the Node host wrote must round trip");
    }

    #[test]
    fn a_missing_required_key_is_not_an_explicit_null() {
        // zod rejects a missing `occupation` even though the field is nullable;
        // an `Option<T>` field would have accepted it as `null` and read a
        // broken file as a real one.
        let missing_key = r#"{
  "version": 2,
  "deviceMid": "dev-8f21c0a4",
  "entries": [
    { "userId": "u_1", "interfaceMode": null,
      "proactiveSuggestionsEnabled": null, "completedAt": "x", "uploadState": "pending" }
  ],
  "decisions": []
}"#;
        assert!(parse_record_file(missing_key).is_err(), "missing `occupation` must fail");

        let null_value = TS_FIXTURE;
        assert!(parse_record_file(null_value).is_ok(), "an explicit null is a value");
    }

    #[test]
    fn unknown_keys_are_stripped_and_the_shape_order_survives() {
        // A writer that spread its fields in a different order and left extra
        // keys behind still produced this file — zod rebuilds it from the shape.
        let scrambled = r#"{"decisions":[],"entries":[{"uploadState":"pending","completedAt":"2026-10-04T09:12:33.512Z","proactiveSuggestionsEnabled":true,"interfaceMode":"coding","occupation":"developer","userId":"u_2f91","legacyExtra":"dropped"}],"deviceMid":"dev-8f21c0a4","junkFromTheFuture":1,"version":2}"#;
        let file = parse_record_file(scrambled).expect("valid file");
        let encoded = serde_json::to_string_pretty(&file).expect("encode");
        assert!(encoded.contains("\n      \"userId\": \"u_2f91\","));
        assert!(!encoded.contains("legacyExtra"));
        assert!(!encoded.contains("junkFromTheFuture"));
        assert!(encoded.starts_with("{\n  \"version\": 2,\n  \"deviceMid\":"));
    }

    #[test]
    fn a_v1_file_reads_as_v2_with_no_decisions() {
        let v1 = r#"{"version":1,"deviceMid":"dev-8f21c0a4","entries":[],"decisions":"ignored"}"#;
        let file = parse_record_file(v1).expect("v1 must parse");
        assert_eq!(file.version, 2, "the transform writes version 2");
        assert!(file.decisions.is_empty(), "v1 has no decisions; a stray key is stripped");
        assert!(parse_record_file(r#"{"version":3,"deviceMid":"m","entries":[],"decisions":[]}"#).is_err());
    }

    #[test]
    fn an_unreadable_record_reads_as_missing() {
        let record = TempRecord::new("missing");
        let service = service(&record, Some("u_1"), false);
        assert_eq!(
            serde_json::to_value(service.read_record()).expect("value"),
            JsonValue::Null
        );
        std::fs::write(&record.path, "{ not json").expect("write corrupt");
        assert_eq!(
            serde_json::to_value(service.read_record()).expect("value"),
            JsonValue::Null,
            "a corrupt file is 'never recorded', not an error"
        );
    }

    #[test]
    fn append_record_writes_the_ts_shape_and_keeps_one_entry_per_user() {
        let record = TempRecord::new("append");
        let service = service(&record, Some("u_1"), false);

        service
            .append_record("dev-8f21c0a4", &entry("developer"))
            .expect("first append");
        let written = std::fs::read_to_string(&record.path).expect("read back");
        assert!(
            written.starts_with("{\n  \"version\": 2,\n  \"deviceMid\": \"dev-8f21c0a4\",\n  \"entries\": [\n    {\n      \"userId\": \"u_1\","),
            "shape: {written}"
        );
        assert!(written.contains("\"uploadState\": \"pending\""));

        // A second answer for the same user overwrites; it does not append.
        service
            .append_record("dev-8f21c0a4", &entry("design"))
            .expect("second append");
        let file = service.read_record().expect("readable");
        assert_eq!(file.entries.len(), 1, "one entry per userId");
        assert_eq!(file.entries[0].occupation.as_deref(), Some("design"));
        assert_eq!(file.device_mid, "dev-8f21c0a4");
    }

    #[test]
    fn a_device_mid_mismatch_keeps_the_files_own_value() {
        let record = TempRecord::new("mid");
        let service = service(&record, Some("u_1"), false);
        service
            .append_record("dev-original", &entry("developer"))
            .expect("seed");
        service
            .append_record("dev-somewhere-else", &entry("developer"))
            .expect("append");
        let file = service.read_record().expect("readable");
        assert_eq!(
            file.device_mid, "dev-original",
            "the device anchor is the file's, a mismatch only warns"
        );
    }

    #[test]
    fn an_empty_user_id_is_rejected_on_append() {
        // A stored profile with `id: ""` reaches the schema, which is min(1):
        // the original throws rather than writing a record nobody can match.
        let record = TempRecord::new("empty-id");
        let service = service(&record, Some(""), false);
        let error = service
            .append_record("dev-8f21c0a4", &entry("developer"))
            .expect_err("empty userId must fail validation");
        assert!(error.to_payload().1.to_string().contains("userId"), "{error}");
        assert!(!record.path.exists(), "nothing may be written: {:?}", record.path);
    }

    #[test]
    fn should_onboard_writes_the_existing_local_task_decision_once() {
        let record = TempRecord::new("should");
        // No record, no local task: a genuinely new user is onboarded.
        let fresh = service(&record, Some("u_1"), false);
        assert!(fresh.should_onboard("dev-8f21c0a4").expect("decision"));
        assert!(!record.path.exists(), "a true answer writes nothing");

        // A workspace that already has tasks records the decision instead.
        let existing = service(&record, Some("u_1"), true);
        assert!(!existing.should_onboard("dev-8f21c0a4").expect("decision"));
        let file = existing.read_record().expect("decision written");
        assert_eq!(file.entries.len(), 0);
        assert_eq!(file.decisions.len(), 1);
        assert_eq!(file.decisions[0].status, DecisionStatus::ExistingLocalUser);
        assert_eq!(file.decisions[0].reason, DecisionReason::ExistingLocalTask);
        assert_eq!(file.device_mid, "dev-8f21c0a4");

        // Writing it twice does not duplicate it.
        assert!(!existing.should_onboard("dev-8f21c0a4").expect("decision"));
        assert_eq!(existing.read_record().expect("readable").decisions.len(), 1);

        // And a completed answer overrides the decision for that user.
        existing
            .append_record("dev-8f21c0a4", &entry("developer"))
            .expect("append");
        assert!(!existing.should_onboard("dev-8f21c0a4").expect("decision"));
        let file = existing.read_record().expect("readable");
        assert_eq!(file.decisions.len(), 0, "the decision is cleared on answer");
        assert_eq!(file.entries.len(), 1);
    }

    #[test]
    fn claim_anonymous_rewrites_the_entry_instead_of_copying_it() {
        let record = TempRecord::new("claim");
        let anonymous = service(&record, None, false);
        anonymous
            .append_record("dev-8f21c0a4", &entry("developer"))
            .expect("anonymous answer");
        assert!(anonymous.read_record().expect("readable").entries[0].user_id.is_none());

        let signed_in = service(&record, Some("u_1"), false);
        signed_in.claim_anonymous_record().expect("claim");
        let file = signed_in.read_record().expect("readable");
        assert_eq!(file.entries.len(), 1, "handover rewrites, it does not copy");
        assert_eq!(file.entries[0].user_id.as_deref(), Some("u_1"));

        // Claiming again is a no-op, and a logged-out caller does nothing.
        signed_in.claim_anonymous_record().expect("claim again");
        assert_eq!(signed_in.read_record().expect("readable").entries.len(), 1);
        anonymous.claim_anonymous_record().expect("logged out");
    }

    #[test]
    fn dismiss_persists_a_decision_but_never_overwrites_an_answer() {
        let record = TempRecord::new("dismiss");
        let service = service(&record, Some("u_1"), false);
        service.dismiss_onboarding("dev-8f21c0a4").expect("dismiss");
        let file = service.read_record().expect("readable");
        assert_eq!(file.decisions.len(), 1);
        assert_eq!(file.decisions[0].status, DecisionStatus::Dismissed);
        assert_eq!(file.decisions[0].reason, DecisionReason::UserClosed);

        service
            .append_record("dev-8f21c0a4", &entry("developer"))
            .expect("answer");
        service.dismiss_onboarding("dev-8f21c0a4").expect("dismiss");
        let file = service.read_record().expect("readable");
        assert_eq!(file.entries.len(), 1, "a completed answer survives a dismissal");
        assert_eq!(file.decisions.len(), 0, "the decision is cleared by the answer");
    }

    #[test]
    fn settings_sync_backfills_unknown_occupation_and_null_preferences() {
        let record = TempRecord::new("sync");
        let service = service(&record, Some("u_1"), false);
        // Nothing to sync for a user with no record.
        assert!(service
            .sync_settings_from_record(&Some("u_1".to_owned()))
            .expect("sync")
            .is_none());

        let mut skipped = entry("archaeologist");
        skipped["proactiveSuggestionsEnabled"] = JsonValue::Null;
        service
            .append_record("dev-8f21c0a4", &skipped)
            .expect("append");
        let patch = service
            .sync_settings_from_record(&Some("u_1".to_owned()))
            .expect("sync")
            .expect("a record yields a patch");
        assert_eq!(patch.onboarding_occupation, "other", "the record's list is open; settings' is an enum");
        assert!(!patch.proactive_suggestions_enabled, "a skipped page is off, not null");

        service
            .append_record("dev-8f21c0a4", &entry("developer"))
            .expect("append");
        let patch = service
            .sync_settings_from_record(&Some("u_1".to_owned()))
            .expect("sync")
            .expect("a record yields a patch");
        assert_eq!(patch.onboarding_occupation, "developer");
        assert!(!patch.proactive_suggestions_enabled, "the entry recorded suggestions off");

        // Another user sees no patch.
        assert!(service
            .sync_settings_from_record(&Some("u_999".to_owned()))
            .expect("sync")
            .is_none());
    }

    #[test]
    fn update_record_preferences_writes_back_only_the_last_matching_entry() {
        let record = TempRecord::new("prefs");
        let service = service(&record, Some("u_1"), false);
        // No file yet: the original returns without creating one.
        service
            .update_record_preferences(&Some("u_1".to_owned()), &json!({}))
            .expect("update");
        assert!(!record.path.exists(), "no file is created");

        service
            .append_record("dev-8f21c0a4", &entry("developer"))
            .expect("append");
        service
            .update_record_preferences(
                &Some("u_1".to_owned()),
                &json!({"proactiveSuggestionsEnabled": true, "notASchemaKey": 1}),
            )
            .expect("update");
        let file = service.read_record().expect("readable");
        assert_eq!(file.entries.len(), 1);
        assert_eq!(file.entries[0].proactive_suggestions_enabled, Some(true));
        let written = std::fs::read_to_string(&record.path).expect("read back");
        assert!(!written.contains("notASchemaKey"), "unknown patch keys are stripped");

        // A different user's record is left alone.
        service
            .update_record_preferences(&Some("u_999".to_owned()), &json!({}))
            .expect("update");
        assert_eq!(
            service
                .read_record()
                .expect("readable")
                .entries[0]
                .proactive_suggestions_enabled,
            Some(true)
        );
    }

    #[test]
    fn clear_records_removes_the_file_and_tolerates_a_missing_one() {
        let record = TempRecord::new("clear");
        let service = service(&record, Some("u_1"), false);
        service.clear_records().expect("clear a missing file");
        service
            .append_record("dev-8f21c0a4", &entry("developer"))
            .expect("append");
        assert!(record.path.exists());
        service.clear_records().expect("clear");
        assert!(!record.path.exists());
    }

    #[test]
    fn an_unregistered_method_stays_a_loud_error() {
        let record = TempRecord::new("unknown");
        let service = service(&record, Some("u_1"), false);
        let error = service
            .call("", "uploadRecords", &[])
            .expect_err("no such method");
        assert!(
            error.to_payload().1.to_string().contains("not implemented"),
            "{error}"
        );
    }
}
