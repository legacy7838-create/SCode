// Classification of V4 physical assembly faults: **Content deterministic failure** vs transient failure.
//
// The recovery ladder treats faults as transient by default: first same-sub resync (the server may return to resume), and then upgrade if the file is interrupted.
// If forceSnapshot still fails, fail closed. This set of upgrades is correct for missing pieces, timeouts, and checksum discrepancies - a reroll is likely
// Just fine. It is wrong to reject **schema**: the bytes have passed the four levels of length/checksum/UTF-8/JSON. Rejection instructions
// The client cannot read the **content** sent by the peer, and the resume file will only submit the same batch of deltas again, which will inevitably be rejected.
//
// When an incompatible field appears in the tool card payload, re-submitting the same content cannot recover; you should try to take a snapshot and clearly report that the content is incompatible.
//
// This module only answers "Is this reason code a deterministic content failure?" and does not decide how to deal with it - it is dealt with in two stores.
// (conversationProjectionStore / sessionsIndexStore).

/**
 * The reason code for a frame whose content passed checksum/JSON but failed the zod schema.
 *
 * A constant rather than a literal written out at each site: the side that decides and the side
 * that produces it (wire-assembler, wire-reassembly) must always say the same word — divergence
 * between the two is exactly the kind of silent mismatch this module exists to fix.
 */
export const WIRE_FAULT_INVALID_PAYLOAD = "proto.frameAssemblyInvalidPayload";

/**
 * Whether this fault is the deterministic failure "redelivering the same content is guaranteed to
 * be rejected again".
 *
 * For now only the schema rejection counts. `proto.frameAssemblyInvalidJson` is deliberately **not**
 * included: invalid JSON can also come from the assembly path itself (fragment stitching, encoding
 * boundaries), and a redelivery really can differ; mistaking a transient fault for a deterministic
 * one leaves a gap that should self-heal stuck in place, which is a worse failure than one useless
 * retry. Add them one at a time on evidence, not on a guess.
 */
export function isDeterministicContentFault(reasonCode: string | undefined): boolean {
  return reasonCode === WIRE_FAULT_INVALID_PAYLOAD;
}

/**
 * The client terminal code for a deterministic content failure that ran its course (`fault.subscription.*`
 * is the 04-sync vocabulary).
 *
 * Keeping this apart from `fault.subscription.recoveryFailed` is a useful distinction, not naming
 * pedantry: the latter means "the link did not recover", where reconnecting makes sense; this code
 * means "this end cannot read the content the other end sent", where a reconnect is guaranteed to
 * produce the same result. Telemetry aggregates by code, and mixing the two would read a single
 * version mismatch as a burst of network flapping.
 */
export const SUBSCRIPTION_CONTENT_REJECTED = "fault.subscription.contentRejected";
