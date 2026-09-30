import { redactFeedbackText } from "@zcode/shared";
import type { FeedbackAgentModelContext } from "@/feedback/feedbackSubmitModelContext.js";
import type {
  FeedbackTicketModule,
  FeedbackTicketSeverity,
  FeedbackTicketType,
} from "@zcode/shared";

const TITLE_MAX = 80;
const FEEDBACK_ZCODE_AGENT_LABEL = "ZCode Agent";

type MessageFormatter = (descriptor: { id: string }, values?: Record<string, string>) => string;

export function buildFeedbackTitle(description: string, formatMessage: MessageFormatter): string {
  const normalized =
    description
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? description.replace(/\s+/g, " ").trim();
  return normalized.slice(0, TITLE_MAX) || formatMessage({ id: "feedback.title.fallback" });
}

export function buildDeveloperFacingDescription({
  raw,
  modelContext,
  ticketType = "bug",
  ticketModule = "Other",
  ticketSeverity = "P2-Medium",
  formatMessage,
}: {
  raw: string;
  modelContext: FeedbackAgentModelContext;
  ticketType?: FeedbackTicketType;
  ticketModule?: FeedbackTicketModule;
  ticketSeverity?: FeedbackTicketSeverity;
  formatMessage: MessageFormatter;
}): string {
  const notReported = formatMessage({ id: "feedback.submit.notReported" });
  return [
    "Original feedback",
    "",
    `Feedback type: ${ticketType}`,
    `Product area: ${ticketModule}`,
    `Severity: ${ticketSeverity}`,
    "Agent framework: zcode-agent",
    `Current Agent: ${FEEDBACK_ZCODE_AGENT_LABEL}`,
    `Current model: ${redactFeedbackText(modelContext.display || modelContext.model || notReported)}`,
    "Handling: the user submits a lightweight form, the client fills in the context automatically, and the backend can generate an AI analysis asynchronously",
    "",
    "User's original description",
    raw.trim(),
  ].join("\n");
}
