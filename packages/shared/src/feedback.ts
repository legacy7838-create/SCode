export type FeedbackTicketType = "bug" | "usage" | "feature" | "performance";

export type FeedbackTicketStatus =
  | "Submitted"
  | "Insufficient Info"
  | "Accepted"
  | "Response Closed"
  | "Archived"
  | "Rejected"
  | "In Progress"
  | "Resolved"
  | "Shipped";

export type FeedbackAttachmentKind = "log" | "image" | "other";

export type FeedbackTicketModule =
  | "Plugin / MCP"
  | "Agent Task Execution Failure"
  | "Model Config / API Key"
  | "Model Call Error"
  | "Permission / Config Save"
  | "SSH Connection Failure"
  | "WSL Connection Failure"
  | "UI Layout / Interaction"
  | "Model Slow / Quota"
  | "Crash / Internal Error"
  | "Docs / Usage Inquiry"
  | "Other";

export type FeedbackTicketFramework = "zcode-agent";

/**
 * A UI-layer Select does not allow an empty string as an option value (Radix throws),
 * so "unspecified" gets a sentinel here; it is converted to undefined before the ticket is submitted.
 */
export const FEEDBACK_FRAMEWORK_NONE = "none" as const;
export type FeedbackTicketFrameworkSelectValue =
  | FeedbackTicketFramework
  | typeof FEEDBACK_FRAMEWORK_NONE;

export type FeedbackTicketSeverity = "P1-High" | "P2-Medium" | "P3-Low";

export interface FeedbackReporter {
  user_id?: string;
  username?: string;
  display_name?: string;
}

export interface FeedbackDeviceInfo {
  appVersion?: string;
  buildCommitId?: string;
  buildTime?: string;
  electronVersion?: string;
  nodeVersion?: string;
  osType?: string;
  osPlatform?: string;
  osRelease?: string;
  osVersion?: string;
  osArch?: string;
  /** The Agent in use when the feedback is submitted. Fixed to the ZCode Agent in single-ZCode-Agent mode. */
  agentProvider?: string;
  /** Framework identifier normalized for the feedback platform when the feedback is submitted, currently fixed to zcode-agent. */
  agentFramework?: FeedbackTicketFramework;
  /** The raw selected value in the current model configuration when the feedback is submitted. */
  agentModel?: string;
  /** Display name matched from the model list when the feedback is submitted; falls back to agentModel when absent. */
  agentModelDisplay?: string;
  /** Number of options in the current model list when the feedback is submitted. */
  agentModelOptionCount?: number;
  /** Preview of the display names in the current model list when the feedback is submitted, used to diagnose the configuration context. */
  agentModelOptionsPreview?: string[];
  hostname?: string;
  deviceMid?: string;
}

export interface CreateFeedbackTicketInput {
  title: string;
  description: string;
  type: FeedbackTicketType;
  severity?: FeedbackTicketSeverity;
  module?: FeedbackTicketModule;
  framework?: FeedbackTicketFramework;
  source?: string;
  reporter?: FeedbackReporter;
  device?: FeedbackDeviceInfo;
  /** Contact detail the user optionally fills in (email or another social account); the backend does not require it. */
  contact?: string;
  /** Current UI language, only passed through in request headers, never written into the backend ticket body. */
}

export interface FeedbackTicketSummary {
  id: string;
  title: string;
  type: FeedbackTicketType;
  severity?: FeedbackTicketSeverity;
  module?: FeedbackTicketModule;
  status: FeedbackTicketStatus;
  assignee_id?: string | null;
  /** Display name of the current assignee (filled in by the backend); null when unassigned */
  assignee_display?: string | null;
  /** Display name of the reporter returned by the backend */
  reporter_display?: string | null;
  /** Whether there has been new activity since it was last viewed */
  unread?: boolean;
  /** Time of the most recent user activity */
  last_user_activity_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type FeedbackTicketEventType =
  | "created"
  | "status_changed"
  | "assignee_changed"
  | "staff_replied"
  | "user_replied";

export interface FeedbackTicketEvent {
  id: number;
  type: FeedbackTicketEventType;
  summary: string;
  actor_display_name?: string | null;
  payload?: Record<string, unknown> | null;
  created_at: string;
}

export interface FeedbackAttachment {
  id: number;
  kind: FeedbackAttachmentKind;
  filename: string;
  size: number;
  sha256?: string | null;
  redacted: boolean;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
  created_at: string;
}

export interface FeedbackCommentAttachment {
  id: number;
  filename: string;
  size: number;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
}

export interface FeedbackComment {
  id: number;
  /** Backend message_id, used to keep binding attachments to that message after the message is created. */
  message_id?: string;
  author_user_id?: string | null;
  author_display_name?: string | null;
  body: string;
  attachments?: FeedbackCommentAttachment[];
  is_staff: boolean;
  created_at: string;
}

export interface FeedbackTicketDetail extends FeedbackTicketSummary {
  description: string;
  framework?: FeedbackTicketFramework;
  reporter?: FeedbackReporter | null;
  device?: FeedbackDeviceInfo | null;
  attachments: FeedbackAttachment[];
  comments: FeedbackComment[];
  events: FeedbackTicketEvent[];
  lark_record_id?: string | null;
}

export interface FeedbackListQuery {
  mine?: boolean;
  status?: FeedbackTicketStatus;
  type?: FeedbackTicketType;
  offset?: number;
  limit?: number;
}

export interface FeedbackListResult {
  items: FeedbackTicketSummary[];
  total: number;
}

export const FEEDBACK_TICKET_MODULES: FeedbackTicketModule[] = [
  "Plugin / MCP",
  "Agent Task Execution Failure",
  "Model Config / API Key",
  "Model Call Error",
  "Permission / Config Save",
  "SSH Connection Failure",
  "WSL Connection Failure",
  "UI Layout / Interaction",
  "Model Slow / Quota",
  "Crash / Internal Error",
  "Docs / Usage Inquiry",
  "Other",
];

export const FEEDBACK_TICKET_TYPES: { value: FeedbackTicketType; label: string }[] = [
  { value: "bug", label: "Bug Report" },
  { value: "usage", label: "Usage Issue" },
  { value: "feature", label: "Feature Request" },
  { value: "performance", label: "Performance Issue" },
];

export const FEEDBACK_TICKET_SEVERITIES: FeedbackTicketSeverity[] = [
  "P1-High",
  "P2-Medium",
  "P3-Low",
];

export const DEFAULT_FEEDBACK_TICKET_FRAMEWORK: FeedbackTicketFramework = "zcode-agent";

export const FEEDBACK_TICKET_FRAMEWORK_OPTIONS: {
  value: FeedbackTicketFramework;
  label: string;
}[] = [{ value: "zcode-agent", label: "ZCode Agent" }];

/** Full list including "Unspecified", for use by the management console and similar surfaces. */
export const FEEDBACK_TICKET_FRAMEWORKS: {
  value: FeedbackTicketFrameworkSelectValue;
  label: string;
}[] = [
  { value: FEEDBACK_FRAMEWORK_NONE, label: "Unspecified" },
  ...FEEDBACK_TICKET_FRAMEWORK_OPTIONS,
];
