// ============================================================
// Notification and provider stop copy table in run of workflow run
// ============================================================
// Detached from notification.ts (eslint max-lines 400 lines): That file carries the final notification skeleton of four tasks,
// Here are three paragraphs of copywriting exclusive to dwf - upgrade Q&A, run-level stagnation and
// provider stops; the latter is shared by final notifications and GetWorkflowRun.

import type { DynamicWorkflowRunError } from "@zcode/contracts";
import { escapeXml, truncateTaskNotification } from "./notification.js";

/**
 * The `<error>` block for `stopped(provider)`: two sentences chosen by `providerStop.kind` (what
 * went wrong / what to do), followed by a fixed fact line and the provider's verbatim line. Every
 * placeholder in the copy has a fallback (a missing provider display name falls back to providerId,
 * and a missing providerId to "the provider") - a notification never degrades into an empty
 * sentence just because one field is missing. GetWorkflowRun's `<error>` block shares this function.
 */
export function formatWorkflowProviderStopError(
  failure: DynamicWorkflowRunError,
  runId: string,
): string {
  const details = failure.providerStop;
  if (details === undefined) return failure.message;
  const provider = details.providerLabel ?? details.providerId ?? "the provider";
  const providerRef =
    details.providerLabel !== undefined && details.providerId !== undefined
      ? `${details.providerLabel} (${details.providerId})`
      : provider;
  const subagent = details.subagentName ?? details.subagent ?? "a subagent";
  const phase = details.phase === undefined ? "" : ` (phase "${details.phase}")`;
  const model = details.modelId ?? "the current model";
  const code = details.providerCode ?? details.reason;
  const resume = `then call ResumeWorkflowRun with run_id="${runId}"`;
  const sentences = ((): [string, string] => {
    switch (details.kind) {
      case "auth":
        return [
          `Sign-in to ${providerRef} expired while subagent ${subagent}${phase} was running.`,
          `Ask the user to sign in to ${provider} again, ${resume}. Finished steps are kept.`,
        ];
      case "not_configured":
        return [
          `Provider ${details.providerId ?? provider} is not configured on this machine, so subagent ${subagent}${phase} could not send its request.`,
          `Ask the user to configure the provider or switch this session to another model, ${resume}.`,
        ];
      case "model_unavailable":
        return [
          `Model ${model} is not available on ${provider} (not in the user's plan, or retired).`,
          `Ask the user to switch this session to a model the plan includes, ${resume}. Subagents follow the session's model.`,
        ];
      case "invalid_request":
        return [
          `${provider} rejected subagent ${subagent}${phase}'s request as invalid (code ${code}).`,
          `Switching the session to another model usually clears this; ${resume}. If it stops again with the same code, show the raw message to the user.`,
        ];
      case "quota":
        return details.resetAt === undefined
          ? [
              `${provider} reports the user's quota is exhausted (code ${code}).`,
              `Ask the user to top up or upgrade the plan, or switch to another provider, ${resume}.`,
            ]
          : [
              `${provider} reports the user's usage cap is reached (code ${code}); it resets at ${new Date(details.resetAt).toISOString()}.`,
              `Tell the user; after the reset, call ResumeWorkflowRun with run_id="${runId}". Do not rebuild the workflow.`,
            ];
      default:
        return [
          `${provider} refused subagent ${subagent}${phase}'s request with a permanent error (code ${code}).`,
          `Resolve it with the user (the raw message below says what the provider wants), ${resume}.`,
        ];
    }
  })();
  const facts = [
    `provider=${details.providerId ?? "unknown"}`,
    `model=${details.modelId ?? "unknown"}`,
    `subagent=${details.subagent ?? "unknown"}`,
    ...(details.phase === undefined ? [] : [`phase=${details.phase}`]),
    `code=${code}`,
  ].join(" ");
  return [
    sentences[0],
    sentences[1],
    facts,
    ...(details.rawMessage === undefined ? [] : [`raw: ${details.rawMessage}`]),
  ].join("\n");
}

/**
 * The in-run notification for a run-level stall. It is of the same family as the escalation
 * question: what it announces is not a terminal state but a fact that is happening right now - the
 * run is still going, it is just that no model request has succeeded for 20 minutes. The copy must
 * state two things flat out: it **requires** nothing of the model (in particular, do not cancel or
 * rebuild), and a user who is waiting should be told. Exactly one entry per stall segment; no
 * nagging.
 */
export interface WorkflowStallNotificationInput {
  runLabel: string;
  runId: string;
  sinceMs: number;
  reason?: string;
  cap?: number;
}

export function formatWorkflowStallNotification(input: WorkflowStallNotificationInput): string {
  const minutes = Math.max(1, Math.round(input.sinceMs / 60_000));
  const lines = [
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "This is an automated workflow event, NOT a message from the user.",
    "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    "",
    "<workflow-stall>",
    `  <run-id>${escapeXml(input.runId)}</run-id>`,
    `  <run>${escapeXml(input.runLabel)}</run>`,
    `  <since-ms>${Math.max(0, Math.floor(input.sinceMs))}</since-ms>`,
  ];
  if (input.reason !== undefined) {
    lines.push(`  <dominant-reason>${escapeXml(input.reason)}</dominant-reason>`);
  }
  if (input.cap !== undefined) lines.push(`  <cap>${input.cap}</cap>`);
  const reasonClause =
    input.reason === undefined
      ? "the provider keeps failing requests"
      : `the provider keeps answering ${input.reason}`;
  const capClause = input.cap === undefined ? "" : ` (current fan-out ${input.cap})`;
  lines.push(
    "</workflow-stall>",
    "",
    `Workflow run ${input.runLabel} (${input.runId}) has not completed a model request in ${minutes} minutes; ${reasonClause} and the run is retrying with backoff${capClause}.`,
    "It is still running and needs nothing from you. Tell the user if they are waiting on it; they can stop it from the run card. Do not cancel or rebuild it on your own.",
  );
  return truncateTaskNotification(lines.join("\n"));
}

/**
 * A blocking question escalated from a **running** run by one actor.
 *
 * The key difference from the formatters above: those announce a **terminal state** (the work is
 * done, read the result), while this one announces **an obligation that is not yet met** - some
 * actor is parked right now waiting for an answer, and no timeout will cover for it. The copy
 * therefore has to state three things flat out: what the question is, the next step verbatim (a
 * tool call carrying the qid), and the fact that the run has not stopped for it (otherwise the
 * model would think the whole workflow is waiting on it and drop everything else it is doing).
 *
 * The structured half uses an XML-ish section (of the same family as
 * `<task-notification>`, with fields that a human and a model can locate stably), and the
 * prose half gives the next step and the boundary conditions. **No resending, no nagging**:
 * the discard fallback is a snapshot query, not a retry.
 */
export interface WorkflowEscalationNotificationInput {
  /** The run's display name (the description in the registry; when absent the caller has already fallen back to the runId). */
  runLabel: string;
  runId: string;
  qid: string;
  /** The actor's human-readable name; it is absent for an anonymous actor, and the caller supplies a structured ref as the fallback. */
  actor: string;
  question: string;
  context?: string;
}

export function formatWorkflowEscalationNotification(
  input: WorkflowEscalationNotificationInput,
): string {
  const lines = [
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "This is an automated workflow event, NOT a message from the user.",
    "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    "",
    "<workflow-escalation>",
    `  <run-id>${escapeXml(input.runId)}</run-id>`,
    `  <run>${escapeXml(input.runLabel)}</run>`,
    `  <question-id>${escapeXml(input.qid)}</question-id>`,
    `  <subagent>${escapeXml(input.actor)}</subagent>`,
    `  <question>${escapeXml(input.question)}</question>`,
  ];
  if (input.context !== undefined && input.context.length > 0) {
    lines.push(`  <context>${escapeXml(input.context)}</context>`);
  }
  lines.push(
    "</workflow-escalation>",
    "",
    `Subagent ${input.actor} in workflow run ${input.runLabel} (${input.runId}) escalated a blocking question and is parked on that call waiting for your answer.`,
    `Next step: call ResolveWorkflowQuestion with question_id="${input.qid}" and your answer.`,
    "The run is still running: only the subagent that asked is parked — every other subagent and the script's control flow keep going. So do not drop what you are doing, but do not leave it unanswered either: nothing times out on its behalf.",
    "If this notification is ever lost, GetWorkflowRun lists the questions this run still owes an answer to.",
  );
  return truncateTaskNotification(lines.join("\n"));
}
