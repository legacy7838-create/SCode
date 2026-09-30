import { SessionEventType, type SessionEvent, type ToolCallResultPayload } from "@zcode/contracts";
import {
  cuaPermissionObservationSchema,
  cuaRequestAccessStatusSchema,
  requiredCuaPermissionsForRequestAccessStatus,
  type CuaPermissionObservation,
} from "@zcode/shared/zcode-protocol-v4";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project the trusted CUA ToolCallResult received in this process into a one-shot permission observation.
 * History recovery has no SessionEvent input, so permission UI side effects cannot be fabricated here.
 */
export class CuaPermissionObservationNormalizer {
  normalize(sessionId: string, event: SessionEvent): CuaPermissionObservation | null {
    if (event.type !== SessionEventType.ToolCallResult) return null;

    const payload = event.payload as ToolCallResultPayload;
    const display = payload.result.display;
    if (
      !isRecord(display) ||
      display.kind !== "cua" ||
      display.toolName !== "request_access" ||
      display.status !== "success"
    ) {
      return null;
    }

    const parsedStatus = cuaRequestAccessStatusSchema.safeParse(
      (display as Record<string, unknown>).permissionStatus,
    );
    if (
      !parsedStatus.success ||
      requiredCuaPermissionsForRequestAccessStatus(parsedStatus.data).length === 0
    ) {
      return null;
    }

    const parsedObservation = cuaPermissionObservationSchema.safeParse({
      schemaVersion: 1,
      eventId: String(event.id),
      eventSeq: event.sequenceNumber,
      occurredAt: event.timestamp.getTime(),
      sessionId,
      ...(event.turnId ? { turnId: String(event.turnId) } : {}),
      toolCallId: payload.toolCallId,
      permissionStatus: parsedStatus.data,
    });
    return parsedObservation.success ? parsedObservation.data : null;
  }
}
