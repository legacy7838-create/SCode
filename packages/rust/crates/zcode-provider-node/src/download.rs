//! `downloadZCodeBuiltinRelease` over the native boundary.
//!
//! The network is the host's: `request` arrives as a JS callback and this port
//! owns the URL, the init shape, the budget, the schema and the error
//! taxonomy. The callback answers `{ status, body }`, so the status gate and
//! the body cap run here (spec §3.5).
//!
//! # Why a plain thread and not `tokio::time::timeout`
//!
//! Calling a JS callback blocks the Rust side — the promise settles when the JS
//! main thread gets to it. A timeout built on the tokio reactor would need the
//! same worker to poll the timer while that worker is blocked in the callback,
//! so the budget could only fire *after* the callback returned, which defeats
//! it. So the exchange runs on a driver thread and the task waits on a channel
//! with a deadline: the 20 s budget is real, and the JS thread is never touched
//! from here.
//!
//! # Cancellation
//!
//! The caller's `AbortSignal` is the wrapper's to forward. This side
//! contributes the total budget: when it is spent, `abort` is invoked so the
//! wrapper cancels the in-flight request, and the wait is abandoned — the same
//! observable outcome as the TS `AbortController`.

use std::sync::mpsc;
use std::time::Duration;

use napi::bindgen_prelude::Promise;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Result, Status, Task};
use napi_derive::napi;

use zcode_provider_config::download::{
    download_builtin_release, DownloadOutcome, DownloadOptions, DownloadRequestError,
    DownloadResponse, DOWNLOAD_BUDGET_MS,
};

/// `(requestJson) => Promise<answerJson>` where `requestJson` is
/// `{ url, stage }` and the answer is `{ status, body }`. A rejected promise is
/// a transport failure, which the taxonomy reports as `invalid response` — the
/// same shape a thrown fetch produces in TS. One string argument on purpose:
/// napi hands a tuple `T` to JavaScript as a single array value, so a split
/// signature would arrive as `[url, stage]` in one parameter.
type RequestTsfn = ThreadsafeFunction<String, Promise<String>, String, Status, false, true>;

/// Fired with the URL whose request must be cancelled.
type AbortTsfn = ThreadsafeFunction<String, (), String, Status, false, true>;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOptionsJson {
    pub endpoint_origin: String,
    pub app_version: String,
    pub platform: String,
}

pub struct DownloadTask {
    options: DownloadOptionsJson,
    /// `Some` only before the single run of the task: napi's TSFN is not
    /// `Clone`, so the driver thread takes ownership.
    request: Option<RequestTsfn>,
    abort: Option<AbortTsfn>,
}

impl Task for DownloadTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let Some(request) = self.request.take() else {
            return Err(napi::Error::new(
                Status::GenericFailure,
                "the download task has already run",
            ));
        };
        // The driver thread owns the three strings and the callback, so the
        // task keeps only what the deadline path needs.
        let endpoint_origin = self.options.endpoint_origin.clone();
        let app_version = self.options.app_version.clone();
        let platform = self.options.platform.clone();

        let (sender, receiver) = mpsc::channel::<std::result::Result<DownloadOutcome, String>>();
        std::thread::spawn({
            let driver_origin = endpoint_origin.clone();
            move || {
            let options = DownloadOptions {
                endpoint_origin: &driver_origin,
                app_version: &app_version,
                platform: &platform,
            };
            let transport = move |url: &str, stage: &str| {
                call_request(&request, url, stage)
            };
            let result = download_builtin_release(&options, &transport);
            let _ = sender.send(result);
            }
        });

        let outcome = match receiver.recv_timeout(Duration::from_millis(DOWNLOAD_BUDGET_MS)) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Budget spent: tell the host to cancel, then report the
                // timeout in the TS vocabulary. The driver thread finishes on
                // its own and drops the callback handle.
                if let Some(abort) = &self.abort {
                    let _ = abort.call(
                        endpoint_origin.clone(),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
                return Err(napi::Error::new(
                    Status::GenericFailure,
                    "ZCode Built-in client-config: timeout",
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(napi::Error::new(
                    Status::GenericFailure,
                    "the download driver stopped without answering",
                ));
            }
        };

        match outcome.map_err(|message| napi::Error::new(Status::GenericFailure, message))? {
            DownloadOutcome::None => Ok("null".to_string()),
            DownloadOutcome::Release(release) => {
                zcode_provider_config::schema::encode_builtin_release(&release)
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
                    .ok_or_else(|| {
                        napi::Error::new(
                            Status::GenericFailure,
                            "the downloaded release could not be re-encoded",
                        )
                    })
            }
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Invokes the host's request callback and waits for its answer. A rejected
/// promise is a transport failure, which the taxonomy reports as
/// `invalid response` — the same shape a thrown fetch produces in TS.
fn call_request(
    request: &RequestTsfn,
    url: &str,
    stage: &str,
) -> std::result::Result<DownloadResponse, DownloadRequestError> {
    let argument = serde_json::json!({ "url": url, "stage": stage }).to_string();
    let promise =
        match napi::bindgen_prelude::block_on(request.call_async(argument)) {
            Ok(promise) => promise,
            Err(error) => {
                return Err(DownloadRequestError::Transport(format!(
                    "the request callback could not be invoked: {}",
                    error.reason
                )));
            }
        };
    let answered = match napi::bindgen_prelude::block_on(promise) {
        Ok(answered) => answered,
        Err(error) => {
            return Err(DownloadRequestError::Transport(format!(
                "the request callback rejected: {}",
                error.reason
            )));
        }
    };
    if answered.trim().is_empty() {
        return Err(DownloadRequestError::Transport(
            "the request callback answered no response".to_string(),
        ));
    }
    parse_answer(&answered).map_err(DownloadRequestError::Transport)
}

fn parse_answer(answer: &str) -> std::result::Result<DownloadResponse, String> {
    #[derive(serde::Deserialize)]
    struct Answer {
        status: u16,
        #[serde(default)]
        body: String,
    }
    serde_json::from_str::<Answer>(answer)
        .map(|answer| DownloadResponse {
            status: answer.status,
            body: answer.body,
        })
        .map_err(|error| format!("the request callback answered an unusable response: {error}"))
}

/// `downloadZCodeBuiltinRelease(options, request, abort)`.
#[napi]
pub fn download_zcode_builtin_release(
    options_json: String,
    request: RequestTsfn,
    abort: Option<AbortTsfn>,
) -> Result<AsyncTask<DownloadTask>> {
    let options: DownloadOptionsJson = serde_json::from_str(&options_json)
        .map_err(|error| napi::Error::new(Status::InvalidArg, error.to_string()))?;
    Ok(AsyncTask::new(DownloadTask {
        options,
        request: Some(request),
        abort,
    }))
}
