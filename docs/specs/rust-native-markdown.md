# Rust native port: TUI frame-producer markdown parse (`zcode-markdown`)

Status: active. Owner: MarkdownSpecAuthor2 (wave-2 port). Written 2026-09-28 **before**
implementation, per `docs/specs/rust-native-ports.md` (wave-2 entry
`rust-native-markdown.md` at `docs/specs/rust-native-ports.md:47`) and the
architecture-governance rule.

## Feasibility verdict (seam analysis — this decided the design)

**Verdict: FEASIBLE — seam (a).** opentui does not offer a documented "pre-parsed tokens"
prop, but it exposes an injection seam that is sufficient and stable at the type level:

1. `MarkdownRenderable._parseState` is a **public** field
   (`node_modules/@mbears/opentui-core/renderables/Markdown.d.ts:139` — note every truly
   private field around it carries the `private` modifier, :129-138, :140; `_parseState`,
   `_blockStates` (:141) and `_stableBlockCount` (:142) do not), and the `ParseState`
   type itself is re-exported from the renderable module
   (`renderables/Markdown.d.ts:127`, `renderables/markdown-parser.d.ts:2-6`).
2. `updateBlocks()` always runs
   `this._parseState = parseMarkdownIncremental(this._content, this._parseState, …)`
   (`index-1j83z2zx.js:9493`, `:9502-9503`), and `parseMarkdownIncremental` **reuses a
   seeded state by raw-prefix matching**: for each previous token it checks
   `newContent.startsWith(token.raw, offset)` and, when every token matches and the
   trailing re-lex slice is empty, it returns the seeded tokens **unchanged**
   (`index-1j83z2zx.js:8291-8314`). The trailing re-lex slice is empty iff
   `trailingUnstable === 0`, i.e. iff the renderable's `_streaming` is `false`
   (`:9502`, `:8311-8314`).
3. opentui-react assigns **arbitrary props directly onto the instance**: `setProperty`
   falls through to `instance[propKey] = propValue`
   (`node_modules/@mbears/opentui-react/chunk-28zb33zd.js:274-321`, default at
   `:318-319`), iterating the props object in insertion order both at mount
   (`setInitialProperties`, `:322-333`) and on update (`updateProperties`, `:334-347`).
   Therefore placing `_parseState` **before** `content` in the same props object
   guarantees the seed is applied before the `content` setter
   (`index-1j83z2zx.js:8391-8399`) triggers `updateBlocks()`.

Consequences that pin the design (all verified in this checkout):

- **JS `marked` lex is eliminated only when the renderable's `streaming` is `false`.**
  With `streaming: true`, `trailingUnstable = 2` (`index-1j83z2zx.js:9502`) makes
  `parseMarkdownIncremental` unconditionally re-lex the last two tokens' raws on every
  content change (`:8301-8319` — `reuseCount = max(0, matched - 2)`, then
  `x.lex(remainingContent)`); for messages with ≤2 tokens `reuseCount` is 0 and the JS
  lexer re-parses the **entire** content each delta. Seeding without flipping the flag
  would add native cost while keeping the JS hot path — pointless. The port therefore
  commits the markdown element with `streaming: false` **always** (see Divergences).
- **Mount must be content-empty.** The constructor copies `options.content`
  (`index-1j83z2zx.js:8380`) and calls `updateBlocks()` with `_parseState = null`
  (`:8353`, `:8386`) before opentui-react's `setInitialProperties` runs
  (`chunk-28zb33zd.js:367-370` → `:415-418`), so any non-empty mount JS-lexes once
  (`index-1j83z2zx.js:8279-8286`). The component therefore mounts the markdown element
  with `content: ""` (early return, no parse: `:9496-9500`) and commits
  `{_parseState, content}` together after the native parse resolves.
- **Finished-message skip is preserved for free.** React skips unchanged props
  (`chunk-28zb33zd.js:344`, `newProp !== oldProp`) and the content setter short-circuits
  on identical strings (`index-1j83z2zx.js:8394`); the wrapper never re-parses when
  `content` is unchanged, so a finalized message triggers zero native work and zero
  renderable work, exactly as today.

Rejected alternative (b) — rendering native-parsed blocks through opentui primitives —
is not needed and would be a second renderer for tables (`createTableBlock`,
`buildTableContentCache`), nested lists (`createListRenderable` tree
`index-1j83z2zx.js:8860-8874`), code fences, blockquotes, and inline styling
(`renderInlineToken`, `:8521-8615`): thousands of lines duplicating
`MarkdownRenderable` while still living inside the same node_modules package. Seeding
the public parse state keeps the entire render path byte-identical by construction.

## Scope (what is ported)

### 1. The parse step — `marked` 17.0.1 lex feeding `MarkdownRenderable`

- Legacy engine: opentui-core's inlined marked 17.0.1
  (`index-1j83z2zx.js:7012-7015` header + defaults; dependency pinned
  `node_modules/@mbears/opentui-core/package.json:58`), invoked as
  `x.lex(content, { gfm: true })` (`index-1j83z2zx.js:8281`, `:8319`; `x` is the marked
  `Lexer` class with static `lex`, `:7515-7531`) inside `parseMarkdownIncremental`
  (`:8278-8331`, typed at `renderables/markdown-parser.d.ts:11`), called synchronously
  from `updateBlocks()` during React commit (`:9503`).
- New engine: Rust crate `packages/rust/crates/zcode-markdown` (cdylib via
  `napi`/`napi-derive`, workspace members `crates/*` — `packages/rust/Cargo.toml:2`),
  loaded through `loadNative("zcode-markdown")` from the existing subpath
  `@zcode/rust/markdown` (`packages/rust/package.json:12`), typed wrapper
  `packages/rust/src/markdown.ts`.
- The crate ports the marked 17.0.1 **GFM lexer** (block + inline tokenization, no
  renderer) and the **incremental reuse protocol** of `parseMarkdownIncremental`
  (`:8291-8322`) exactly: prefix reuse by raw match, shrink by `trailingUnstable`,
  re-lex of the remaining slice, the fresh-parse path (`:8279-8289`), and the
  `stableTokenCount` formulas (`:8285`, `:8313`, `:8321`). For identical input sequences
  its token stream is identical to the legacy JS chain (parity oracle A below).

### 2. Integration contract in `app-markdown.tsx` (the only render site)

`h("markdown", …)` appears exactly once in the TUI
(`apps/zcode-cli/packages/tui/src/app-markdown.tsx:45-50`), fed from
`app-transcript-components.tsx:136-141` and `:176-181` (`content` + `streaming` props).
The rewrite keeps the `MarkdownText` public props (`app-markdown.tsx:8-14`) unchanged
and enforces four rules:

1. **Mount rule** — in `mode === "markdown"` with a `syntaxStyle`, always render the
   markdown element (never the empty-content `h("text")` branch at `:38-40`), starting
   with `content: ""` until the first parse resolves. Instance stays stable across the
   empty→content transition (no constructor lex). The `h("text")` fallbacks for missing
   `syntaxStyle` (`:52`, capability detection via `createMarkdownSyntaxStyle`
   `app-markdown-theme.ts:55-58`) and the `code`/`plain` modes (`:55-67`) are unchanged.
2. **Seed-order rule** — each commit passes `{ conceal: true, _parseState: state,
   content: state.content, syntaxStyle }` with `_parseState` **before** `content` in the
   object literal (prop application is insertion-ordered —
   `chunk-28zb33zd.js:322-333`/`:334-347`; the `h` helper already accepts untyped props,
   `app-markdown.tsx:16-20`). `state.content` and the content prop are always the same
   string in the same commit (atomic pair) — the seed is never stale relative to the
   content setter.
3. **Streaming rule** — the renderable's `streaming` prop is never `true` (omit it;
   constructor default is `false`, `index-1j83z2zx.js:8362-8367`). The message-level
   `streaming` prop from callers instead selects `trailingUnstable` for the **native**
   incremental protocol (2 while streaming, 0 after) — preserving the legacy token
   stream semantics (`:9502`) without invoking the JS lexer.
4. **Skip rule** — no native call when the content string is unchanged (finalized
   messages: `app-transcript-stream.ts:43-45` flips `streaming` while keeping the same
   content string), mirroring the prop-identity skip (`chunk-28zb33zd.js:344`).

## Crate / wrapper API

| export | signature | semantics |
|---|---|---|
| `MarkdownParser` (napi class) | `new MarkdownParser()` | Holds the Rust-side previous parse (content + token tree) for one markdown element. One instance per `MarkdownText` mount. |
| `MarkdownParser.parse` | `parse(content: string, trailingUnstable: 0 \| 2): Promise<NativeParseDelta>` | napi **AsyncTask** (see Ordering). Ports `parseMarkdownIncremental`: reuses the Rust previous state by raw-prefix match, shrinks by `trailingUnstable`, re-lexes the remainder with the marked-17.0.1-equivalent GFM lexer. |
| `NativeParseDelta` | `{ stablePrefixLen: number, stableTokenCount: number, newTokens: NativeMarkdownToken[] }` | `newTokens` is **only the re-lexed tail**; the stable prefix stays in the native state and in the wrapper's JS token array. `stablePrefixLen` = how many of the previous tokens are reused (the exact slice index for JS composition); `stableTokenCount` = the legacy `ParseState.stableTokenCount` formula value (`:8285` fresh path `n - trailingUnstable`, `:8313`/`:8321` reuse paths). First call (`prev = null`, legacy `:8279-8286`): `stablePrefixLen = 0`, `newTokens` = all tokens. |
| `NativeMarkdownToken` | JSON tree (serde) | Field-for-field identical to marked 17.0.1 token objects (see Parity table); `raw` bytes exact. |
| `loadMarkdown()` | `(): NativeMarkdownApi` in `packages/rust/src/markdown.ts` | `loadNative<…>("zcode-markdown")` following `packages/rust/src/diff.ts:21-23`; throws loudly on missing binary (`packages/rust/src/loader.ts:59-68`). |
| `createMarkdownParseSession()` | `(): { update(content: string, trailingUnstable: 0 \| 2): Promise<MarkdownParseState>; }` in `packages/rust/src/markdown.ts` | Owns the native parser handle + the JS token array; composes `tokens = [...prevJs.slice(0, stablePrefixLen), ...newTokens]` — reproducing the legacy stable-prefix object sharing (`index-1j83z2zx.js:8310`, `markdown-parser.d.ts:8-10`) without marshalling the prefix every chunk — and builds the seed `{ content, tokens, stableTokenCount }` with the delta's legacy-formula `stableTokenCount`. Returns the full `MarkdownParseState` (`markdown-parser.d.ts:2-6`). |

`NativeMarkdownApi` = `{ MarkdownParser: new () => MarkdownParser }` — same shape
convention as `NativeDiffApi` (`packages/rust/src/diff.ts:14-19`).

## Parity table vs marked 17.0.1 / legacy chain

Oracle A (primary, invariant 3): for an identical input sequence, the native chain's
composed token stream must be JSON-deep-equal to the legacy
`parseMarkdownIncremental` chain. The harness obtains the exact legacy algorithm by
extracting `function parseMarkdownIncremental …` verbatim from the bundle
(`index-1j83z2zx.js:8278-8331`, source-anchored, no re-implementation drift) and feeding
it `Lexer.lex` from `marked@17.0.1` (the same version opentui pins,
`@mbears/opentui-core/package.json:58`).

| aspect | legacy / marked 17.0.1 | native requirement | verification |
|---|---|---|---|
| lex entry & options | `x.lex(content, { gfm: true })` on a fresh `Lexer` (`:8281`, `:7529-7531`); defaults `gfm: true, breaks: false, pedantic: false, extensions: null, hooks: null` (`:7013-7015`); no extension hooks reachable (`:7547` reads `options.extensions` which the `{gfm:true}`-only call never sets) | same options pinned in the port; no extensions/hooks/walkTokens | fixtures + fuzz (below) |
| `\r` normalization | lexer replaces `\r` variants with `\n` before tokenizing (`:7535-7536`); token `raw`s therefore contain no `\r` | byte-identical `raw`s (CRLF content makes raw-prefix reuse fail every chunk → full re-lex — **both** legacy and native behave this way; enumerated) | CRLF fixture in chain harness |
| token types (block) | whatever marked emits; consumers require `space` (`:8983-9013`, `:9355-9356`), `heading`, `paragraph`, `text`, `code`, `table`, `list`, `blockquote`, `hr`, `html` (raw fallback `:9358`), nested `list_item` children incl. `checkbox`/`space` (`:8751-8817`) | JSON-identical objects for every type marked emits; `raw` of each token byte-exact | fixtures per type + fuzz vs `marked@17.0.1` |
| token types (inline) | `text`, `escape`, `codespan`, `strong`, `em`, `del`, `link`, `image`, `br` + default nested-token/`text` fallback (`:8521-8615`); fields read: `text`, `tokens`, `href` | identical nesting and fields | same |
| raw-concat invariant | `tokens.map(t => t.raw).join("")` equals the (CR-normalized) content — this is what makes seeded reuse skip the JS lex (`:8291-8300`) | harness asserts it every step; the wrapper asserts it for `\n`-only content (CRLF input is the enumerated exemption where the JS lexer takes over, exactly as in legacy) | asserted per harness step |
| incremental protocol | prefix reuse by `startsWith(token.raw, offset)`, shrink by `trailingUnstable`, tail re-lex (`:8291-8322`); fresh path (`:8279-8286`) | same, in Rust, same boundary | chain harness (oracle A) with per-delta sequences (1-token paragraphs, growing lists, partial tables, unclosed fences) |
| `stableTokenCount` | `n - trailingUnstable` (fresh, `:8285`); `stable` / `stable+new` rules (`:8313`, `:8321`) | same formulas in `NativeParseDelta` | chain harness |
| object identity | stable-prefix token objects are shared across chunks (`markdown-parser.d.ts:8-10`) | wrapper reuses its JS objects for the prefix (`prevJs.slice(0, stablePrefixLen)`) — same sharing | identity assertions in harness |
| zero-JS-lex proof | seeded state + `trailingUnstable = 0` returns the seed's token objects unchanged (no lex can have run) | harness calls the extracted legacy fn with the native seed and asserts element-wise `===` on the returned tokens | harness assertion |
| rendered equivalence | frames produced by `MarkdownRenderable` from seeded vs legacy parse state | token JSON equality implies identical `updateBlocks` input; live TUI smoke covers the rest | acceptance smoke |

## Ordering / async / abort

- **AsyncTask decision (invariant 4).** Every `parse` runs as a napi AsyncTask (Promise),
  regardless of chunk size. Input per call is the full current message content (streamed
  deltas typically append 1–500 bytes; message content grows to 1–100+ KB), so per-call
  work is O(content) on the fresh/reuse paths (worst case ≤2-token messages re-lex the
  whole content, the same
  case where legacy did a full sync `x.lex` per delta) and the caller thread pays
  O(content) string ingestion plus O(tail) result construction — both above ~1 ms for
  large messages; legacy did this synchronously inside commit
  (`index-1j83z2zx.js:8391-8399`, applied by `commitUpdate`
  `chunk-28zb33zd.js:420-422`). For rich messages the marshalled tail is only the last
  two tokens' worth (stable prefix is not marshalled), matching legacy's per-commit
  work profile. Thread-pool dispatch overhead at stream-delta rates (≤ ~60/s) is
  negligible. No sync export exists (no caller needs one).
- **Sequencing.** One in-flight parse per session handle (native state is sequential).
  Deltas arriving while a parse is in flight **coalesce at the input**: only the newest
  content is queued next; results are never dropped, so the native state and the
  wrapper's JS token array always advance together. The React side applies a result only
  when `state.content` equals the content it currently intends to render (drop guard).
- **Abort parity (invariant 6).** The legacy API accepted no `AbortSignal` and no
  timeout — `MarkdownTextProps` (`app-markdown.tsx:8-14`) and `MarkdownOptions`
  (`Markdown.d.ts:68-106`) have no cancellation field; the legacy parse was synchronous
  and therefore never needed one. Native preserves the observable semantics: results are
  applied in order and only for the latest intended content; an unmount mid-parse
  discards the resolved state via a mounted/content guard (the task itself is tiny and
  completes). There is no signal to forward because none existed.
- **Cheap finalize.** When `streaming` flips false with unchanged content
  (`app-transcript-stream.ts:43-45`, `:50-53`), the wrapper makes **no** native call and
  the renderable sees no prop change → no parse, no `updateBlocks`
  (`chunk-28zb33zd.js:344`). Legacy did run `updateBlocks(true)` on that flip
  (`index-1j83z2zx.js:8450-8456`); the skipped refresh re-renders already-current blocks
  (enumerated divergence).

## Ownership

| Piece | Owner |
|---|---|
| `packages/rust/crates/zcode-markdown/**` | MarkdownSpecAuthor2 |
| `packages/rust/src/markdown.ts` (subpath binding: types + `loadMarkdown()` + parse session) | MarkdownSpecAuthor2 |
| `docs/specs/rust-native-markdown.md` (this file) | MarkdownSpecAuthor2 |
| `apps/zcode-cli/packages/tui/src/app-markdown.tsx`, `apps/zcode-cli/packages/tui/package.json` (adds `@zcode/rust: workspace:*`, precedent `core/package.json:36`) | MarkdownSpecAuthor2 |
| `packages/rust` shared scaffold (`Cargo.toml`, `package.json`, `tsconfig.json`, `src/loader.ts`, `src/index.ts`, `scripts/build-native.sh`), umbrella spec, policy, lockfile, CLI `build.mjs` | main session (never edited by MarkdownSpecAuthor2) |

No shared-file change is required: workspace members glob `crates/*`
(`packages/rust/Cargo.toml:2`), `build-native.sh` globs `crates/*/`
(`packages/rust/scripts/build-native.sh:21`), the `./markdown` export already exists
(`packages/rust/package.json:12`), `@zcode/rust` is already esbuild-external in the CLI
(`apps/zcode-cli/packages/cli/scripts/build.mjs:14`), and `architecture-policy.yaml`
treats `packages/rust/src` as one managed-`false` domain with no per-port entries
(`architecture-policy.yaml:56-59`). The only main-session side effect is the lockfile
update when the tui dependency lands.

## Invariants (engine rules 1–7)

1. **Zero JS fallback.** `app-markdown.tsx` calls the native session directly; a missing
   or broken binary throws from `loadNative` (`packages/rust/src/loader.ts:64-68`)
   during render — there is no `try { native } catch { legacy }`, no env flag, no
   "plain text if parse failed" downgrade (such a branch would be a fallback and is
   forbidden). The legacy lex code itself lives in node_modules and cannot be deleted;
   it is instead made **unreachable**: every content commit carries a seed, so the JS
   lexer never runs (proven by the zero-JS-lex identity assertion), except the
   enumerated CRLF case where legacy had the same behavior.
2. **Legacy deleted, not disabled.** The repo-side legacy invocation — the
   content-only `h("markdown", { conceal, content, streaming, syntaxStyle })` shape
   (`app-markdown.tsx:45-50`) — is replaced wholesale in the same change; after the
   port no unseeded `h("markdown")` call site exists (grep proof in acceptance). The
   TUI has no `marked` dependency to remove (`apps/zcode-cli/packages/tui/package.json:21-31`
   lists none); `marked` stays in `@mbears/opentui-core` (upstream) and in core
   (`apps/zcode-cli/packages/core/package.json:43`, v16.4.2 — the memory indexer, a
   different feature, see Non-goals).
3. **Wire shapes unchanged.** The token stream crossing the renderable boundary is
   JSON-identical to legacy (Parity table); rendered frames are produced by the same
   `MarkdownRenderable.updateBlocks` from the same token bytes.
4. **Event-loop rule.** All native parse work is a napi AsyncTask (see Ordering); no
   synchronous native markdown export exists.
5. **Process rule.** The ported feature spawns nothing (pure string compute in-process).
   Sibling features stay as-is and are documented under Non-goals — they are separate
   features, not fallbacks.
6. **Abort/cancellation parity.** No legacy signal existed; order-and-drop-guard
   semantics documented above.
7. **Packaging.** `@zcode/rust` remains esbuild-external in the CLI
   (`apps/zcode-cli/packages/cli/scripts/build.mjs:14`). The tui esbuild build bundles
   `@zcode/*` TypeScript but never `.node` bytes
   (`apps/zcode-cli/packages/tui/scripts/build.mjs:16` — external list excludes
   `@zcode/*`; the loader resolves the binary from disk at runtime, with
   `require.resolve("@zcode/rust/package.json")` reachable through the declared tui
   dependency).

## Failure semantics

- **Binary missing / load failure** → `loadNative` throws an actionable error
  (`packages/rust/src/loader.ts:59-68`). No silent empty render, no plain-text
  downgrade, no JS parse path.
- **Parse errors.** marked's lexer with these options is total over strings; legacy
  still wrapped it in try/catch mapping any throw to `{ tokens: [], stableTokenCount: 0 }`
  (`index-1j83z2zx.js:8287-8289`, `:8324-8329`), which makes the renderable fall back
  to rendering the raw content as one code block (`:9505-9519`). The Rust port has no
  throw/panic path for any string input, so that fallback is never entered (enumerated
  divergence below).
- **Stale-result drop.** Applying a parse result for content the component no longer
  renders is prevented by the content guard; this is a correctness property of the
  wrapper, not an error path.

## Non-goals / unported sibling features (NOT fallbacks)

- **tree-sitter WASM syntax highlighting** (bundled parsers incl. markdown,
  `node_modules/@mbears/opentui-core/index-ba782b4w.js:7449-7498`, worker-based,
  `treeSitterClient` prop `Markdown.d.ts:77`) — unchanged sibling feature.
- **shiki for diff views** (`apps/zcode-cli/packages/tui/src/app-shiki-highlighter.ts:43`,
  `:66-67`, `:77` content-keyed cache) — unchanged sibling feature, not streaming.
- **Desktop/web renderer markdown** — `streamdown`/`unified`
  (`packages/ui/src/components/ai-elements/message.tsx:41`,
  `packages/ui/package.json:75`, `:92`) in the Electron renderer process; no `.node`
  may load there (umbrella `docs/specs/rust-native-ports.md:48`).
- **Memory-index lexing** — `import { Lexer } from "marked"` in
  `apps/zcode-cli/packages/core/src/memory/index-content.ts:1` (marked 16.4.2) — a
  different feature on a different path.
- **`MarkdownText` `code`/`plain` modes and the missing-`syntaxStyle` text fallback**
  (`app-markdown.tsx:52`, `:55-67`) — capability detection, unchanged.
- **`renderNode` custom rendering** (`Markdown.d.ts:100`) — unused, unchanged; no
  changes to `@mbears/opentui-core` / `@mbears/opentui-react` (upstream read-only).
- No change to transcript data flow (`app-transcript-components.tsx`,
  `app-transcript-stream.ts`), no scrollback/virtualization changes.

## Migration boundary

Consumers keep calling `MarkdownText` with the same props
(`app-transcript-components.tsx:136-141`, `:176-181` — untouched).

Files changed in the same commit:

| file | change |
|---|---|
| `packages/rust/crates/zcode-markdown/**` | new crate (lexer port + incremental protocol + napi class) |
| `packages/rust/src/markdown.ts` | new wrapper: `loadMarkdown()`, `MarkdownParseState`, `createMarkdownParseSession()` |
| `apps/zcode-cli/packages/tui/src/app-markdown.tsx` | markdown branch rewritten to the four integration rules; content-only invocation (`:45-50`) deleted; empty-content `h("text")` shortcut (`:38-40`) deleted for markdown mode (mount rule) |
| `apps/zcode-cli/packages/tui/package.json` | add `"@zcode/rust": "workspace:*"` |
| `docs/specs/rust-native-markdown.md` | this file |

Deleted (invariant 2): the legacy renderable-driving contract — passing raw
`content` + `streaming` straight into `h("markdown")` — and the markdown-mode empty
shortcut. Nothing else in the repo called the marked frame path (grep: the only
`h("markdown")` site is `app-markdown.tsx:45`).

## Divergences enumerated

1. **`streaming: false` on the renderable while a message streams** (required for the
   zero-JS-lex seam; the documented contract says keep it true while appending —
   `Markdown.d.ts:78-91`). Consequences, all inside opentui-core:
   - Fenced code blocks inside streamed markdown receive
     `streaming: false, drawUnstyledText: !streaming`
     (`index-1j83z2zx.js:8895-8900`, `:8937-8941`). Legacy deferred highlighting during
     streaming (`index-ba782b4w.js:18219-18223`) and applied it at finalize
     (`:18267-18273`); native schedules highlight work per dirty frame during the
     stream instead (still worker-side, off the main thread). **Converges at settle;
     verified visually in the TUI smoke (fenced code during and after streaming).**
     This is the top risk of this design; if the visual difference is unacceptable the
     only seam-preserving mitigation is a custom `renderNode` for `code` tokens
     (`Markdown.d.ts:100`) — an implementation-wave decision for main.
   - `stableTokenCount` seen by the renderable is `n` instead of legacy's `n-2` during
     streaming (`:8321` vs `:9503` path with `trailingUnstable = 0`). The field is only
     consumed in `internalBlockMode: "top-level"` (`:9428`); the app runs the default
     `coalesced` mode (`Markdown.d.ts:145-151`; no prop passed at
     `app-markdown.tsx:45-50`), where `_stableBlockCount` is reset to 0
     (`index-1j83z2zx.js:9524`) and has no readers. No rendering effect.
   - No `updateBlocks(true)` force-refresh at finalize (legacy `:8450-8456`); blocks are
     already current for the final tokens — visually idempotent (smoke-checked).
2. **Async paint timing.** Legacy parsed and painted the new content in the same commit;
   native paints after the AsyncTask resolves (≤1 frame later typically). Required by
   invariant 4.
3. **Input coalescing.** If deltas arrive faster than parses, intermediate chunk states
   may never paint (legacy painted every delta). Bounds: at most one intermediate state
   per in-flight parse; content only grows.
4. **Mount shape.** The markdown element mounts with `content: ""` and fills on first
   resolve instead of painting the constructor-parsed content in the mount commit — a
   possible ≤1-frame empty box on first appearance (scrollback or first delta); in
   exchange the legacy mount-time full JS lex (`:8380` + `:8386`) is gone.
5. **Legacy lexer-throw fallback** (`tokens: []` → raw code block, `:9505-9519`) is
   unreachable in native (no throw path; no extensions registered — `:7547`).
6. **CRLF content** keeps a residual JS full re-lex per delta (raw-prefix reuse cannot
   match raws that lack `\r`, `:8291-8300` vs normalization `:7535-7536`) — byte-for-byte
   the behavior legacy had on the same input, so parity holds; only the perf win is
   absent for that (rare) input class.
7. **Theme flip to a markdown-less style** (`createMarkdownSyntaxStyle` throws →
   `undefined`, `app-markdown-theme.ts:55-58`) swaps the element type markdown→text and
   back, causing one constructor JS lex on the next markdown mount — identical to legacy
   behavior on that path.

## Performance (fast-path design)

Fast-path strategy: keep `fancy-regex` as the semantics oracle (all patterns
are byte-pinned dumps of marked 17.0.1 rules, `src/rules.rs`), but bypass the
backtracking engine on the hottest per-byte loops with byte-equivalent
hand scans, each verified byte-equal by the parity harness (oracle A):

| site | before (fancy-regex) | after (hand scan) | why safe |
|---|---|---|---|
| inline codespan (`t_codespan`, `lexer.rs`) | `` /^(`+)(...)\1(?!`) `` backref scan | maximal-backtick-run byte scan, first same-length closer wins | opener/closer runs are pure `` ` `` bytes; `(?!`)` fails inside longer runs by construction |
| inline text (`t_inline_text`, `lexer.rs`) | gfm text alternation with 3 zero-width lookahead families | byte scan over ASCII stop bytes + `  +\n` / `email+@` / `http\|ftp://\|www.` checks | stops trigger only at ASCII bytes (always UTF-8 boundaries); case-insensitive `http` via `\| 0x20` |
| inline dispatch (`inline_tokens_core_inner`) | every tokenizer regex `exec` per loop iteration | literal first-byte guard (`b0` match) before each `exec` | every inline rule's pattern starts with a fixed byte; non-matching tokenizers are skipped without engine entry |
| em-strong rdelim prefilter (`t_em_strong`) | full O(tail) backtracking scan even with no closer | `masked.as_bytes().contains(&delim_byte)` early-out | both rdelim rules require a literal delimiter run, so a tail without that byte can never capture |
| block-skip mask loop | unanchored backtracking search from every position | jump to next `[`/`` ` ``/`<` candidate byte first | `block_skip`'s three alternatives can only start at those bytes (engine search is "try each position in order") |
| list dynamic rules | `new RegExp` compile per list item | `cached_dynamic` memo by pattern string | patterns are pure functions of marked's arguments |

What stays `fancy-regex` (correctness over speed): block rules
(paragraph/table/blockquote/list/html/def/hr/fences/heading — backrefs,
lookbehind, `\p{...}` classes have no cheap hand equivalent), inline
escape/link/reflink/tag/autolink/url/del/br, and all `other` helper patterns.
Heading, fences, escape, and plain-paragraph lexing therefore still go through
the engine; their `bench_fastpath` numbers are the regression baseline, not a
claim of hand-scan speed.

0-JS-fallback reaffirmed: none of the above adds a JS path. `loadMarkdown()`
(`packages/rust/src/markdown.ts`) still throws loudly via `loadNative` on a
missing/broken binary (`packages/rust/src/loader.ts`); there is no
`try { native } catch { legacy }`, no env flag, no plain-text downgrade
(invariant 1). Perf work only changes *how fast* the Rust lexer runs, never
*where* parsing happens.

In-crate benches (`cargo test -p zcode-markdown -- --ignored --nocapture`):
`bench::bench_inline` (em/strong, codespan), `bench2::bench_parts`
(paragraph/block-skip/any-punct/full-lex/heading/codespan/links), and
`bench_fastpath::bench_fastpath_cases` (heading/fences/escape/codespan/
plain-paragraph, criterion-style `BENCH <case>: <mean>/parse (iters=N)` lines
for before/after diffing). Representative run (debug build, this machine):

- `BENCH paragraph-regex: 1.962036ms/exec`
- `BENCH block-skip-regex: 2.122531ms/scan`
- `BENCH any-punct-regex: 6.339µs/scan`
- `BENCH full-lex: 5.707738ms/parse (inline portion: 14715us)`
- `BENCH heading-lex: 41.348µs/parse`
- `BENCH codespan-lex: 25.813691ms/parse`
- `BENCH links-lex: 31.705809ms/parse`

(Rerun after this change for the `bench_fastpath` per-case table; numbers are
machine/build-profile-relative and only meaningful as in-place diffs.)
`bench_fastpath` run (same machine, debug build, with warmup):

- `BENCH heading: 36.096µs/parse (iters=1000)`
- `BENCH fences: 44.101µs/parse (iters=500)`
- `BENCH escape: 163.06µs/parse (iters=500)`
- `BENCH codespan: 8.481248ms/parse (iters=20)`
- `BENCH plain-paragraph: 6.230297ms/parse (iters=20)`

## Evidence & acceptance checklist (implementation wave)

Throwaway harness in `/tmp` (deleted after run; results quoted in the delivery report):

1. **Chain parity (oracle A):** extract `parseMarkdownIncremental` from
   `node_modules/@mbears/opentui-core/index-1j83z2zx.js:8278-8331` (source-anchored),
   run it with `marked@17.0.1` `Lexer.lex` over fixture chunk sequences (headings,
   nested/loose/task lists, partial & ragged tables, unclosed fences, blockquotes,
   HTML blocks, links w/ reference defs, inline styles, unicode, CRLF, 1-token
   paragraph growth) and compare per-step token JSON with the native chain; fuzz
   (seeded) append sequences.
2. **Raw-concat + identity:** every native step asserts `raw`s concat to the
   (CR-normalized) content and — for `\n`-only content — that the seeded call returns
   prefix objects unchanged (⇒ JS lexer provably skipped).
3. **Direct-load smoke:** `node -e require('./packages/rust/zcode-markdown.linux-x64-gnu.node')`
   + a parse exercising the API surface.
4. **Grep proofs:** no unseeded `h("markdown")`; no `catch` → plain-text/legacy shape
   around `loadMarkdown`; `streaming: true` never passed to the markdown element.
5. **Typecheck/lint/architecture:** `pnpm --filter @zcode/tui typecheck`,
   `oxlint src` on owned files, `pnpm architecture:check --changed` — no new violations
   (respect `architecture-policy.yaml:66` 400-line cap in `app-markdown.tsx`).
6. **Live TUI smoke:** run the CLI TUI; stream a reply containing heading, list, table,
   fenced code (JS/TS), blockquote, links and inline styles; verify progressive render,
   finalize render, scrollback of finished messages (mount path), and the fenced-code
   highlight timing (divergence 1); finished message causes zero re-parse (instrument the
   wrapper's call count).
7. **Perf evidence:** before/after wall-time of the commit path on a worst-case sparse
   stream (single growing paragraph, the legacy full-re-lex-per-delta case
   `:8299-8301`) and a rich stream; report main-thread delta cost and confirm the JS
   lexer is absent from the hot path (identity assertion covers the mechanism).
