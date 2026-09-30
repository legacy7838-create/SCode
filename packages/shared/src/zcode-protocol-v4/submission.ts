import { z } from "zod";

/** Agent modes the Composer can submit explicitly; auto is an internal Runtime state and never enters a user Submission. */
export const submissionModeSchema = z.enum(["build", "edit", "plan", "yolo"]);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;
