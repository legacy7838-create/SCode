import { create } from "zustand";
import type {
  FeedbackTicketModule,
  FeedbackTicketSeverity,
  FeedbackTicketType,
} from "@zcode/shared";

type FeedbackTab = "submit" | "tickets";

export interface FeedbackAttachmentDraft {
  readonly filename: string;
  readonly contentType: string;
  readonly dataBase64: string;
  readonly size: number;
}

export interface FeedbackSubmitDraft {
  readonly title?: string;
  readonly description?: string;
  readonly contact?: string;
  readonly type?: FeedbackTicketType;
  readonly module?: FeedbackTicketModule;
  readonly severity?: FeedbackTicketSeverity;
  readonly screenshots?: readonly FeedbackAttachmentDraft[];
  readonly includeLogs?: boolean;
}

interface FeedbackUiState {
  open: boolean;
  featureRequestOpen: boolean;
  tab: FeedbackTab;
  submitDraft: FeedbackSubmitDraft | null;
  /** Set when viewing only specified background submissions; new feedback must remain null */
  submissionJobId: string | null;
  /** Optionally highlight a ticket when opening the "My Feedback" list */
  selectedTicketId: string | null;
  /** Immediately after opening, focus on the submission form */
  openSubmit: (draft?: FeedbackSubmitDraft) => void;
  /** Open the progress pop-up window of the specified background submission task */
  openSubmissionJob: (jobId: string) => void;
  /** Open independent product demand feedback pop-up window */
  openFeatureRequest: () => void;
  /** Immediately focus on the work order list after opening, optional highlight */
  openTickets: (ticketId?: string) => void;
  /** Switch tabs without closing dialog */
  setTab: (tab: FeedbackTab) => void;
  setSelectedTicketId: (ticketId: string | null) => void;
  close: () => void;
}

export const useFeedbackStore = create<FeedbackUiState>((set) => ({
  open: false,
  featureRequestOpen: false,
  tab: "submit",
  submitDraft: null,
  submissionJobId: null,
  selectedTicketId: null,
  openSubmit: (draft) =>
    set({
      // "Problem Reporting" is a new entry, and cannot implicitly continue the job that is still being uploaded last time.
      // Otherwise the new form will inherit the submitting status of the old job and prevent the user from continuing to submit.
      open: true,
      featureRequestOpen: false,
      tab: "submit",
      submitDraft: draft ?? null,
      submissionJobId: null,
      selectedTicketId: null,
    }),
  openSubmissionJob: (jobId) =>
    set({
      open: true,
      featureRequestOpen: false,
      tab: "submit",
      submitDraft: null,
      submissionJobId: jobId,
      selectedTicketId: null,
    }),
  openFeatureRequest: () =>
    set({
      // Demand feedback and problem reporting are two independent Dialogs that must be opened mutually exclusive to avoid double pop-up windows in the background floating layer or quick entry.
      open: false,
      featureRequestOpen: true,
      submitDraft: null,
      submissionJobId: null,
      selectedTicketId: null,
    }),
  openTickets: (ticketId) =>
    set({
      open: true,
      featureRequestOpen: false,
      tab: "tickets",
      submitDraft: null,
      submissionJobId: null,
      selectedTicketId: ticketId ?? null,
    }),
  setTab: (tab) =>
    set({
      tab,
      ...(tab === "submit" ? { submissionJobId: null } : {}),
    }),
  setSelectedTicketId: (ticketId) => set({ selectedTicketId: ticketId }),
  close: () =>
    set({
      open: false,
      featureRequestOpen: false,
      submitDraft: null,
      submissionJobId: null,
      selectedTicketId: null,
    }),
}));
