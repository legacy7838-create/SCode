//! Frozen session-store migration SQL (the Agent CLI `~/.zcode/cli/db/db.sqlite` schema),
//! byte-for-byte mirror of `apps/zcode-cli/.../session-store/migrations.ts` + its three JS-generated
//! fragments (0020/0021/0022). The ledger checksum is `sha256(sql.trim())` exactly as the TS
//! `migration-runner.ts` computes it, so `run_session_migrations` can adopt/verify a DB the JS runner
//! already migrated. These strings are FROZEN: any edit changes the checksum and would make the
//! runner reject an existing DB — `checksum_matches_live_ledger` guards against transcription drift.
//!
//! Trim parity: every SQL string here has ASCII-whitespace trim boundaries, so Rust's `str::trim`
//! and JS's `String.prototype.trim` agree at the ends; the checksum-fixture test asserts full parity.

use sha2::{Digest, Sha256};

/// One frozen migration: stable id, the `app_version` recorded in the ledger, and the exact SQL.
pub struct SessionMigration {
    pub id: &'static str,
    pub app_version: &'static str,
    pub sql: &'static str,
}

/// The ordered migration list, applied inside a single `BEGIN IMMEDIATE` transaction.
pub static SESSION_MIGRATIONS: &[SessionMigration] = &[
    SessionMigration {
        id: "0001_base_session_store",
        app_version: "0.2.0",
        sql: r##"
      create table if not exists session (
        id text primary key,
        project_id text not null,
        workspace_id text,
        parent_id text,
        slug text not null,
        directory text not null,
        path text,
        title text not null,
        version text not null,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        revert text,
        permission text,
        time_created integer not null,
        time_updated integer not null,
        time_compacting integer,
        time_archived integer
      );

      create index if not exists session_project_idx on session(project_id);
      create index if not exists session_workspace_idx on session(workspace_id);
      create index if not exists session_parent_idx on session(parent_id);

      create table if not exists message (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create index if not exists message_session_time_created_id_idx
        on message(session_id, time_created, id);

      create table if not exists part (
        id text primary key,
        message_id text not null references message(id) on delete cascade,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create index if not exists part_message_id_id_idx on part(message_id, id);
      create index if not exists part_session_idx on part(session_id);

      create table if not exists todo (
        session_id text not null references session(id) on delete cascade,
        content text not null,
        status text not null,
        priority text not null,
        position integer not null,
        time_created integer not null,
        time_updated integer not null,
        primary key(session_id, position)
      );

      create index if not exists todo_session_idx on todo(session_id);

      create table if not exists session_entry (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        type text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create index if not exists session_entry_session_idx on session_entry(session_id);
      create index if not exists session_entry_session_type_idx on session_entry(session_id, type);
      create index if not exists session_entry_time_created_idx on session_entry(time_created);

      create table if not exists permission (
        project_id text primary key,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create table if not exists input_history (
        id text primary key,
        project_id text not null,
        session_id text,
        text text not null,
        kind text not null,
        time_created integer not null
      );

      create index if not exists input_history_project_time_idx
        on input_history(project_id, time_created desc, id desc);
      create index if not exists input_history_time_idx
        on input_history(time_created desc, id desc);
    "##,
    },
    SessionMigration {
        id: "0002_local_setting",
        app_version: "0.2.0",
        sql: r##"
      create table if not exists local_setting (
        scope text not null,
        scope_id text not null,
        namespace text not null,
        key text not null,
        value text not null,
        schema_version integer not null,
        time_created integer not null,
        time_updated integer not null,
        primary key(scope, scope_id, namespace, key)
      );

      create index if not exists local_setting_scope_idx
        on local_setting(scope, scope_id);

      create index if not exists local_setting_namespace_key_idx
        on local_setting(namespace, key);
    "##,
    },
    SessionMigration {
        id: "0003_backfill_permission_local_setting",
        app_version: "0.2.0",
        sql: r##"
      insert or ignore into local_setting (
        scope,
        scope_id,
        namespace,
        key,
        value,
        schema_version,
        time_created,
        time_updated
      )
      select
        'project',
        project_id,
        'permission',
        'ruleset',
        data,
        1,
        time_created,
        time_updated
      from permission
      where data is not null;
    "##,
    },
    SessionMigration {
        id: "0004_session_target",
        app_version: "0.7.0",
        sql: r##"
      create table if not exists session_target (
        session_id text primary key references session(id) on delete cascade,
        target_id text not null,
        objective text not null,
        status text not null check(status in ('active', 'paused', 'complete')),
        time_created integer not null,
        time_updated integer not null
      );
    "##,
    },
    SessionMigration {
        id: "0005_session_target_accounting",
        app_version: "0.7.0",
        sql: r##"
      create table if not exists session_target_next (
        session_id text primary key references session(id) on delete cascade,
        target_id text not null,
        objective text not null,
        status text not null check(status in ('active', 'paused', 'budget_limited', 'complete')),
        token_budget integer,
        tokens_used integer not null default 0,
        time_used_seconds integer not null default 0,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_target_next (
        session_id,
        target_id,
        objective,
        status,
        token_budget,
        tokens_used,
        time_used_seconds,
        time_created,
        time_updated
      )
      select
        session_id,
        target_id,
        objective,
        status,
        null,
        0,
        0,
        time_created,
        time_updated
      from session_target;

      drop table session_target;
      alter table session_target_next rename to session_target;
    "##,
    },
    SessionMigration {
        id: "0006_input_history_attachments",
        app_version: "0.11.0",
        sql: r##"
      alter table input_history add column attachments text;
    "##,
    },
    SessionMigration {
        id: "0007_workflow_script_runtime",
        app_version: "0.13.0",
        sql: r##"
      alter table session add column task_type text not null default 'interactive';

      create index if not exists session_task_type_idx on session(task_type);

      create table if not exists workflow_definition (
        id text primary key,
        name text not null,
        source text not null check(source in ('builtin', 'user')),
        trusted integer not null default 0 check(trusted in (0, 1)),
        enabled integer not null default 1 check(enabled in (0, 1)),
        script_path text,
        script_hash text not null,
        meta_json text not null,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists workflow_definition_source_idx
        on workflow_definition(source, enabled);

      create table if not exists workflow_run (
        id text primary key,
        definition_id text,
        name text not null,
        kind text not null default 'script',
        parent_session_id text references session(id) on delete set null,
        cwd text not null,
        script_path text,
        script_hash text not null,
        args_json text,
        args_hash text,
        status text not null check(status in (
          'pending',
          'running',
          'paused',
          'completed',
          'failed',
          'cancelled'
        )),
        current_phase text,
        budget_total integer,
        budget_spent integer not null default 0,
        stats_json text,
        failure_json text,
        time_created integer not null,
        time_started integer,
        time_updated integer not null,
        time_completed integer
      );

      create index if not exists workflow_run_parent_session_idx
        on workflow_run(parent_session_id);
      create index if not exists workflow_run_cwd_status_idx
        on workflow_run(cwd, status, time_updated desc);
      create index if not exists workflow_run_definition_idx
        on workflow_run(definition_id);

      create table if not exists workflow_activity (
        id text primary key,
        run_id text not null references workflow_run(id) on delete cascade,
        parent_activity_id text,
        call_index integer not null,
        call_path text not null,
        attempt integer not null default 1,
        type text not null,
        phase text,
        label text,
        input_hash text not null,
        prompt text,
        opts_json text,
        status text not null check(status in (
          'queued',
          'running',
          'completed',
          'failed',
          'skipped',
          'cancelled',
          'cached',
          'lost'
        )),
        child_session_id text references session(id) on delete set null,
        result_json text,
        error_json text,
        time_created integer not null,
        time_started integer,
        time_updated integer not null,
        time_completed integer,
        unique(run_id, call_path, attempt)
      );

      create index if not exists workflow_activity_run_status_idx
        on workflow_activity(run_id, status, call_index);
      create index if not exists workflow_activity_child_session_idx
        on workflow_activity(child_session_id);

      create table if not exists workflow_event (
        id text primary key,
        run_id text not null references workflow_run(id) on delete cascade,
        sequence integer not null,
        type text not null,
        phase text,
        activity_id text references workflow_activity(id) on delete set null,
        payload_json text,
        time_created integer not null,
        unique(run_id, sequence)
      );

      create index if not exists workflow_event_run_sequence_idx
        on workflow_event(run_id, sequence);

      create table if not exists session_task_link (
        id text primary key,
        root_workflow_run_id text references workflow_run(id) on delete cascade,
        parent_link_id text references session_task_link(id) on delete cascade,
        activity_id text references workflow_activity(id) on delete set null,
        parent_session_id text references session(id) on delete set null,
        child_session_id text not null references session(id) on delete cascade,
        role text not null,
        depth integer not null default 0,
        path text not null,
        phase text,
        label text,
        agent_type text,
        model text,
        status text not null,
        time_created integer not null,
        time_updated integer not null,
        unique(child_session_id)
      );

      create index if not exists session_task_link_root_workflow_idx
        on session_task_link(root_workflow_run_id, depth, path);
      create index if not exists session_task_link_parent_idx
        on session_task_link(parent_link_id);
      create index if not exists session_task_link_activity_idx
        on session_task_link(activity_id);
    "##,
    },
    SessionMigration {
        id: "0008_workflow_definition_scope",
        app_version: "0.13.0",
        sql: r##"
      alter table workflow_definition
        add column scope text not null default 'explicit'
        check(scope in ('builtin', 'explicit', 'project', 'user'));
    "##,
    },
    SessionMigration {
        id: "0009_session_title_metadata",
        app_version: "0.14.0",
        sql: r##"
      alter table session
        add column title_source text not null default 'first_input'
        check(title_source in ('default', 'first_input', 'generated', 'custom'));

      alter table session
        add column title_message_id text;

      alter table session
        add column time_title_updated integer;
    "##,
    },
    SessionMigration {
        id: "0010_usage_observability",
        app_version: "0.15.0",
        sql: r##"
      create table if not exists model_usage (
        id text primary key,
        logical_request_id text not null,
        attempt_index integer not null default 0,
        session_id text not null references session(id) on delete cascade,
        turn_id text,
        trace_id text,
        span_id text,
        assistant_message_id text,
        parent_user_message_id text,
        query_source text not null,
        provider_id text not null,
        model_id text not null,
        variant text,
        agent text,
        mode text,
        task_type text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_token_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_token_ms integer,
        finish_reason text,
        tool_call_count integer not null default 0,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_creation_input_tokens integer not null default 0,
        cache_read_input_tokens integer not null default 0,
        provider_total_tokens integer,
        computed_total_tokens integer not null default 0,
        retry_count integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
        error_type text,
        error_code text,
        error_message text,
        raw_usage_json text,
        provider_metadata_json text
      );

      create index if not exists model_usage_started_model_idx
        on model_usage(started_at, provider_id, model_id);
      create index if not exists model_usage_session_turn_idx
        on model_usage(session_id, turn_id);
      create index if not exists model_usage_trace_idx
        on model_usage(trace_id);
      create index if not exists model_usage_query_source_idx
        on model_usage(query_source);

      create table if not exists turn_usage (
        session_id text not null references session(id) on delete cascade,
        turn_id text not null,
        trace_id text,
        user_message_id text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_model_start_at integer,
        first_token_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_token_ms integer,
        model_request_count integer not null default 0,
        model_retry_count integer not null default 0,
        tool_call_count integer not null default 0,
        tool_error_count integer not null default 0,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_creation_input_tokens integer not null default 0,
        cache_read_input_tokens integer not null default 0,
        computed_total_tokens integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
        error_type text,
        error_code text,
        primary key(session_id, turn_id)
      );

      create index if not exists turn_usage_started_idx
        on turn_usage(started_at);

      create table if not exists tool_usage (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        turn_id text,
        trace_id text,
        tool_call_id text not null,
        tool_name text not null,
        side_effect_scope text,
        read_only integer check(read_only in (0, 1)),
        destructive integer check(destructive in (0, 1)),
        approval_status text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_output_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_output_ms integer,
        exit_code integer,
        output_bytes integer not null default 0,
        stdout_bytes integer not null default 0,
        stderr_bytes integer not null default 0,
        truncated integer not null default 0 check(truncated in (0, 1)),
        retry_count integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        error_type text,
        error_code text,
        error_message text
      );

      create unique index if not exists tool_usage_session_tool_call_idx
        on tool_usage(session_id, tool_call_id);
      create index if not exists tool_usage_started_tool_idx
        on tool_usage(started_at, tool_name);
      create index if not exists tool_usage_session_turn_idx
        on tool_usage(session_id, turn_id);
    "##,
    },
    SessionMigration {
        id: "0011_session_target_summary_title",
        app_version: "0.15.0",
        sql: r##"
      alter table session_target add column summary_title text;
    "##,
    },
    SessionMigration {
        id: "0012_session_trace_id",
        app_version: "0.15.0",
        sql: r##"
      alter table session add column trace_id text;

      create index if not exists session_trace_idx on session(trace_id);
    "##,
    },
    SessionMigration {
        id: "0013_session_target_active_run_accounting",
        app_version: "0.15.0",
        sql: r##"
      alter table session_target add column active_input_id text;
      alter table session_target add column active_run_started_at integer;
      alter table session_target add column active_run_last_seen_at integer;
    "##,
    },
    SessionMigration {
        id: "0014_message_part_sequence",
        app_version: "0.15.0",
        sql: r##"
      alter table message add column sequence integer;
      alter table part add column sequence integer;

      with ordered_message as (
        select
          id,
          row_number() over (
            partition by session_id
            order by time_created, rowid
          ) - 1 as stable_sequence
        from message
      )
      update message
      set sequence = (
        select stable_sequence
        from ordered_message
        where ordered_message.id = message.id
      )
      where sequence is null;

      with ordered_part as (
        select
          id,
          row_number() over (
            partition by message_id
            order by time_created, rowid
          ) - 1 as stable_sequence
        from part
      )
      update part
      set sequence = (
        select stable_sequence
        from ordered_part
        where ordered_part.id = part.id
      )
      where sequence is null;

      create index if not exists message_session_sequence_idx
        on message(session_id, sequence, time_created, id);

      create index if not exists part_message_sequence_idx
        on part(message_id, sequence, time_created, id);

      create index if not exists part_session_message_sequence_idx
        on part(session_id, message_id, sequence);
    "##,
    },
    SessionMigration {
        id: "0015_message_part_sequence_backfill_and_guard",
        app_version: "0.15.2",
        sql: r##"
      with session_max as (
        select session_id, coalesce(max(sequence), -1) as max_sequence
        from message
        group by session_id
      ),
      ordered_null_message as (
        select
          m.id as id,
          sm.max_sequence + row_number() over (
            partition by m.session_id
            order by m.time_created, m.rowid
          ) as stable_sequence
        from message m
        join session_max sm on sm.session_id = m.session_id
        where m.sequence is null
      )
      update message
      set sequence = (
        select stable_sequence
        from ordered_null_message
        where ordered_null_message.id = message.id
      )
      where sequence is null;

      with message_max as (
        select message_id, coalesce(max(sequence), -1) as max_sequence
        from part
        group by message_id
      ),
      ordered_null_part as (
        select
          p.id as id,
          mm.max_sequence + row_number() over (
            partition by p.message_id
            order by p.time_created, p.rowid
          ) as stable_sequence
        from part p
        join message_max mm on mm.message_id = p.message_id
        where p.sequence is null
      )
      update part
      set sequence = (
        select stable_sequence
        from ordered_null_part
        where ordered_null_part.id = part.id
      )
      where sequence is null;

      create trigger if not exists message_sequence_autofill
      after insert on message
      when new.sequence is null
      begin
        update message
        set sequence = (
          select coalesce(max(sequence), -1) + 1
          from message
          where session_id = new.session_id
        )
        where id = new.id;
      end;

      create trigger if not exists part_sequence_autofill
      after insert on part
      when new.sequence is null
      begin
        update part
        set sequence = (
          select coalesce(max(sequence), -1) + 1
          from part
          where message_id = new.message_id
        )
        where id = new.id;
      end;
    "##,
    },
    SessionMigration {
        id: "0016_session_input_ledger",
        app_version: "0.15.2",
        sql: r##"
      create table if not exists session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index if not exists session_input_session_status_idx
        on session_input(session_id, status);
    "##,
    },
    SessionMigration {
        id: "0017_session_input_start_now_delivery",
        app_version: "0.15.2",
        sql: r##"
      alter table session_input rename to session_input_before_start_now;

      create table session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('startNow', 'guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_input (
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      )
      select
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      from session_input_before_start_now;

      drop table session_input_before_start_now;

      create index session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index session_input_session_status_idx
        on session_input(session_id, status);
    "##,
    },
    SessionMigration {
        id: "0018_session_input_failed_status",
        app_version: "0.15.2",
        sql: r##"
      alter table session_input rename to session_input_before_failed_status;

      create table session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('startNow', 'guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded', 'failed')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_input (
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      )
      select
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      from session_input_before_failed_status;

      drop table session_input_before_failed_status;

      create index session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index session_input_session_status_idx
        on session_input(session_id, status);
    "##,
    },
    SessionMigration {
        id: "0019_dwf_journal",
        app_version: "0.16.5",
        sql: r##"
      create table if not exists dwf_run (
        id text primary key,
        parent_session_id text,
        cwd text,
        name text,
        script_text text,
        script_hash text,
        args_json text,
        tool_call_id text,
        resumed_from text,
        caps_max_concurrency integer not null,
        spent_tokens integer not null default 0,
        status text not null check(status in (
          'pending',
          'running',
          'completed',
          'failed',
          'cancelled'
        )),
        result_json text,
        failure_json text,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists dwf_run_cwd_idx on dwf_run(cwd, time_updated);

      create table if not exists dwf_actor (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        site_id text not null,
        ordinal integer not null,
        name text,
        persona_json text,
        resolved_model text,
        session_id text,
        time_created integer not null,
        time_updated integer not null,
        unique(run_id, site_id, ordinal)
      );

      create index if not exists dwf_actor_run_idx on dwf_actor(run_id);

      create table if not exists dwf_node (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        site_id text not null,
        ordinal integer not null,
        kind text not null check(kind in ('ask', 'world-read', 'world-run', 'report', 'artifact')),
        actor_site_id text,
        actor_ordinal integer,
        actor_seq integer,
        input_hash text not null,
        input_json text,
        status text not null check(status in ('running', 'completed', 'failed')),
        result_json text,
        error_json text,
        stats_json text,
        message_boundary integer,
        artifact_id text,
        time_created integer not null,
        time_updated integer not null,
        unique(run_id, site_id, ordinal)
      );

      create index if not exists dwf_node_run_idx on dwf_node(run_id);
      create index if not exists dwf_node_artifact_idx on dwf_node(run_id, artifact_id);

      create table if not exists dwf_event (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        sequence integer not null,
        type text not null,
        payload_json text not null,
        time_created integer not null,
        unique(run_id, sequence)
      );

      create index if not exists dwf_event_artifact_idx
        on dwf_event(run_id, json_extract(payload_json, '$.artifactId'), sequence);
    "##,
    },
    SessionMigration {
        id: "0020_provider_model_selection",
        app_version: "0.16.5",
        sql: r##"
  -- 无 entry 时沿用既有最后一个明确消息来源规则；不能越过损坏/明确空选择找更早的值。
  with ranked as (
    select message.*, row_number() over (
      partition by session_id order by sequence desc, time_created desc, rowid desc
    ) as rank
    from message
    where json_valid(data) and json_type(data) = 'object'
      and ((json_extract(data, '$.role') = 'user' and (json_type(data, '$.model') is not null or json_type(data, '$.modelSelection') is not null))
        or (json_extract(data, '$.role') = 'assistant' and (json_type(data, '$.providerID') is not null or json_type(data, '$.modelID') is not null
          or json_type(data, '$.providerId') is not null or json_type(data, '$.modelId') is not null or json_type(data, '$.reasoningLevel') is not null)))
      and not exists (select 1 from session_entry e where e.session_id = message.session_id and e.type = 'runtime/model_selection')
  ), candidates as (
    select *, case
  when json_extract(data, '$.role') = 'user' then
    case when json_type(data, '$.modelSelection') is not null
      then case when substr(json_extract(data, '$.modelSelection.providerId'), 1, 8) = 'builtin:'
        then case when (typeof(json_extract(data, '$.modelSelection.providerId')) = 'text' and length(trim(json_extract(data, '$.modelSelection.providerId'))) > 0) and (typeof(json_extract(data, '$.modelSelection.modelId')) = 'text' and length(trim(json_extract(data, '$.modelSelection.modelId'))) > 0) then
    json_patch(
      json_patch(json_object('providerId', json_extract(data, '$.modelSelection.providerId'), 'modelId', json_extract(data, '$.modelSelection.modelId')),
        case when (typeof(json_extract(data, '$.modelSelection.options.reasoningLevel')) = 'text' and length(trim(json_extract(data, '$.modelSelection.options.reasoningLevel'))) > 0) then json_object('options', json_object('reasoningLevel', json_extract(data, '$.modelSelection.options.reasoningLevel'))) else '{}' end),
      case when typeof(NULL) = 'text' then json_object('label', NULL) else '{}' end)
    else NULL end
        else NULL end
      else case when (typeof(json_extract(data, '$.model.providerID')) = 'text' and length(trim(json_extract(data, '$.model.providerID'))) > 0) and (typeof(json_extract(data, '$.model.modelID')) = 'text' and length(trim(json_extract(data, '$.model.modelID'))) > 0) then
    json_patch(
      json_patch(json_object('providerId', json_extract(data, '$.model.providerID'), 'modelId', json_extract(data, '$.model.modelID')),
        case when (typeof(json_extract(data, '$.model.variant')) = 'text' and length(trim(json_extract(data, '$.model.variant'))) > 0) then json_object('options', json_object('reasoningLevel', json_extract(data, '$.model.variant'))) else '{}' end),
      case when typeof(NULL) = 'text' then json_object('label', NULL) else '{}' end)
    else NULL end end
  else case when json_type(data, '$.providerId') is not null or json_type(data, '$.modelId') is not null or json_type(data, '$.reasoningLevel') is not null
    then case when substr(json_extract(data, '$.providerId'), 1, 8) = 'builtin:'
      then case when (typeof(json_extract(data, '$.providerId')) = 'text' and length(trim(json_extract(data, '$.providerId'))) > 0) and (typeof(json_extract(data, '$.modelId')) = 'text' and length(trim(json_extract(data, '$.modelId'))) > 0) then
    json_patch(
      json_patch(json_object('providerId', json_extract(data, '$.providerId'), 'modelId', json_extract(data, '$.modelId')),
        case when (typeof(json_extract(data, '$.reasoningLevel')) = 'text' and length(trim(json_extract(data, '$.reasoningLevel'))) > 0) then json_object('options', json_object('reasoningLevel', json_extract(data, '$.reasoningLevel'))) else '{}' end),
      case when typeof(NULL) = 'text' then json_object('label', NULL) else '{}' end)
    else NULL end else NULL end
    else case when (typeof(json_extract(data, '$.providerID')) = 'text' and length(trim(json_extract(data, '$.providerID'))) > 0) and (typeof(json_extract(data, '$.modelID')) = 'text' and length(trim(json_extract(data, '$.modelID'))) > 0) then
    json_patch(
      json_patch(json_object('providerId', json_extract(data, '$.providerID'), 'modelId', json_extract(data, '$.modelID')),
        case when (typeof(json_extract(data, '$.variant')) = 'text' and length(trim(json_extract(data, '$.variant'))) > 0) then json_object('options', json_object('reasoningLevel', json_extract(data, '$.variant'))) else '{}' end),
      case when typeof(NULL) = 'text' then json_object('label', NULL) else '{}' end)
    else NULL end end end as candidate from ranked where rank = 1
  ), migrated as (
    select *, case when (typeof(case trim(json_extract(candidate, '$.providerId'))
    when 'builtin:bigmodel' then 'bigmodel-api'
    when 'builtin:zai' then 'zai-api'
    when 'builtin:bigmodel-start-plan' then 'account:bigmodel-start-plan'
    when 'builtin:zai-start-plan' then 'account:zai-start-plan'
    when 'builtin:bigmodel-coding-plan' then 'account:bigmodel-individual-coding-plan'
    when 'builtin:zai-coding-plan' then 'account:zai-individual-coding-plan'
    else case when substr(trim(json_extract(candidate, '$.providerId')), 1, 8) = 'builtin:' then NULL else trim(json_extract(candidate, '$.providerId')) end end) = 'text' and length(trim(case trim(json_extract(candidate, '$.providerId'))
    when 'builtin:bigmodel' then 'bigmodel-api'
    when 'builtin:zai' then 'zai-api'
    when 'builtin:bigmodel-start-plan' then 'account:bigmodel-start-plan'
    when 'builtin:zai-start-plan' then 'account:zai-start-plan'
    when 'builtin:bigmodel-coding-plan' then 'account:bigmodel-individual-coding-plan'
    when 'builtin:zai-coding-plan' then 'account:zai-individual-coding-plan'
    else case when substr(trim(json_extract(candidate, '$.providerId')), 1, 8) = 'builtin:' then NULL else trim(json_extract(candidate, '$.providerId')) end end)) > 0) and (typeof(trim(json_extract(candidate, '$.modelId'))) = 'text' and length(trim(trim(json_extract(candidate, '$.modelId')))) > 0) then
    json_patch(
      json_patch(json_object('providerId', case trim(json_extract(candidate, '$.providerId'))
    when 'builtin:bigmodel' then 'bigmodel-api'
    when 'builtin:zai' then 'zai-api'
    when 'builtin:bigmodel-start-plan' then 'account:bigmodel-start-plan'
    when 'builtin:zai-start-plan' then 'account:zai-start-plan'
    when 'builtin:bigmodel-coding-plan' then 'account:bigmodel-individual-coding-plan'
    when 'builtin:zai-coding-plan' then 'account:zai-individual-coding-plan'
    else case when substr(trim(json_extract(candidate, '$.providerId')), 1, 8) = 'builtin:' then NULL else trim(json_extract(candidate, '$.providerId')) end end, 'modelId', trim(json_extract(candidate, '$.modelId'))),
        case when (typeof(trim(json_extract(candidate, '$.options.reasoningLevel'))) = 'text' and length(trim(trim(json_extract(candidate, '$.options.reasoningLevel')))) > 0) then json_object('options', json_object('reasoningLevel', trim(json_extract(candidate, '$.options.reasoningLevel')))) else '{}' end),
      case when typeof(NULL) = 'text' then json_object('label', NULL) else '{}' end)
    else NULL end as normalized from candidates
  )
  insert into session_entry(id, session_id, type, time_created, time_updated, data)
    select session_id || ':runtime-model-selection', session_id, 'runtime/model_selection', time_created, time_updated,
      json_object('modelSelection', json(normalized))
    from migrated where normalized is not null
    on conflict(id) do nothing;

  update session_entry set data = json_set(data, '$.modelSelection', json(case when (typeof(case trim(json_extract(data, '$.providerId'))
    when 'builtin:bigmodel' then 'bigmodel-api'
    when 'builtin:zai' then 'zai-api'
    when 'builtin:bigmodel-start-plan' then 'account:bigmodel-start-plan'
    when 'builtin:zai-start-plan' then 'account:zai-start-plan'
    when 'builtin:bigmodel-coding-plan' then 'account:bigmodel-individual-coding-plan'
    when 'builtin:zai-coding-plan' then 'account:zai-individual-coding-plan'
    else case when substr(trim(json_extract(data, '$.providerId')), 1, 8) = 'builtin:' then NULL else trim(json_extract(data, '$.providerId')) end end) = 'text' and length(trim(case trim(json_extract(data, '$.providerId'))
    when 'builtin:bigmodel' then 'bigmodel-api'
    when 'builtin:zai' then 'zai-api'
    when 'builtin:bigmodel-start-plan' then 'account:bigmodel-start-plan'
    when 'builtin:zai-start-plan' then 'account:zai-start-plan'
    when 'builtin:bigmodel-coding-plan' then 'account:bigmodel-individual-coding-plan'
    when 'builtin:zai-coding-plan' then 'account:zai-individual-coding-plan'
    else case when substr(trim(json_extract(data, '$.providerId')), 1, 8) = 'builtin:' then NULL else trim(json_extract(data, '$.providerId')) end end)) > 0) and (typeof(trim(json_extract(data, '$.modelId'))) = 'text' and length(trim(trim(json_extract(data, '$.modelId')))) > 0) then
    json_patch(
      json_patch(json_object('providerId', case trim(json_extract(data, '$.providerId'))
    when 'builtin:bigmodel' then 'bigmodel-api'
    when 'builtin:zai' then 'zai-api'
    when 'builtin:bigmodel-start-plan' then 'account:bigmodel-start-plan'
    when 'builtin:zai-start-plan' then 'account:zai-start-plan'
    when 'builtin:bigmodel-coding-plan' then 'account:bigmodel-individual-coding-plan'
    when 'builtin:zai-coding-plan' then 'account:zai-individual-coding-plan'
    else case when substr(trim(json_extract(data, '$.providerId')), 1, 8) = 'builtin:' then NULL else trim(json_extract(data, '$.providerId')) end end, 'modelId', trim(json_extract(data, '$.modelId'))),
        case when (typeof(trim(json_extract(data, '$.thoughtLevel'))) = 'text' and length(trim(trim(json_extract(data, '$.thoughtLevel')))) > 0) then json_object('options', json_object('reasoningLevel', trim(json_extract(data, '$.thoughtLevel')))) else '{}' end),
      case when typeof(NULL) = 'text' then json_object('label', NULL) else '{}' end)
    else NULL end))
    where type = 'runtime/model_selection' and json_valid(data) and json_type(data) = 'object'
      and (typeof(json_extract(data, '$.providerId')) = 'text' and length(trim(json_extract(data, '$.providerId'))) > 0) and (typeof(json_extract(data, '$.modelId')) = 'text' and length(trim(json_extract(data, '$.modelId'))) > 0) and case when (typeof(case trim(json_extract(data, '$.providerId'))
    when 'builtin:bigmodel' then 'bigmodel-api'
    when 'builtin:zai' then 'zai-api'
    when 'builtin:bigmodel-start-plan' then 'account:bigmodel-start-plan'
    when 'builtin:zai-start-plan' then 'account:zai-start-plan'
    when 'builtin:bigmodel-coding-plan' then 'account:bigmodel-individual-coding-plan'
    when 'builtin:zai-coding-plan' then 'account:zai-individual-coding-plan'
    else case when substr(trim(json_extract(data, '$.providerId')), 1, 8) = 'builtin:' then NULL else trim(json_extract(data, '$.providerId')) end end) = 'text' and length(trim(case trim(json_extract(data, '$.providerId'))
    when 'builtin:bigmodel' then 'bigmodel-api'
    when 'builtin:zai' then 'zai-api'
    when 'builtin:bigmodel-start-plan' then 'account:bigmodel-start-plan'
    when 'builtin:zai-start-plan' then 'account:zai-start-plan'
    when 'builtin:bigmodel-coding-plan' then 'account:bigmodel-individual-coding-plan'
    when 'builtin:zai-coding-plan' then 'account:zai-individual-coding-plan'
    else case when substr(trim(json_extract(data, '$.providerId')), 1, 8) = 'builtin:' then NULL else trim(json_extract(data, '$.providerId')) end end)) > 0) and (typeof(trim(json_extract(data, '$.modelId'))) = 'text' and length(trim(trim(json_extract(data, '$.modelId')))) > 0) then
    json_patch(
      json_patch(json_object('providerId', case trim(json_extract(data, '$.providerId'))
    when 'builtin:bigmodel' then 'bigmodel-api'
    when 'builtin:zai' then 'zai-api'
    when 'builtin:bigmodel-start-plan' then 'account:bigmodel-start-plan'
    when 'builtin:zai-start-plan' then 'account:zai-start-plan'
    when 'builtin:bigmodel-coding-plan' then 'account:bigmodel-individual-coding-plan'
    when 'builtin:zai-coding-plan' then 'account:zai-individual-coding-plan'
    else case when substr(trim(json_extract(data, '$.providerId')), 1, 8) = 'builtin:' then NULL else trim(json_extract(data, '$.providerId')) end end, 'modelId', trim(json_extract(data, '$.modelId'))),
        case when (typeof(trim(json_extract(data, '$.thoughtLevel'))) = 'text' and length(trim(trim(json_extract(data, '$.thoughtLevel')))) > 0) then json_object('options', json_object('reasoningLevel', trim(json_extract(data, '$.thoughtLevel')))) else '{}' end),
      case when typeof(NULL) = 'text' then json_object('label', NULL) else '{}' end)
    else NULL end is not null;

  -- 已发布 User 消息也可能含 modelSelection；它本身不是可覆盖的未发布新目标字段。
  update message set data = json_set(data, '$.modelSelection', json(case when (typeof(json_extract(data, '$.model.providerID')) = 'text' and length(trim(json_extract(data, '$.model.providerID'))) > 0) and (typeof(json_extract(data, '$.model.modelID')) = 'text' and length(trim(json_extract(data, '$.model.modelID'))) > 0) then
    json_patch(
      json_patch(json_object('providerId', json_extract(data, '$.model.providerID'), 'modelId', json_extract(data, '$.model.modelID')),
        case when (typeof(json_extract(data, '$.model.variant')) = 'text' and length(trim(json_extract(data, '$.model.variant'))) > 0) then json_object('options', json_object('reasoningLevel', json_extract(data, '$.model.variant'))) else '{}' end),
      case when typeof(NULL) = 'text' then json_object('label', NULL) else '{}' end)
    else NULL end))
    where json_valid(data) and json_type(data) = 'object' and json_extract(data, '$.role') = 'user'
      and json_type(data, '$.modelSelection') is null and json_type(data, '$.model') = 'object';

  update message set data = json_patch(data, json_patch(
      json_object('providerId', json_extract(data, '$.providerID'), 'modelId', json_extract(data, '$.modelID')),
      case when (typeof(json_extract(data, '$.variant')) = 'text' and length(trim(json_extract(data, '$.variant'))) > 0) then json_object('reasoningLevel', json_extract(data, '$.variant')) else '{}' end))
    where json_valid(data) and json_type(data) = 'object' and json_extract(data, '$.role') = 'assistant'
      and (typeof(json_extract(data, '$.providerID')) = 'text' and length(trim(json_extract(data, '$.providerID'))) > 0) and (typeof(json_extract(data, '$.modelID')) = 'text' and length(trim(json_extract(data, '$.modelID'))) > 0);

  update part set data = json_set(data, '$.fromModelSelection', json(case when (typeof(json_extract(data, '$.fromModel.providerID')) = 'text' and length(trim(json_extract(data, '$.fromModel.providerID'))) > 0) and (typeof(json_extract(data, '$.fromModel.modelID')) = 'text' and length(trim(json_extract(data, '$.fromModel.modelID'))) > 0) then
    json_patch(
      json_patch(json_object('providerId', json_extract(data, '$.fromModel.providerID'), 'modelId', json_extract(data, '$.fromModel.modelID')),
        case when (typeof(json_extract(data, '$.fromModel.variant')) = 'text' and length(trim(json_extract(data, '$.fromModel.variant'))) > 0) then json_object('options', json_object('reasoningLevel', json_extract(data, '$.fromModel.variant'))) else '{}' end),
      case when typeof(json_extract(data, '$.fromModel.label')) = 'text' then json_object('label', json_extract(data, '$.fromModel.label')) else '{}' end)
    else NULL end))
    where json_valid(data) and json_type(data) = 'object'
      and ((json_extract(data, '$.type') = 'timeline' and json_extract(data, '$.timelineType') = 'model_change' and 'fromModel' in ('fromModel','toModel'))
        or (json_extract(data, '$.type') = 'subtask' and 'fromModel' = 'model'))
      and json_type(data, '$.fromModel') = 'object'
      and (json_type(data, '$.fromModel.providerID') is not null or json_type(data, '$.fromModel.modelID') is not null);
  update part set data = json_set(data, '$.toModelSelection', json(case when (typeof(json_extract(data, '$.toModel.providerID')) = 'text' and length(trim(json_extract(data, '$.toModel.providerID'))) > 0) and (typeof(json_extract(data, '$.toModel.modelID')) = 'text' and length(trim(json_extract(data, '$.toModel.modelID'))) > 0) then
    json_patch(
      json_patch(json_object('providerId', json_extract(data, '$.toModel.providerID'), 'modelId', json_extract(data, '$.toModel.modelID')),
        case when (typeof(json_extract(data, '$.toModel.variant')) = 'text' and length(trim(json_extract(data, '$.toModel.variant'))) > 0) then json_object('options', json_object('reasoningLevel', json_extract(data, '$.toModel.variant'))) else '{}' end),
      case when typeof(json_extract(data, '$.toModel.label')) = 'text' then json_object('label', json_extract(data, '$.toModel.label')) else '{}' end)
    else NULL end))
    where json_valid(data) and json_type(data) = 'object'
      and ((json_extract(data, '$.type') = 'timeline' and json_extract(data, '$.timelineType') = 'model_change' and 'toModel' in ('fromModel','toModel'))
        or (json_extract(data, '$.type') = 'subtask' and 'toModel' = 'model'))
      and json_type(data, '$.toModel') = 'object'
      and (json_type(data, '$.toModel.providerID') is not null or json_type(data, '$.toModel.modelID') is not null);
  update part set data = json_set(data, '$.modelSelection', json(case when (typeof(json_extract(data, '$.model.providerID')) = 'text' and length(trim(json_extract(data, '$.model.providerID'))) > 0) and (typeof(json_extract(data, '$.model.modelID')) = 'text' and length(trim(json_extract(data, '$.model.modelID'))) > 0) then
    json_patch(
      json_patch(json_object('providerId', json_extract(data, '$.model.providerID'), 'modelId', json_extract(data, '$.model.modelID')),
        case when (typeof(json_extract(data, '$.model.variant')) = 'text' and length(trim(json_extract(data, '$.model.variant'))) > 0) then json_object('options', json_object('reasoningLevel', json_extract(data, '$.model.variant'))) else '{}' end),
      case when typeof(json_extract(data, '$.model.label')) = 'text' then json_object('label', json_extract(data, '$.model.label')) else '{}' end)
    else NULL end))
    where json_valid(data) and json_type(data) = 'object'
      and ((json_extract(data, '$.type') = 'timeline' and json_extract(data, '$.timelineType') = 'model_change' and 'model' in ('fromModel','toModel'))
        or (json_extract(data, '$.type') = 'subtask' and 'model' = 'model'))
      and json_type(data, '$.model') = 'object'
      and (json_type(data, '$.model.providerID') is not null or json_type(data, '$.model.modelID') is not null);
"##,
    },
    SessionMigration {
        id: "0021_official_glm_selection",
        app_version: "0.16.5",
        sql: r##"
UPDATE session_entry
SET data = json_set(data, '$.modelSelection.modelId',
  CASE lower(json_extract(data, '$.modelSelection.modelId'))
    WHEN 'glm-5.3' THEN 'GLM-5.3'
    WHEN 'glm-5.3-flash' THEN 'GLM-5.3-Flash'
    WHEN 'glm-5v-turbo' THEN 'GLM-5V-Turbo'
    WHEN 'glm-5.2' THEN 'GLM-5.2'
    WHEN 'glm-5.1' THEN 'GLM-5.1'
    WHEN 'glm-5.1-highspeed' THEN 'GLM-5.1-Highspeed'
    WHEN 'glm-5' THEN 'GLM-5'
    WHEN 'glm-5-turbo' THEN 'GLM-5-Turbo'
    WHEN 'glm-4.7' THEN 'GLM-4.7'
    WHEN 'glm-4.7-flashx' THEN 'GLM-4.7-FlashX'
    WHEN 'glm-4.7-flash' THEN 'GLM-4.7-Flash'
    WHEN 'glm-4.6' THEN 'GLM-4.6'
    WHEN 'glm-4.5-air' THEN 'GLM-4.5-Air'
    WHEN 'glm-4.5' THEN 'GLM-4.5'
    WHEN 'glm-4.6v' THEN 'GLM-4.6V'
    WHEN 'glm-4.6v-flash' THEN 'GLM-4.6V-Flash'
    WHEN 'glm-4.6v-flashx' THEN 'GLM-4.6V-FlashX'
    WHEN 'glm-4.1v-thinking-flashx' THEN 'GLM-4.1V-Thinking-FlashX'
    WHEN 'glm-4.1v-thinking-flash' THEN 'GLM-4.1V-Thinking-Flash'
    WHEN 'glm-4-flashx-250414' THEN 'GLM-4-FlashX-250414'
    WHEN 'glm-4-flash-250414' THEN 'GLM-4-Flash-250414'
    WHEN 'glm-4v-flash' THEN 'GLM-4V-Flash'
    ELSE json_extract(data, '$.modelSelection.modelId')
  END)
WHERE type = 'runtime/model_selection' AND CASE WHEN json_valid(data) THEN
  json_extract(data, '$.modelSelection.providerId') IN ('account:zai-start-plan', 'account:bigmodel-start-plan', 'account:zai-individual-coding-plan', 'account:bigmodel-individual-coding-plan', 'account:zai-team-coding-plan', 'account:bigmodel-team-coding-plan')
  AND lower(json_extract(data, '$.modelSelection.modelId')) IN ('glm-5.3', 'glm-5.3-flash', 'glm-5v-turbo', 'glm-5.2', 'glm-5.1', 'glm-5.1-highspeed', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flashx', 'glm-4.7-flash', 'glm-4.6', 'glm-4.5-air', 'glm-4.5', 'glm-4.6v', 'glm-4.6v-flash', 'glm-4.6v-flashx', 'glm-4.1v-thinking-flashx', 'glm-4.1v-thinking-flash', 'glm-4-flashx-250414', 'glm-4-flash-250414', 'glm-4v-flash')
  ELSE 0 END;
"##,
    },
    SessionMigration {
        id: "0022_backfilled_session_reasoning",
        app_version: "0.16.5",
        sql: r##"
WITH last_user AS (
  SELECT session_id, data, row_number() OVER (
    PARTITION BY session_id ORDER BY sequence DESC, time_created DESC, rowid DESC
  ) AS rank
  FROM message
  WHERE CASE WHEN json_valid(data) THEN json_extract(data, '$.role') = 'user' ELSE 0 END
), normalized_user AS (
  SELECT session_id,
    CASE trim(json_extract(data, '$.modelSelection.providerId'))
      WHEN 'builtin:bigmodel' THEN 'bigmodel-api'
      WHEN 'builtin:zai' THEN 'zai-api'
      WHEN 'builtin:bigmodel-start-plan' THEN 'account:bigmodel-start-plan'
      WHEN 'builtin:zai-start-plan' THEN 'account:zai-start-plan'
      WHEN 'builtin:bigmodel-coding-plan' THEN 'account:bigmodel-individual-coding-plan'
      WHEN 'builtin:zai-coding-plan' THEN 'account:zai-individual-coding-plan'
      ELSE CASE WHEN substr(trim(json_extract(data, '$.modelSelection.providerId')), 1, 8) = 'builtin:'
        THEN NULL ELSE trim(json_extract(data, '$.modelSelection.providerId')) END
    END AS provider_id,
    trim(json_extract(data, '$.modelSelection.modelId')) AS model_id,
    json_extract(data, '$.modelSelection.options.reasoningLevel') AS level
  FROM last_user
  WHERE rank = 1
    AND json_type(data, '$.modelSelection.providerId') = 'text'
    AND json_type(data, '$.modelSelection.modelId') = 'text'
    AND json_type(data, '$.modelSelection.options.reasoningLevel') = 'text'
    AND length(trim(json_extract(data, '$.modelSelection.options.reasoningLevel'))) > 0
), canonical_user AS (
  SELECT session_id, provider_id, level,
    CASE WHEN provider_id IN ('account:zai-start-plan', 'account:bigmodel-start-plan', 'account:zai-individual-coding-plan', 'account:bigmodel-individual-coding-plan', 'account:zai-team-coding-plan', 'account:bigmodel-team-coding-plan')
      THEN CASE lower(model_id)
        WHEN 'glm-5.3' THEN 'GLM-5.3'
        WHEN 'glm-5.3-flash' THEN 'GLM-5.3-Flash'
        WHEN 'glm-5v-turbo' THEN 'GLM-5V-Turbo'
        WHEN 'glm-5.2' THEN 'GLM-5.2'
        WHEN 'glm-5.1' THEN 'GLM-5.1'
        WHEN 'glm-5.1-highspeed' THEN 'GLM-5.1-Highspeed'
        WHEN 'glm-5' THEN 'GLM-5'
        WHEN 'glm-5-turbo' THEN 'GLM-5-Turbo'
        WHEN 'glm-4.7' THEN 'GLM-4.7'
        WHEN 'glm-4.7-flashx' THEN 'GLM-4.7-FlashX'
        WHEN 'glm-4.7-flash' THEN 'GLM-4.7-Flash'
        WHEN 'glm-4.6' THEN 'GLM-4.6'
        WHEN 'glm-4.5-air' THEN 'GLM-4.5-Air'
        WHEN 'glm-4.5' THEN 'GLM-4.5'
        WHEN 'glm-4.6v' THEN 'GLM-4.6V'
        WHEN 'glm-4.6v-flash' THEN 'GLM-4.6V-Flash'
        WHEN 'glm-4.6v-flashx' THEN 'GLM-4.6V-FlashX'
        WHEN 'glm-4.1v-thinking-flashx' THEN 'GLM-4.1V-Thinking-FlashX'
        WHEN 'glm-4.1v-thinking-flash' THEN 'GLM-4.1V-Thinking-Flash'
        WHEN 'glm-4-flashx-250414' THEN 'GLM-4-FlashX-250414'
        WHEN 'glm-4-flash-250414' THEN 'GLM-4-Flash-250414'
        WHEN 'glm-4v-flash' THEN 'GLM-4V-Flash'
        ELSE model_id END
      ELSE model_id END AS model_id
  FROM normalized_user
), untouched_entries AS (
  SELECT e.id, CASE WHEN json_valid(e.data) THEN e.data ELSE '{}' END AS data, e.session_id
  FROM session_entry e
  JOIN session s ON s.id = e.session_id
  JOIN schema_migration m ON m.id = '0020_provider_model_selection'
  WHERE e.type = 'runtime/model_selection'
    AND e.id = e.session_id || ':runtime-model-selection'
    AND e.time_updated <= m.time_applied AND s.time_updated <= m.time_applied
), repairs AS (
  SELECT e.id, u.level
  FROM untouched_entries e JOIN canonical_user u ON u.session_id = e.session_id
  WHERE json_type(e.data, '$.providerId') IS NULL
    AND json_type(e.data, '$.modelId') IS NULL
    AND json_type(e.data, '$.thoughtLevel') IS NULL
    AND json_type(e.data, '$.modelSelection.options') IS NULL
    AND json_type(e.data, '$.modelSelection.providerId') = 'text'
    AND json_type(e.data, '$.modelSelection.modelId') = 'text'
    AND length(u.provider_id) > 0 AND length(u.model_id) > 0
    AND json_extract(e.data, '$.modelSelection.providerId') = u.provider_id
    AND json_extract(e.data, '$.modelSelection.modelId') = u.model_id
)
UPDATE session_entry AS e
SET data = json_set(data, '$.modelSelection.options.reasoningLevel',
  (SELECT level FROM repairs WHERE repairs.id = e.id))
WHERE id IN (SELECT id FROM repairs);
"##,
    },
];

/// `sha256(sql.trim())` over one migration, matching the TS runner byte-for-byte.
pub fn migration_checksum(sql: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(sql.trim().as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Canonical `sha256(trim(sql))` values captured from the live TS runner (`dump_session_migrations`).
    const CHECKSUM_FIXTURE: &[(&str, &str)] = &[
    ("0001_base_session_store", "60e2d6a38ab36f31417c4f92c02690c96c7dcaaa0b6abe1741117d62a55c6462"),
    ("0002_local_setting", "22a6ada9325c9ad55a00a1f0ecf72332c63c1e89fc3d91fec8d155bb0058b465"),
    ("0003_backfill_permission_local_setting", "bd880375ba7b948c8bcda847e7eb52bc568d065bcba48190f6c3bfb14d11b7dc"),
    ("0004_session_target", "df670752991c78e38e2f25b0a003abc0e9689bc8d4894351358f2f83335a3ae1"),
    ("0005_session_target_accounting", "6138ed4562dfdd5b571d39d3b62266c55dd9eb8f2f41948e046441a0e4a954cc"),
    ("0006_input_history_attachments", "a2eab98649d738e15bdae27de7c5c114713f7777c55aa4111b19e03ee5ced54f"),
    ("0007_workflow_script_runtime", "0068fc4bcaffe4de4669442a62eee227726e0e8e81b61c7458213a20ac596009"),
    ("0008_workflow_definition_scope", "f7ee304e4005c291fb8883cfc180005263e6c6b2f94077487443f2c17a71d3eb"),
    ("0009_session_title_metadata", "3855cf957177ae6319ae91866cdff59e946ca07a10b36b5b59689818bd13fe00"),
    ("0010_usage_observability", "36918b0a98f465fe844097aa60c65ef73ea9c62cc266f02742bf3fc2cedf860b"),
    ("0011_session_target_summary_title", "2b7723479426a4e7a1ed9901ed817495c1bbf63e9547eb1c63cd9e24bf9305f8"),
    ("0012_session_trace_id", "9dcef90998dd00c8ed1b22a2170e180eb15471b93947e65ebe101d41e96bdb60"),
    ("0013_session_target_active_run_accounting", "7ab185540ebb7d26c5403ca52a50de6cf161c79cb93ccd47ff1b43b87415fe1c"),
    ("0014_message_part_sequence", "66b45c45e4d3a1a60829f193f38d865dcdbd3de2eb78aa79ba954fe7ef1aab08"),
    ("0015_message_part_sequence_backfill_and_guard", "da3046bf061ebb5ba253bb772f0fc9e4d1f2856dac4cdbc4cc0a65aae00e8511"),
    ("0016_session_input_ledger", "18d51ae3f5e1425dc1e5c809282129fdc7430cacb6b1ce517b412ddbc34be790"),
    ("0017_session_input_start_now_delivery", "8c2da5985ecdf342438a2df713c9e18114276a0e85ce6f2e4f79bdf1596b52f8"),
    ("0018_session_input_failed_status", "a4d1a7b7c5d4af426b695769ed0f3a031efac8aa7af1f6412a85292c42b5d15b"),
    ("0019_dwf_journal", "1c8da5568d2357f25c392be486fae80e1f3ad3ebc830dab1bee941634573e8ba"),
    ("0020_provider_model_selection", "681180b4fcb497e13289b6970021678f24c975efdf3538777541105c5b2b444e"),
    ("0021_official_glm_selection", "433a8da454682406e962b043f2e0f412e9801bf7e4641ff25760aa16625ebafe"),
    ("0022_backfilled_session_reasoning", "aee472fe499e9c25d2e71df0fbc68d92e462b30d1d02919ca35d540bf133c99a"),
    ];

    #[test]
    fn checksum_matches_live_ledger() {
        assert_eq!(
            SESSION_MIGRATIONS.len(),
            CHECKSUM_FIXTURE.len(),
            "migration count drifted from the TS runner"
        );
        for (mig, (id, expected)) in SESSION_MIGRATIONS.iter().zip(CHECKSUM_FIXTURE) {
            assert_eq!(mig.id, *id, "migration id/order drifted");
            assert_eq!(
                migration_checksum(mig.sql),
                *expected,
                "checksum drifted for {} (SQL bytes must be frozen)",
                mig.id
            );
        }
    }
}
