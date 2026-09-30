// zcode-markdown: native markdown parse for the TUI frame producer.
// Spec: docs/specs/rust-native-markdown.md — port of the marked 17.0.1 GFM
// lexer plus the incremental reuse protocol of opentui's
// `parseMarkdownIncremental`. There is no JS fallback by design.

use std::sync::Arc;

use napi::bindgen_prelude::{AsyncTask, Task};
use parking_lot::Mutex;
use napi_derive::napi;
use serde_json::Value;

mod emstrong;
mod helpers;

pub static GUARD_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static TAIL_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static LOOP_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static LOOP_ITERS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static TEXT_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static TEXT_CALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static MASK_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static INLINE_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
mod lexer;
mod par_inline;
mod rules;
mod scanners;

/// Previous parse held per markdown element (legacy `ParseState` on the JS
/// side holds `content` too, but `parseMarkdownIncremental` only ever reads
/// `prevState.tokens`, so the native state mirrors that). `tokens` are the
/// full token tree; their `raw`s are CR-normalized (marked normalizes at lex
/// entry), which is why prefix reuse fails on every chunk of CRLF content —
/// byte-for-byte the legacy behavior (spec divergence 6).
///
/// Each token is `Arc`-shared so the protocol's stable-prefix reuse
/// (`tokens[..reuse]` carried into the next state) is a pointer copy — legacy
/// shares the same token objects across chunks (`markdown-parser.d.ts`), and
/// a deep clone of the prefix per chunk would make long streaming chains
/// quadratic.
#[derive(Default)]
struct PrevState {
  tokens: Vec<Arc<Value>>,
}

/// Marshalled delta: only the re-lexed tail crosses the boundary. The stable
/// prefix stays native-side and in the wrapper's JS token array.
#[napi(object)]
pub struct NativeParseDelta {
  /// How many leading previous tokens are reused (slice index for JS composition).
  pub stable_prefix_len: u32,
  /// Legacy `ParseState.stableTokenCount` formula value.
  pub stable_token_count: u32,
  /// Only the re-lexed tail tokens.
  pub new_tokens: Vec<Value>,
}

/// One parser instance per `MarkdownText` mount.
#[napi]
pub struct MarkdownParser {
  state: Arc<Mutex<PrevState>>,
}

#[napi]
impl MarkdownParser {
  #[napi(constructor)]
  pub fn new() -> Self {
    Self {
      state: Arc::new(Mutex::new(PrevState::default())),
    }
  }

  /// Port of `parseMarkdownIncremental(content, prev, trailingUnstable)` as a
  /// napi AsyncTask (invariant 4: never synchronous on the event loop).
  #[napi]
  pub fn parse(&self, content: String, trailing_unstable: u32) -> AsyncTask<ParseTask> {
    AsyncTask::new(ParseTask {
      state: Arc::clone(&self.state),
      content,
      trailing_unstable,
    })
  }
}

pub struct ParseTask {
  state: Arc<Mutex<PrevState>>,
  content: String,
  trailing_unstable: u32,
}

impl Task for ParseTask {
  type Output = NativeParseDelta;
  type JsValue = NativeParseDelta;

  fn compute(&mut self) -> napi::Result<Self::Output> {
    let trailing = self.trailing_unstable as usize;
    let prev = self.state.lock();
    // `content` is compared against previous raws EXACTLY as legacy does
    // (`newContent.startsWith(token.raw, offset)`); CR normalization happens
    // inside `lex()` (marked `_Lexer#lex`), never before the prefix match.
    let new_content = &self.content;

    // Fresh path (legacy `!prevState || prevState.tokens.length === 0`).
    if prev.tokens.is_empty() {
      let tokens = crate::lexer::lex(new_content);
      let stable_token_count = (tokens.len() as u32).saturating_sub(self.trailing_unstable);
      drop(prev);
      let mut state = self.state.lock();
      state.tokens = tokens.iter().map(|t| Arc::new(t.clone())).collect();
      return Ok(NativeParseDelta {
        stable_prefix_len: 0,
        stable_token_count,
        new_tokens: tokens,
      });
    }

    // Prefix reuse by raw match (legacy `parseMarkdownIncremental`).
    // 中文：单遍前缀匹配——每个 token 的 raw 只提取一次 `&str`（缓存 raw
    // 字节长度），匹配过程中同步累积 offset，避免第二次 `stable_offset` 求和；
    // 字节比较直接复用已提取的切片，不再调用第二次 `as_str`。
    let new_bytes = new_content.as_bytes();
    let mut matched: usize = 0;
    let mut offset: usize = 0;
    // 中文：累积偏移表，cum[i] 为前 i+1 个 token 的 raw 总长度，
    // reuse_count 对应的 stable_offset 可 O(1) 查表得出。
    let mut cum: Vec<usize> = Vec::with_capacity(prev.tokens.len().min(64));
    for token in &prev.tokens {
      let raw: &str = token.get("raw").and_then(Value::as_str).unwrap_or("");
      let raw_bytes = raw.as_bytes();
      let raw_len = raw_bytes.len(); // 中文：缓存一次长度，后续比较与累加复用。
      if offset + raw_len <= new_bytes.len()
        && new_bytes[offset..].starts_with(raw_bytes)
      {
        matched += 1;
        offset += raw_len;
        cum.push(offset);
      } else {
        break;
      }
    }
    let reuse_count = matched.saturating_sub(trailing);
    let stable_offset: usize = if reuse_count == 0 {
      0
    } else {
      cum[reuse_count - 1]
    };
    let remaining = &new_content[stable_offset..];

    if remaining.is_empty() {
      let stable_token_count = reuse_count as u32;
      let stable_prefix_len = reuse_count as u32;
      drop(prev);
      let mut state = self.state.lock();
      state.tokens.truncate(reuse_count);
      return Ok(NativeParseDelta {
        stable_prefix_len,
        stable_token_count,
        new_tokens: vec![],
      });
    }

    // Tail re-lex (legacy `x.lex(remainingContent, { gfm: true })`; marked's
    // lexer has no throw path in Rust, so the legacy try/catch fallback legs
    // are unreachable by construction — spec divergence 5).
    let new_tokens = crate::lexer::lex(remaining);
    let stable_token_count = if self.trailing_unstable == 0 {
      (reuse_count + new_tokens.len()) as u32
    } else {
      reuse_count as u32
    };
    let stable_prefix_len = reuse_count as u32;
    // Arc clones for the reused prefix; only the fresh tail is owned.
    // 中文：预分配容量并用 `Arc::clone` 逐个复用前缀，避免 `to_vec()` 的
    // 中间切片分配语义歧义；tail 仍各 clone 一次（state 与 delta 各持一份）。
    let mut full: Vec<Arc<Value>> = Vec::with_capacity(reuse_count + new_tokens.len());
    full.extend(prev.tokens[..reuse_count].iter().cloned());
    full.extend(new_tokens.iter().map(|t| Arc::new(t.clone())));
    drop(prev);
    let mut state = self.state.lock();
    state.tokens = full;
    Ok(NativeParseDelta {
      stable_prefix_len,
      stable_token_count,
      new_tokens,
    })
  }

  fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
    Ok(output)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn run(parser: &MarkdownParser, content: &str, trailing: u32) -> NativeParseDelta {
    let mut task = ParseTask {
      state: Arc::clone(&parser.state),
      content: content.to_string(),
      trailing_unstable: trailing,
    };
    task.compute().expect("parse task")
  }

  fn composed(parser: &MarkdownParser) -> Vec<Value> {
    parser
      .state
      .lock()
      .tokens
      .iter()
      .map(|t| (**t).clone())
      .collect()
  }

  /// Raw-concat invariant: top-level token raws concatenate back to the
  /// CR-normalized content.
  fn assert_raw_concat(tokens: &[Value], normalized: &str) {
    let joined: String = tokens
      .iter()
      .filter_map(|t| t.get("raw").and_then(Value::as_str))
      .collect();
    assert_eq!(joined, normalized, "raw-concat invariant broken");
  }

  #[test]
  fn lex_basic_shapes() {
    let tokens = lexer::lex("# Hi\n\npara *a* **b** `c` [d](u)\n");
    assert_raw_concat(&tokens, "# Hi\n\npara *a* **b** `c` [d](u)\n");
    assert_eq!(tokens[0]["type"], "heading");
    assert_eq!(tokens[0]["depth"], 1);
    assert!(tokens[0].get("tokens").is_some());
    let json = serde_json::to_string(&tokens).unwrap();
    assert!(!json.contains(lexer::PEND), "placeholder leaked: {json}");
  }

  #[test]
  fn crlf_is_normalized_at_lex_entry() {
    let tokens = lexer::lex("# Hi\r\n\r\npara\r\n");
    let joined: String = tokens
      .iter()
      .filter_map(|t| t.get("raw").and_then(Value::as_str))
      .collect();
    assert_eq!(joined, "# Hi\n\npara\n");
  }

  #[test]
  fn incremental_protocol_matches_legacy_formulas() {
    let p = MarkdownParser::new();
    // fresh
    let d0 = run(&p, "# a\n\nbb", 0);
    assert_eq!(d0.stable_prefix_len, 0);
    assert_eq!(d0.stable_token_count, d0.new_tokens.len() as u32);
    // grow with trailingUnstable = 2 (streaming usage)
    let d1 = run(&p, "# a\n\nbb and more text", 2);
    let full = lexer::lex("# a\n\nbb and more text");
    assert_eq!(
      composed(&p),
      full,
      "streaming invariant: composed == full parse"
    );
    assert_eq!(
      d1.stable_prefix_len + d1.new_tokens.len() as u32,
      composed(&p).len() as u32
    );
    // finalize with unchanged content, trailingUnstable = 0
    let d2 = run(&p, "# a\n\nbb and more text", 0);
    assert_eq!(d2.new_tokens.len(), 0, "seeded call re-lexes nothing");
    assert_eq!(d2.stable_prefix_len, composed(&p).len() as u32);
    assert_eq!(
      d2.stable_token_count,
      composed(&p).len() as u32,
      "legacy stableTokenCount = stableTokens.length when remaining is empty"
    );
  }
}


#[cfg(test)]
mod bench {
  use std::time::Instant;

  #[test]
  #[ignore]
  fn bench_inline() {
    let big = "# Doc\n\n".to_string() + &"some words with *em* and **strong** text here. ".repeat(80);
    let cs = "# Doc\n\n".to_string() + &"text with `code spans` inside here. ".repeat(80);
    for (name, c) in [("emstrong", big.as_str()), ("codespan", cs.as_str())] {
      let t = Instant::now();
      for _ in 0..10 {
        let _ = crate::lexer::lex(c);
      }
      println!("BENCH {name}: {:?}/parse", t.elapsed() / 10);
    }
  }
}

#[cfg(test)]
mod bench2 {
  use std::time::Instant;

  #[test]
  #[ignore]
  fn bench_parts() {
    let plain = "plain words no delimiters at all here. ".repeat(80);
    let rules = crate::rules::rules();
    // paragraph rule alone on the 3KB paragraph
    let t = Instant::now();
    for _ in 0..50 {
      assert!(crate::helpers::exec(&rules.block.paragraph, &plain).is_some());
    }
    println!("BENCH paragraph-regex: {:?}/exec", t.elapsed() / 50);
    // block_skip mask loop alone
    let t = Instant::now();
    for _ in 0..50 {
      let mut pos = 0usize;
      while let Some(mc) = rules.inline.block_skip.captures_from_pos(&plain, pos).ok().flatten() {
        let m = mc.get(0).unwrap();
        pos = m.end();
      }
    }
    println!("BENCH block-skip-regex: {:?}/scan", t.elapsed() / 50);
    // any_punctuation loop
    let t = Instant::now();
    for _ in 0..50 {
      let mut pos = 0usize;
      while let Some(m) = rules.inline.any_punctuation.find_from_pos(&plain, pos).ok().flatten() {
        pos = m.end();
      }
    }
    println!("BENCH any-punct-regex: {:?}/scan", t.elapsed() / 50);
    // full lex + inline portion
    let t = Instant::now();
    for _ in 0..20 {
      let _ = crate::lexer::lex(&plain);
    }
    let total = t.elapsed() / 20;
    println!(
      "BENCH full-lex: {total:?}/parse (inline portion: {}us)",
      crate::INLINE_NS.swap(0, std::sync::atomic::Ordering::Relaxed) / 20 / 1000
    );
    // heading only
    let h = format!("# {}\n", "a heading with words");
    let t = Instant::now();
    for _ in 0..1000 {
      let _ = crate::lexer::lex(&h);
    }
    println!("BENCH heading-lex: {:?}/parse", t.elapsed() / 1000);
    let cs = "# Doc\n\n".to_string() + &"text with `code spans` inside here. ".repeat(80);
    let t = Instant::now();
    for _ in 0..20 {
      let _ = crate::lexer::lex(&cs);
    }
    println!(
      "BENCH codespan-lex: {:?}/parse (inline {}us mask {}us loop {}us iters {} guard {}us text {}us tail {}us)",
      t.elapsed() / 20,
      crate::INLINE_NS.swap(0, std::sync::atomic::Ordering::Relaxed) / 20 / 1000, crate::MASK_NS.swap(0, std::sync::atomic::Ordering::Relaxed) / 20 / 1000,
      crate::LOOP_NS.swap(0, std::sync::atomic::Ordering::Relaxed) / 20 / 1000, crate::LOOP_ITERS.swap(0, std::sync::atomic::Ordering::Relaxed) / 20, crate::GUARD_NS.swap(0, std::sync::atomic::Ordering::Relaxed) / 20 / 1000, crate::TEXT_NS.swap(0, std::sync::atomic::Ordering::Relaxed) / 20 / 1000, crate::TAIL_NS.swap(0, std::sync::atomic::Ordering::Relaxed) / 20 / 1000
    );
    let lk = "# Doc\n\n".to_string() + &"see [docs](https://example.com) here. ".repeat(80);
    let t = Instant::now();
    for _ in 0..20 {
      let _ = crate::lexer::lex(&lk);
    }
    println!(
      "BENCH links-lex: {:?}/parse (inline {}us mask {}us)",
      t.elapsed() / 20,
      crate::INLINE_NS.swap(0, std::sync::atomic::Ordering::Relaxed) / 20 / 1000, crate::MASK_NS.swap(0, std::sync::atomic::Ordering::Relaxed) / 20 / 1000
    );
  }
}

/// 快速路径前后对比 probing benches（仅测量，不改行为）。
/// Fast-path before/after probes: each case lexes a fixed fixture and
/// prints a criterion-style `BENCH <case>: <mean>/parse (iters=N)` line so
/// runs can be diffed across commits. 手扫（codespan/inline-text）与
/// fancy-regex（heading/fences/escape/paragraph）的划分见 spec Performance 节。
#[cfg(test)]
mod bench_fastpath {
  use std::time::Instant;

  fn mean(iters: u32, f: impl Fn()) -> std::time::Duration {
    // 预热一次，排除 OnceLock/regex 首次编译开销。
    f();
    let t = Instant::now();
    for _ in 0..iters {
      f();
    }
    t.elapsed() / iters
  }

  #[test]
  #[ignore]
  fn bench_fastpath_cases() {
    let heading = "# a heading with words\n".to_string();
    let fences = "```js\nconst x = 1;\nconsole.log(x);\n```\n".to_string();
    let escape = "para with \\*escaped\\* marks and \\[brackets\\]\n".to_string();
    let codespan = "text with `code spans` inside here. ".repeat(40);
    let plain = "plain words no delimiters at all here. ".repeat(80);
    let cases: [(&str, u32, &str); 5] = [
      ("heading", 1000, heading.as_str()),
      ("fences", 500, fences.as_str()),
      ("escape", 500, escape.as_str()),
      ("codespan", 20, codespan.as_str()),
      ("plain-paragraph", 20, plain.as_str()),
    ];
    for (name, iters, input) in cases {
      let d = mean(iters, || {
        let _ = crate::lexer::lex(input);
      });
      println!("BENCH {name}: {d:?}/parse (iters={iters})");
    }
  }
}
