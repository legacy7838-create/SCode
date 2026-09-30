/**
 * Typed wrapper over the zcode-markdown napi binary
 * (spec: docs/specs/rust-native-markdown.md). Load errors are thrown loudly
 * by loadNative — there is no JS fallback here.
 */
import { loadNative } from "./loader.js";

/**
 * Field-for-field marked 17.0.1 token tree (serde). Consumers only read
 * documented marked fields; the shapes are pinned by the parity harness.
 */
export interface NativeMarkdownToken {
  raw: string;
  type: string;
  [field: string]: unknown;
}

export interface NativeParseDelta {
  /** How many leading previous tokens are reused (slice index for composition). */
  stablePrefixLen: number;
  /** Legacy `ParseState.stableTokenCount` formula value. */
  stableTokenCount: number;
  /** Only the re-lexed tail tokens; the stable prefix stays in the session. */
  newTokens: NativeMarkdownToken[];
}

export interface NativeMarkdownApi {
  MarkdownParser: new () => MarkdownParser;
}

/** napi class; one instance per `MarkdownText` mount. */
export interface MarkdownParser {
  parse(content: string, trailingUnstable: 0 | 2): Promise<NativeParseDelta>;
}

/**
 * Shape-compatible with opentui-core's `ParseState`
 * (`renderables/markdown-parser.d.ts`) — this is what seeds the renderable.
 */
export interface MarkdownParseState {
  content: string;
  tokens: NativeMarkdownToken[];
  stableTokenCount?: number;
}

export function loadMarkdown(): NativeMarkdownApi {
  return loadNative<NativeMarkdownApi>("zcode-markdown");
}

/**
 * Owns the native parser handle and the JS token array; reproduces the
 * legacy stable-prefix object sharing (`prevJs.slice(0, stablePrefixLen)`)
 * without marshalling the prefix every chunk.
 *
 * Sequencing: one in-flight parse per handle (the native state is
 * sequential). Deltas arriving while a parse is in flight coalesce at the
 * input — only the newest content is queued next — so the queue is bounded
 * by one in-flight parse plus one pending slot. Every produced result
 * advances the native state and the JS token array together; each waiting
 * `update` promise resolves with the state of the queued parse it was
 * folded into. Stale paints are prevented by the caller's content drop
 * guard.
 */
export function createMarkdownParseSession(): {
  update(content: string, trailingUnstable: 0 | 2): Promise<MarkdownParseState>;
} {
  const parser = new (loadMarkdown().MarkdownParser)();
  let tokens: NativeMarkdownToken[] = [];
  let inFlight = false;
  let pending: {
    content: string;
    trailingUnstable: 0 | 2;
    waiters: {
      resolve: (state: MarkdownParseState) => void;
      reject: (cause: unknown) => void;
    }[];
  } | null = null;

  function pump(): void {
    if (inFlight || pending === null) {
      return;
    }
    const job = pending;
    pending = null;
    inFlight = true;
    parser
      .parse(job.content, job.trailingUnstable)
      .then((delta) => {
        tokens = [...tokens.slice(0, delta.stablePrefixLen), ...delta.newTokens];
        const state: MarkdownParseState = {
          content: job.content,
          tokens,
          stableTokenCount: delta.stableTokenCount,
        };
        for (const waiter of job.waiters) {
          waiter.resolve(state);
        }
      })
      .catch((cause: unknown) => {
        for (const waiter of job.waiters) {
          waiter.reject(cause);
        }
      })
      .finally(() => {
        inFlight = false;
        pump();
      });
  }

  function update(
    content: string,
    trailingUnstable: 0 | 2,
  ): Promise<MarkdownParseState> {
    return new Promise<MarkdownParseState>((resolve, reject) => {
      const waiter = { resolve, reject };
      if (pending) {
        pending.content = content;
        pending.trailingUnstable = trailingUnstable;
        pending.waiters.push(waiter);
      } else {
        pending = { content, trailingUnstable, waiters: [waiter] };
      }
      pump();
    });
  }

  return { update };
}
