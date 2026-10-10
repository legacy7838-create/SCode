//! Session-input PROMOTION/SETTLE/EDIT write ops (ported from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-inputs.ts`):
//! `promoteSessionInput`, `markSessionInputPromoted`, `settleSessionInput` and
//! `updateSessionInputs`. Together these drive the `session_input` status state machine
//! (`admitted → promoted | cancelled | discarded | failed`; the ledger semantics documented at the top
//! of the TS file). The `saveSessionInput` admit path already lives in
//! [`crate::session_write_inputs`]; this module owns only the post-admission transitions.
//!
//! Transaction decisions, reproduced per the SOURCE (not "improved"):
//!
//! - `markSessionInputPromoted` (TS 294-312) and `settleSessionInput` (TS 314-331) are a LONE
//!   parameterised `UPDATE` guarded by `... and status = 'admitted'` in the WHERE clause. A lone
//!   statement is atomic on its own, so — exactly like the TS — neither is wrapped in a transaction.
//!   The `status = 'admitted'` guard is the state transition: a row already `promoted`/`cancelled`/…
//!   matches zero rows, so a late `discard` after promotion is a silent no-op (the TS comment on
//!   line 323: "只收口未终态的记录"). There is no read-back and no `touchSession` in either.
//! - `updateSessionInputs` (TS 136-189) is a per-id SELECT→decode→patch→UPDATE loop. The TS opens a
//!   single `BEGIN IMMEDIATE` around the whole batch (only AFTER the `updates.length === 0` early
//!   return, so an empty batch never opens a transaction) and commits/rolls back once at the end.
//!   Reproduced: one `rusqlite` transaction, `COMMIT` on success, `ROLLBACK` on any error.
//! - `promoteSessionInput` (TS 191-292) runs `saveMessage` + every `savePart` + the optional
//!   `shared_context_import` attach work + the final `session_input` `UPDATE` inside ONE
//!   `BEGIN IMMEDIATE`. Promotion's atomicity is the module's headline requirement (杜绝「queue 已消费
//!   但 transcript 无 user message」): the shared-context path can `throw` (missing / no-longer
//!   attachable) and the surrounding transaction must roll back the already-written message/parts.
//!   Unlike `mark`, promote's `UPDATE` has NO `status` guard (it writes `promoted` from any state),
//!   so `promoted_update_sql(false)` vs `promoted_update_sql(true)` distinguishes the two.
//!
//! JSON-column parity: `serde_json` runs with `preserve_order`, so a patched payload/entry/message is
//! re-serialised with `Value::to_string()` keeping insertion order to byte-match JS `JSON.stringify`.
//! TS `??` is modelled as "left present-and-non-null, else right"; `x !== undefined` as "key present";
//! and a JS `undefined` value (which `JSON.stringify` DROPS) is modelled as "do not insert the key".
//! The payload patch is a FULL re-encode of the decoded object after the TS mutations, NOT a
//! `json_set` partial update — matching `encodeJson(payload) ?? "{}"` at TS line 178. `now` and every
//! id are INJECTED by the caller; the addon never reads the clock, keeping writes deterministic and
//! parity-testable.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

/// The shared `promoted` bump used by both `promoteSessionInput` (any prior status, `guard == false`)
/// and `markSessionInputPromoted` (`guard == true`, `... and status = 'admitted'`). Bind order
/// (`?1..?5`) mirrors both TS `.run(...)` calls:
/// `message/promotedMessageID, sessionID, now, id, sessionID`.
fn promoted_update_sql(guard: bool) -> String {
    format!(
        "update session_input
         set status = 'promoted',
             promoted_message_id = ?1,
             promoted_sequence = (
               select coalesce(max(promoted_sequence), -1) + 1
               from session_input
               where session_id = ?2
             ),
             time_updated = ?3
         where id = ?4 and session_id = ?5{}",
        if guard {
            " and status = 'admitted'"
        } else {
            ""
        }
    )
}

/// Port of `markSessionInputPromoted` (TS 294-312): a lone `UPDATE` bumping an `admitted` row to
/// `promoted` with the given message id and the per-session `promoted_sequence` queue tail. A row not
/// in `admitted` is a no-op (0 rows changed) — the state guard lives in the WHERE clause.
///
/// # Arguments
///
/// * `conn` — read-write connection (FK enforcement owned by the caller, see [`crate::open_readwrite`]).
/// * `id` — the `session_input` primary key to transition.
/// * `session_id` — owning session (the `session_input.session_id` scope + `promoted_sequence` queue).
/// * `promoted_message_id` — value written to `promoted_message_id`.
/// * `now` — injected epoch ms for `time_updated` (no clock read here).
///
/// # Errors
///
/// Returns the `rusqlite` error string when the statement fails.
pub fn mark_session_input_promoted(
    conn: &Connection,
    id: &str,
    session_id: &str,
    promoted_message_id: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        &promoted_update_sql(true),
        params![promoted_message_id, session_id, now, id, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `settleSessionInput` (TS 314-331): a lone `UPDATE` moving an `admitted` row to a terminal
/// `cancelled`/`discarded`/`failed` with an optional reason. `reason == None` writes SQL `NULL`
/// (TS `input.reason ?? null`). A row not in `admitted` (e.g. already `promoted`) is a no-op, so a
/// late settle never rolls back a promotion. No `promoted_sequence` bump, no `touchSession`.
///
/// # Arguments
///
/// * `conn` — read-write connection.
/// * `id` — the `session_input` primary key to settle.
/// * `session_id` — owning session scope.
/// * `status` — terminal status; the column `CHECK` rejects values outside the allowed set (matching
///   `node:sqlite`'s constraint failure).
/// * `reason` — optional `status_reason` (`None` → `NULL`).
/// * `now` — injected epoch ms for `time_updated`.
///
/// # Errors
///
/// Returns the `rusqlite` error string when the statement fails (e.g. an invalid `status`).
pub fn settle_session_input(
    conn: &Connection,
    id: &str,
    session_id: &str,
    status: &str,
    reason: Option<&str>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "update session_input
         set status = ?1, status_reason = ?2, time_updated = ?3
         where id = ?4 and session_id = ?5 and status = 'admitted'",
        params![status, reason, now, id, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `promoteSessionInput` (TS 191-292): inside ONE `BEGIN IMMEDIATE` transaction, save the
/// user message + its parts, optionally attach any `shared_context_import` refs carried on the
/// message metadata, then bump the `session_input` row to `promoted`. On any error (including the two
/// shared-context `throw`s) the transaction rolls back so no orphan transcript row survives.
///
/// # Arguments
///
/// * `conn` — read-write connection.
/// * `id` — the `session_input` primary key to promote (no status guard, mirroring the TS UPDATE).
/// * `session_id` — owning session.
/// * `message` — `MessageInfo` JSON object; its `id` becomes `promoted_message_id`, and its
///   `metadata.inputIntent.sharedContextRefs` drives the optional attach path.
/// * `parts` — `MessagePart[]` JSON objects to save.
/// * `now` — injected epoch ms; used for the message/parts fallback, the attach `updated` time and the
///   final `time_updated` (the TS reads `Date.now()` once before the transaction).
///
/// # Errors
///
/// Returns `Err(String)`: the TS `Error("shared context import is missing")` when a
/// `shared_context_import` ref has no matching entry, `Error("shared context import is no longer
/// attachable")` when the entry's status is not `pending`/`reserved`, or a `rusqlite`/sibling-module
/// error string. Any error rolls the transaction back.
pub fn promote_session_input(
    conn: &Connection,
    id: &str,
    session_id: &str,
    message: &Value,
    parts: &[Value],
    now: i64,
) -> Result<(), String> {
    let message_id = message
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "message.id must be a string".to_string())?;

    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let body = || -> Result<(), String> {
        crate::session_write_messages::save_message(conn, message, None, now)?;
        for part in parts {
            crate::session_write_messages::save_part(conn, part, None, now)?;
        }

        // TS 207-219: refs = metadata.inputIntent.sharedContextRefs, acted on only when an Array.
        let refs = message
            .get("metadata")
            .and_then(Value::as_object)
            .and_then(|m| m.get("inputIntent"))
            .and_then(Value::as_object)
            .and_then(|ii| ii.get("sharedContextRefs"));
        if let Some(Value::Array(refs)) = refs {
            for rf in refs {
                // TS 221-228: skip non-object refs and refs whose kind/context_id don't qualify.
                let Some(rf) = rf.as_object() else { continue };
                if rf.get("kind").and_then(Value::as_str) != Some("shared_context_import") {
                    continue;
                }
                let Some(context_id) = rf.get("context_id").and_then(Value::as_str) else {
                    continue;
                };

                // TS 229-240: find the v4/shared_context_import entry with a matching data.contextId.
                let entries = crate::session_entries::session_entries(
                    conn,
                    session_id,
                    Some("v4/shared_context_import"),
                )?;
                let entry = entries
                    .as_array()
                    .and_then(|arr| {
                        arr.iter().find(|c| {
                            c.get("data")
                                .and_then(Value::as_object)
                                .and_then(|d| d.get("contextId"))
                                .and_then(Value::as_str)
                                == Some(context_id)
                        })
                    })
                    .ok_or_else(|| "shared context import is missing".to_string())?;

                // TS 241-243: the entry must still be pending/reserved (a String(data.status) test).
                let data = entry.get("data").cloned().unwrap_or(Value::Null);
                if !matches!(
                    data.get("status").and_then(Value::as_str),
                    Some("pending") | Some("reserved")
                ) {
                    return Err("shared context import is no longer attachable".to_string());
                }

                // TS 245-249: saveSessionEntry({...entry, time:{...entry.time, updated: now},
                //                          data:{...data, status:"attached", attachedMessageId}}).
                let mut entry_obj = entry.as_object().cloned().unwrap_or_default();
                entry_obj.insert(
                    "time".to_string(),
                    with_updated_time(entry.get("time"), now),
                );
                entry_obj.insert("data".to_string(), attach_data(&data, message_id));
                crate::session_write_entry::save_session_entry(conn, &Value::Object(entry_obj))?;

                // TS 250-261: find the context message (info.metadata.contextId === contextId) and,
                // if present, re-save it with metadata.sharedContextStatus = "attached" (262-270).
                let msgs = crate::session_messages::messages(conn, session_id)?;
                let info = msgs.as_array().and_then(|arr| {
                    arr.iter().find_map(|c| {
                        let info = c.get("info")?;
                        if info
                            .get("metadata")
                            .and_then(|md| md.get("contextId"))
                            .and_then(Value::as_str)
                            == Some(context_id)
                        {
                            Some(info.clone())
                        } else {
                            None
                        }
                    })
                });
                if let Some(info) = info {
                    let mut obj = info.as_object().cloned().unwrap_or_default();
                    obj.insert(
                        "metadata".to_string(),
                        with_attached_status(info.get("metadata")),
                    );
                    crate::session_write_messages::save_message(
                        conn,
                        &Value::Object(obj),
                        None,
                        now,
                    )?;
                }
            }
        }

        // TS 273-286: promote the input (NO status guard; differs from `mark`). `promoted_sequence`
        // is the per-session max of the existing values + 1, computed inside the same transaction so
        // it sees the rows already committed by the concurrent admit ledger.
        conn.execute(
            &promoted_update_sql(false),
            params![message_id, session_id, now, id, session_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }();

    match body {
        Ok(()) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// TS `{ ...entry.time, updated: now }` (247): copy the existing `time` keys, then set `updated`. The
/// copy helper keeps an existing key's position; a new key appends.
fn with_updated_time(time: Option<&Value>, now: i64) -> Value {
    let mut m = match time {
        Some(Value::Object(obj)) => obj.clone(),
        _ => Map::new(),
    };
    m.insert("updated".to_string(), Value::Number(now.into()));
    Value::Object(m)
}

/// TS `{ ...data, status: "attached", attachedMessageId: String(message.id) }` (248): copy the entry
/// `data` keys, then stamp the two attach keys (existing `status` keeps its position, otherwise
/// appended).
fn attach_data(data: &Value, message_id: &str) -> Value {
    let mut m = match data {
        Value::Object(obj) => obj.clone(),
        _ => Map::new(),
    };
    m.insert("status".to_string(), Value::String("attached".to_string()));
    m.insert(
        "attachedMessageId".to_string(),
        Value::String(message_id.to_string()),
    );
    Value::Object(m)
}

/// TS `{ ...(contextMessage.info.metadata ?? {}), sharedContextStatus: "attached" }` (265-268): spread
/// the existing metadata (`?? {}` only fires for null/undefined, NOT for a falsy non-null object),
/// then append `sharedContextStatus`.
fn with_attached_status(metadata: Option<&Value>) -> Value {
    let mut m = match metadata {
        Some(Value::Object(obj)) => obj.clone(),
        _ => Map::new(),
    };
    m.insert(
        "sharedContextStatus".to_string(),
        Value::String("attached".to_string()),
    );
    Value::Object(m)
}

/// Port of `decodePayload` (TS 80-92): `JSON.parse`; a non-array object becomes `{ text: "",
/// ...parsed }` (`text` occupies the FIRST slot and keeps it even when `parsed` also carries a `text`
/// key, which only overrides the value), anything else — array, primitive, invalid JSON — becomes
/// `{ text: "" }`.
fn decode_payload(raw: &str) -> Value {
    let mut out = Map::new();
    if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(raw) {
        let text = parsed
            .get("text")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new()));
        out.insert("text".to_string(), text);
        for (k, v) in parsed {
            if k != "text" {
                out.insert(k, v);
            }
        }
        Value::Object(out)
    } else {
        out.insert("text".to_string(), Value::String(String::new()));
        Value::Object(out)
    }
}

/// JS `{ ...base, [key]: value }` onto a fresh owned map: `insert` keeps an existing key's position
/// (matching assignment) and appends a new one; `value == None` (JS `undefined`) is DROPPED by
/// `JSON.stringify`, so the key is omitted.
fn js_set(map: &mut Map<String, Value>, base: Option<&Value>, key: &str, value: Option<&Value>) {
    if let Some(Value::Object(base)) = base {
        for (k, v) in base {
            map.insert(k.clone(), v.clone());
        }
    }
    if let Some(v) = value {
        map.insert(key.to_string(), v.clone());
    }
}

/// Port of `patchObject` (TS 102-134) applied to a payload's `conversationInputIntent`. A falsy /
/// non-object / array `value` is returned unchanged; otherwise the result is the object spread
/// `{ ...current, [text], [order], [delivery, steer] }` with JS `undefined` values dropped and `??`
/// semantics for the queue position.
fn patch_object(value: &Value, patch: &Value) -> Value {
    let current = match value {
        Value::Object(map) => map.clone(),
        _ => return value.clone(),
    };
    // `order` lives on the current object; JS reads `current.order` directly.
    let order_base = value.get("order");
    // `intent` is truthy only when present and not null (a null/absent intent skips the branch).
    let intent = match patch.get("intent") {
        Some(v) if !v.is_null() => Some(v),
        _ => None,
    };
    let mut m = current.clone();

    // `...(patch.text !== undefined ? { text: patch.text } : {})`.
    if let Some(text) = patch.get("text") {
        m.insert("text".to_string(), text.clone());
    }

    // `...(patch.queuePosition !== undefined || intent?.queuePosition !== undefined ? { order } : {})`.
    let has_qp = patch.get("queuePosition").is_some()
        || intent.and_then(|i| i.get("queuePosition")).is_some();
    if has_qp {
        // `patch.queuePosition ?? intent?.queuePosition` — left present-and-non-null, else right.
        let qp = patch
            .get("queuePosition")
            .filter(|v| !v.is_null())
            .or_else(|| {
                intent
                    .and_then(|i| i.get("queuePosition"))
                    .filter(|v| !v.is_null())
            });
        let mut order = Map::new();
        if let Some(Value::Object(o)) = order_base.filter(|v| !v.is_null()) {
            for (k, v) in o {
                order.insert(k.clone(), v.clone());
            }
        }
        if let Some(q) = qp {
            order.insert("queuePosition".to_string(), q.clone());
        }
        m.insert("order".to_string(), Value::Object(order));
    }

    // `...(intent ? { delivery, steer } : {})`.
    if let Some(it) = intent {
        let mut delivery = Map::new();
        js_set(
            &mut delivery,
            None,
            "requested",
            it.get("requestedDelivery"),
        );
        js_set(&mut delivery, None, "admitted", it.get("admittedDelivery"));
        js_set(
            &mut delivery,
            None,
            "fallbackReasonCode",
            it.get("fallbackReasonCode").filter(|v| js_truthy(v)),
        );
        m.insert("delivery".to_string(), Value::Object(delivery));

        let mut steer = Map::new();
        if let Some(fr) = it.get("fallbackReasonCode").filter(|v| js_truthy(v)) {
            js_set(
                &mut steer,
                None,
                "state",
                Some(&Value::String("fellBack".to_string())),
            );
            js_set(&mut steer, None, "reasonCode", Some(fr));
            m.insert("steer".to_string(), Value::Object(steer));
        } else {
            js_set(&mut steer, None, "steer", value.get("steer"));
        }
    }

    Value::Object(m)
}

/// JS truthiness (used by the ternary gates `intent.fallbackReasonCode ? …`). `null`/`false`/`0`/`""`
/// are falsy; a non-empty string, a non-zero number, a bool-true, or any object/array is truthy.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Port of `updateSessionInputs`' per-row mutation (TS 159-175), returning the new `payload` value.
/// Reproduces the JS exactly: decode → optional `text` overwrite → optional `conversationInputIntent`
/// `patchObject` (only when the key is present) → intent handling (`update.intent` replaces, else a
/// `queuePosition` merge onto an existing `intent` object).
fn patch_payload(payload: &mut Value, update: &Value) {
    if let Some(text) = update.get("text") {
        if let Some(map) = payload.as_object_mut() {
            map.insert("text".to_string(), text.clone());
        }
    }
    // `"conversationInputIntent" in payload`: presence, not truthiness.
    if payload
        .as_object()
        .is_some_and(|m| m.contains_key("conversationInputIntent"))
    {
        let existing = payload
            .get("conversationInputIntent")
            .cloned()
            .unwrap_or(Value::Null);
        let patched = patch_object(&existing, update);
        if let Some(map) = payload.as_object_mut() {
            map.insert("conversationInputIntent".to_string(), patched);
        }
    }
    // `if (update.intent)` — truthy gate.
    if update.get("intent").is_some_and(js_truthy) {
        let intent = update.get("intent").cloned().unwrap();
        if let Some(map) = payload.as_object_mut() {
            map.insert("intent".to_string(), intent);
        }
    } else if payload
        .as_object()
        .is_some_and(|m| m.contains_key("intent"))
        && update.get("queuePosition").is_some()
    {
        // `else if ("intent" in payload && update.queuePosition !== undefined)`: merge the new
        // queuePosition onto the existing intent object only when it is a plain object.
        let merged = payload.get("intent").and_then(|v| v.as_object()).map(|o| {
            let mut nm = o.clone();
            nm.insert(
                "queuePosition".to_string(),
                update.get("queuePosition").cloned().unwrap(),
            );
            Value::Object(nm)
        });
        if let (Some(merged), Some(map)) = (merged, payload.as_object_mut()) {
            map.insert("intent".to_string(), merged);
        }
    }
}

/// Port of `updateSessionInputs` (TS 136-189): a `BEGIN IMMEDIATE` batch that, for each `admitted`
/// row in this session, re-encodes the patched payload (and optionally rewrites `delivery`). An empty
/// `updates` batch returns before any transaction is opened (TS 144).
///
/// # Arguments
///
/// * `conn` — read-write connection.
/// * `session_id` — owning session scope (the read/update both filter on `session_id` and
///   `status = 'admitted'`).
/// * `updates` — `SessionInputPatch[]`; each element carries at least `id` and optionally
///   `delivery`/`intent`/`text`/`queuePosition`.
/// * `now` — injected epoch ms, computed once for the whole batch (TS 153) and written to every
///   updated row's `time_updated`.
///
/// # Errors
///
/// Returns `Err(String)` when a statement or a JSON decode fails; the transaction is rolled back, so
/// a mid-batch failure leaves no partial patch. A row that is not `admitted` (or absent) is skipped
/// (`if (!row) continue`).
pub fn update_session_inputs(
    conn: &Connection,
    session_id: &str,
    updates: &[Value],
    now: i64,
) -> Result<(), String> {
    if updates.is_empty() {
        return Ok(());
    }
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let body = || -> Result<(), String> {
        for update in updates {
            let uid = update.get("id").and_then(Value::as_str).unwrap_or_default();
            let row: Option<(String, String)> = conn
                .query_row(
                    "select delivery, payload from session_input \
                     where id = ?1 and session_id = ?2 and status = 'admitted'",
                    params![uid, session_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some((row_delivery, row_payload)) = row else {
                continue;
            };
            let mut payload = decode_payload(&row_payload);
            patch_payload(&mut payload, update);
            // `update.delivery ?? row.delivery`: use the patch's delivery when present-and-non-null.
            let new_delivery = update
                .get("delivery")
                .and_then(Value::as_str)
                .unwrap_or(row_delivery.as_str());
            // `encodeJson(payload) ?? "{}"` — payload is always an object, so never null.
            let encoded = payload.to_string();
            conn.execute(
                "update session_input set delivery = ?1, payload = ?2, time_updated = ?3 \
                 where id = ?4 and session_id = ?5 and status = 'admitted'",
                params![new_delivery, encoded, now, uid, session_id],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }();

    match body {
        Ok(()) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// N-API: `promoteSessionInput` write boundary. Opens a read-write DB, runs the promotion inside one
/// transaction, and returns the JSON literal `"null"` (the TS returns `void`). `message_json` is the
/// serialized `MessageInfo`; `parts_json` is a JSON array of `MessagePart`; `now` is a JS number
/// (epoch ms) injected by the caller.
#[napi]
pub fn promote_session_input_json(
    db_path: String,
    id: String,
    session_id: String,
    message_json: String,
    parts_json: String,
    now: f64,
) -> napi::Result<String> {
    let message: Value =
        serde_json::from_str(&message_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let parts: Vec<Value> =
        serde_json::from_str(&parts_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    promote_session_input(&conn, &id, &session_id, &message, &parts, now as i64)
        .map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `markSessionInputPromoted` write boundary (lone guarded `UPDATE`; no transaction).
#[napi]
pub fn mark_session_input_promoted_json(
    db_path: String,
    id: String,
    session_id: String,
    promoted_message_id: String,
    now: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    mark_session_input_promoted(&conn, &id, &session_id, &promoted_message_id, now as i64)
        .map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `settleSessionInput` write boundary (lone guarded `UPDATE`; no transaction). `reason_json`
/// is the raw reason string, or `null`/omitted → SQL `NULL`.
#[napi]
pub fn settle_session_input_json(
    db_path: String,
    id: String,
    session_id: String,
    status: String,
    reason: Option<String>,
    now: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    settle_session_input(
        &conn,
        &id,
        &session_id,
        &status,
        reason.as_deref(),
        now as i64,
    )
    .map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `updateSessionInputs` write boundary (transactional batch). `updates_json` is a JSON array
/// of `SessionInputPatch` objects; `now` is the injected epoch ms.
#[napi]
pub fn update_session_inputs_json(
    db_path: String,
    session_id: String,
    updates_json: String,
    now: f64,
) -> napi::Result<String> {
    let updates: Vec<Value> =
        serde_json::from_str(&updates_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    update_session_inputs(&conn, &session_id, &updates, now as i64).map_err(Error::from_reason)?;
    Ok("null".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        conn.execute("PRAGMA foreign_keys = ON", [])
            .expect("invariant: enable fk");
        crate::session_bootstrap::run_session_migrations_in_tx(&conn, 1_700_000_000_000)
            .expect("invariant: apply session schema");
        conn.execute(
            "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
             values ('s1','p','slug','/d','t','v',100,100)",
            [],
        )
        .expect("invariant: seed session");
        conn
    }

    fn seed_input(conn: &Connection, id: &str, payload: &str, delivery: &str, status: &str) {
        conn.execute(
            "insert into session_input (
               id, session_id, kind, delivery, payload, admitted_sequence, status,
               time_created, time_updated
             ) values (?1,'s1','user',?2,?3,
               (select coalesce(max(admitted_sequence), -1) + 1 from session_input where session_id='s1'),
               ?4, 1, 1)",
            params![id, delivery, payload, status],
        )
        .expect("seed input");
    }

    fn input_state(conn: &Connection, id: &str) -> (String, Option<String>, Option<i64>, i64) {
        conn.query_row(
            "select status, status_reason, promoted_sequence, time_updated
             from session_input where id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("read state")
    }

    fn input_payload_delivery(conn: &Connection, id: &str) -> (String, String) {
        conn.query_row(
            "select delivery, payload from session_input where id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("read payload")
    }

    #[test]
    fn mark_promotes_an_admitted_row_and_sets_sequence() {
        let conn = db();
        seed_input(&conn, "i1", r#"{"text":"a"}"#, "queue", "admitted");
        mark_session_input_promoted(&conn, "i1", "s1", "msg-1", 5000).expect("mark ok");
        let (status, reason, seq, updated) = input_state(&conn, "i1");
        assert_eq!(status, "promoted");
        assert_eq!(reason, None, "mark never writes status_reason");
        assert_eq!(seq, Some(0), "first promoted row gets promoted_sequence 0");
        assert_eq!(updated, 5000);
        let pmid: String = conn
            .query_row(
                "select promoted_message_id from session_input where id='i1'",
                [],
                |r| r.get(0),
            )
            .expect("read pmid");
        assert_eq!(pmid, "msg-1");
    }

    #[test]
    fn mark_is_a_noop_on_a_non_admitted_row() {
        let conn = db();
        seed_input(&conn, "i1", r#"{"text":"a"}"#, "queue", "cancelled");
        mark_session_input_promoted(&conn, "i1", "s1", "msg-1", 5000).expect("mark ok");
        let (status, _, seq, _) = input_state(&conn, "i1");
        assert_eq!(status, "cancelled", "guard rejects a non-admitted row");
        assert_eq!(seq, None, "no promoted_sequence written");
    }

    #[test]
    fn mark_missing_id_is_noop() {
        let conn = db();
        // No seeded row: 0 rows changed, no error.
        mark_session_input_promoted(&conn, "ghost", "s1", "msg-1", 5000).expect("mark ok");
    }

    #[test]
    fn settle_moves_admitted_to_terminal_with_reason() {
        let conn = db();
        seed_input(&conn, "i1", r#"{"text":"a"}"#, "queue", "admitted");
        settle_session_input(&conn, "i1", "s1", "cancelled", Some("user cancelled"), 5000)
            .expect("settle ok");
        let (status, reason, seq, updated) = input_state(&conn, "i1");
        assert_eq!(status, "cancelled");
        assert_eq!(reason.as_deref(), Some("user cancelled"));
        assert_eq!(seq, None, "settle does not touch promoted_sequence");
        assert_eq!(updated, 5000);
    }

    #[test]
    fn settle_without_reason_writes_null() {
        let conn = db();
        seed_input(&conn, "i1", r#"{"text":"a"}"#, "queue", "admitted");
        settle_session_input(&conn, "i1", "s1", "discarded", None, 5000).expect("settle ok");
        let (status, reason, _, _) = input_state(&conn, "i1");
        assert_eq!(status, "discarded");
        assert_eq!(reason, None, "None reason → SQL NULL");
    }

    #[test]
    fn settle_after_promotion_is_rejected() {
        let conn = db();
        seed_input(&conn, "i1", r#"{"text":"a"}"#, "queue", "promoted");
        settle_session_input(&conn, "i1", "s1", "discarded", Some("late"), 5000)
            .expect("settle ok");
        let (status, reason, _, _) = input_state(&conn, "i1");
        assert_eq!(
            status, "promoted",
            "late discard must not roll back a promotion"
        );
        assert_eq!(reason, None);
    }

    #[test]
    fn promote_updates_any_status_without_the_admitted_guard() {
        let conn = db();
        // Prior state already promoted (e.g. a re-promote): promote still writes (unlike mark).
        seed_input(&conn, "i1", r#"{"text":"a"}"#, "queue", "admitted");
        let msg = json!({
            "id": "m1", "sessionID": "s1", "role": "user",
            "time": { "created": 200 }
        });
        promote_session_input(&conn, "i1", "s1", &msg, &[], 5000).expect("promote ok");
        let (status, _, seq, updated) = input_state(&conn, "i1");
        assert_eq!(status, "promoted");
        assert_eq!(seq, Some(0));
        assert_eq!(updated, 5000);
        // the message got saved as part of the transaction.
        let msg_count: i64 = conn
            .query_row("select count(*) from message where id='m1'", [], |r| {
                r.get(0)
            })
            .expect("count");
        assert_eq!(msg_count, 1);
    }

    #[test]
    fn promote_missing_shared_context_rolls_back_the_message() {
        let conn = db();
        seed_input(&conn, "i1", r#"{"text":"a"}"#, "queue", "admitted");
        let msg = json!({
            "id": "m1", "sessionID": "s1", "role": "user",
            "time": { "created": 200 },
            "metadata": { "inputIntent": { "sharedContextRefs": [
                { "kind": "shared_context_import", "context_id": "ctx-1" }
            ] } }
        });
        let err = promote_session_input(&conn, "i1", "s1", &msg, &[], 5000)
            .expect_err("missing shared context must throw");
        assert_eq!(err, "shared context import is missing");
        // Transaction rolled back: the message save is undone and the input is still admitted.
        let msg_count: i64 = conn
            .query_row("select count(*) from message where id='m1'", [], |r| {
                r.get(0)
            })
            .expect("count");
        assert_eq!(msg_count, 0, "rolled-back message must not persist");
        assert_eq!(
            input_state(&conn, "i1").0,
            "admitted",
            "promotion rolled back"
        );
    }

    #[test]
    fn promote_no_longer_attachable_rolls_back() {
        let conn = db();
        seed_input(&conn, "i1", r#"{"text":"a"}"#, "queue", "admitted");
        // An entry present but already attached → status not pending/reserved.
        conn.execute(
            "insert into session_entry (id, session_id, type, time_created, time_updated, data)
             values ('e1','s1','v4/shared_context_import',1,1,
                     '{\"contextId\":\"ctx-1\",\"status\":\"attached\"}')",
            [],
        )
        .expect("seed entry");
        let msg = json!({
            "id": "m1", "sessionID": "s1", "role": "user",
            "time": { "created": 200 },
            "metadata": { "inputIntent": { "sharedContextRefs": [
                { "kind": "shared_context_import", "context_id": "ctx-1" }
            ] } }
        });
        let err = promote_session_input(&conn, "i1", "s1", &msg, &[], 5000)
            .expect_err("no-longer-attachable must throw");
        assert_eq!(err, "shared context import is no longer attachable");
        let entry_data: String = conn
            .query_row("select data from session_entry where id='e1'", [], |r| {
                r.get(0)
            })
            .expect("read entry");
        assert!(
            entry_data.contains("attached"),
            "entry unchanged by rollback"
        );
    }

    #[test]
    fn promote_attaches_a_pending_entry_and_stamps_context_message() {
        let conn = db();
        seed_input(&conn, "i1", r#"{"text":"a"}"#, "queue", "admitted");
        conn.execute(
            "insert into session_entry (id, session_id, type, time_created, time_updated, data)
             values ('e1','s1','v4/shared_context_import',1,1,
                     '{\"contextId\":\"ctx-1\",\"status\":\"pending\"}')",
            [],
        )
        .expect("seed entry");
        // A pre-existing context message carrying metadata.contextId === ctx-1. Its stored `data`
        // includes `time` so the read-back `info` (re-fed to `saveMessage`, which requires `time`)
        // is a valid `MessageInfo` — mirroring a message originally written through `saveMessage`.
        conn.execute(
            "insert into message (id, session_id, time_created, time_updated, data, sequence)
             values ('cm1','s1',1,1,
                     '{\"role\":\"user\",\"time\":{\"created\":10},\"metadata\":{\"contextId\":\"ctx-1\"}}',-1)",
            [],
        )
        .expect("seed context message");
        let msg = json!({
            "id": "m1", "sessionID": "s1", "role": "user",
            "time": { "created": 200 },
            "metadata": { "inputIntent": { "sharedContextRefs": [
                { "kind": "shared_context_import", "context_id": "ctx-1" }
            ] } }
        });
        promote_session_input(&conn, "i1", "s1", &msg, &[], 5000).expect("promote ok");
        // Entry now attached with the promoted message id and updated clock.
        let entry_data: String = conn
            .query_row("select data from session_entry where id='e1'", [], |r| {
                r.get(0)
            })
            .expect("read entry");
        let parsed: Value = serde_json::from_str(&entry_data).expect("valid json");
        assert_eq!(parsed.get("status"), Some(&json!("attached")));
        assert_eq!(parsed.get("attachedMessageId"), Some(&json!("m1")));
        assert_eq!(
            parsed.get("contextId"),
            Some(&json!("ctx-1")),
            "existing keys preserved"
        );
        // Context message metadata got sharedContextStatus appended.
        let cm_data: String = conn
            .query_row("select data from message where id='cm1'", [], |r| r.get(0))
            .expect("read cm");
        let parsed: Value = serde_json::from_str(&cm_data).expect("valid json");
        assert_eq!(
            parsed
                .get("metadata")
                .and_then(|md| md.get("sharedContextStatus")),
            Some(&json!("attached"))
        );
    }

    #[test]
    fn update_text_and_queue_position_reencodes_payload() {
        let conn = db();
        seed_input(
            &conn,
            "i1",
            r#"{"text":"a","order":{"x":1}}"#,
            "queue",
            "admitted",
        );
        update_session_inputs(
            &conn,
            "s1",
            &[json!({ "id": "i1", "text": "b", "queuePosition": 3 })],
            5000,
        )
        .expect("update ok");
        let (delivery, payload) = input_payload_delivery(&conn, "i1");
        assert_eq!(delivery, "queue", "delivery preserved when patch omits it");
        // `text` updated in place. A bare `queuePosition` has NO effect on a top-level `order` here:
        // TS only applies it via `conversationInputIntent`/`patchObject` or an existing `intent`
        // object (session-inputs.ts 161-175), neither of which this payload carries.
        assert_eq!(payload, r#"{"text":"b","order":{"x":1}}"#);
    }

    #[test]
    fn update_queue_position_merges_into_legacy_intent_object() {
        let conn = db();
        seed_input(
            &conn,
            "i1",
            r#"{"text":"a","intent":{"queuePosition":1,"foo":"bar"}}"#,
            "queue",
            "admitted",
        );
        update_session_inputs(
            &conn,
            "s1",
            &[json!({ "id": "i1", "queuePosition": 3 })],
            5000,
        )
        .expect("update ok");
        let payload = input_payload_delivery(&conn, "i1").1;
        // No `update.intent` and `intent` present in the payload → `{ ...intent, queuePosition }`:
        // existing queuePosition keeps its first position with the new value, other keys preserved.
        assert_eq!(
            payload,
            r#"{"text":"a","intent":{"queuePosition":3,"foo":"bar"}}"#
        );
    }

    #[test]
    fn update_intent_replaces_and_sets_delivery() {
        let conn = db();
        seed_input(&conn, "i1", r#"{"text":"a"}"#, "queue", "admitted");
        update_session_inputs(
            &conn,
            "s1",
            &[json!({
                "id": "i1",
                "delivery": "startNow",
                "intent": { "requestedDelivery": "steer", "admittedDelivery": "queue" }
            })],
            5000,
        )
        .expect("update ok");
        let (delivery, payload) = input_payload_delivery(&conn, "i1");
        assert_eq!(
            delivery, "startNow",
            "patch delivery wins over stored value"
        );
        assert_eq!(
            payload,
            r#"{"text":"a","intent":{"requestedDelivery":"steer","admittedDelivery":"queue"}}"#
        );
    }

    #[test]
    fn update_conversation_input_intent_patch_falls_back_to_current_steer() {
        let conn = db();
        seed_input(
            &conn,
            "i1",
            r#"{"conversationInputIntent":{"steer":{"state":"steered"},"order":{"z":1}},"text":"x"}"#,
            "queue",
            "admitted",
        );
        update_session_inputs(
            &conn,
            "s1",
            &[json!({ "id": "i1", "queuePosition": 7 })],
            5000,
        )
        .expect("update ok");
        let payload = input_payload_delivery(&conn, "i1").1;
        // `order` rebuilt with queuePosition; `text` untouched (default empty preserved as "x");
        // no intent in the patch → steer stays the current value, no delivery key added.
        let parsed: Value = serde_json::from_str(&payload).expect("valid json");
        assert_eq!(
            parsed
                .get("conversationInputIntent")
                .and_then(|c| c.get("order")),
            Some(&json!({ "z": 1, "queuePosition": 7 }))
        );
        assert_eq!(
            parsed
                .get("conversationInputIntent")
                .and_then(|c| c.get("steer")),
            Some(&json!({ "state": "steered" })),
            "steer preserved (no fallbackReasonCode in the patch)"
        );
        assert_eq!(
            parsed
                .get("conversationInputIntent")
                .and_then(|c| c.get("delivery")),
            None,
            "delivery key not added when the patch has no intent"
        );
    }

    #[test]
    fn update_skips_non_admitted_and_missing_rows() {
        let conn = db();
        seed_input(&conn, "i1", r#"{"text":"a"}"#, "queue", "promoted");
        update_session_inputs(
            &conn,
            "s1",
            &[
                json!({ "id": "i1", "text": "b" }),
                json!({ "id": "ghost", "text": "c" }),
            ],
            5000,
        )
        .expect("update ok");
        // The promoted row was skipped: payload still original, time_updated still 1.
        let (_, payload) = input_payload_delivery(&conn, "i1");
        assert_eq!(payload, r#"{"text":"a"}"#);
    }

    #[test]
    fn update_empty_batch_is_a_noop() {
        let conn = db();
        seed_input(&conn, "i1", r#"{"text":"a"}"#, "queue", "admitted");
        update_session_inputs(&conn, "s1", &[], 5000).expect("update ok");
        let (delivery, payload) = input_payload_delivery(&conn, "i1");
        assert_eq!(delivery, "queue");
        assert_eq!(payload, r#"{"text":"a"}"#);
    }

    #[test]
    fn decode_payload_keeps_text_first_and_overrides_value() {
        // Stored payload has `text` at a non-first position and an extra key; decode must hoist text
        // to the front and preserve the remaining order.
        let value = decode_payload(r#"{"extra":1,"text":"hi","other":2}"#);
        assert_eq!(value.to_string(), r#"{"text":"hi","extra":1,"other":2}"#);
    }

    #[test]
    fn decode_payload_non_object_falls_back_to_empty_text() {
        assert_eq!(decode_payload("[1,2]").to_string(), r#"{"text":""}"#);
        assert_eq!(decode_payload("not json").to_string(), r#"{"text":""}"#);
        assert_eq!(decode_payload("42").to_string(), r#"{"text":""}"#);
    }
}
