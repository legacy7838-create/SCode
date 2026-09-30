import {
  HostResponseTypes,
  resolveWorkspaceTelemetryDetail,
  type AutomationSessionCreateTelemetry,
} from "@zcode/shared";

/** Only called by the dispatch branch that actually creates a session and completes first admission; a creation is never inferred from a recovery subscription. */
export function reportHostSessionCreate(
  port: { postMessage(message: unknown): void } | null | undefined,
  input: {
    sessionId: string;
    messageId: string;
    source: AutomationSessionCreateTelemetry["eventExtraDetail"]["create_source"];
    workspaceIdentity?: string;
  },
): void {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions();
    const event: AutomationSessionCreateTelemetry = {
      elementName: "session_create",
      eventRegion: "app",
      eventType: "result",
      talkId: input.sessionId,
      messageId: input.messageId,
      context: {
        clientTimezone: locale.timeZone,
        clientLanguage: locale.locale,
        screenResolution: "",
      },
      eventExtraDetail: {
        create_source: input.source,
        client_kind: "desktop",
        ...resolveWorkspaceTelemetryDetail(input),
      },
    };
    port?.postMessage({ type: HostResponseTypes.SessionCreateTelemetry, event });
  } catch {
    // When Main has exited or IPC is unavailable, this bypass report is discarded, and accepted distribution cannot be misjudged as failure.
  }
}
