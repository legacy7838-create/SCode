/**
 * The driver's **observation** vocabulary for one ask: usage ({@link AskStats}) and progress ({@link AskProgress}) —
 * the two halves reported by a single turn resolution, one the bill, the other "is it still moving?".
 *
 * The reason for splitting this out of types.ts is the same one as for imported-cache-types.ts: that contract has reached oxlint's max-lines
 * limit. The public surface is unchanged — types.ts re-exports every name here in place, and the import path is still `./types.js`.
 */

/** The usage statistics the driver reports on completing an ask. */
export interface AskStats {
  tokens: number;
  toolCalls: number;
  turns: number;
  /**
   * The number of calls that **looked at or touched the outside world**: reading files, running commands, hitting the network.
   * It excludes the protocol tools that only hand a result or a question back to the engine (`submit_result`, `escalate`), so a typed ask that only answers is 0 here — such an ask is
   * **pure**, depending on nothing but the instructions and the transcript prefix, and it can still settle from cache once import caching is turned off.
   * Old journal rows have no such key and are all treated as "it touched something" (the conservative choice).
   */
  worldToolCalls?: number;
}

/**
 * The character limit (240) of `instructionsHead` on `node-queued`. Enough for a sentence or two to explain this ask,
 * without letting the event table grow a second copy of the instructions — the full instructions live on the `dwf_node.input_json` side.
 */
export const INSTRUCTIONS_HEAD_MAX_CHARS = 240;

/** The character limit (64) of `lastTool.name` on `node-progress`: a tool name, not a description. */
export const LAST_TOOL_NAME_MAX_CHARS = 64;

/**
 * The character limit (120) of `lastTool.target` on `node-progress`: a clue for human eyes (a file path /
 * command head), not the arguments themselves — the arguments can hold anything, and this event is read by the main agent and drawn by the GUI.
 */
export const LAST_TOOL_TARGET_MAX_CHARS = 120;

/**
 * The most recently observed tool call (the `lastTool` of {@link AskProgress}).
 * `target` is a clue **for** human eyes, not the arguments: file tools give a path, Bash gives the command head, and it is absent when nothing can be recognized.
 */
export interface AskLastTool {
  /** The tool name, ≤ {@link LAST_TOOL_NAME_MAX_CHARS}. */
  name: string;
  /** A short target, ≤ {@link LAST_TOOL_TARGET_MAX_CHARS}; absent when it cannot be determined (no synthesized placeholder string). */
  target?: string;
}

/**
 * An ask's progress at **the moment its turn resolution happens**.
 * The two halves of the same driver report as {@link AskStats}: stats is the bill (tokens), progress is "is it still moving?".
 */
export interface AskProgress {
  /** The number of turns resolved within this ask, counting from 1 (the nudge round counter; repair rounds are not counted — they do not end a turn). */
  turn: number;
  /** The cumulative number of tool calls within this ask, the very same counter as {@link AskStats.toolCalls}. */
  toolCalls: number;
  lastTool?: AskLastTool;
}
