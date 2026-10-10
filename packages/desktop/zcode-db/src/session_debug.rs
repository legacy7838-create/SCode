//! Read-only RAW-ROW projection for the developer observation server
//! (`apps/zcode-cli/packages/debug/server/sources.ts:loadSqlite`).
//!
//! WHY this exists: that viewer is the one remaining consumer that reads the session DB **outside**
//! the `SessionStorePort` facade — it wants the raw `session` / `message` / `part` windows (ordered +
//! capped, exactly as the TS SQL) to render a diagnostic dump, not the decoded domain projections the
//! facade ops return. After the Rust cutover no JS may hold a `node:sqlite` handle, so the three
//! verbatim TS `SELECT`s live here instead. Rows come back UNDECODED (`data` stays a JSON text
//! column) so the JS mapping in `sources.ts` keeps its exact semantics, including the `null` → `""`
//! coercion and the `parseData` guard.
//!
//! Purely additive and read-only: `crate::open_readonly` (no create, WAL readers, `busy_timeout`),
//! no transaction, and it never mutates the database.

use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;
use rusqlite::{types::Value as SqlValue, Connection, Row};
use serde_json::{Map, Value};

/// One raw row as a JSON object, keys = column names. The three queries below only project TEXT and
/// INTEGER columns; any other storage class is surfaced as `null` (a `BLOB` in these columns would
/// already be data corruption, and the viewer treats it as "no value" exactly like the TS did).
fn row_to_json(row: &Row<'_>, columns: &[&str]) -> std::result::Result<Value, rusqlite::Error> {
    let mut map = Map::with_capacity(columns.len());
    for (index, name) in columns.iter().enumerate() {
        let value: SqlValue = row.get(index)?;
        let projected = match value {
            SqlValue::Text(text) => Value::String(text),
            SqlValue::Integer(number) => Value::from(number),
            SqlValue::Real(number) => Value::from(number),
            SqlValue::Null | SqlValue::Blob(_) => Value::Null,
        };
        map.insert((*name).to_string(), projected);
    }
    Ok(Value::Object(map))
}

/// Runs one `SELECT` copied verbatim from `sources.ts` and collects every row into a JSON array.
fn query_rows(
    conn: &Connection,
    sql: &str,
    columns: &[&str],
    limit: i64,
) -> std::result::Result<Vec<Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |row| row_to_json(row, columns))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

const SESSION_SQL: &str = "select id, project_id, title, directory, time_created, time_updated \
                            from session order by time_updated desc limit ?1";
const MESSAGE_SQL: &str = "select id, session_id, time_created, time_updated, data \
                           from message order by time_created asc, rowid asc limit ?1";
const PART_SQL: &str = "select id, message_id, session_id, time_created, time_updated, data \
                        from part order by time_created asc, id asc limit ?1";

const SESSION_COLUMNS: [&str; 6] =
    ["id", "project_id", "title", "directory", "time_created", "time_updated"];
const MESSAGE_COLUMNS: [&str; 5] = ["id", "session_id", "time_created", "time_updated", "data"];
const PART_COLUMNS: [&str; 6] = [
    "id",
    "message_id",
    "session_id",
    "time_created",
    "time_updated",
    "data",
];

/// N-API: the observation dump for `loadSqlite`. Returns
/// `{ sessions: [...], messages: [...], parts: [...] }` with the exact column sets, ordering and
/// `LIMIT`s the TS used. The limits are caller-supplied because they are the viewer's own display
/// budget, not a storage rule.
#[napi]
pub fn debug_observation_json(
    db_path: String,
    sessions_limit: i64,
    messages_limit: i64,
    parts_limit: i64,
) -> Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let dump = |sql: &str, columns: &[&str], limit: i64| -> std::result::Result<Vec<Value>, String> {
        query_rows(&conn, sql, columns, limit)
    };
    let mut out = Map::new();
    out.insert(
        "sessions".to_string(),
        Value::Array(
            dump(SESSION_SQL, &SESSION_COLUMNS, sessions_limit).map_err(Error::from_reason)?,
        ),
    );
    out.insert(
        "messages".to_string(),
        Value::Array(
            dump(MESSAGE_SQL, &MESSAGE_COLUMNS, messages_limit).map_err(Error::from_reason)?,
        ),
    );
    out.insert(
        "parts".to_string(),
        Value::Array(dump(PART_SQL, &PART_COLUMNS, parts_limit).map_err(Error::from_reason)?),
    );
    serde_json::to_string(&Value::Object(out)).map_err(|e| Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three projections come from a schema the session migrations already own.
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        crate::session_bootstrap::run_session_migrations_in_tx(&conn, 1_700_000_000_000)
            .expect("invariant: apply session schema");
        conn.execute(
            "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
             values ('S','p','s','/d','t','v',1000,2000)",
            [],
        )
        .expect("invariant: seed session");
        conn.execute(
            "insert into message (id, session_id, data, time_created, time_updated)
             values ('M','S','{\"role\":\"user\"}',1000,1000)",
            [],
        )
        .expect("invariant: seed message");
        conn.execute(
            "insert into part (id, message_id, session_id, data, time_created, time_updated)
             values ('P','M','S','{\"type\":\"text\"}',1000,1000)",
            [],
        )
        .expect("invariant: seed part");
        conn
    }

    #[test]
    fn observation_projects_raw_rows_and_keeps_data_as_text() {
        let conn = seeded();

        let sessions =
            query_rows(&conn, SESSION_SQL, &SESSION_COLUMNS, 200).expect("sessions projection");
        assert_eq!(sessions[0]["id"], Value::String("S".into()));
        assert_eq!(sessions[0]["time_updated"], Value::from(2000));

        // `data` stays the RAW text column: the viewer parses and guards it itself.
        let messages =
            query_rows(&conn, MESSAGE_SQL, &MESSAGE_COLUMNS, 1000).expect("messages projection");
        assert_eq!(
            messages[0]["data"],
            Value::String(r#"{"role":"user"}"#.into())
        );

        let parts = query_rows(&conn, PART_SQL, &PART_COLUMNS, 2000).expect("parts projection");
        assert_eq!(parts[0]["message_id"], Value::String("M".into()));
    }

    #[test]
    fn observation_honours_the_row_limits() {
        let conn = seeded();
        let empty = query_rows(&conn, SESSION_SQL, &SESSION_COLUMNS, 0).expect("limit 0 projection");
        assert!(empty.is_empty());
    }
}
