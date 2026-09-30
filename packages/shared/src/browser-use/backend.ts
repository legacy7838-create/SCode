import { z } from "zod";
import { browserClientModeSchema } from "./commands.js";

/**
 * Browser backend family. Playwright is a capability layer on top of a Tab, not a backend.
 */
export const browserBackendTypeSchema = z.enum(["iab", "extension", "cdp"]);
export type BrowserBackendType = z.infer<typeof browserBackendTypeSchema>;

/** Stable description of a single browser/tab capability. */
export const browserCapabilityDescriptorSchema = z
  .object({
    id: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .strict();
export type BrowserCapabilityDescriptor = z.infer<typeof browserCapabilityDescriptorSchema>;

/**
 * Runtime description of a reachable browser backend.
 *
 * `id` is the connection identity: several instances of the same type can exist at
 * once; only a backend that completed the handshake and is genuinely usable may
 * appear in discovery results.
 */
export const browserBackendDescriptorSchema = z
  .object({
    id: z.string().trim().min(1),
    /** Connection generation for the same runtime id; an object from an older generation must not drift onto the new connection on its own. */
    generation: z.number().int().nonnegative().default(0),
    type: browserBackendTypeSchema,
    name: z.string().trim().min(1),
    capabilities: z
      .object({
        browser: z.array(browserCapabilityDescriptorSchema).optional(),
        tab: z.array(browserCapabilityDescriptorSchema).optional(),
      })
      .strict(),
    apiSupportOverrides: z.record(z.string(), z.boolean()).optional(),
    /** metadata only allows non-sensitive strings; credentials must never be mixed into discovery. */
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type BrowserBackendDescriptor = z.infer<typeof browserBackendDescriptorSchema>;

/** A backend request either uses a live session, or a cached session context. */
export const browserSessionContextKindSchema = z.enum(["live", "cached"]);
export type BrowserSessionContextKind = z.infer<typeof browserSessionContextKindSchema>;

/**
 * The full isolation context for discovery. workspaceKey provides identity isolation;
 * workspacePath is only used for path semantics.
 */
export const browserDiscoveryContextSchema = z
  .object({
    requestId: z.string().trim().min(1),
    workspaceKey: z.string().trim().min(1),
    workspacePath: z.string().trim().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    remoteSessionId: z.string().trim().min(1).optional(),
    sessionId: z.string().trim().min(1),
    turnId: z.string().trim().min(1).optional(),
    clientMode: browserClientModeSchema,
    sessionContext: browserSessionContextKindSchema,
  })
  .strict();
export type BrowserDiscoveryContext = z.infer<typeof browserDiscoveryContextSchema>;

/** Adds the precise runtime browser identity on top of the discovery context when executing a command. */
export const browserSessionContextSchema = browserDiscoveryContextSchema
  .extend({
    browserId: z.string().trim().min(1),
    browserGeneration: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserSessionContext = z.infer<typeof browserSessionContextSchema>;

/** Discovery result wrapper for ZCode Protocol; the port layer unwraps it and returns `browsers` directly. */
export const browserBackendListResultSchema = z
  .object({ browsers: z.array(browserBackendDescriptorSchema) })
  .strict();
export type BrowserBackendListResult = z.infer<typeof browserBackendListResultSchema>;
