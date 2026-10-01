import { z } from "zod";

export type SessionCreateSource = "group" | "project" | "session";
export type SessionCreateClientKind = "desktop" | "mobile" | "web";

/** Mobile forwarding only opens this event; the common user/device identity is still injected by the desktop TelemetryCore. */
export const sessionCreateTelemetrySchema = z
  .object({
    elementName: z.literal("session_create"),
    eventRegion: z.literal("app"),
    eventType: z.literal("result"),
    talkId: z.string().min(1).max(512),
    messageId: z.string().min(1).max(512),
    context: z
      .object({
        clientTimezone: z.string().max(128),
        clientLanguage: z.string().max(128),
        screenResolution: z.string().max(64),
      })
      .strict(),
    eventExtraDetail: z
      .object({
        create_source: z.enum(["group", "project", "session"]),
        client_kind: z.literal("mobile"),
        workspace_kind: z.enum(["local", "remote"]),
        remote_kind: z.enum(["", "ssh", "server"]),
      })
      .strict(),
  })
  .strict();

export type MobileSessionCreateTelemetry = z.infer<typeof sessionCreateTelemetrySchema>;

/** Automation is reported by the executing Host; mobile must not masquerade as an unattended dispatch source. */
export const automationSessionCreateTelemetrySchema = sessionCreateTelemetrySchema.extend({
  eventExtraDetail: sessionCreateTelemetrySchema.shape.eventExtraDetail.extend({
    create_source: z.enum(["automation_idle", "automation_scheduled"]),
    client_kind: z.literal("desktop"),
  }),
});
export type AutomationSessionCreateTelemetry = z.infer<
  typeof automationSessionCreateTelemetrySchema
>;
