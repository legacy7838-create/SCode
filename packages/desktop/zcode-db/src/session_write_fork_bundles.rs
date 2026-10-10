//! Fork composite bundle WRITE ops — the two ATOMIC multi-step writes that copy an entire chat
//! transcript (child session + messages + parts + entries + input + parent command fact) in ONE
//! transaction. Ported from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts`
//! (`createForkedSessionWithMetadata` ~315-382, `commitForkBundle` ~384-470) plus the private
//! `assertForkBundleChildLocal` (~105-221) / `forkChildSessionId` (~105-113) guards, and
//! `cloneSessionTargetForFork` from `apps/zcode-cli/packages/adapters/src/storage/session-target.ts`.
//!
//! WHY these are composites: the TS wraps MULTIPLE already-ported sub-writes in a single
//! `db.exec("begin immediate")` … `commit` / `rollback`. The stateless addon mirrors that exactly:
//! each `#[napi]` wrapper opens ONE read-write connection, issues `BEGIN IMMEDIATE`, calls the pure
//! `pub fn(&Connection, …)` orchestration on that SAME connection (which in turn reuses the already-
//! ported cores on it), then `COMMIT`s, or `ROLLBACK`s and returns `Err` on ANY step failure. No
//! sub-step SQL is re-implemented — the cores
//! [`crate::session_write_create_session::create_session`],
//! [`crate::session_write_messages::save_message`] / [`crate::session_write_messages::save_part`],
//! [`crate::session_write_entry::save_session_entry`] and
//! [`crate::session_write_inputs::save_session_input`] are called verbatim so the whole bundle is one
//! atomic unit. The read-back `SessionInfo` projection (via [`crate::session_sessions::get_session`]
//! / `create_session`'s re-read) is byte-identical to the TS return.
//!
//! TEST-ONLY FAULT HOOKS: the TS `maybeThrowForkCommitFault("afterChild" | "afterMessages" |
//! "afterGoal" | "afterEntries" | "afterInput" | "afterCommandFact" | "beforeCommit")` stages are
//! injected fault points for tests and CANNOT cross the JSON boundary of the addon. They model a
//! mid-step failure that rolls the whole bundle back. In Rust that atomicity is inherent: ANY step
//! returning `Err` makes the wrapper `ROLLBACK` — so "a mid-step failure rolls everything back" is
//! represented structurally, and the parity harness triggers it with a genuinely failing step (a part
//! whose `copyFrom` source row is missing, which throws `Storage copy source missing` after earlier
//! writes, exactly as the fault hook would).

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::Connection;
use serde_json::{json, Value};

/// Port of the private `forkChildSessionId` (`sqlite-session-store.ts` 105-113): read the child
/// session id out of a stored command-fact entry's `data.ack.result.sessionId`, returning `None`
/// when any hop is missing/non-object or the id is a non-string / empty string.
fn fork_child_session_id(entry: &Value) -> Option<String> {
    let data = entry.get("data").filter(|d| d.is_object())?;
    let ack = data.get("ack").filter(|a| a.is_object())?;
    let result = ack.get("result").filter(|r| r.is_object())?;
    let session_id = result.get("sessionId").and_then(Value::as_str)?;
    if session_id.is_empty() {
        return None;
    }
    Some(session_id.to_string())
}

/// JS `String(x)` coercion for the identity/child-local comparisons, reproducing the exact TS
/// operand: an absent JS property (`undefined`) → `"undefined"`, `null` → `"null"`, a string is
/// returned verbatim, a number is rendered without a trailing `.0`, a bool as `"true"`/`"false"`, and
/// an object/array as the empty-ish placeholder (never used for real ids). Private to this module.
fn js_str(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else {
                n.as_f64()
                    .map(|f| {
                        if f.fract() == 0.0 && f.is_finite() {
                            format!("{}", f as i64)
                        } else {
                            f.to_string()
                        }
                    })
                    .unwrap_or_else(|| n.to_string())
            }
        }
        Some(Value::Array(_)) | Some(Value::Object(_)) => String::new(),
    }
}

/// JS falsiness of a possibly-absent value (`undefined`/`null`/`false`/`0`/`""`). Used only to gate
/// the leading `!input.parentID` / `!child.parentID` short-circuits in the identity guards.
fn is_falsy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::Bool(b)) => !b,
        Some(Value::Number(n)) => n.as_f64().is_none_or(|f| f == 0.0 || f.is_nan()),
        Some(Value::String(s)) => s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => false,
    }
}

/// Port of the private `assertForkBundleChildLocal` (`sqlite-session-store.ts` 115-221): every id the
/// bundle claims must be child-local (owned by the freshly-forked child session and present in the
/// bundle's own message id set), and the command result must be a fork result naming that child. It
/// runs BEFORE any write, so any violation throws without touching the DB (the wrapper then rolls
/// back an empty transaction). Reproduced verbatim — same checks, same order, same messages.
fn assert_fork_bundle_child_local(bundle: &Value) -> Result<(), String> {
    let child = bundle.get("child").unwrap_or(&Value::Null);
    let command_fact = bundle.get("commandFact").unwrap_or(&Value::Null);
    let goal = bundle.get("goal").filter(|g| !g.is_null());
    let child_id = js_str(child.get("id"));

    // commandFact.ack.result must be a fork result whose sessionId equals the child id.
    let result = command_fact
        .get("ack")
        .and_then(|a| a.get("result"))
        .filter(|r| r.is_object());
    let session_id = result
        .and_then(|r| r.get("sessionId"))
        .filter(|s| s.is_string())
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let result_type = result.and_then(|r| r.get("type")).and_then(Value::as_str);
    let disposition = result.and_then(|r| r.get("disposition")).and_then(Value::as_str);
    let is_fork_result = result_type == Some("forkAssistant")
        || result_type == Some("createSelectionSideSession")
        || (result_type == Some("editUserQuery") && disposition == Some("fork"));
    if !is_fork_result || session_id.is_empty() || session_id != child_id {
        // 缺失或非 fork 的 command result 会留下无法重放到 child 的幂等事实。
        return Err("Fork bundle command result is missing, invalid, or not child-local".to_string());
    }

    let messages_arr = bundle.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let message_ids: Vec<String> = messages_arr
        .iter()
        .map(|m| js_str(m.get("info").and_then(|i| i.get("id"))))
        .collect();
    let has_message_id = |v: &str| message_ids.iter().any(|id| id == v);

    // JS `assertMessage`: only fails when the value is a string NOT in the bundle's message id set
    // (an absent/`undefined`/non-string value is silently skipped, exactly like the TS `typeof` gate).
    let assert_message = |value: Option<&Value>, field: &str| -> Result<(), String> {
        if value.is_some_and(Value::is_string) {
            let s = value.unwrap().as_str().unwrap();
            if !has_message_id(s) {
                return Err(format!("Fork bundle {field} is not child-local: {s}"));
            }
        }
        Ok(())
    };

    let mut target_ids: Vec<String> = Vec::new();
    if let Some(goal) = goal {
        let tid = js_str(goal.get("source").and_then(|s| s.get("targetID")));
        target_ids.push(tid);
    }

    for message in &messages_arr {
        let info = message.get("info").unwrap_or(&Value::Null);
        if js_str(info.get("sessionID")) != child_id {
            return Err("Fork bundle message session is not child-local".to_string());
        }
        if info.get("role").and_then(Value::as_str) == Some("assistant")
            && !has_message_id(&js_str(info.get("parentID")))
        {
            return Err("Fork bundle assistant parent is not child-local".to_string());
        }
        let anchor = info.get("anchor");
        if let Some(ordered) = anchor.and_then(|a| a.get("orderedMessageIds")).and_then(Value::as_array) {
            for id in ordered {
                assert_message(Some(id), "anchor orderedMessageId")?;
            }
        }
        assert_message(anchor.and_then(|a| a.get("boundaryMessageId")), "anchor boundaryMessageId")?;
        let goal_boundary = anchor.and_then(|a| a.get("goalBoundary"));
        if goal_boundary
            .and_then(|gb| gb.get("kind"))
            .and_then(Value::as_str)
            == Some("snapshot")
        {
            let target = goal_boundary.and_then(|gb| gb.get("target"));
            if js_str(target.and_then(|t| t.get("sessionID"))) != child_id {
                return Err("Fork bundle anchor goal session is not child-local".to_string());
            }
            target_ids.push(js_str(target.and_then(|t| t.get("targetID"))));
        }
        let parts = message.get("parts").and_then(Value::as_array).cloned().unwrap_or_default();
        let message_id_str = js_str(info.get("id"));
        for part in &parts {
            if js_str(part.get("sessionID")) != child_id
                || js_str(part.get("messageID")) != message_id_str
            {
                return Err("Fork bundle part owner is not child-local".to_string());
            }
            let part_type = part.get("type").and_then(Value::as_str);
            if part_type == Some("timeline") {
                assert_message(part.get("anchorMessageId"), "timeline anchorMessageId")?;
                let timeline_type = part.get("timelineType").and_then(Value::as_str);
                if timeline_type == Some("context_compaction") {
                    assert_message(part.get("summaryMessageId"), "timeline summaryMessageId")?;
                }
                if timeline_type == Some("goal_verification") {
                    target_ids.push(js_str(part.get("targetId")));
                }
            }
            if part_type == Some("compaction") {
                assert_message(part.get("tail_start_id"), "compaction tail_start_id")?;
                assert_message(part.get("summaryMessageId"), "compaction summaryMessageId")?;
                let boundary = part.get("compactBoundary");
                assert_message(
                    boundary.and_then(|b| b.get("lastSummarizedMessageId")),
                    "compact lastSummarizedMessageId",
                )?;
                for key in [
                    ("summaryMessageIds", "compact summaryMessageId"),
                    ("attachmentMessageIds", "compact attachmentMessageId"),
                    ("hookResultMessageIds", "compact hookResultMessageId"),
                ] {
                    if let Some(ids) = boundary.and_then(|b| b.get(key.0)).and_then(Value::as_array) {
                        for id in ids {
                            assert_message(Some(id), key.1)?;
                        }
                    }
                }
                let preserved = boundary.and_then(|b| b.get("preservedSegment"));
                assert_message(preserved.and_then(|p| p.get("headMessageId")), "compact preserved head")?;
                assert_message(
                    preserved.and_then(|p| p.get("anchorMessageId")),
                    "compact preserved anchor",
                )?;
                assert_message(preserved.and_then(|p| p.get("tailMessageId")), "compact preserved tail")?;
            }
            if part_type == Some("tool")
                && part
                    .get("state")
                    .and_then(|s| s.get("status"))
                    .and_then(Value::as_str)
                    == Some("completed")
            {
                let attachments = part
                    .get("state")
                    .and_then(|s| s.get("attachments"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for attachment in &attachments {
                    if js_str(attachment.get("sessionID")) != child_id
                        || js_str(attachment.get("messageID")) != message_id_str
                    {
                        return Err("Fork bundle tool attachment owner is not child-local".to_string());
                    }
                }
            }
        }
    }

    if let Some(goal) = goal {
        if js_str(goal.get("source").and_then(|s| s.get("sessionID"))) != child_id {
            return Err("Fork bundle goal session is not child-local".to_string());
        }
    }

    let entries = bundle.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
    for entry in &entries {
        if js_str(entry.get("sessionID")) != child_id {
            return Err("Fork bundle verifier entry session is not child-local".to_string());
        }
        let data = entry
            .get("data")
            .filter(|d| d.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let payload = data
            .get("payload")
            .filter(|p| p.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        assert_message(payload.get("anchorAssistantMessageId"), "verifier assistant anchor")?;
        let target_id_present = payload.get("targetId").is_some_and(Value::is_string);
        let target_id_val = payload.get("targetId").and_then(Value::as_str).unwrap_or("");
        if target_id_present && !target_ids.iter().any(|t| t == target_id_val) {
            return Err("Fork bundle verifier target is not child-local".to_string());
        }
    }
    Ok(())
}

/// Port of `cloneSessionTargetForFork` (`session-target.ts` 78-136). fork is a session-state branch,
/// NOT a new goal: the child's target row keeps the source `target_id` and ORIGINAL `time_created`
/// (so copied goal-continuation / verifier metadata still align), resets the three `active_*` run
/// fields to NULL (the parent's live run must not leak to the child as a phantom), overrides only
/// `status`, and keeps `time_updated` from the source. Runs on the caller's connection INSIDE the
/// bundle transaction; no own `BEGIN`. Ends with `touchSessionForTarget` + `mustReadTarget`.
///
/// # Arguments
///
/// * `conn` — the bundle transaction's open read-write connection.
/// * `source` — the parent `SessionGoal` JSON being cloned.
/// * `session_id` — the child session id (`child.id`).
/// * `status` — the goal status to write for the child.
/// * `now` — injected epoch ms for the `touchSessionForTarget` bump (TS `Date.now()`).
///
/// # Errors
///
/// Returns `Err` on a statement failure or a missing read-back after the write.
pub fn clone_session_target_for_fork(
    conn: &Connection,
    source: &Value,
    session_id: &str,
    status: &str,
    now: i64,
) -> Result<Value, String> {
    // `now` is the injected `Date.now()`; only the `touchSessionForTarget` bump uses it — the row's
    // `time_created`/`time_updated` come from `source.time`, NOT `now` (verbatim TS column bindings).
    conn.execute(
        "insert into session_target (
          session_id,
          target_id,
          objective,
          summary_title,
          status,
          token_budget,
          tokens_used,
          time_used_seconds,
          active_input_id,
          active_run_started_at,
          active_run_last_seen_at,
          time_created,
          time_updated
        ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, null, null, null, ?9, ?10)
        on conflict(session_id) do update set
          target_id = excluded.target_id,
          objective = excluded.objective,
          summary_title = excluded.summary_title,
          status = excluded.status,
          token_budget = excluded.token_budget,
          tokens_used = excluded.tokens_used,
          time_used_seconds = excluded.time_used_seconds,
          active_input_id = null,
          active_run_started_at = null,
          active_run_last_seen_at = null,
          time_created = excluded.time_created,
          time_updated = excluded.time_updated",
        rusqlite::params![
            session_id,
            js_str(source.get("targetID")),
            js_str(source.get("objective")),
            source.get("summaryTitle").and_then(Value::as_str),
            status,
            source.get("tokenBudget").and_then(Value::as_i64),
            source.get("tokensUsed").and_then(Value::as_i64).unwrap_or(0),
            source.get("timeUsedSeconds").and_then(Value::as_i64).unwrap_or(0),
            source.get("time").and_then(|t| t.get("created")).and_then(Value::as_i64).unwrap_or(0),
            source.get("time").and_then(|t| t.get("updated")).and_then(Value::as_i64).unwrap_or(0),
        ],
    )
    .map_err(|e| e.to_string())?;

    // `touchSessionForTarget(db, sessionID, now)` — bump the child session's clock, never backwards.
    conn.execute(
        "update session set time_updated = max(time_updated, ?1) where id = ?2",
        rusqlite::params![now, session_id],
    )
    .map_err(|e| e.to_string())?;

    let target = crate::session_store::read_target(conn, session_id)?;
    if target.is_null() {
        return Err(format!("Session target not found after write: {session_id}"));
    }
    Ok(target)
}

/// Port of `createForkedSessionWithMetadata` (`sqlite-session-store.ts` 315-382). Runs the parent/
/// boundary validity guards, the idempotent existing-command-fact short-circuit, then creates the
/// child session and writes the deterministic `v4/command_fact` child fact. MUST be invoked on a
/// connection ALREADY inside a `BEGIN IMMEDIATE` (the `#[napi]` wrapper owns the transaction), so the
/// guard failure, the read, and the two writes all live or die together.
///
/// # Arguments
///
/// * `conn` — connection inside the bundle transaction.
/// * `input` — `CreateSessionInput` JSON (child session spec, must carry `parentID`).
/// * `metadata` — `ForkChildSessionMetadata` JSON (`{ parentSessionId, sourceCommandId, forkTarget }`).
/// * `now` — injected epoch ms (TS `Date.now()`), used for `create_session` fallbacks and the fact time.
///
/// # Returns
///
/// The created child `SessionInfo` projection, or (idempotent path) the already-existing child.
///
/// # Errors
///
/// `Fork child metadata parent does not match session parentID`, `Fork child metadata is invalid`,
/// `Fork child command fact is corrupt: <id>`, `Fork child session is missing: <id>`, or any sub-core
/// `Err` (which rolls the transaction back).
pub fn create_forked_session_with_metadata(
    conn: &Connection,
    input: &Value,
    metadata: &Value,
    now: i64,
) -> Result<Value, String> {
    let parent_session_id = metadata.get("parentSessionId").and_then(Value::as_str).unwrap_or("");
    let source_command_id = metadata.get("sourceCommandId").and_then(Value::as_str).unwrap_or("");

    // Guard 1: `!input.parentID || String(input.parentID) !== metadata.parentSessionId`.
    let input_parent = input.get("parentID");
    if is_falsy(input_parent) || js_str(input_parent) != parent_session_id {
        return Err("Fork child metadata parent does not match session parentID".to_string());
    }

    // Guard 2: boundary validity. compact can cover the first query, so a stable prefix may be empty;
    // the boundary message id still records the edited input for the idempotent fact locator.
    let fork_target = metadata.get("forkTarget");
    let boundary_message_id = fork_target
        .and_then(|f| f.get("boundaryMessageId"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let ordered = fork_target.and_then(|f| f.get("orderedMessageIds")).and_then(Value::as_array);
    let ordered_len = ordered.map(Vec::len).unwrap_or(0);
    let last = ordered.and_then(|a| a.last()).and_then(Value::as_str);
    let valid_boundary =
        !boundary_message_id.trim().is_empty() && (ordered_len == 0 || last == Some(boundary_message_id));
    if source_command_id.trim().is_empty() || !valid_boundary {
        return Err("Fork child metadata is invalid".to_string());
    }

    // command key = (parentSessionId, sourceCommandId); session_entry.id is a global PK, so the parent
    // must be in the id or two sessions reusing a commandId would overwrite each other's fact.
    let entry_id = format!("v4_command_fact:child:{parent_session_id}:{source_command_id}");
    let parent_id = js_str(input_parent);

    let entries = crate::session_entries::session_entries(conn, &parent_id, Some("v4/command_fact"))?;
    let existing = entries
        .as_array()
        .and_then(|arr| arr.iter().find(|e| e.get("id").and_then(Value::as_str) == Some(entry_id.as_str())));
    if let Some(existing) = existing {
        let child_session_id = fork_child_session_id(existing)
            .ok_or_else(|| format!("Fork child command fact is corrupt: {entry_id}"))?;
        let child = crate::session_sessions::get_session(conn, &child_session_id)?;
        if child.is_null() {
            return Err(format!("Fork child session is missing: {child_session_id}"));
        }
        return Ok(child);
    }

    let child = crate::session_write_create_session::create_session(conn, input, now)?;
    let child_id = js_str(child.get("id"));
    let fact_entry = json!({
        "id": entry_id,
        "sessionID": parent_id,
        "type": "v4/command_fact",
        "time": { "created": now, "updated": now },
        "data": {
            "source": "child",
            "ack": {
                "commandId": source_command_id,
                "status": "accepted",
                "revisionAtDecision": 0,
                "result": { "type": "forkAssistant", "sessionId": child_id }
            },
            "metadata": metadata
        }
    });
    crate::session_write_entry::save_session_entry(conn, &fact_entry)?;
    Ok(child)
}

/// Port of `commitForkBundle` (`sqlite-session-store.ts` 384-470). THE headline atomic bundle: one
/// transaction that writes the child session, every message + part (with optional `copyFrom`
/// legacy-member sources), the optional cloned goal target, the verifier entries, the optional initial
/// input, and finally the parent `v4/command_fact`. Any step failing rolls the WHOLE bundle back. Must
/// run inside the wrapper's `BEGIN IMMEDIATE`.
///
/// # Arguments
///
/// * `conn` — connection inside the bundle transaction.
/// * `bundle` — `ForkCommitBundle` JSON.
/// * `now` — injected epoch ms (TS `Date.now()`) reused for every sub-write's clock read.
///
/// # Returns
///
/// The persisted child `SessionInfo` projection, or (idempotent path) the already-existing child.
///
/// # Errors
///
/// `Fork commit bundle identity is invalid`, `Fork bundle command fact is corrupt: <id>`, any
/// `assertForkBundleChildLocal` message, or any sub-core `Err`.
pub fn commit_fork_bundle(conn: &Connection, bundle: &Value, now: i64) -> Result<Value, String> {
    let child = bundle.get("child").unwrap_or(&Value::Null);
    let command_fact = bundle.get("commandFact").unwrap_or(&Value::Null);
    let initial_input = bundle.get("initialInput").filter(|v| !v.is_null());

    let child_parent = child.get("parentID");
    let fact_parent_session_id = command_fact.get("parentSessionId").and_then(Value::as_str).unwrap_or("");
    let fact_source_command_id = command_fact.get("sourceCommandId").and_then(Value::as_str).unwrap_or("");
    let fact_ack_command_id = command_fact
        .get("ack")
        .and_then(|a| a.get("commandId"))
        .and_then(Value::as_str)
        .unwrap_or("");
    // Identity guard (TS 387-394): child parent matches the fact; initialInput (if any) is owned by
    // the child; and ack.commandId === sourceCommandId.
    let identity_invalid = is_falsy(child_parent)
        || js_str(child_parent) != fact_parent_session_id
        || (initial_input.is_some()
            && js_str(initial_input.and_then(|i| i.get("sessionID"))) != js_str(child.get("id")))
        || fact_ack_command_id != fact_source_command_id;
    if identity_invalid {
        return Err("Fork commit bundle identity is invalid".to_string());
    }

    let entry_id = format!("v4_command_fact:child:{fact_parent_session_id}:{fact_source_command_id}");
    let parent_id = js_str(child_parent);

    let entries = crate::session_entries::session_entries(conn, &parent_id, Some("v4/command_fact"))?;
    let existing = entries
        .as_array()
        .and_then(|arr| arr.iter().find(|e| e.get("id").and_then(Value::as_str) == Some(entry_id.as_str())));
    if let Some(existing) = existing {
        let existing_child = fork_child_session_id(existing)
            .map(|id| crate::session_sessions::get_session(conn, &id))
            .transpose()?
            .unwrap_or(Value::Null);
        if existing_child.is_null() {
            return Err(format!("Fork bundle command fact is corrupt: {entry_id}"));
        }
        return Ok(existing_child);
    }

    assert_fork_bundle_child_local(bundle)?;
    let persisted_child = crate::session_write_create_session::create_session(conn, child, now)?;

    let copy_sources = bundle.get("copySources");
    let messages = bundle.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    for message in &messages {
        let info = message.get("info").unwrap_or(&Value::Null);
        let msg_key = js_str(info.get("id"));
        let msg_source = copy_sources
            .and_then(|cs| cs.get("messages"))
            .and_then(|m| m.get(&msg_key))
            .and_then(Value::as_str);
        let message_copy = msg_source.map(|s| json!({ "sessionID": parent_id, "id": s }));
        crate::session_write_messages::save_message(conn, info, message_copy.as_ref(), now)?;
        let parts = message.get("parts").and_then(Value::as_array).cloned().unwrap_or_default();
        for part in &parts {
            let part_key = js_str(part.get("id"));
            let part_source = copy_sources
                .and_then(|cs| cs.get("parts"))
                .and_then(|m| m.get(&part_key))
                .and_then(Value::as_str);
            let part_copy = part_source.map(|s| json!({ "sessionID": parent_id, "id": s }));
            crate::session_write_messages::save_part(conn, part, part_copy.as_ref(), now)?;
        }
    }

    if let Some(goal) = bundle.get("goal").filter(|g| !g.is_null()) {
        let source = goal.get("source").unwrap_or(&Value::Null);
        let status = goal.get("status").and_then(Value::as_str).unwrap_or("");
        clone_session_target_for_fork(conn, source, &js_str(child.get("id")), status, now)?;
    }

    let verifier_entries = bundle.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
    for entry in &verifier_entries {
        crate::session_write_entry::save_session_entry(conn, entry)?;
    }

    if let Some(initial_input) = initial_input {
        // `encodeJson(input.payload) ?? "{}"` — a present object re-serialises (preserve_order keeps
        // JS key order); absent/null encodes to SQL NULL and `save_session_input` maps it to "{}".
        let payload_json = initial_input
            .get("payload")
            .filter(|p| !p.is_null())
            .map(Value::to_string)
            .unwrap_or_else(|| "null".to_string());
        crate::session_write_inputs::save_session_input(
            conn,
            &js_str(initial_input.get("id")),
            &js_str(initial_input.get("sessionID")),
            &js_str(initial_input.get("kind")),
            &js_str(initial_input.get("delivery")),
            &payload_json,
            now,
        )?;
    }

    let fact_entry = json!({
        "id": entry_id,
        "sessionID": parent_id,
        "type": "v4/command_fact",
        "time": { "created": now, "updated": now },
        "data": {
            "source": "child",
            "ack": command_fact.get("ack").cloned().unwrap_or(Value::Null),
            "metadata": command_fact.get("metadata").cloned().unwrap_or(Value::Null)
        }
    });
    crate::session_write_entry::save_session_entry(conn, &fact_entry)?;
    Ok(persisted_child)
}

/// Run a composite `pub fn` inside ONE `BEGIN IMMEDIATE` … `COMMIT` / `ROLLBACK` on a freshly opened
/// read-write connection, and serialise the returned `SessionInfo` projection. This is the ONLY place
/// the fork composite owns the transaction, matching the TS `db.exec("begin immediate")` boundary.
fn run_in_tx<F>(db_path: &str, f: F) -> napi::Result<String>
where
    F: FnOnce(&Connection) -> Result<Value, String>,
{
    let conn = crate::open_readwrite(db_path)?;
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| Error::from_reason(e.to_string()))?;
    match f(&conn) {
        Ok(session) => {
            conn.execute("COMMIT", []).map_err(|e| Error::from_reason(e.to_string()))?;
            serde_json::to_string(&session).map_err(|e| Error::from_reason(e.to_string()))
        }
        Err(e) => {
            // Any guard/read/write failure: undo every partial row so the child + messages + parts +
            // entries + input are absent (the TS `rollback` arm). The error text is surfaced verbatim.
            let _ = conn.execute("ROLLBACK", []);
            Err(Error::from_reason(e))
        }
    }
}

/// N-API: `createForkedSessionWithMetadata` write boundary. `input_json` = `CreateSessionInput`,
/// `metadata_json` = `ForkChildSessionMetadata`, `now` = injected epoch ms (TS `Date.now()`).
#[napi]
pub fn create_forked_session_with_metadata_json(
    db_path: String,
    input_json: String,
    metadata_json: String,
    now: f64,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let metadata: Value =
        serde_json::from_str(&metadata_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let now_ms = now as i64;
    run_in_tx(&db_path, |conn| {
        create_forked_session_with_metadata(conn, &input, &metadata, now_ms)
    })
}

/// N-API: `commitForkBundle` write boundary. `bundle_json` = `ForkCommitBundle`, `now` = injected
/// epoch ms (TS `Date.now()`). Returns the persisted/returned child `SessionInfo` JSON.
#[napi]
pub fn commit_fork_bundle_json(
    db_path: String,
    bundle_json: String,
    now: f64,
) -> napi::Result<String> {
    let bundle: Value =
        serde_json::from_str(&bundle_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let now_ms = now as i64;
    run_in_tx(&db_path, |conn| commit_fork_bundle(conn, &bundle, now_ms))
}

/// N-API: standalone `cloneTargetForFork` boundary (the port of
/// `session-target.ts:cloneSessionTargetForFork`, also used INSIDE [`commit_fork_bundle_json`]).
/// `source_json` is the parent `SessionGoal` projection; the child keeps its `targetID`, objective,
/// summary, budget and usage while the three `active_*` run columns are reset. Runs inside ONE
/// `BEGIN IMMEDIATE` because the row write and the `touchSessionForTarget` bump must live or die
/// together — the TS relied on the caller's implicit single-connection ordering; the stateless addon
/// cannot, so the wrapper owns the transaction exactly like the sibling bundle ops above.
#[napi]
pub fn clone_session_target_for_fork_json(
    db_path: String,
    source_json: String,
    session_id: String,
    status: String,
    now: f64,
) -> napi::Result<String> {
    let source: Value =
        serde_json::from_str(&source_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let now_ms = now as i64;
    run_in_tx(&db_path, |conn| {
        clone_session_target_for_fork(conn, &source, &session_id, &status, now_ms)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory DB with the full session schema; a real parent session `PARENT` is seeded so the
    /// fork's `parentID` FK and the command-fact `session_id` FK resolve.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        conn.execute("PRAGMA foreign_keys = ON", [])
            .expect("invariant: enable fk");
        crate::session_bootstrap::run_session_migrations_in_tx(&conn, 1_700_000_000_000)
            .expect("invariant: apply session schema");
        conn.execute(
            "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
             values ('PARENT','p','pslug','/p','parent','v',1000,1000)",
            [],
        )
        .expect("invariant: seed parent");
        conn
    }

    fn child_input(id: &str) -> Value {
        json!({
            "id": id,
            "projectID": "p",
            "slug": format!("{id}-slug"),
            "directory": "/d",
            "path": "/d",
            "title": "child",
            "version": "v",
            "parentID": "PARENT",
            "time": { "created": 1000, "updated": 1000 }
        })
    }

    fn metadata(cmd: &str) -> Value {
        json!({
            "parentSessionId": "PARENT",
            "sourceCommandId": cmd,
            "forkTarget": {
                "productTurnId": "pt1",
                "transcriptTurnId": "tt1",
                "orderedMessageIds": ["bm1"],
                "boundaryMessageId": "bm1"
            }
        })
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("select count(*) from {table}"), [], |r| r.get(0))
            .expect("count")
    }

    fn run_tx<T, F>(conn: &Connection, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        conn.execute("BEGIN IMMEDIATE", []).map_err(|e| e.to_string())?;
        match f(conn) {
            Ok(v) => {
                conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
                Ok(v)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    #[test]
    fn create_forked_child_writes_session_and_command_fact() {
        let conn = db();
        let child = run_tx(&conn, |c| {
            create_forked_session_with_metadata(c, &child_input("CHILD1"), &metadata("cmd1"), 1_700_000_000_000)
        })
        .expect("fork child created");
        assert_eq!(child.get("id").and_then(Value::as_str), Some("CHILD1"));
        assert_eq!(count(&conn, "session"), 2, "parent + child present");
        let fact: String = conn
            .query_row(
                "select data from session_entry where id = ?1",
                ["v4_command_fact:child:PARENT:cmd1"],
                |r| r.get(0),
            )
            .expect("fact present");
        assert!(fact.contains("\"sessionId\":\"CHILD1\""), "fact points at the child");
    }

    #[test]
    fn create_forked_is_idempotent_on_existing_fact() {
        let conn = db();
        run_tx(&conn, |c| {
            create_forked_session_with_metadata(c, &child_input("CHILD1"), &metadata("cmd1"), 1_700_000_000_000)
        })
        .expect("first commit");
        let before = count(&conn, "session");
        // Re-run the SAME command: the existing fact short-circuits to the existing child; no new rows.
        let child = run_tx(&conn, |c| {
            create_forked_session_with_metadata(c, &child_input("CHILD1"), &metadata("cmd1"), 1_700_000_000_000)
        })
        .expect("idempotent");
        assert_eq!(child.get("id").and_then(Value::as_str), Some("CHILD1"));
        assert_eq!(count(&conn, "session"), before, "no duplicate child session written");
    }

    #[test]
    fn create_forked_guard_rejects_mismatched_parent_before_write() {
        let conn = db();
        let bad_meta = json!({
            "parentSessionId": "OTHER",
            "sourceCommandId": "cmd1",
            "forkTarget": { "productTurnId":"pt","transcriptTurnId":"tt","orderedMessageIds":["bm1"],"boundaryMessageId":"bm1" }
        });
        let err = run_tx(&conn, |c| {
            create_forked_session_with_metadata(c, &child_input("CHILD1"), &bad_meta, 1_700_000_000_000)
        })
        .expect_err("mismatched parent must throw");
        assert_eq!(err, "Fork child metadata parent does not match session parentID");
        assert_eq!(count(&conn, "session"), 1, "no child written on guard failure");
        assert_eq!(count(&conn, "session_entry"), 0, "no fact written");
    }

    #[test]
    fn create_forked_guard_rejects_invalid_boundary() {
        let conn = db();
        let bad_meta = json!({
            "parentSessionId": "PARENT",
            "sourceCommandId": "cmd1",
            "forkTarget": { "productTurnId":"pt","transcriptTurnId":"tt","orderedMessageIds":["x1"],"boundaryMessageId":"bm1" }
        });
        let err = run_tx(&conn, |c| {
            create_forked_session_with_metadata(c, &child_input("CHILD1"), &bad_meta, 1_700_000_000_000)
        })
        .expect_err("boundary not last of prefix must throw");
        assert_eq!(err, "Fork child metadata is invalid");
    }

    /// A complete bundle: child + one user message + its part + one verifier entry + initialInput + a
    /// goal, plus the final command fact. Every entity ends up present after one atomic commit.
    fn full_bundle() -> Value {
        json!({
            "child": child_input("CHILD2"),
            "messages": [
                {
                    "info": {
                        "id": "m1",
                        "sessionID": "CHILD2",
                        "role": "user",
                        "time": { "created": 1001 },
                        "agent": "main"
                    },
                    "parts": [
                        { "id": "p1", "sessionID": "CHILD2", "messageID": "m1", "type": "text", "text": "hi", "time": { "start": 1002 } }
                    ]
                }
            ],
            "entries": [
                {
                    "id": "ventry",
                    "sessionID": "CHILD2",
                    "type": "goal/verifier",
                    "time": { "created": 1003, "updated": 1003 },
                    "data": { "payload": { "anchorAssistantMessageId": "m1" } }
                }
            ],
            "goal": {
                "source": {
                    "sessionID": "CHILD2",
                    "targetID": "tgt1",
                    "objective": "obj",
                    "summaryTitle": null,
                    "status": "active",
                    "tokenBudget": null,
                    "tokensUsed": 5,
                    "timeUsedSeconds": 7,
                    "time": { "created": 900, "updated": 950 }
                },
                "status": "paused"
            },
            "initialInput": {
                "id": "in1",
                "sessionID": "CHILD2",
                "kind": "text",
                "delivery": "startNow",
                "payload": { "text": "hello world" }
            },
            "commandFact": {
                "parentSessionId": "PARENT",
                "sourceCommandId": "cmd2",
                "ack": {
                    "commandId": "cmd2",
                    "status": "accepted",
                    "revisionAtDecision": 0,
                    "result": { "type": "forkAssistant", "sessionId": "CHILD2" }
                },
                "metadata": { "parentSessionId": "PARENT", "sourceCommandId": "cmd2", "forkTarget": { "productTurnId":"pt","transcriptTurnId":"tt","orderedMessageIds":["m1"],"boundaryMessageId":"m1" } }
            }
        })
    }

    #[test]
    fn commit_bundle_writes_every_entity() {
        let conn = db();
        let child = run_tx(&conn, |c| commit_fork_bundle(c, &full_bundle(), 1_700_000_000_000))
            .expect("bundle committed");
        assert_eq!(child.get("id").and_then(Value::as_str), Some("CHILD2"));
        assert_eq!(count(&conn, "session"), 2);
        assert_eq!(count(&conn, "message"), 1);
        assert_eq!(count(&conn, "part"), 1);
        // verifier entry + final command fact = 2 entries.
        assert_eq!(count(&conn, "session_entry"), 2);
        assert_eq!(count(&conn, "session_input"), 1);
        // cloned goal target with the source's target_id + created time, child status override.
        let status: String = conn
            .query_row("select status from session_target where session_id='CHILD2'", [], |r| r.get(0))
            .expect("target present");
        assert_eq!(status, "paused");
        let created: i64 = conn
            .query_row("select time_created from session_target where session_id='CHILD2'", [], |r| r.get(0))
            .expect("created");
        assert_eq!(created, 900, "child keeps the ORIGINAL created time");
    }

    #[test]
    fn commit_bundle_is_idempotent_on_existing_fact() {
        let conn = db();
        run_tx(&conn, |c| commit_fork_bundle(c, &full_bundle(), 1_700_000_000_000)).expect("first");
        let sessions = count(&conn, "session");
        let messages = count(&conn, "message");
        let entries = count(&conn, "session_entry");
        // Second commit of the SAME bundle: the existing fact short-circuits to the existing child.
        let child = run_tx(&conn, |c| commit_fork_bundle(c, &full_bundle(), 1_700_000_000_000))
            .expect("idempotent commit");
        assert_eq!(child.get("id").and_then(Value::as_str), Some("CHILD2"));
        assert_eq!(count(&conn, "session"), sessions, "no second child");
        assert_eq!(count(&conn, "message"), messages, "no duplicated messages");
        assert_eq!(count(&conn, "session_entry"), entries, "no duplicated entries");
    }

    #[test]
    fn commit_bundle_identity_guard_throws_before_write() {
        let conn = db();
        let mut bundle = full_bundle();
        bundle["commandFact"]["ack"]["commandId"] = json!("different");
        let err = run_tx(&conn, |c| commit_fork_bundle(c, &bundle, 1_700_000_000_000))
            .expect_err("ack.commandId must equal sourceCommandId");
        assert_eq!(err, "Fork commit bundle identity is invalid");
        assert_eq!(count(&conn, "session"), 1, "no child written");
    }

    #[test]
    fn commit_bundle_child_local_guard_throws_before_write() {
        let conn = db();
        let mut bundle = full_bundle();
        // A message whose session is NOT the child → fails assertForkBundleChildLocal before any write.
        bundle["messages"][0]["info"]["sessionID"] = json!("SOMEONE_ELSE");
        let err = run_tx(&conn, |c| commit_fork_bundle(c, &bundle, 1_700_000_000_000))
            .expect_err("message must be child-local");
        assert_eq!(err, "Fork bundle message session is not child-local");
        assert_eq!(count(&conn, "session"), 1, "no child written");
    }

    #[test]
    fn commit_bundle_rolls_back_everything_on_mid_step_failure() {
        let conn = db();
        let mut bundle = full_bundle();
        // Inject a valid SECOND message (passes the child-local assert) whose part copyFrom source row
        // does not exist. Processing order: createSession, save m1+p1, then m2 → its part throws
        // `Storage copy source missing` AFTER earlier writes succeeded. The whole tx must roll back.
        bundle["messages"].as_array_mut().expect("messages array").push(json!({
            "info": { "id": "m2", "sessionID": "CHILD2", "role": "user", "time": { "created": 2001 } },
            "parts": [ { "id": "p2", "sessionID": "CHILD2", "messageID": "m2", "type": "text", "text": "x", "time": { "start": 2002 } } ]
        }));
        bundle["copySources"] = json!({ "messages": {}, "parts": { "p2": "GHOST_PART" } });

        let err = run_tx(&conn, |c| commit_fork_bundle(c, &bundle, 1_700_000_000_000))
            .expect_err("missing part copyFrom must abort the bundle");
        assert!(
            err.contains("Storage copy source missing"),
            "expected the copy-source throw, got: {err}"
        );
        // ATOMIC: nothing from the bundle survives — the child, its message/part are all rolled back.
        assert_eq!(count(&conn, "session"), 1, "child session rolled back (only parent remains)");
        assert_eq!(count(&conn, "message"), 0, "no partial messages survived");
        assert_eq!(count(&conn, "part"), 0, "no partial parts survived");
        assert_eq!(count(&conn, "session_entry"), 0, "no fact/verifier entry survived");
        assert_eq!(count(&conn, "session_input"), 0, "no initial input survived");
    }
}
