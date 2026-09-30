import {
  resolveWorkspaceTelemetryDetail,
  type IPlatformService,
  type SessionCreateClientKind,
  type SessionCreateSource,
} from "@zcode/shared";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";

interface SessionCreateInput {
  sessionId: string;
  messageId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  source: SessionCreateSource;
  clientKind: SessionCreateClientKind;
}

function createSessionCreateReporter() {
  const reported = new Set<string>();
  return async (
    platform: Pick<IPlatformService, "reportTelemetryEvent"> | null | undefined,
    input: SessionCreateInput,
  ): Promise<void> => {
    if (!platform) return;
    const key = JSON.stringify([
      input.workspaceIdentity?.trim() || input.workspacePath,
      input.sessionId,
    ]);
    // The creation callback and pending recovery may point to the same session; deduplication is based on identity and the remote end is not merged according to path.
    if (reported.has(key)) return;
    reported.add(key);
    if (reported.size > 4096) reported.delete(reported.values().next().value!);
    await reportAppTelemetryEvent(
      platform,
      {
        elementName: "session_create",
        eventRegion: "app",
        eventType: "result",
        talkId: input.sessionId,
        messageId: input.messageId,
        eventExtraDetail: {
          create_source: input.source,
          client_kind: input.clientKind,
          ...resolveWorkspaceTelemetryDetail(input),
        },
      },
      "session-create-telemetry",
    );
  };
}

export const reportSessionCreate = createSessionCreateReporter();
