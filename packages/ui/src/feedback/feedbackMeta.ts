import type { FeedbackTicketStatus } from "@zcode/shared";

type MessageFormatter = (descriptor: { id: string }, values?: Record<string, string>) => string;

interface StatusMeta {
  className: string;
  dot: string;
}

export const STATUS_META: Record<FeedbackTicketStatus, StatusMeta> = {
  Submitted: {
    className: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  "Insufficient Info": {
    className: "text-orange-700 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  Accepted: {
    className: "text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  "Response Closed": {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  // The public feedback interface will return historical "Reply Closed" as "Archived".
  // The client must recognize both final states at the same time, otherwise my feedback list will not be able to get the meta and crash when rendering the status tag.
  Archived: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  Rejected: {
    className: "text-foreground-subtle",
    dot: "bg-foreground-subtlest",
  },
  "In Progress": {
    className: "text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  Resolved: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  Shipped: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
};

const FEEDBACK_STATUS_MESSAGE_IDS: Record<FeedbackTicketStatus, string> = {
  Submitted: "feedback.status.pendingReview",
  "Insufficient Info": "feedback.status.needInfo",
  Accepted: "feedback.status.accepted",
  "Response Closed": "feedback.status.closedByReply",
  // The backend closed is still normalized to the "archived" compatible value, but the internal naming of the interface cannot be directly exposed to the user.
  // This is mapped to the completed display copy, so that the "My Feedback" list and details are uniformly displayed as "Completed".
  Archived: "feedback.status.completed",
  Rejected: "feedback.status.rejected",
  "In Progress": "feedback.status.inDevelopment",
  Resolved: "feedback.status.resolved",
  Shipped: "feedback.status.released",
};

export function formatFeedbackStatusLabel(
  status: FeedbackTicketStatus,
  formatMessage: MessageFormatter,
) {
  return formatMessage({ id: FEEDBACK_STATUS_MESSAGE_IDS[status] });
}
