//! Port of the `saveSessionInput` write path (from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-inputs.ts`).
//!
//! A single upsert statement admits one `session_input` row. The TS does not wrap it in a
//! transaction, so neither does this (the statement is atomic on its own). Two behaviors are
//! reproduced exactly:
//!
//! - `admitted_sequence` is auto-assigned per session as `coalesce(max(admitted_sequence), -1) + 1`
//!   restricted to the same `session_id`, so a fresh row gets the next monotonic sequence (0, 1, …).
//! - `on conflict(id) do update` re-admits an existing id in place: it overwrites
//!   `kind`/`delivery`/`payload`/`time_updated` from the excluded row but deliberately does NOT bump
//!   `admitted_sequence` (the original order is preserved) and does NOT touch `status`.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection};

/// Core port of `saveSessionInput` against an already-open read-write connection.
///
/// The SQL text and the bind order mirror the TS `db.prepare(...).run(...)` call exactly:
/// `id, session_id, kind, delivery, payload, session_id (subquery), now, now`. The `status` is the
/// literal `'admitted'`.
///
/// # Arguments
///
/// * `conn` — an open read-write `Connection` (FK enforcement is the caller's concern, see
///   [`crate::open_readwrite`]).
/// * `id` — primary key of the `session_input` row.
/// * `session_id` — owning session (`session_input.session_id` FK → `session.id`).
/// * `kind` — input kind column.
/// * `delivery` — delivery column (`startNow`/`guide`/`queue`).
/// * `payload_json` — the already-serialized payload. Matches TS `encodeJson(payload) ?? "{}"`:
///   an empty string or the literal `"null"` is treated as `"{}"`; any other value is stored verbatim.
/// * `now` — epoch milliseconds, injected by the caller (no clock is read here) for both
///   `time_created` and `time_updated`.
///
/// # Errors
///
/// Returns the `rusqlite` error string when the statement fails (e.g. an FK violation when the
/// parent `session` row is missing, mirroring the `node:sqlite` path).
pub fn save_session_input(
    conn: &Connection,
    id: &str,
    session_id: &str,
    kind: &str,
    delivery: &str,
    payload_json: &str,
    now: i64,
) -> Result<(), String> {
    let payload = if payload_json.is_empty() || payload_json == "null" {
        "{}"
    } else {
        payload_json
    };
    conn.execute(
        "insert into session_input (
          id, session_id, kind, delivery, payload,
          admitted_sequence, status, time_created, time_updated
        )
        values (
          ?1, ?2, ?3, ?4, ?5,
          (
            select coalesce(max(admitted_sequence), -1) + 1
            from session_input
            where session_id = ?6
          ),
          'admitted', ?7, ?8
        )
        on conflict(id) do update set
          kind = excluded.kind,
          delivery = excluded.delivery,
          payload = excluded.payload,
          time_updated = excluded.time_updated",
        params![id, session_id, kind, delivery, payload, session_id, now, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// N-API write boundary for [`save_session_input`]: opens the session-store DB read-write, applies
/// the same per-connection PRAGMAs as the TS shared connection, and runs the single upsert.
///
/// `payload_json` is the pre-serialized payload from the caller; `now` is a JS number (epoch ms),
/// passed in rather than read from the clock so the operation is deterministic and parity-testable.
/// The statement is atomic and is intentionally NOT wrapped in a transaction (matching the TS).
#[napi]
pub fn save_session_input_json(
    db_path: String,
    id: String,
    session_id: String,
    kind: String,
    delivery: String,
    payload_json: String,
    now: f64,
) -> napi::Result<()> {
    let conn = crate::open_readwrite(&db_path)?;
    save_session_input(
        &conn,
        &id,
        &session_id,
        &kind,
        &delivery,
        &payload_json,
        now as i64,
    )
    .map_err(Error::from_reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        conn.execute("PRAGMA foreign_keys = ON", [])
            .expect("invariant: enable fk");
        // Build the real session schema (incl. `session` + `session_input` and the FK) from the
        // frozen migration ledger so FK behavior matches the production/bootstrap path exactly.
        crate::session_bootstrap::run_session_migrations_in_tx(&conn, 1_700_000_000_000)
            .expect("invariant: apply session migrations");
        conn
    }

    fn make_session(conn: &Connection, id: &str) {
        conn.execute(
            "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
             values (?1,'p','s','/d','t','v',1,1)",
            params![id],
        )
        .expect("seed session");
    }

    fn read_row(conn: &Connection, id: &str) -> (String, String, String, i64, String, i64) {
        conn.query_row(
            "select kind, delivery, payload, admitted_sequence, status, time_updated
             from session_input where id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .expect("read row")
    }

    #[test]
    fn admitted_sequence_auto_increments_per_session() {
        let conn = session_db();
        make_session(&conn, "s1");
        save_session_input(&conn, "i1", "s1", "user", "queue", r#"{"text":"a"}"#, 100).expect("first");
        save_session_input(&conn, "i2", "s1", "user", "queue", r#"{"text":"b"}"#, 101).expect("second");
        assert_eq!(read_row(&conn, "i1").3, 0);
        assert_eq!(read_row(&conn, "i2").3, 1);
        assert_eq!(read_row(&conn, "i1").4, "admitted");
    }

    #[test]
    fn upsert_updates_in_place_without_bumping_sequence() {
        let conn = session_db();
        make_session(&conn, "s1");
        save_session_input(&conn, "i1", "s1", "user", "queue", r#"{"text":"a"}"#, 100).expect("insert");
        save_session_input(&conn, "i2", "s1", "user", "queue", r#"{"text":"b"}"#, 101).expect("insert 2");
        // Re-admit the first id with changed kind/delivery/payload/time.
        save_session_input(&conn, "i1", "s1", "system", "startNow", r#"{"text":"z"}"#, 200)
            .expect("upsert");
        let (kind, delivery, payload, seq, status, updated) = read_row(&conn, "i1");
        assert_eq!(kind, "system");
        assert_eq!(delivery, "startNow");
        assert_eq!(payload, r#"{"text":"z"}"#);
        assert_eq!(seq, 0, "admitted_sequence preserved on conflict");
        assert_eq!(status, "admitted", "status not touched by the upsert");
        assert_eq!(updated, 200, "time_updated overwritten");
        // time_created is NOT in the update set, so it stays at the original insert value.
        let created: i64 = conn
            .query_row(
                "select time_created from session_input where id = 'i1'",
                [],
                |r| r.get(0),
            )
            .expect("read created");
        assert_eq!(created, 100);
    }

    #[test]
    fn empty_or_null_payload_falls_back_to_brace_object() {
        let conn = session_db();
        make_session(&conn, "s1");
        save_session_input(&conn, "i1", "s1", "user", "queue", "", 100).expect("empty");
        save_session_input(&conn, "i2", "s1", "user", "queue", "null", 100).expect("null");
        assert_eq!(read_row(&conn, "i1").2, "{}");
        assert_eq!(read_row(&conn, "i2").2, "{}");
    }

    #[test]
    fn missing_parent_session_is_rejected_by_fk() {
        let conn = session_db();
        conn.execute("PRAGMA foreign_keys = ON", []).expect("fk on");
        let err = save_session_input(&conn, "i1", "ghost", "user", "queue", "{}", 100)
            .expect_err("fk violation expected");
        assert!(err.contains("FOREIGN KEY constraint failed"), "got: {err}");
    }
}
