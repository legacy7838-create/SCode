//! `system` channel — the first service ported to Rust.
//!
//! Transcribed from `packages/services/src/system/systemService.ts` and
//! `integratedTerminalShells.ts`. The channel has three methods and no events,
//! so `subscribe` returns `None`.
//!
//! # Platform strings must match Node exactly
//!
//! `SystemInfo.platform` is compared against Node's `process.platform` values
//! (`linux`, `darwin`, `win32`), not Rust's `std::env::consts::OS` values
//! (`linux`, `macos`, `windows`). The UI branches on these strings, so emitting
//! `macos`/`windows` here would silently change behaviour on those platforms.

use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value as JsonValue};
use crossbeam_channel::Receiver;
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

/// Default SSH port, matching `DEFAULT_PROBE_PORT` in the TypeScript original.
const DEFAULT_PROBE_PORT: u16 = 22;
const DEFAULT_PROBE_TIMEOUT_MS: u64 = 800;
const DEFAULT_PROBE_ATTEMPTS: u32 = 2;
const MAX_PROBE_ATTEMPTS: u32 = 3;
const MIN_PROBE_TIMEOUT_MS: u64 = 100;
const MAX_PROBE_TIMEOUT_MS: u64 = 10_000;

/// The Windows Git Bash locations probed, in order.
const WINDOWS_GIT_BASH_PATHS: [&str; 2] = [
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files (x86)\Git\bin\bash.exe",
];

/// Node's `process.platform` for this host.
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// The user's home directory.
///
/// `os.homedir()` in Node prefers `$HOME` and only consults the password
/// database when it is unset. This mirrors the `$HOME` path; the passwd fallback
/// is not reproduced because that would need a libc dependency, and the
/// scheduler store in this app already resolves its base dir from `$HOME` the
/// same way.
fn homedir() -> String {
    std::env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_default()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The `system` channel.
pub struct SystemService;

impl SystemService {
    pub fn new() -> Self {
        Self
    }

    fn info(&self) -> JsonValue {
        json!({ "homedir": homedir(), "platform": node_platform() })
    }

    /// Windows-only shell discovery, transcribed from
    /// `listIntegratedTerminalShellOptions`. Non-Windows returns an empty list,
    /// which is what the original does.
    fn list_integrated_terminal_shells(&self) -> JsonValue {
        if node_platform() != "win32" {
            return json!([]);
        }

        let mut options = vec![json!({
            "dialect": "cmd",
            // `ComSpec` is the system command interpreter; `cmd.exe` is the
            // original's literal fallback.
            "id": format!(
                "cmd:{}",
                comspec().unwrap_or_else(|| "cmd.exe".to_owned())
            ),
            "label": "CMD",
            "path": comspec().unwrap_or_else(|| "cmd.exe".to_owned()),
            "source": "system",
        })];

        if let Some(path) = resolve_windows_git_bash() {
            options.push(json!({
                "dialect": "git-bash",
                "id": format!("git-bash:{path}"),
                "label": "Git Bash",
                "path": path,
                "source": "system",
            }));
        }

        json!(options)
    }

    fn probe_intranet(&self, request: &JsonValue) -> JsonValue {
        let targets = normalize_targets(request);
        let attempts = normalize_attempts(request.get("attempts"));
        let required = normalize_required(request.get("requiredSuccessCount"), targets.len());

        let results: Vec<JsonValue> = targets
            .iter()
            .map(|target| match target {
                NormalizedTarget::Tcp(tcp) => run_tcp_probe(tcp, attempts),
                NormalizedTarget::Service(service) => run_service_probe(service, attempts),
            })
            .collect();

        let reached = results
            .iter()
            .filter(|result| result["reachable"] == JsonValue::Bool(true))
            .count();

        json!({
            "isIntranet": !targets.is_empty() && reached >= required,
            "reachedTargetCount": reached,
            "requiredSuccessCount": required,
            "totalTargets": targets.len(),
            "checkedAt": now_ms(),
            "strategy": resolve_strategy(&targets),
            "results": results,
        })
    }
}

impl Default for SystemService {
    fn default() -> Self {
        Self::new()
    }
}

fn comspec() -> Option<String> {
    std::env::var("ComSpec")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn resolve_windows_git_bash() -> Option<String> {
    WINDOWS_GIT_BASH_PATHS
        .iter()
        .find(|candidate| std::path::Path::new(candidate).exists())
        .map(|candidate| (*candidate).to_owned())
}

impl ChannelHandler for SystemService {
    fn call(
        &self,
        _ctx: &str,
        method: &str,
        args: &[JsonValue],
    ) -> Result<JsonValue, HandlerError> {
        // `args` is the positional argument list the client sent; see
        // `ChannelHandler::call`. A zero-argument call arrives as an empty list,
        // and a one-argument call as a one-element list.
        match method {
            "info" => Ok(self.info()),
            "listIntegratedTerminalShells" => Ok(self.list_integrated_terminal_shells()),
            "probeIntranet" => {
                let request = args.first().cloned().unwrap_or(JsonValue::Null);
                Ok(self.probe_intranet(&request))
            }
            other => Err(HandlerError::message(format!(
                "system.{other} is not implemented by the Rust host"
            ))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        _event: &str,
        _arg: Option<&JsonValue>,
    ) -> Option<Receiver<JsonValue>> {
        // The `system` channel publishes no events; the UI only calls methods.
        None
    }
}

// ---------------------------------------------------------------------------
// Probe normalisation — transcribed so clamping matches the original exactly.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct TcpTarget {
    target_id: String,
    host: String,
    port: u16,
    timeout_ms: u64,
}

#[derive(Debug, Clone)]
struct ServiceTarget {
    target_id: String,
    url: String,
    expected_marker: Option<String>,
    token: Option<String>,
    timeout_ms: u64,
}

#[derive(Debug, Clone)]
enum NormalizedTarget {
    Tcp(TcpTarget),
    Service(ServiceTarget),
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    value.get(key)
}

fn trimmed_string(value: Option<&JsonValue>) -> Option<String> {
    value
        .and_then(JsonValue::as_str)
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

/// Read a finite number, including negative ones.
///
/// The distinction matters: the TypeScript original treats "not a number" as
/// "use the default" but treats a negative number as a real value to clamp. So a
/// finite negative must not fall through to the default.
fn as_finite_f64(value: Option<&JsonValue>) -> Option<f64> {
    value
        .and_then(JsonValue::as_f64)
        .filter(|number| number.is_finite())
}

fn normalize_attempts(value: Option<&JsonValue>) -> u32 {
    match as_finite_f64(value) {
        None => DEFAULT_PROBE_ATTEMPTS,
        // `Math.min(MAX, Math.max(1, Math.floor(n)))`: floor first, then clamp,
        // so a negative attempts value lands on 1 rather than on the default.
        // The clamp is done in i64 because casting a negative float to u32 first
        // would wrap it to a huge value and produce the maximum instead.
        Some(raw) => {
            let floored = raw.floor() as i64;
            floored.max(1).min(MAX_PROBE_ATTEMPTS as i64) as u32
        }
    }
}

fn normalize_required(value: Option<&JsonValue>, total: usize) -> usize {
    if total == 0 {
        return 1;
    }
    match as_finite_f64(value) {
        None => 1,
        Some(raw) => {
            let floored = raw.floor() as i64;
            floored.max(1).min(total as i64) as usize
        }
    }
}

fn normalize_timeout(value: Option<&JsonValue>) -> u64 {
    match as_finite_f64(value) {
        Some(raw) => {
            let floored = raw.floor() as i64;
            floored
                .max(MIN_PROBE_TIMEOUT_MS as i64)
                .min(MAX_PROBE_TIMEOUT_MS as i64) as u64
        }
        None => DEFAULT_PROBE_TIMEOUT_MS,
    }
}

fn normalize_targets(request: &JsonValue) -> Vec<NormalizedTarget> {
    let Some(list) = request.get("targets").and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    list.iter().filter_map(normalize_target).collect()
}

fn normalize_target(value: &JsonValue) -> Option<NormalizedTarget> {
    // The original keys on `kind === "service"`; anything else is treated as tcp.
    if value.get("kind").and_then(JsonValue::as_str) == Some("service") {
        normalize_service_target(value)
    } else {
        normalize_tcp_target(value)
    }
}

fn normalize_tcp_target(value: &JsonValue) -> Option<NormalizedTarget> {
    let host = trimmed_string(field(value, "host"))?;
    // A port is honoured only when it is a whole number in range, exactly as
    // the original's `Number.isInteger && >= 1 && <= 65535` check.
    let port = value
        .get("port")
        .and_then(JsonValue::as_f64)
        .filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= 65535.0)
        .map(|n| n as u16)
        .unwrap_or(DEFAULT_PROBE_PORT);

    Some(NormalizedTarget::Tcp(TcpTarget {
        target_id: trimmed_string(field(value, "id"))
            .unwrap_or_else(|| format!("{host}:{port}")),
        host,
        port,
        timeout_ms: normalize_timeout(field(value, "timeoutMs")),
    }))
}

fn normalize_service_target(value: &JsonValue) -> Option<NormalizedTarget> {
    let url = trimmed_string(field(value, "url"))?;
    let parsed = reqwest::Url::parse(&url).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    // `Url::to_string` is the normalised form, matching the original's
    // `parsedUrl.toString()`.
    let normalized = parsed.to_string();
    Some(NormalizedTarget::Service(ServiceTarget {
        target_id: trimmed_string(field(value, "id")).unwrap_or_else(|| normalized.clone()),
        url: normalized,
        expected_marker: trimmed_string(field(value, "expectedMarker")),
        token: trimmed_string(field(value, "token")),
        timeout_ms: normalize_timeout(field(value, "timeoutMs")),
    }))
}

fn resolve_strategy(targets: &[NormalizedTarget]) -> &'static str {
    // `every` on an empty list is true, so an empty target set reports
    // "tcp-connect" — the same as the original.
    if targets
        .iter()
        .all(|t| matches!(t, NormalizedTarget::Tcp(_)))
    {
        "tcp-connect"
    } else if targets
        .iter()
        .all(|t| matches!(t, NormalizedTarget::Service(_)))
    {
        "service-http"
    } else {
        "mixed"
    }
}

// ---------------------------------------------------------------------------
// Probe execution
// ---------------------------------------------------------------------------

/// Connect once, returning the measured latency or an error string.
fn probe_tcp_once(host: &str, port: u16, timeout: Duration) -> Result<u64, String> {
    let started = Instant::now();
    let addresses: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .collect();
    if addresses.is_empty() {
        return Err(format!("no address for {host}:{port}"));
    }
    TcpStream::connect_timeout(&addresses[0], timeout).map_err(|error| error.to_string())?;
    Ok(started.elapsed().as_millis() as u64)
}

fn run_tcp_probe(target: &TcpTarget, attempts: u32) -> JsonValue {
    let timeout = Duration::from_millis(target.timeout_ms);
    let mut last_error = String::new();

    for attempt in 1..=attempts {
        match probe_tcp_once(&target.host, target.port, timeout) {
            Ok(latency_ms) => {
                return json!({
                    "targetId": target.target_id,
                    "kind": "tcp",
                    "host": target.host,
                    "port": target.port,
                    "reachable": true,
                    "attemptCount": attempt,
                    "latencyMs": latency_ms,
                });
            }
            Err(error) => last_error = error,
        }
    }

    json!({
        "targetId": target.target_id,
        "kind": "tcp",
        "host": target.host,
        "port": target.port,
        "reachable": false,
        "attemptCount": attempts,
        "latencyMs": JsonValue::Null,
        "error": if last_error.is_empty() { "probe failed".to_owned() } else { last_error },
    })
}

fn run_service_probe(target: &ServiceTarget, attempts: u32) -> JsonValue {
    let mut last_error = String::new();
    let client = match build_probe_client(target.timeout_ms) {
        Ok(client) => client,
        Err(error) => {
            return json!({
                "targetId": target.target_id,
                "kind": "service",
                "url": target.url,
                "reachable": false,
                "attemptCount": attempts,
                "latencyMs": JsonValue::Null,
                "error": error,
            });
        }
    };

    for attempt in 1..=attempts {
        let started = Instant::now();
        let mut request = client.get(&target.url);
        if let Some(token) = &target.token {
            request = request.header("x-zcode-intranet-token", token);
        }
        match request.send() {
            Ok(response) => {
                let status = response.status();
                let body = response.text().unwrap_or_default();
                let latency_ms = started.elapsed().as_millis() as u64;
                let marker_hit = target
                    .expected_marker
                    .as_ref()
                    .map(|marker| body.contains(marker.as_str()))
                    .unwrap_or(true);

                if status.is_success() && marker_hit {
                    let mut result = Map::new();
                    result.insert("targetId".into(), JsonValue::String(target.target_id.clone()));
                    result.insert("kind".into(), JsonValue::String("service".into()));
                    result.insert("url".into(), JsonValue::String(target.url.clone()));
                    result.insert("reachable".into(), JsonValue::Bool(true));
                    result.insert("attemptCount".into(), json!(attempt));
                    result.insert("latencyMs".into(), json!(latency_ms));
                    if !body.is_empty() {
                        result.insert("marker".into(), JsonValue::String(body));
                    }
                    return JsonValue::Object(result);
                }
                last_error = if status.is_success() {
                    "expected marker not found".to_owned()
                } else {
                    format!("unexpected status {status}")
                };
            }
            Err(error) => last_error = error.to_string(),
        }
    }

    json!({
        "targetId": target.target_id,
        "kind": "service",
        "url": target.url,
        "reachable": false,
        "attemptCount": attempts,
        "latencyMs": JsonValue::Null,
        "error": if last_error.is_empty() { "probe failed".to_owned() } else { last_error },
    })
}

fn build_probe_client(timeout_ms: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        // The per-target timeout is the authoritative one; this is a ceiling so a
        // stalled DNS lookup cannot outlive the attempts budget.
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| error.to_string())
}
