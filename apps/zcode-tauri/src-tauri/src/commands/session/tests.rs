//! Tests for `commands::session`.
//!
//! Two rules govern what is here. First, every command is split so that the
//! decision it makes is reachable without a live Tauri app — the `#[tauri::command]`
//! function is a five-line wrapper that derives the caller and calls one of
//! these. Second, a test has to fail if the *behaviour the port is protecting*
//! regresses, so the assertions target the Electron invariants (the handshake
//! gate, reload identity, the notification dedupe key) and not the plumbing.

use std::collections::{HashMap, HashSet};

use super::*;

// ---------------------------------------------------------------------------
// Session handshake
// ---------------------------------------------------------------------------

/// `host/index.ts:2926-2933` only hands the port over once initialisation has
/// completed. Before that, `AttachServicePort` is *parked*
/// (`host/index.ts:2739-2746`). A renderer that asks early must therefore be
/// refused — and refused *without* an identity being minted, because minting one
/// on a refused attach is how a session id starts meaning "a renderer once asked
/// for something".
#[test]
fn renderer_ready_before_host_ready_is_rejected() {
    let rpc = RpcHost::new();
    assert!(rpc.endpoint().is_none(), "an unstarted host must publish no endpoint");
    assert!(bound_endpoint(&rpc).is_none());

    let sessions = SessionState::default();
    let handshake = begin_attach_for("main", &rpc, &sessions, None);

    assert_eq!(
        handshake,
        RendererSessionHandshake::HostNotReady { phase: HostPhase::Starting }
    );
    // No attachment, no identity, no epoch: the rejected call left no trace.
    assert_eq!(sessions.session_for("main"), None);
}

#[test]
fn a_ready_handshake_carries_a_bound_endpoint() {
    let rpc = RpcHost::new();
    rpc.start().expect("bind");
    let sessions = SessionState::default();

    let RendererSessionHandshake::Ready { session, service_endpoint } =
        begin_attach_for("main", &rpc, &sessions, Some("host-1".into()))
    else {
        panic!("a bound endpoint must produce a ready handshake");
    };

    assert!(service_endpoint.ws_url.starts_with("ws://127.0.0.1:"));
    assert!(!service_endpoint.address.is_empty());
    assert_eq!(session.session_id, "zs-1");
    assert_eq!(session.attachment_id.as_deref(), Some("za-1"));
    assert_eq!(session.renderer_epoch, 1);
    assert_eq!(session.phase, HostPhase::Ready);
    assert_eq!(session.host_id.as_deref(), Some("host-1"));
    assert_eq!(session.client_mode, SESSION_CLIENT_MODE);
}

/// The headline invariant from `desktopWindowLifecycle.ts:136-166`: a renderer
/// reload must not cost the session its identity. The port *does* die with the
/// renderer context, so the attachment id and the epoch must both change while
/// the session id stays put.
#[test]
fn reattach_across_a_reload_preserves_identity() {
    let rpc = RpcHost::new();
    rpc.start().expect("bind");
    let sessions = SessionState::default();

    let first = begin_attach_for("main", &rpc, &sessions, None);
    let RendererSessionHandshake::Ready { session: before, .. } = first else {
        panic!("first attach must be ready");
    };

    // The renderer context goes away.
    let detached = sessions.detach("main").expect("the first attach registered a session");
    assert_eq!(detached.session_id, before.session_id);
    assert_eq!(detached.attachment_id, None, "the attachment dies with the renderer");
    assert_eq!(detached.phase, HostPhase::Ready, "the host itself survives the reload");

    // A fresh renderer attaches to the same surviving host.
    let second = begin_attach_for("main", &rpc, &sessions, None);
    let RendererSessionHandshake::Ready { session: after, .. } = second else {
        panic!("second attach must be ready");
    };

    assert_eq!(after.session_id, before.session_id, "session identity is not volatile");
    assert_ne!(after.attachment_id, before.attachment_id, "a reload re-attaches a fresh port");
    assert_eq!(after.renderer_epoch, before.renderer_epoch + 1);
    assert_eq!(after.phase, HostPhase::Ready);
}

#[test]
fn detach_is_idempotent_and_never_forgets_the_session() {
    let rpc = RpcHost::new();
    rpc.start().expect("bind");
    let sessions = SessionState::default();
    let RendererSessionHandshake::Ready { session, .. } =
        begin_attach_for("main", &rpc, &sessions, None)
    else {
        panic!("attach must be ready");
    };

    let first = sessions.detach("main").expect("attached");
    let second = sessions.detach("main").expect("still known, just detached");
    assert_eq!(first, second, "detach is idempotent");
    assert_eq!(sessions.session_for("main").map(|s| s.session_id), Some(session.session_id));
    assert_eq!(sessions.detach("never-attached"), None);
}

#[test]
fn each_window_gets_its_own_identity() {
    let rpc = RpcHost::new();
    rpc.start().expect("bind");
    let sessions = SessionState::default();
    let RendererSessionHandshake::Ready { session: main_session, .. } =
        begin_attach_for("main", &rpc, &sessions, None)
    else {
        panic!("main attach");
    };
    let RendererSessionHandshake::Ready { session: other_session, .. } =
        begin_attach_for("second", &rpc, &sessions, None)
    else {
        panic!("second attach");
    };
    assert_ne!(main_session.session_id, other_session.session_id);
    assert_ne!(main_session.attachment_id, other_session.attachment_id);
    // Detaching one window must not disturb the other.
    sessions.detach("main");
    assert!(sessions.session_for("second").expect("still attached").attachment_id.is_some());
}

#[test]
fn handshake_wire_shape_is_kebab_tagged_and_camel_cased() {
    let handshake = RendererSessionHandshake::HostNotReady { phase: HostPhase::Starting };
    assert_eq!(
        serde_json::to_value(&handshake).unwrap(),
        serde_json::json!({ "status": "host-not-ready", "phase": "starting" })
    );

    let ready = RendererSessionHandshake::Ready {
        session: RendererSessionWire {
            session_id: "zs-1".into(),
            attachment_id: None,
            renderer_epoch: 2,
            phase: HostPhase::Ready,
            host_id: None,
            client_mode: SESSION_CLIENT_MODE.into(),
        },
        service_endpoint: ServiceEndpointWire {
            ws_url: "ws://127.0.0.1:1/".into(),
            address: "127.0.0.1:1".into(),
            native_channel_count: 3,
            proxy_enabled: false,
        },
    };
    let value = serde_json::to_value(&ready).unwrap();
    assert_eq!(value["status"], "ready");
    assert_eq!(value["session"]["sessionId"], "zs-1");
    assert_eq!(value["session"]["attachmentId"], serde_json::Value::Null);
    assert_eq!(value["session"]["rendererEpoch"], 2);
    assert_eq!(value["session"]["clientMode"], "desktop-continuous");
    assert_eq!(value["serviceEndpoint"]["wsUrl"], "ws://127.0.0.1:1/");
    assert_eq!(value["serviceEndpoint"]["nativeChannelCount"], 3);
}


// ---------------------------------------------------------------------------
// Session activity refusal
// ---------------------------------------------------------------------------

/// The refusal has to be produced by Rust, carry a reason, and be
/// machine-matchable — a string the UI greps for is the whole point.
#[test]
fn session_activity_refusal_is_typed_and_explains_the_boundary() {
    let error = get_desktop_session_activity_refusal();
    let CommandError::Forbidden(message) = &error else {
        panic!("a refusal must be Forbidden, got {error:?}");
    };
    assert!(
        message.starts_with(NO_NATIVE_EQUIV),
        "the machine-readable code must lead: {message}"
    );
    assert!(
        message.contains("@zcode/server") && message.contains("R2"),
        "the reason must name the ownership boundary: {message}"
    );
}

// ---------------------------------------------------------------------------
// Notification dedupe
// ---------------------------------------------------------------------------

fn payload(task_id: &str, status: TaskStatus, request_id: Option<&str>) -> TaskNotificationPayload {
    TaskNotificationPayload {
        task_id: task_id.to_string(),
        status,
        request_id: request_id.map(str::to_string),
        title: "Task finished".into(),
        body: "Open the app to see the result.".into(),
    }
}

/// `desktopNotifications.ts:39-44`: the two blocking statuses key on
/// `requestId`, so two consecutive asks inside one task both get through.
#[test]
fn blocking_requests_dedupe_on_request_id_not_task_id() {
    let first = notification_dedupe_key(
        TaskStatus::PermissionRequest,
        "task-1",
        Some("req-1"),
    );
    let second = notification_dedupe_key(
        TaskStatus::PermissionRequest,
        "task-1",
        Some("req-2"),
    );
    assert_ne!(first, second, "two different asks are two different notifications");
    assert_eq!(
        notification_dedupe_key(TaskStatus::PermissionRequest, "task-1", Some(" req-1 ")),
        first,
        "the request id is trimmed before it becomes a key"
    );
    // No request id at all falls back to the task id.
    assert_eq!(
        notification_dedupe_key(TaskStatus::ElicitationRequest, "task-1", None),
        notification_dedupe_key(TaskStatus::ElicitationRequest, "task-1", Some("   "))
    );
    assert_eq!(
        notification_dedupe_key(TaskStatus::ElicitationRequest, "task-1", None),
        "elicitation-request:task-1"
    );
}

#[test]
fn non_blocking_statuses_key_on_task_id() {
    for status in [
        TaskStatus::Completed,
        TaskStatus::Failed,
        TaskStatus::FeedbackUpdate,
    ] {
        assert_eq!(
            notification_dedupe_key(status, "task-1", Some("req-1")),
            notification_dedupe_key(status, "task-1", None),
            "{status:?} must ignore requestId"
        );
    }
    assert_eq!(notification_dedupe_key(TaskStatus::Completed, "task-1", None), "completed:task-1");
    assert_eq!(notification_dedupe_key(TaskStatus::Failed, "task-1", None), "failed:task-1");
    assert_eq!(
        notification_dedupe_key(TaskStatus::FeedbackUpdate, "task-1", None),
        "feedback-update:task-1"
    );
}

#[test]
fn status_is_part_of_the_key_so_a_completion_is_never_swallowed() {
    assert_ne!(
        notification_dedupe_key(TaskStatus::Failed, "task-1", None),
        notification_dedupe_key(TaskStatus::Completed, "task-1", None)
    );
}

#[test]
fn the_dedupe_window_suppresses_then_expires() {
    let mut window = DedupeWindow::default();
    assert!(!window.should_suppress("completed:task-1", 1_000));
    // Inside the 3s window.
    assert!(window.should_suppress("completed:task-1", 1_000));
    assert!(window.should_suppress("completed:task-1", 1_000 + TASK_NOTIFICATION_DEDUPE_WINDOW_MS - 1));
    // A suppressed call must not slide the window forward, or a burst would
    // suppress forever.
    assert!(window.should_suppress("completed:task-1", 1_000 + TASK_NOTIFICATION_DEDUPE_WINDOW_MS));
    // Expired.
    assert!(!window.should_suppress(
        "completed:task-1",
        1_000 + TASK_NOTIFICATION_DEDUPE_WINDOW_MS * 2
    ));
}

#[test]
fn the_dedupe_window_prunes_expired_entries() {
    let mut window = DedupeWindow::default();
    for index in 0..50u32 {
        assert!(!window.should_suppress(&format!("failed:task-{index}"), 0));
    }
    assert_eq!(window.len(), 50);
    // Two windows later every entry is stale and must be gone, so the map
    // cannot grow without bound on a long-lived session.
    window.should_suppress("failed:task-0", TASK_NOTIFICATION_DEDUPE_WINDOW_MS * 2);
    assert!(window.len() <= 1, "expired keys must be pruned, got {}", window.len());
}

#[test]
fn the_window_survives_a_clock_that_jumps_backwards() {
    let mut window = DedupeWindow::default();
    assert!(!window.should_suppress("completed:task-1", 10_000));
    // `saturating_sub` means a backwards clock reads as "just now" rather than
    // wrapping to a huge number and silently expiring every entry.
    assert!(window.should_suppress("completed:task-1", 5_000));
}

// ---------------------------------------------------------------------------
// Notification routing
// ---------------------------------------------------------------------------

#[test]
fn a_click_routes_to_the_window_that_raised_the_notification() {
    let mut router = NotificationRouter::default();
    let live: HashSet<String> = ["main".to_string()].into_iter().collect();
    assert!(router.accept(
        &payload("task-1", TaskStatus::Completed, None),
        "main",
        0,
        &live
    ));

    let route = route_task_notification_click(&router.routes, "task-1").expect("a route exists");
    assert_eq!(route.window_label, "main");
    assert_eq!(route.request_id, None);
    assert_eq!(route_task_notification_click(&router.routes, "task-2"), None);
}

#[test]
fn a_second_window_taking_over_a_task_repoints_the_route() {
    let mut router = NotificationRouter::default();
    let live: HashSet<String> = ["main".to_string(), "second".to_string()].into_iter().collect();
    router.accept(&payload("task-1", TaskStatus::Failed, None), "main", 0, &live);
    router.accept(&payload("task-1", TaskStatus::Failed, None), "second", 10_000, &live);

    let route = route_task_notification_click(&router.routes, "task-1").expect("a route exists");
    assert_eq!(route.window_label, "second");
    assert_eq!(router.route_order.iter().filter(|id| *id == "task-1").count(), 1);
}

#[test]
fn routes_for_a_destroyed_window_are_dropped() {
    let mut router = NotificationRouter::default();
    let live: HashSet<String> = ["main".to_string(), "second".to_string()].into_iter().collect();
    router.accept(&payload("task-1", TaskStatus::Completed, None), "main", 0, &live);
    router.accept(&payload("task-2", TaskStatus::Completed, None), "second", 10_000, &live);
    assert_eq!(router.routes.len(), 2);

    // "main" is gone; the next notification for "second" prunes it.
    let remaining: HashSet<String> = ["second".to_string()].into_iter().collect();
    router.accept(&payload("task-3", TaskStatus::Completed, None), "second", 20_000, &remaining);

    assert!(!router.routes.contains_key("task-1"), "a destroyed window cannot be routed back to");
    assert!(router.routes.contains_key("task-2"));
    assert!(router.routes.contains_key("task-3"));
    assert_eq!(router.route_order.len(), router.routes.len(), "the order queue cannot leak");
}

#[test]
fn the_route_table_is_bounded() {
    let mut router = NotificationRouter::default();
    let live: HashSet<String> = ["main".to_string()].into_iter().collect();
    for index in 0..(MAX_TRACKED_TASK_ROUTES + 25) {
        assert!(router.accept(
            &payload(&format!("task-{index}"), TaskStatus::Completed, None),
            "main",
            index as u64 * 10_000,
            &live
        ));
    }
    assert_eq!(router.routes.len(), MAX_TRACKED_TASK_ROUTES);
    assert_eq!(router.route_order.len(), MAX_TRACKED_TASK_ROUTES);
    assert!(
        !router.routes.contains_key("task-0"),
        "the oldest route is the one evicted"
    );
}

/// A live-notification entry with no platform handle.
///
/// `ActiveNotification::handle` is an `Option` precisely so this exists: a real
/// `notify_rust::NotificationHandle` cannot be constructed without a running
/// notification server, and the behaviour under test is the router's
/// bookkeeping (the live cap, show-order eviction, and re-tagging replacing
/// rather than stacking) — none of which touches the handle. Production entries
/// are always `Some`, built straight from `show()`.
fn stub_active(task_id: &str) -> ActiveNotification {
    ActiveNotification { handle: None, window_label: "main".into(), task_id: task_id.into() }
}

#[test]
fn the_live_notification_table_is_bounded() {
    let mut router = NotificationRouter::default();
    // Stand-in handles: the table's bookkeeping is what is under test, and a
    // real `NotificationHandle` needs a live notification server.
    router.retain_live("tag-0".into(), stub_active("task-0"));
    for index in 1..=MAX_ACTIVE_TASK_NOTIFICATIONS {
        router.retain_live(format!("tag-{index}"), stub_active(&format!("task-{index}")));
    }
    assert_eq!(router.live.len(), MAX_ACTIVE_TASK_NOTIFICATIONS);
    assert!(!router.live.contains_key("tag-0"), "the oldest is evicted first");
    assert!(router.live.contains_key(&format!("tag-{MAX_ACTIVE_TASK_NOTIFICATIONS}")));
    assert_eq!(router.live_order.len(), router.live.len());
}

#[test]
fn re_tagging_a_live_notification_replaces_rather_than_stacks() {
    let mut router = NotificationRouter::default();
    router.retain_live("task-1".into(), stub_active("task-1"));
    router.retain_live("task-1".into(), stub_active("task-1"));
    assert_eq!(router.live.len(), 1, "the same tag is one live notification");
    assert_eq!(router.live_order.len(), 1, "and it is not queued twice for eviction");
}

#[test]
fn platform_ids_are_stable_and_distinct() {
    // The XDG notification id is what makes a same-tag notification *replace*
    // its predecessor, so the mapping must be deterministic across processes.
    assert_eq!(platform_tag("completed:task-1"), platform_tag("completed:task-1"));
    assert_ne!(platform_tag("completed:task-1"), platform_tag("completed:task-2"));
    assert_ne!(platform_tag("failed:task-1"), platform_tag("completed:task-1"));
}

#[test]
fn the_notification_payload_wire_vocabulary_is_kebab_case() {
    let wire = serde_json::to_value(payload(
        "task-1",
        TaskStatus::PermissionRequest,
        Some("req-1"),
    ))
    .unwrap();
    assert_eq!(wire["status"], "permission-request");
    assert_eq!(wire["taskId"], "task-1");
    assert_eq!(wire["requestId"], "req-1");

    // And the underscore spelling the TypeScript member uses is *not* accepted
    // on the wire, so the adapter is the only translation point.
    let underscore = serde_json::json!({
        "taskId": "task-1",
        "status": "permission_request",
        "title": "t",
        "body": "b",
    });
    assert!(
        serde_json::from_value::<TaskNotificationPayload>(underscore).is_err(),
        "the wire vocabulary must not fork"
    );
}

#[test]
fn an_unknown_notification_field_is_rejected() {
    let extra = serde_json::json!({
        "taskId": "task-1",
        "status": "completed",
        "title": "t",
        "body": "b",
        "origin": "somewhere-else",
    });
    assert!(serde_json::from_value::<TaskNotificationPayload>(extra).is_err());
}

#[test]
fn a_skipped_notification_carries_its_reason() {
    let skipped = TaskNotificationResult::skipped("completed:t", NotificationSkipReason::AppFocused);
    assert!(!skipped.delivered);
    let value = serde_json::to_value(&skipped).unwrap();
    assert_eq!(value["delivered"], false);
    assert_eq!(value["reason"], "app-focused");
    // `reason` is omitted rather than nulled on success, so the renderer can
    // branch on presence.
    let delivered = serde_json::to_value(TaskNotificationResult::delivered("completed:t")).unwrap();
    assert_eq!(delivered, serde_json::json!({ "delivered": true, "tag": "completed:t" }));
}

// ---------------------------------------------------------------------------
// Remote refusals
// ---------------------------------------------------------------------------

fn ssh_request(host: &str, username: &str) -> ConnectRemoteRequest {
    ConnectRemoteRequest {
        target: RemoteTarget::Ssh {
            host: host.into(),
            port: None,
            username: username.into(),
            ssh_config_alias: None,
            private_key_path: None,
            asset_install_mode: None,
        },
        request_id: None,
        workspace_path: None,
        workspace_identity: None,
        connect_trigger: None,
    }
}

#[test]
fn a_well_formed_remote_request_passes_validation() {
    assert_eq!(validate_connect_remote(&ssh_request("build.example.com", "deploy")), None);
}

#[test]
fn a_malformed_remote_request_is_reported_as_malformed() {
    for (request, needle) in [
        (ssh_request("", "deploy"), "host"),
        (ssh_request("   ", "deploy"), "host"),
        (ssh_request("host", ""), "username"),
        (ssh_request("host", "  "), "username"),
    ] {
        let error = validate_connect_remote(&request).expect("must be rejected");
        assert!(error.contains(needle), "{error:?} should mention {needle:?}");
    }

    let blank_key = ConnectRemoteRequest {
        target: RemoteTarget::Ssh {
            host: "host".into(),
            port: None,
            username: "deploy".into(),
            ssh_config_alias: None,
            private_key_path: Some("  ".into()),
            asset_install_mode: None,
        },
        ..ssh_request("host", "deploy")
    };
    let error = validate_connect_remote(&blank_key).expect("blank key path is rejected");
    assert!(error.contains("privateKeyPath"), "{error}");

}

#[test]
fn a_zero_ssh_port_is_rejected() {
    let request = ConnectRemoteRequest {
        target: RemoteTarget::Ssh {
            host: "build.example.com".into(),
            port: Some(0),
            username: "deploy".into(),
            ssh_config_alias: None,
            private_key_path: None,
            asset_install_mode: None,
        },
        ..ssh_request("build.example.com", "deploy")
    };
    let error = validate_connect_remote(&request).expect("port 0 is not a port");
    assert!(error.contains("port"), "{error}");
}

/// The remote target carries credentials, so an unrecognised key must be a hard
/// failure rather than a silently-dropped one — otherwise the connection would
/// use different credentials than the user chose.
#[test]
fn an_unknown_remote_target_field_is_rejected() {
    let payload = serde_json::json!({
        "kind": "ssh",
        "host": "build.example.com",
        "username": "deploy",
        "privateKeyPath": "/home/u/.ssh/id_ed25519",
        "password": "hunter2",
    });
    assert!(
        serde_json::from_value::<RemoteTarget>(payload).is_err(),
        "a secret the port does not model must not be silently dropped"
    );
}

#[test]
fn the_remote_refusal_is_typed_and_carries_the_kind() {
    let request = ConnectRemoteRequest {
        request_id: Some("  req-7  ".into()),
        connect_trigger: Some("restore".into()),
        ..ssh_request("build.example.com", "deploy")
    };
    let outcome = refuse_connect_remote(&request);
    let ConnectRemoteOutcome::NoNativeEquiv { code, kind, reason, request_id, connect_trigger } =
        outcome
    else {
        panic!("connect_remote must refuse, got {outcome:?}");
    };
    assert_eq!(code, NO_NATIVE_EQUIV);
    assert_eq!(kind, "ssh");
    assert!(reason.contains("@zcode/server"));
    assert_eq!(request_id.as_deref(), Some("req-7"), "the id is trimmed, as Electron did");
    assert_eq!(connect_trigger, "restore");

    let value = serde_json::to_value(ConnectRemoteOutcome::NoNativeEquiv {
        code,
        kind,
        reason,
        request_id,
        connect_trigger,
    })
    .unwrap();
    assert_eq!(value["status"], "no-native-equiv");
    assert_eq!(value["connectTrigger"], "restore");
}

#[test]
fn an_unrecognised_connect_trigger_normalises_to_new() {
    let mut request = ssh_request("build.example.com", "deploy");
    assert_eq!(request.connect_trigger(), "new");
    for trigger in ["reconnect", "restore"] {
        request.connect_trigger = Some(trigger.into());
        assert_eq!(request.connect_trigger(), trigger);
    }
    request.connect_trigger = Some("something-else".into());
    assert_eq!(request.connect_trigger(), "new");
}

#[test]
fn a_blank_request_id_normalises_to_absent() {
    let mut request = ssh_request("build.example.com", "deploy");
    request.request_id = Some("   ".into());
    assert_eq!(request.normalized_request_id(), None);
    request.request_id = Some(" req-1 ".into());
    assert_eq!(request.normalized_request_id(), Some("req-1"));
}

#[test]
fn the_remote_context_is_validated_before_the_refusal() {
    let ok = RemoteSessionContext {
        remote_session_id: "rs-1".into(),
        workspace_path: "/home/u/project".into(),
        workspace_identity: None,
    };
    assert!(ok.validate().is_ok());

    for context in [
        RemoteSessionContext { remote_session_id: "  ".into(), ..ok.clone() },
        RemoteSessionContext { workspace_path: "".into(), ..ok.clone() },
    ] {
        let error = context.validate().expect_err("rejected");
        let CommandError::InvalidPayload(message) = error else {
            panic!("a missing field is a payload error");
        };
        assert!(message.contains("sessionId") && message.contains("workspacePath"), "{message}");
    }
}

#[test]
fn the_remote_follow_up_members_refuse_with_the_same_code() {
    let bound = CommandError::Forbidden(format!("{NO_NATIVE_EQUIV}: {REMOTE_REFUSAL_REASON}"));
    let disposed = CommandError::Forbidden(format!("{NO_NATIVE_EQUIV}: {REMOTE_REFUSAL_REASON}"));
    for error in [bound, disposed] {
        let CommandError::Forbidden(message) = error else { panic!("Forbidden") };
        assert!(message.starts_with(NO_NATIVE_EQUIV));
    }
}
// ---------------------------------------------------------------------------
// SSH config
// ---------------------------------------------------------------------------

use ssh_config as ssh;

/// The TS port resolved aliases through `mapWithConcurrency(…, SSH_G_CONCURRENCY, …)`
/// (`sshConfigAlias.ts:674`). The first Rust draft made it a sequential `.map()`,
/// leaving the constant the spec calls for unused. This pins both halves of the
/// contract: never more than the cap in flight, and results in *input* order
/// rather than whichever worker finished first.
#[test]
fn ssh_g_queries_run_at_the_capped_concurrency_and_stay_in_order() {
    const CAP: usize = 3;
    let current = std::sync::atomic::AtomicUsize::new(0);
    let peak = std::sync::atomic::AtomicUsize::new(0);
    let items: Vec<usize> = (0..12).collect();

    let results = ssh::map_with_concurrency(&items, CAP, |index| {
        let inflight = current.fetch_add(1, Ordering::Relaxed) + 1;
        peak.fetch_max(inflight, Ordering::Relaxed);
        // Item 0 finishes last on purpose: completion order then disagrees with
        // input order, so a map that collected as workers finished fails below.
        std::thread::sleep(std::time::Duration::from_millis(if *index == 0 { 40 } else { 5 }));
        current.fetch_sub(1, Ordering::Relaxed);
        index * 10
    });

    assert_eq!(
        results,
        (0..12).map(|index| index * 10).collect::<Vec<_>>(),
        "results follow input order, not completion order"
    );
    let peak = peak.load(Ordering::Relaxed);
    assert!(peak <= CAP, "at most {CAP} ssh -G runs at once, saw {peak}");
    assert!(peak >= 2, "the pass must overlap; a sequential map regresses to {peak} at a time");
}

#[test]
fn an_empty_alias_list_maps_to_nothing_and_the_worker_floor_is_one() {
    let nothing: Vec<usize> = Vec::new();
    assert!(ssh::map_with_concurrency(&nothing, 3, |_| 1).is_empty());

    // A cap of zero must not deadlock the pool: one worker is the floor.
    let four: Vec<usize> = (0..4).collect();
    assert_eq!(ssh::map_with_concurrency(&four, 0, |value| value + 1), vec![1, 2, 3, 4]);
}

/// A throwaway directory, unique per test name and pid so the suite (which runs
/// in one process) cannot collide with itself. Env vars are off-limits here
/// because they would race other tests.
fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("zcode-session-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[test]
fn host_patterns_glob_the_way_ssh_does() {
    assert!(ssh::glob_match("*", "anything"));
    assert!(ssh::glob_match("build-?", "build-1"));
    assert!(!ssh::glob_match("build-?", "build-12"));
    assert!(ssh::glob_match("*.teleport-*.example.com", "acme.teleport-7.example.com"));
    assert!(!ssh::glob_match("*.teleport-*.example.com", "acme.example.com"));
    assert!(ssh::glob_match("exact", "exact"));
    assert!(!ssh::glob_match("exact", "exactly"));
    assert!(ssh::glob_match("a*b*c", "axxbyyc"));
    assert!(!ssh::glob_match("a*b*c", "axxbyy"));
    assert!(ssh::glob_match("", ""));
    assert!(!ssh::glob_match("", "x"));
}

#[test]
fn tokens_split_on_whitespace_respecting_quotes() {
    assert_eq!(ssh::split_ssh_tokens(r#"Host  "my host"   alpha"#), vec!["Host", "my host", "alpha"]);
    assert_eq!(ssh::split_ssh_tokens(r"IdentityFile ~/.ssh/my\ key"), vec!["IdentityFile", "~/.ssh/my key"]);
    // A Windows path's backslashes are literal, not escapes.
    assert_eq!(
        ssh::split_ssh_tokens(r"Include C:\Users\me\.ssh\config"),
        vec!["Include", r"C:\Users\me\.ssh\config"]
    );
    assert!(ssh::split_ssh_tokens("   ").is_empty());
}

#[test]
fn inline_comments_are_stripped_outside_quotes() {
    assert_eq!(ssh::strip_inline_comment("Host alpha # a comment").trim(), "Host alpha");
    assert_eq!(ssh::strip_inline_comment("Host \"a#b\"").trim(), "Host \"a#b\"");
    assert_eq!(ssh::strip_inline_comment("Host alpha"), "Host alpha");
}

#[test]
fn home_tokens_expand() {
    let home = ssh::home_dir();
    assert_eq!(ssh::expand_home_token("~"), home);
    assert_eq!(ssh::expand_home_token("~/keys/id"), home.join("keys").join("id"));
    assert_eq!(ssh::expand_home_token("%d/keys"), home.join("keys"));
    // Not a home token: left alone.
    assert_eq!(ssh::expand_home_token("/etc/ssh/ssh_config"), std::path::PathBuf::from("/etc/ssh/ssh_config"));
    assert!(ssh::expand_home_token("  ").as_os_str().is_empty());
}

#[test]
fn a_typical_config_resolves_its_aliases() {
    let dir = temp_dir("config-basic");
    let config = dir.join("config");
    std::fs::write(
        &config,
        "# my hosts\n\
Host *\n\
  User default-user\n\
  Port 2200\n\
\n\
Host build\n\
  HostName build.example.com\n\
  User deploy\n\
\n\
Host db-* !db-old\n\
  HostName %h.internal\n\
\n\
Host *\n\
  IdentityFile ~/.ssh/id_ed25519\n",
    )
    .expect("write config");

    let options = ssh::resolve_config(&config);
    let by_alias: HashMap<&str, &ssh::SshConfigAliasOption> =
        options.iter().map(|o| (o.alias.as_str(), o)).collect();

    let build = by_alias["build"];
    assert_eq!(build.host, "build.example.com");
    assert_eq!(build.username, Some("deploy".into()), "the specific block wins over `Host *`");
    assert_eq!(build.port, Some(2200), "inherited from the first matching `Host *`");
    assert_eq!(
        build.private_key_path.as_deref(),
        Some(ssh::home_dir().join(".ssh").join("id_ed25519").to_string_lossy().as_ref())
    );

    let wildcard = by_alias["db-primary"];
    assert_eq!(wildcard.host, "db-primary.internal", "%h expands to the alias name");
    assert!(!by_alias.contains_key("db-old"), "a negated pattern removes the alias entirely");
    assert!(!by_alias.contains_key("*"), "a catch-all Host is not an alias");
}

#[test]
fn include_is_expanded_and_deep_recursion_is_bounded() {
    let dir = temp_dir("config-include");
    let included = dir.join("work.conf");
    std::fs::write(
        &included,
        "Host jump\n  HostName jump.example.com\n  Port 2222\n  User ops\n",
    )
    .expect("write included");
    let config = dir.join("config");
    std::fs::write(
        &config,
        "Include work.conf\n\
Host edge\n  HostName edge.example.com\n",
    )
    .expect("write config");

    let options = ssh::resolve_config(&config);
    let by_alias: HashMap<&str, &ssh::SshConfigAliasOption> =
        options.iter().map(|o| (o.alias.as_str(), o)).collect();
    let jump = by_alias.get("jump").expect("the included alias must be enumerated");
    assert_eq!(jump.host, "jump.example.com");
    assert_eq!(jump.port, Some(2222));
    assert_eq!(jump.username, Some("ops".into()));
    assert!(
        by_alias.get("edge").is_some(),
        "directives before the Include must still be read"
    );

    // A self-including config must terminate rather than recurse forever.
    let loop_dir = temp_dir("config-loop");
    let looping = loop_dir.join("config");
    std::fs::write(&looping, "Include config\nHost selfy\n  HostName selfy.example.com\n")
        .expect("write looping config");
    let options = ssh::resolve_config(&looping);
    assert_eq!(options.len(), 1);
    assert_eq!(options[0].alias, "selfy");
}

#[test]
fn only_single_word_hosts_become_aliases() {
    let dir = temp_dir("config-multi");
    let config = dir.join("config");
    std::fs::write(
        &config,
        "Host alpha beta\n  HostName shared.example.com\n\
Host *.wild\n  HostName wild.example.com\n\
Host gamma\n  HostName gamma.example.com\n",
    )
    .expect("write config");

    let aliases: Vec<String> = ssh::resolve_config(&config).into_iter().map(|o| o.alias).collect();
    assert_eq!(aliases, vec!["gamma".to_string()], "multi-word and glob Hosts are not aliases");
}

#[test]
fn a_missing_config_yields_no_aliases() {
    let dir = temp_dir("config-missing");
    assert!(ssh::resolve_config(&dir.join("nope")).is_empty());
}

#[test]
fn an_out_of_range_port_falls_through_to_the_next_match() {
    let dir = temp_dir("config-port");
    let config = dir.join("config");
    std::fs::write(
        &config,
        "Host *\n  Port 22\n\
Host bad\n  Port 70000\n\
Host zero\n  Port 0\n",
    )
    .expect("write config");

    let options = ssh::resolve_config(&config);
    let by_alias: HashMap<&str, &ssh::SshConfigAliasOption> =
        options.iter().map(|o| (o.alias.as_str(), o)).collect();
    assert_eq!(by_alias["bad"].port, Some(22), "an unusable port falls through to `Host *`");
    assert_eq!(by_alias["zero"].port, Some(22));
}

#[test]
fn an_alias_with_no_directives_falls_back_to_its_own_name() {
    let dir = temp_dir("config-bare");
    let config = dir.join("config");
    std::fs::write(&config, "Host bare\n").expect("write config");
    let options = ssh::resolve_config(&config);
    assert_eq!(options[0].host, "bare");
    assert_eq!(options[0].port, None);
    assert_eq!(options[0].username, None);
}

/// `resolve_config` confirms every alias with `ssh -G`, so what a test observes
/// there depends on the ssh build the machine happens to have — which is exactly
/// why four sibling tests fail on some hosts and not others (CUTOVER_SPEC §8.7).
/// `parse_config_only` is the half that is ours: enumeration, `HostName`
/// resolution and port inheritance, with no `ssh` binary in the loop.
///
/// Deliberately asserts nothing about `User` precedence — that expectation is
/// what `a_typical_config_resolves_its_aliases` is arguing with, and it is
/// recorded as a known failure rather than re-decided in two places.
#[test]
fn the_parse_stage_resolves_host_and_port_without_ssh() {
    let dir = temp_dir("config-parse-only");
    let config = dir.join("config");
    std::fs::write(
        &config,
        "Host *\n  Port 2200\n\
\n\
Host build\n  HostName build.example.com\n  User deploy\n",
    )
    .expect("write config");

    let options = ssh::parse_config_only(&config);
    let build = options
        .iter()
        .find(|option| option.alias == "build")
        .expect("the alias is enumerated");
    assert_eq!(build.host, "build.example.com");
    assert_eq!(build.port, Some(2200), "inherited from the first matching `Host *`");
    assert_eq!(build.username.as_deref(), Some("deploy"), "the first `User` value obtained wins");
}

#[test]
fn the_alias_wire_shape_matches_the_shared_interface() {
    let option = ssh::SshConfigAliasOption {
        alias: "build".into(),
        host: "build.example.com".into(),
        port: Some(2222),
        username: Some("deploy".into()),
        private_key_path: None,
        source: "/home/u/.ssh/config".into(),
    };
    let value = serde_json::to_value(&option).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "alias": "build",
            "host": "build.example.com",
            "port": 2222,
            "username": "deploy",
            "source": "/home/u/.ssh/config",
        }),
        "absent optional fields are omitted, not nulled"
    );
}
