//! Script-workflow run reads (`getScriptWorkflowRun`, `listScriptWorkflowRuns`) mirroring `decodeRun`
//! (`script-workflow-codecs.ts`). Fixed key order; `?? undefined` fields omit when NULL; JSON columns
//! (`args`/`failure`/`stats`) via `decode_json_col` (null/empty → omit, invalid → error). Columns are
//! gathered as owned rusqlite values first so a JSON parse error propagates instead of being swallowed.
//! Verified by `harness/session_workflow_runs_parity`.

use rusqlite::{Connection, OptionalExtension, types::ToSql};
use serde_json::{Map, Value, json};

use super::session_sessions::decode_json_col;

/// Owned raw workflow-run row (rusqlite-native reads only).
struct RunRaw {
    id: String,
    kind: String,
    name: String,
    cwd: String,
    status: String,
    budget_spent: i64,
    script_hash: String,
    definition_id: Option<String>,
    parent_session_id: Option<String>,
    script_path: Option<String>,
    args_json: Option<String>,
    args_hash: Option<String>,
    stats_json: Option<String>,
    failure_json: Option<String>,
    current_phase: Option<String>,
    time_created: i64,
    time_updated: i64,
    time_started: Option<i64>,
    time_completed: Option<i64>,
    budget_total: Option<i64>,
}

fn read_run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunRaw> {
    Ok(RunRaw {
        id: row.get("id")?,
        kind: row.get("kind")?,
        name: row.get("name")?,
        cwd: row.get("cwd")?,
        status: row.get("status")?,
        budget_spent: row.get("budget_spent")?,
        script_hash: row.get("script_hash")?,
        definition_id: row.get("definition_id")?,
        parent_session_id: row.get("parent_session_id")?,
        script_path: row.get("script_path")?,
        args_json: row.get("args_json")?,
        args_hash: row.get("args_hash")?,
        stats_json: row.get("stats_json")?,
        failure_json: row.get("failure_json")?,
        current_phase: row.get("current_phase")?,
        time_created: row.get("time_created")?,
        time_updated: row.get("time_updated")?,
        time_started: row.get("time_started")?,
        time_completed: row.get("time_completed")?,
        budget_total: row.get("budget_total")?,
    })
}

fn opt_str(m: &mut Map<String, Value>, key: &str, raw: Option<String>) {
    if let Some(v) = raw {
        m.insert(key.to_string(), json!(v));
    }
}

fn opt_i64(m: &mut Map<String, Value>, key: &str, raw: Option<i64>) {
    if let Some(v) = raw {
        m.insert(key.to_string(), json!(v));
    }
}

fn json_col(m: &mut Map<String, Value>, key: &str, raw: &Option<String>) -> Result<(), String> {
    if let Some(v) = decode_json_col(raw)? {
        m.insert(key.to_string(), v);
    }
    Ok(())
}

impl RunRaw {
    fn into_value(self) -> Result<Value, String> {
        // decodeRun key order.
        let mut m = Map::new();
        json_col(&mut m, "args", &self.args_json)?;
        opt_str(&mut m, "argsHash", self.args_hash);
        m.insert("budgetSpent".into(), json!(self.budget_spent));
        opt_i64(&mut m, "budgetTotal", self.budget_total);
        opt_i64(&mut m, "completedAt", self.time_completed);
        m.insert("createdAt".into(), json!(self.time_created));
        opt_str(&mut m, "currentPhase", self.current_phase);
        m.insert("cwd".into(), json!(self.cwd));
        opt_str(&mut m, "definitionId", self.definition_id);
        json_col(&mut m, "failure", &self.failure_json)?;
        m.insert("id".into(), json!(self.id));
        m.insert("kind".into(), json!(self.kind));
        m.insert("name".into(), json!(self.name));
        opt_str(&mut m, "parentSessionId", self.parent_session_id);
        m.insert("scriptHash".into(), json!(self.script_hash));
        opt_str(&mut m, "scriptPath", self.script_path);
        opt_i64(&mut m, "startedAt", self.time_started);
        json_col(&mut m, "stats", &self.stats_json)?;
        m.insert("status".into(), json!(self.status));
        m.insert("updatedAt".into(), json!(self.time_updated));
        Ok(Value::Object(m))
    }
}

/// Port of `getScriptWorkflowRun`: the run by id, or `null`.
pub fn get_script_workflow_run(conn: &Connection, run_id: &str) -> Result<Value, String> {
    let row = conn
        .query_row("select * from workflow_run where id = ?1", [run_id], read_run_row)
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        None => Ok(Value::Null),
        Some(r) => r.into_value(),
    }
}

/// Port of `listScriptWorkflowRuns`: optional `cwd`/`statuses` filter + `limit`, ordered by
/// `time_updated desc, id desc`. `filter_json` = `{ cwd?, statuses?, limit? }`.
pub fn list_script_workflow_runs(conn: &Connection, filter: &Value) -> Result<Value, String> {
    let obj = match filter {
        Value::Null | Value::Object(_) => filter.as_object().cloned().unwrap_or_default(),
        _ => return Err("listScriptWorkflowRuns filter must be an object or null".to_string()),
    };
    let mut clauses: Vec<String> = Vec::new();
    let mut vals: Vec<Box<dyn ToSql>> = Vec::new();
    if let Some(cwd) = obj.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        clauses.push("cwd = ?".to_string());
        vals.push(Box::new(cwd.to_string()));
    }
    if let Some(arr) = obj.get("statuses").and_then(Value::as_array) {
        let list: Vec<&str> = arr.iter().filter_map(Value::as_str).collect();
        if !list.is_empty() {
            clauses.push(format!("status in ({})", list.iter().map(|_| "?").collect::<Vec<_>>().join(", ")));
            for s in &list {
                vals.push(Box::new(s.to_string()));
            }
        }
    }
    let limit = obj.get("limit").and_then(Value::as_i64).filter(|l| *l > 0);
    if let Some(l) = limit {
        vals.push(Box::new(l));
    }
    let where_sql = if clauses.is_empty() { String::new() } else { format!(" where {}", clauses.join(" and ")) };
    let limit_sql = if limit.is_some() { " limit ?" } else { "" };
    let sql = format!(
        "select * from workflow_run{} order by time_updated desc, id desc{}",
        where_sql, limit_sql
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let refs: Vec<&dyn ToSql> = vals.iter().map(|v| v.as_ref()).collect();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(refs), read_run_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(r.into_value()?);
    }
    Ok(Value::Array(out))
}
