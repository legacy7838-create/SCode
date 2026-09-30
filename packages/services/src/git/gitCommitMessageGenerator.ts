import type {
  GitCommitMessageConversationContext,
  GitDiffResult,
  GitFileChange,
  Locale,
  ZCodeWorkspaceGenerateTextParams,
} from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

const MAX_PROMPT_FILES = 20;
const MAX_DIFF_FILES = 8;
const MAX_DIFF_CHARS = 12_000;
const MAX_DIFF_CHARS_PER_FILE = 2_000;
const MAX_CONVERSATION_CONTEXT_MESSAGES = 12;
const MAX_CONVERSATION_CONTEXT_CHARS = 4_000;
const MAX_CONVERSATION_CONTEXT_CHARS_PER_MESSAGE = 600;
const MAX_COMMIT_MESSAGE_CHARS = 1_000;
const COMMIT_MESSAGE_QUERY_SOURCE = "git_commit_message";

const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .{1,100}$/;

interface GitCommitMessageCurrentModelProvider {
  readCurrentModel(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeWorkspaceGenerateTextParams["selection"] | null>;
}

interface GitCommitMessageTextGenerator {
  generateText(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    selection: ZCodeWorkspaceGenerateTextParams["selection"];
    prompt: string;
    querySource: string;
  }): Promise<{ text: string; selection: ZCodeWorkspaceGenerateTextParams["selection"] }>;
}

interface GitCommitMessageGeneratorOptions {
  currentModelProvider: GitCommitMessageCurrentModelProvider;
  textGenerator: GitCommitMessageTextGenerator;
  logger?: ServiceLogger;
}

class GitCommitMessageGenerationError extends Error {
  constructor(
    message: string,
    readonly reason: "model-unavailable" | "request-failed" | "invalid-output",
    readonly detail?: string,
  ) {
    super(message);
    this.name = "GitCommitMessageGenerationError";
  }
}

export class GitCommitMessageGenerator {
  constructor(private readonly options: GitCommitMessageGeneratorOptions) {}

  async generate(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    branchName: string | null;
    locale?: Locale;
    files: readonly GitFileChange[];
    diffs: readonly GitDiffResult[];
    conversationContext?: GitCommitMessageConversationContext;
  }): Promise<{ message: string; providerId: string; model: string }> {
    const selection = await this.resolveCurrentModel(params);
    const prompt = buildGitCommitMessageGenerationPrompt({
      branchName: params.branchName,
      locale: params.locale,
      files: params.files,
      diffs: params.diffs,
      conversationContext: params.conversationContext,
    });

    this.options.logger?.info(undefined, "generating git commit message", {
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      providerId: selection.providerId,
      model: selection.modelId,
      fileCount: params.files.length,
      diffCount: params.diffs.length,
      conversationMessageCount: params.conversationContext?.messages.length ?? 0,
      conversationOmittedMessageCount: params.conversationContext?.omittedMessageCount ?? 0,
    });

    const rawMessage = await this.complete({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      selection,
      prompt,
    });
    const validation = validateGeneratedGitCommitMessage(rawMessage);
    if (!validation.ok) {
      // The model may repeat prompts or return long explanatory text, which can cause error messages to get out of control when shoved directly into the UI.
      // Only a short preview is reserved here for users, and the complete model call details are recorded in the model log of the agent runtime.
      this.options.logger?.debug(undefined, "generated git commit message is invalid", {
        workspacePath: params.workspacePath,
        providerId: selection.providerId,
        model: selection.modelId,
        reason: validation.reason,
        preview: validation.preview,
      });
      throw new GitCommitMessageGenerationError(
        "The model did not return a usable Conventional Commit message.",
        "invalid-output",
        validation.preview,
      );
    }

    return {
      message: validation.message,
      providerId: selection.providerId,
      model: selection.modelId,
    };
  }

  private async resolveCurrentModel(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeWorkspaceGenerateTextParams["selection"]> {
    const currentModel = await this.options.currentModelProvider.readCurrentModel({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const modelId = currentModel?.modelId?.trim();
    const providerId = currentModel?.providerId?.trim();
    const options = currentModel?.options;
    if (!providerId || !modelId) {
      throw new GitCommitMessageGenerationError(
        "Could not read the current model.",
        "model-unavailable",
      );
    }
    return {
      providerId,
      modelId,
      ...(options
        ? {
            options: {
              ...options,
            },
          }
        : {}),
    };
  }

  private async complete(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    selection: ZCodeWorkspaceGenerateTextParams["selection"];
    prompt: string;
  }): Promise<string> {
    try {
      const result = await this.options.textGenerator.generateText({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        selection: params.selection,
        prompt: params.prompt,
        querySource: COMMIT_MESSAGE_QUERY_SOURCE,
      });
      return normalizeModelText(result.text);
    } catch (error) {
      if (error instanceof GitCommitMessageGenerationError) {
        throw error;
      }
      throw new GitCommitMessageGenerationError(
        "Model request failed.",
        "request-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function buildGitCommitMessageGenerationPrompt(params: {
  branchName: string | null;
  locale?: Locale;
  files: readonly GitFileChange[];
  diffs: readonly GitDiffResult[];
  conversationContext?: GitCommitMessageConversationContext;
}): string {
  const normalizedBranchName = params.branchName?.trim() || "(detached or unknown)";
  const language = resolveCommitMessageLanguage(params.locale);
  const visibleFiles = params.files.slice(0, MAX_PROMPT_FILES);
  const omittedFileCount = Math.max(0, params.files.length - visibleFiles.length);
  const fileSummary = visibleFiles
    .map((file) => `- ${file.kind} ${file.repoRelativePath} (+${file.added}/-${file.removed})`)
    .join("\n");
  const diffSummary = buildDiffSummary(params.diffs);
  const conversationSummary = buildConversationContextSummary(params.conversationContext);

  return [
    "Write exactly one Git commit message for the workspace changes below.",
    "Return only the commit message text.",
    "",
    "Hard requirements:",
    "- The first line must be a valid Conventional Commit subject.",
    "- Use one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.",
    "- Keep the Conventional Commit type and optional scope in English.",
    "- Write the subject and any body in the current language.",
    "- Keep the subject under 72 characters.",
    "- Use the current session conversation context only to infer user intent.",
    "- Do not mention the conversation, chat, prompt, or user request explicitly.",
    "- Do not explain your reasoning.",
    "- Do not repeat these instructions.",
    "",
    `Current branch: ${normalizedBranchName}`,
    `Current language: ${language}`,
    "",
    "Current session conversation context:",
    conversationSummary || "(not provided)",
    "",
    "Changed files:",
    fileSummary || "- (no file summary available)",
    omittedFileCount > 0 ? `- ... ${omittedFileCount} more files` : "",
    "",
    "Diff excerpts:",
    diffSummary || "(diff unavailable; infer only from the changed file summary)",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function resolveCommitMessageLanguage(locale?: Locale): "Chinese" | "English" {
  const candidate = locale ?? readRuntimeLocale();
  return candidate?.toLowerCase().startsWith("zh") ? "Chinese" : "English";
}

function readRuntimeLocale(): string | undefined {
  try {
    // When the system default language is not explicitly passed in from the UI, the service layer can only read the Intl locale of the current runtime.
    // Here we still only accept zh as Chinese, and other unknown or failed reads will be treated as English to avoid accidentally generating a third language.
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

function validateGeneratedGitCommitMessage(
  rawMessage: string,
): { ok: true; message: string } | { ok: false; reason: "empty" | "invalid"; preview?: string } {
  const message = stripGeneratedCommitMessageDecorations(rawMessage)
    .trim()
    .slice(0, MAX_COMMIT_MESSAGE_CHARS)
    .trim();
  if (!message) {
    return { ok: false, reason: "empty" };
  }

  const subject = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!CONVENTIONAL_COMMIT_RE.test(subject)) {
    return { ok: false, reason: "invalid", preview: subject || message.slice(0, 120) };
  }
  return { ok: true, message };
}

function buildDiffSummary(diffs: readonly GitDiffResult[]): string {
  let totalChars = 0;
  const chunks: string[] = [];
  for (const diff of diffs.slice(0, MAX_DIFF_FILES)) {
    const header = `--- ${diff.path}`;
    const body = diff.patch?.trim() || diff.summary?.trim() || "(diff unavailable)";
    const remainingChars = MAX_DIFF_CHARS - totalChars;
    if (remainingChars <= 0) {
      break;
    }
    const clippedBody = clipText(
      body,
      Math.min(MAX_DIFF_CHARS_PER_FILE, remainingChars),
      "...diff truncated...",
    );
    const chunk = `${header}\n${clippedBody}`;
    chunks.push(chunk);
    totalChars += chunk.length;
  }
  return chunks.join("\n\n");
}

function buildConversationContextSummary(
  context: GitCommitMessageConversationContext | undefined,
): string {
  const messages = context?.messages ?? [];
  if (messages.length === 0) {
    return "";
  }

  const chunks: string[] = [];
  let totalChars = 0;
  const omittedMessageCount =
    (context?.omittedMessageCount ?? 0) +
    Math.max(0, messages.length - MAX_CONVERSATION_CONTEXT_MESSAGES);
  if (omittedMessageCount > 0) {
    chunks.push(`- ${omittedMessageCount} earlier messages omitted`);
  }

  for (const message of messages.slice(-MAX_CONVERSATION_CONTEXT_MESSAGES)) {
    const content = normalizeConversationContextText(message.content);
    if (!content) {
      continue;
    }

    const role = message.role === "assistant" ? "Assistant" : "User";
    const clippedContent = clipText(
      content,
      MAX_CONVERSATION_CONTEXT_CHARS_PER_MESSAGE,
      "...message truncated...",
    );
    const nextChunk = `${role}: ${clippedContent}`;
    const remainingChars = MAX_CONVERSATION_CONTEXT_CHARS - totalChars;
    if (remainingChars <= 0) {
      break;
    }

    const clippedChunk = clipText(nextChunk, remainingChars, "...conversation truncated...");
    chunks.push(clippedChunk);
    totalChars += clippedChunk.length + 1;
  }

  return chunks.join("\n");
}

function normalizeConversationContextText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function clipText(value: string, maxChars: number, marker: string): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - marker.length - 1)).trimEnd()}\n${marker}`;
}

function stripGeneratedCommitMessageDecorations(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const withoutFence = fenced?.[1] ?? trimmed;
  const withoutPrefix = withoutFence.replace(/^commit message:\s*/i, "").trim();
  if (
    (withoutPrefix.startsWith('"') && withoutPrefix.endsWith('"')) ||
    (withoutPrefix.startsWith("'") && withoutPrefix.endsWith("'"))
  ) {
    return withoutPrefix.slice(1, -1);
  }
  return withoutPrefix;
}

function normalizeModelText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("The model response has no text content.");
  }
  return value.trim();
}
