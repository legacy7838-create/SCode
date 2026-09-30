//! marked 17.0.1 GFM lexer port (block + inline), options pinned to
//! `{ gfm: true, breaks: false, pedantic: false }` — exactly what opentui's
//! `x.lex(content, { gfm: true })` runs (spec parity table).
//!
//! Design notes:
//! - Tokens are `serde_json::Value` objects, field-for-field identical to
//!   marked's token objects (fields marked sets to `undefined` are omitted so
//!   `JSON.stringify` matches; `null` is kept).
//! - marked defers inline lexing through a lexer-level `inlineQueue` of
//!   `{src, tokens[]}` entries; those arrays are not yet attached to the tree
//!   when queued. The port stores them in an arena and puts a placeholder
//!   (`{"__md_arr": id}`) in the parent token; after the queue drains,
//!   `splice` replaces every placeholder with its array.
//! - Byte offsets everywhere; each length-arithmetic site was reviewed
//!   against the JS UTF-16 semantics (all are ASCII-boundary-equivalent or
//!   self-consistent within the byte coordinate system).

use crate::helpers::*;
use crate::rules::{
  fences_begin_regex, heading_begin_regex, hr_regex, html_begin_regex, list_item_regex,
  next_bullet_regex, rules,
};
use fancy_regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashMap;

pub(crate) const PEND: &str = "__md_arr";

#[derive(Default)]
pub struct State {
  in_link: bool,
  in_raw_block: bool,
  top: bool,
}

pub struct LinkDef {
  href: String,
  title: Option<String>,
}

struct Job {
  src: String,
  arr: usize,
}

pub struct Lexer {
  state: State,
  links: HashMap<String, LinkDef>,
  queue: Vec<Job>,
  arena: Vec<Vec<Value>>,
}

// ---------------------------------------------------------------------------
// token/value helpers
// ---------------------------------------------------------------------------

fn sv(s: impl Into<String>) -> Value {
  Value::String(s.into())
}

fn tok(map: Map<String, Value>) -> Value {
  Value::Object(map)
}

fn pend(id: usize) -> Value {
  let mut m = Map::new();
  m.insert(PEND.to_string(), Value::Number(id.into()));
  Value::Object(m)
}

fn pending_id(v: &Value) -> Option<usize> {
  v.get(PEND).and_then(Value::as_u64).map(|x| x as usize)
}

fn get_str<'a>(v: &'a Value, k: &str) -> &'a str {
  v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// `obj[k] = obj[k] + suffix` for string fields.
/// 中文：热路径合并优化——直接对 `Value::String` 做 `push_str`，
/// 避免 `get_str().to_string()` + `format!` 的两次分配。
fn append_field(v: &mut Value, k: &str, suffix: &str) {
  match v.get_mut(k) {
    Some(Value::String(s)) => s.push_str(suffix),
    _ => {
      v[k] = sv(suffix);
    }
  }
}

/// 中文：把另一个 token 的 `&str` 字段直接追加到 `dst`，避免中间 `to_string()`。
fn append_token_field(dst: &mut Value, k: &str, src: &Value) {
  let suffix = get_str(src, k);
  if !suffix.is_empty() {
    append_field(dst, k, suffix);
  }
}

/// `arr.at(-1)?.type`.
fn token_type(v: &Value) -> &str {
  get_str(v, "type")
}

/// JS `str.split('\n', 1)[0]`.
fn first_line(s: &str) -> &str {
  match s.find('\n') {
    Some(i) => &s[..i],
    None => s,
  }
}

/// JS `str.substring(0, n)` — clamps to length (negatives mean 0).
fn substring0(s: &str, n: i64) -> &str {
  let mut end = n.clamp(0, s.len() as i64) as usize;
  while end > 0 && !s.is_char_boundary(end) {
    end -= 1;
  }
  &s[..end]
}

/// JS `str.slice(n)` — start clamps to length (unlike substring, out-of-range
/// yields "").
fn slice_from(s: &str, n: usize) -> &str {
  let mut start = n.min(s.len());
  while start > 0 && !s.is_char_boundary(start) {
    start -= 1;
  }
  &s[start..]
}

/// `source.replace(/re/g, prefix + '$1')` (blockquote setext guard).
fn replace_all_prefixed_g1(s: &str, re: &Regex, prefix: &str) -> String {
  let mut out = String::with_capacity(s.len());
  let mut pos = 0usize;
  while pos <= s.len() {
    let c = match re.captures_from_pos(s, pos).ok().flatten() {
      Some(c) => c,
      None => break,
    };
    let m0 = c.get(0).unwrap();
    out.push_str(&s[pos..m0.start()]);
    out.push_str(prefix);
    out.push_str(c.get(1).map(|x| x.as_str()).unwrap_or(""));
    if m0.end() == m0.start() {
      break;
    }
    pos = m0.end();
  }
  out.push_str(&s[pos.min(s.len())..]);
  out
}

// 中文（bug fix 说明）：原 `strip_ends`/`slice0`（em/strong 文本抽取的 JS 语义克隆）
// 已被 `emstrong.rs::strip_ends_local`/`slice0_local` 取代，调用方 `t_em_strong`
// 现在走 `emstrong::find_closing_em_strong` 状态机，这两个函数零调用点。
// 按 docs/specs/rust-native-ports.md 不变量 2「Legacy paths are deleted, not disabled」
// 直接删除，而不是留 `#[allow(dead_code)]` 挂在那里。

// ---------------------------------------------------------------------------
// prevChar: marked keeps the last UTF-16 unit of the previous inline text
// token. For non-BMP chars that unit is a lone surrogate (truthy, matches no
// `\p{...}` class) — modeled explicitly so emphasis decisions match JS.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum PC {
  Empty,
  Ch(char),
  LoneSurrogate,
}

impl PC {
  fn from_raw(raw: &str) -> PC {
    match raw.chars().next_back() {
      None => PC::Empty,
      Some(c) if (c as u32) > 0xFFFF => PC::LoneSurrogate,
      Some(c) => PC::Ch(c),
    }
  }
  fn is_empty(self) -> bool {
    self == PC::Empty
  }
  fn matches(&self, re: &Regex) -> bool {
    match self {
      PC::Empty | PC::LoneSurrogate => false,
      PC::Ch(c) => {
        let mut buf = [0u8; 4];
        re.test(c.encode_utf8(&mut buf))
      }
    }
  }
}

// ---------------------------------------------------------------------------
// entry point (marked `_Lexer#lex`)
// ---------------------------------------------------------------------------

pub fn lex(content: &str) -> Vec<Value> {
  let r = rules();
  // marked: src.replace(other.carriageReturn, '\n')
  let src = replace_all_literal(content, &r.other.carriage_return, "\n");
  let mut lx = Lexer::new();
  let root = lx.new_array();
  lx.block_tokens(&src, root, false);
  let mut i = 0;
  while i < lx.queue.len() {
    let (job_src, arr) = (lx.queue[i].src.clone(), lx.queue[i].arr);
    lx.inline_tokens_into(&job_src, arr);
    i += 1;
  }
  let mut root_val = Value::Array(std::mem::take(&mut lx.arena[root]));
  splice(&mut root_val, &mut lx.arena);
  match root_val {
    Value::Array(a) => a,
    _ => Vec::new(),
  }
}

/// Replace every `{"__md_arr": id}` placeholder with its arena array.
fn splice(v: &mut Value, arena: &mut Vec<Vec<Value>>) {
  match v {
    Value::Object(map) => {
      let id = map.get(PEND).and_then(Value::as_u64);
      if let Some(id) = id {
        let mut arr = std::mem::take(&mut arena[id as usize]);
        for el in arr.iter_mut() {
          splice(el, arena);
        }
        *v = Value::Array(arr);
      } else {
        for (_, val) in map.iter_mut() {
          splice(val, arena);
        }
      }
    }
    Value::Array(items) => {
      for it in items.iter_mut() {
        splice(it, arena);
      }
    }
    _ => {}
  }
}

/// marked `indentCodeCompensation`.
fn indent_code_compensation(raw: &str, text: &str) -> String {
  let r = rules();
  let c = match exec(&r.other.indent_code_compensation, raw) {
    Some(c) => c,
    None => return text.to_string(),
  };
  let indent = match cap(&c, 1) {
    Some(i) => i.to_string(),
    None => return text.to_string(),
  };
  let indent_chars = indent.chars().count();
  let out: Vec<&str> = text
    .split('\n')
    .map(|node| match exec(&r.other.beginning_space, node) {
      Some(b) => {
        let in_node = b.get(0).unwrap().as_str();
        if in_node.chars().count() >= indent_chars {
          slice_from(node, indent.len())
        } else {
          node
        }
      }
      None => node,
    })
    .collect();
  out.join("\n")
}

fn align_json(a: Option<&str>) -> Value {
  match a {
    Some(a) => sv(a),
    None => Value::Null,
  }
}

// ---------------------------------------------------------------------------
// block 字节快路径扫描器：hot block 规则的手写等价实现。
// 修复原理：fancy-regex 的巨型正则在每个 block 迭代上都要做锚定
// 回溯扫描，而 heading/fences/hr/code/space 的“能否进入”判定只是
// ASCII 首字节+行结构检查；先用 O(行) 手写扫描拿 raw 边界，复杂
// 边缘情况回落正则，保证字节级 parity 的同时把常见 case 的正则
// exec 次数降为 0。刻意不引入 memchr 依赖：单字节 `position`/`find`
// 经 LLVM 已降为 memchr 指令，加依赖无收益。
// ---------------------------------------------------------------------------

/// `block.code` 的 raw 边界：
/// `^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+`。
/// 全 ASCII 判定（`[ \t\n]`），与正则逐字节等价；失败返回 None。
fn scan_indented_code_raw(src: &str) -> Option<usize> {
  let b = src.as_bytes();
  let mut pos = 0usize;
  let mut any = false;
  while pos < b.len() {
    // `(?: {4}| {0,3}\t)`：4 空格，或 ≤3 空格后跟 tab。
    let mut j = pos;
    let mut sp = 0usize;
    while j < b.len() && b[j] == b' ' && sp < 4 {
      sp += 1;
      j += 1;
    }
    if sp == 4 {
      // 4 空格缩进成立（` {4}` 分支）。
    } else if sp <= 3 && j < b.len() && b[j] == b'\t' {
      j += 1;
    } else {
      break;
    }
    // `[^\n]+`：至少一个非换行字符。
    if j >= b.len() || b[j] == b'\n' {
      break;
    }
    while j < b.len() && b[j] != b'\n' {
      j += 1;
    }
    any = true;
    pos = j;
    // `(?:\n(?:[ \t]*(?:\n|$))*)?`：一个换行 + 若干“空格+换行/文末”。
    if pos < b.len() && b[pos] == b'\n' {
      let mut k = pos + 1;
      loop {
        let mut m = k;
        while m < b.len() && (b[m] == b' ' || b[m] == b'\t') {
          m += 1;
        }
        if m < b.len() && b[m] == b'\n' {
          k = m + 1;
        } else if m >= b.len() {
          // `[ \t]*$`：行尾空格直达文末，一并吞入。
          k = m;
          break;
        } else {
          break;
        }
      }
      pos = k;
    }
  }
  if any { Some(pos) } else { None }
}

/// `block.hr` 的正文边界（不含尾部换行）：
/// `^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)`。
/// 全 ASCII 判定，与正则逐字节等价；返回正文字节长。
fn scan_hr_body(src: &str) -> Option<usize> {
  let b = src.as_bytes();
  let mut i = 0usize;
  while i < b.len() && b[i] == b' ' && i < 3 {
    i += 1;
  }
  if i >= b.len() {
    return None;
  }
  let mark = b[i];
  if !matches!(mark, b'-' | b'_' | b'*') {
    return None;
  }
  let mut count = 0u32;
  while i < b.len() {
    if b[i] == mark {
      count += 1;
      i += 1;
    } else if b[i] == b' ' || b[i] == b'\t' {
      i += 1;
    } else {
      break;
    }
  }
  if count < 3 {
    return None;
  }
  // `(?:\n+|$)`：尾部换行或文末；` *(?=\n|$)` 外的杂字符则无匹配。
  let mut j = i;
  while j < b.len() && b[j] == b'\n' {
    j += 1;
  }
  if j != i {
    Some(i)
  } else if i >= b.len() {
    Some(i)
  } else {
    None
  }
}

/// ATX heading 首行检查：`^ {0,3}(#{1,6})(?=\s|$)`。
/// 返回 `(hash 数, 内容起始下标)`。`(?=\s)` 的 ASCII 子集
/// （space/tab/\n/EOS）走快路径；`\s` 的非 ASCII 成员
/// （如 `\u{A0}`/`\u{FEFF}`）回落正则以保 parity。
/// 调用方另需确认行内无 `\r`/`\u{2028}`/`\u{2029}`（`.` 排除它们），
// 含则同样回落正则。
fn scan_heading_open(src: &str) -> Option<(usize, usize)> {
  let b = src.as_bytes();
  let mut i = 0usize;
  while i < b.len() && b[i] == b' ' && i < 3 {
    i += 1;
  }
  let start = i;
  while i < b.len() && b[i] == b'#' {
    i += 1;
  }
  let depth = i - start;
  if depth == 0 || depth > 6 {
    return None;
  }
  if i >= b.len() {
    return Some((depth, i)); // `$`（文末）分支
  }
  match b[i] {
    b' ' | b'\t' | b'\n' => Some((depth, i)),
    _ => None, // 含非 ASCII 空白可能：回落正则判定
  }
}

/// fenced code 的 raw/内容边界：`^ {0,3}(`{3,}|~{3,})info\ncontent\nclose`。
/// 返回 `(raw_len, info, content)`；`content` 为开闭栏之间的原文
/// （`([\s\S]*?)` 懒匹配 + `(?:\n|$)` 边界），调用方复用原
/// `lang`/`indent_code_compensation` 后处理以保 parity。
/// 模糊 case（info 含反引号、混合围栏关闭栏等）直接返回 None
/// 回落正则，不猜测。
fn scan_fences_raw(src: &str) -> Option<(usize, &str, &str)> {
  let b = src.as_bytes();
  let mut i = 0usize;
  while i < b.len() && b[i] == b' ' && i < 3 {
    i += 1;
  }
  if i >= b.len() {
    return None;
  }
  let fence = b[i];
  if !matches!(fence, b'`' | b'~') {
    return None;
  }
  let mut j = i;
  while j < b.len() && b[j] == fence {
    j += 1;
  }
  let open_len = j - i;
  if open_len < 3 {
    return None;
  }
  // `(?=[^`\n]*(?:\n|$))`：backtick 开栏的 info 不能含反引号
  // （tilde 开栏可含；关闭栏只认同种字符开头，逐行判定）。
  let mut k = j;
  while k < b.len() && b[k] != b'\n' {
    if fence == b'`' && b[k] == b'`' {
      return None;
    }
    k += 1;
  }
  let info = &src[j..k];
  let mut content_start = k;
  if content_start < b.len() && b[content_start] == b'\n' {
    content_start += 1;
  } else if content_start < b.len() {
    return None; // 到不了 `(?:\n|$)`：只能回落（实际不可达）
  }
  // 逐行找关闭栏：` {0,3}\1[~`]* *(?=\n|$)`，
  // `\1` 为开栏精确复现（同字符同长度），后跟任意 `` `~ `` 尾巴。
  let mut pos = content_start;
  loop {
    if pos >= b.len() {
      // `$` 分支：无关闭栏，content 直达文末；`([\s\S]*?)(?:\n|$)`
      // 尾部恰好吞一个换行（与关闭栏成立时同式）。
      let content = src[content_start..].strip_suffix('\n').unwrap_or(&src[content_start..]);
      return Some((b.len(), info, content));
    }
    let mut q = pos;
    let mut sp = 0usize;
    while q < b.len() && b[q] == b' ' && sp < 3 {
      sp += 1;
      q += 1;
    }
    let mut r = q;
    while r < b.len() && b[r] == fence {
      r += 1;
    }
    let run = r - q;
    if run >= open_len {
      // `\1` 恰为开栏串（同字符、长度 ≥ 开栏长；超长部分由 `[~`]*`
      // 吸收）。混合字符尾巴（如 ```~~）的语义微妙，回落正则判定。
      let mut t = r;
      let mut mixed = false;
      while t < b.len() && (b[t] == b'`' || b[t] == b'~') {
        if b[t] != fence {
          mixed = true;
        }
        t += 1;
      }
      if mixed {
        let mut u = t;
        while u < b.len() && b[u] == b' ' {
          u += 1;
        }
        if u >= b.len() || b[u] == b'\n' {
          return None; // 混合尾巴：回落正则，不猜测
        }
      } else {
        let mut u = t;
        while u < b.len() && b[u] == b' ' {
          u += 1;
        }
        if u >= b.len() || b[u] == b'\n' {
          // 关闭栏成立：raw 到关闭栏尾（不含尾换行，`(?=\n|$)` 前瞻）。
          let content = &src[content_start..pos];
          // `([\s\S]*?)(?:\n|$)`：content 尾部恰好吞一个换行。
          let content = content.strip_suffix('\n').unwrap_or(content);
          return Some((t, info, content));
        }
      }
    }
    // 下一行；无换行即文末（`$` 分支，同上剥一个尾换行）。
    match b[pos..].iter().position(|&c| c == b'\n') {
      Some(off) => pos += off + 1,
      None => {
        let content = src[content_start..].strip_suffix('\n').unwrap_or(&src[content_start..]);
        return Some((b.len(), info, content));
      }
    }
  }
}

fn blockquote_token(raw: String, text: String, id: usize) -> Value {
  let mut m = Map::new();
  m.insert("type".into(), sv("blockquote"));
  m.insert("raw".into(), sv(raw));
  m.insert("tokens".into(), pend(id));
  m.insert("text".into(), sv(text));
  tok(m)
}

impl Lexer {
  fn new() -> Self {
    Self {
      state: State {
        in_link: false,
        in_raw_block: false,
        top: true,
      },
      links: HashMap::new(),
      queue: Vec::new(),
      arena: Vec::new(),
    }
  }

  fn new_array(&mut self) -> usize {
    self.arena.push(Vec::new());
    self.arena.len() - 1
  }

  /// marked `_Lexer#inline` — queue inline lexing of `src` into a fresh
  /// children array; returns the placeholder stored in the parent token.
  fn queue_inline(&mut self, src: &str) -> Value {
    let id = self.new_array();
    self.queue.push(Job {
      src: src.to_string(),
      arr: id,
    });
    pend(id)
  }

  fn inline_tokens_into(&mut self, src: &str, arr: usize) {
    let mut tmp = std::mem::take(&mut self.arena[arr]);
    self.inline_tokens_core(src, &mut tmp);
    self.arena[arr] = tmp;
  }

  fn inline_tokens_new(&mut self, src: &str) -> Vec<Value> {
    let mut out = Vec::new();
    self.inline_tokens_core(src, &mut out);
    out
  }

  fn block_tokens_new(&mut self, src: &str) -> usize {
    let id = self.new_array();
    self.block_tokens(src, id, false);
    id
  }

  // =========================================================================
  // block tokenizers
  // =========================================================================

  /// marked `tokenizer.space` — raw length of the newline spacer.
  ///
  /// 字节快路径（修复原理：`^(?:[ \t]*(?:\n|$))+` 是纯 ASCII
  /// 行扫描，fancy-regex 对它的每轮 exec 开销远大于手写循环；
  /// 手写语义与正则逐字节等价：若干个“行内空格+换行/输入结尾”
  /// 单元，首单元失败即整体无匹配）。
  fn t_space(&self, src: &str) -> Option<usize> {
    let b = src.as_bytes();
    // 首字节预检：首单元 `[ \t]*(\n|$)` 要求到首个非空格字节为止
    // 只能是 `\n` 或输入结尾，否则正则必无匹配。
    let mut k = 0usize;
    while k < b.len() && (b[k] == b' ' || b[k] == b'\t') {
      k += 1;
    }
    if k < b.len() && b[k] != b'\n' {
      return None;
    }
    let mut pos = 0usize;
    let mut any = false;
    loop {
      // 注意：行尾空格只有在后跟 `\n`/文末时才属于匹配（正则回溯语义）；
      // 先用临时下标试探，确认成单元才推进 `pos`。
      let mut m = pos;
      while m < b.len() && (b[m] == b' ' || b[m] == b'\t') {
        m += 1;
      }
      if m >= b.len() {
        // `[ \t]*$`：输入结尾（`$` 非多行模式即文末；`src` 已做
        // CR 归一化，无需考虑 `\r`）。
        pos = m;
        any = true;
        break;
      }
      if b[m] == b'\n' {
        pos = m + 1;
        any = true;
        continue;
      }
      break;
    }
    if any && pos > 0 { Some(pos) } else { None }
  }

  /// marked `tokenizer.code` (indented) — (raw, de-indented text).
  ///
  /// 字节快路径（修复原理：`block.code` 正则的热循环只是 ASCII
  /// 缩进/空行扫描，回溯开销大；手写扫描与
  /// `^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+` 逐字节
  /// 等价，去缩进后处理仍复用原正则以保 parity）。
  fn t_code(&self, src: &str) -> Option<(String, String)> {
    let b0 = *src.as_bytes().first()?;
    if !matches!(b0, b' ' | b'\t') {
      return None;
    }
    let raw_len = scan_indented_code_raw(src)?;
    let raw = src[..raw_len].to_string();
    let text = remove_all(&raw, &rules().other.code_remove_indent);
    let text = rtrim(&text, '\n').to_string();
    Some((raw, text))
  }

  /// marked `tokenizer.fences` — (raw, lang, text).
  ///
  /// 字节快路径（修复原理：见 `scan_fences_raw`；常见围栏块不再进
  /// `block.fences` 巨正则；`lang`/缩进补偿复用原后处理，输出逐字节一致）。
  fn t_fences(&self, src: &str) -> Option<(String, String, String)> {
    let b0 = *src.as_bytes().first()?;
    if !matches!(b0, b' ' | b'`' | b'~') {
      return None;
    }
    if let Some((raw_len, info, content)) = scan_fences_raw(src) {
      let raw = src[..raw_len].to_string();
      // 与正则路径同式：`lang` 取 info 去空白后做标点反转义。
      let lang_raw = info;
      let lang = if !lang_raw.is_empty() && !js_trim(lang_raw).is_empty() {
        replace_first_g1(js_trim(lang_raw), &rules().inline.any_punctuation)
      } else {
        // 空 info 时正则 `([^\n]*)` 捕获 ""（falsy）→ lang 为 ""；
        // 与原分支 `lang_raw.unwrap_or("")` 一致。
        String::new()
      };
      let text = indent_code_compensation(&raw, content);
      return Some((raw, lang, text));
    }
    let c = exec(&rules().block.fences, src)?;
    let raw = c.get(0)?.as_str().to_string();
    let lang_raw = cap(&c, 2);
    let lang = if truthy(lang_raw) {
      replace_first_g1(js_trim(lang_raw.unwrap()), &rules().inline.any_punctuation)
    } else {
      lang_raw.unwrap_or("").to_string()
    };
    let text = indent_code_compensation(&raw, cap(&c, 3).unwrap_or(""));
    Some((raw, lang, text))
  }

  /// marked `tokenizer.heading` — (raw, depth, text).
  ///
  /// 字节快路径（修复原理：`^ {0,3}#{1,6}(?=\s|$)` 的 ASCII 常见形
  /// 可用计数判定；含 `\r`/`\u{2028}`/`\u{2029}`（`.` 排除集）或非
  /// ASCII 空白时回落正则，保证 parity）。
  fn t_heading(&self, src: &str) -> Option<(String, usize, String)> {
    let b0 = *src.as_bytes().first()?;
    if !matches!(b0, b' ' | b'#') {
      return None;
    }
    if let Some((depth, _)) = scan_heading_open(src) {
      // 快路径成立条件：首行（到首个 `\n`）为纯 ASCII 且不含 `\r`。
      // `src` 已 CR 归一化，`\r` 仅存于刻意构造；仍做检查以保 parity。
      let line_end = src.as_bytes().iter().position(|&c| c == b'\n').unwrap_or(src.len());
      let first = &src[..line_end];
      let ascii_clean = first.is_ascii() && !first.as_bytes().contains(&b'\r');
      if ascii_clean {
        // `(.*)(?:\n+|$)`：raw = 首行 + 其后连续换行。
        let mut raw_end = line_end;
        while raw_end < src.len() && src.as_bytes()[raw_end] == b'\n' {
          raw_end += 1;
        }
        let raw = src[..raw_end].to_string();
        // `(.*)` 取 `#` 运行后全部（含前导空格，后续 js_trim 处理）。
        let b = first.as_bytes();
        let mut i = 0usize;
        while i < b.len() && b[i] == b' ' && i < 3 {
          i += 1;
        }
        while i < b.len() && b[i] == b'#' {
          i += 1;
        }
        let body = &first[i..];
        // 与原实现同式：trim + 尾部 `#` 处理。
        let mut text = js_trim(body).to_string();
        if rules().other.ending_hash.test(&text) {
          let trimmed = rtrim(&text, '#').to_string();
          if trimmed.is_empty() || rules().other.ending_space_char.test(&trimmed) {
            text = js_trim(&trimmed).to_string();
          }
        }
        return Some((raw, depth, text));
      }
    }
    let c = exec(&rules().block.heading, src)?;
    let raw = c.get(0)?.as_str().to_string();
    let depth = cap(&c, 1)?.len();
    let mut text = js_trim(cap(&c, 2)?).to_string();
    if rules().other.ending_hash.test(&text) {
      let trimmed = rtrim(&text, '#').to_string();
      // non-pedantic branch: CommonMark requires space before trailing #s
      if trimmed.is_empty() || rules().other.ending_space_char.test(&trimmed) {
        text = js_trim(&trimmed).to_string();
      }
    }
    Some((raw, depth, text))
  }

  /// marked `tokenizer.hr` — raw with trailing newlines stripped.
  ///
  /// 字节快路径（修复原理：`block.hr` 全 ASCII、无回溯分支，
  /// 手写扫描与正则逐字节等价，零 exec 命中常见 `---`/`***` 行）。
  fn t_hr(&self, src: &str) -> Option<String> {
    let b0 = *src.as_bytes().first()?;
    if !matches!(b0, b' ' | b'-' | b'_' | b'*') {
      return None;
    }
    if let Some(body_len) = scan_hr_body(src) {
      return Some(src[..body_len].to_string());
    }
    None
  }

  /// marked `tokenizer.html` — (raw, pre, text).
  fn t_html(&self, src: &str) -> Option<(String, bool, String)> {
        let b0 = *src.as_bytes().first()?;
    if !matches!(b0, b' ' | b'<') {
      return None;
    }
    let c = exec(&rules().block.html, src)?;
    let m0 = c.get(0)?.as_str();
    let pre_raw = cap(&c, 1).unwrap_or("");
    let pre = matches!(pre_raw, "pre" | "script" | "style");
    Some((m0.to_string(), pre, m0.to_string()))
  }

  /// marked `tokenizer.def` — (raw, tag, href, title?) where `title: None`
  /// omits the key (JS `undefined` drops out of JSON.stringify).
  fn t_def(&self, src: &str) -> Option<(String, String, String, Option<String>)> {
        let b0 = *src.as_bytes().first()?;
    if !matches!(b0, b' ' | b'[') {
      return None;
    }
    let c = exec(&rules().block.def, src)?;
    let raw = c.get(0)?.as_str().to_string();
    let tag = replace_all_literal(
      &cap(&c, 1)?.to_lowercase(),
      &rules().other.multiple_space_global,
      " ",
    );
    let href = match cap(&c, 2) {
      Some(h) if !h.is_empty() => {
        let h = replace_first_g1(h, &rules().other.href_brackets);
        replace_first_g1(&h, &rules().inline.any_punctuation)
      }
      _ => String::new(),
    };
    let title = match cap(&c, 3) {
      Some(t) if t.len() >= 2 => {
        // quote + content + quote; quotes are ASCII, bytes == units
        let stripped = &t[1..t.len() - 1];
        Some(replace_first_g1(stripped, &rules().inline.any_punctuation))
      }
      Some(t) => Some(t.to_string()),
      None => None,
    };
    Some((raw, tag, href, title))
  }

  /// marked `tokenizer.lheading` — (raw, depth, text).
  ///
  /// 字节预检扩展（修复原理：`block.lheading` 是巨正则，绝大多数段落
  /// 第二行根本不是 setext 标记行；先用 O(行) 手写检查第二行
  /// ` {0,3}(=+|-+) *(?:\n+|$)` 形状，不符直接跳过 exec。实际捕获仍
  /// 走正则，保证 parity；巨正则只在可能命中时运行）。
  fn t_lheading(&self, src: &str) -> Option<(String, usize, String)> {
    {
      let nl = match src.as_bytes().iter().position(|&c| c == b'\n') {
        Some(nl) => nl,
        None => return None,
      };
      let mut i = nl + 1;
      while i < src.len() && src.as_bytes()[i] == b' ' && i <= nl + 3 {
        i += 1;
      }
      if i >= src.len() || !matches!(src.as_bytes()[i], b'=' | b'-') {
        return None;
      }
      // 第二行剩余形状：同种 `=`/`-` 运行 + 尾空格 + 换行/文末。
      let mark = src.as_bytes()[i];
      while i < src.len() && src.as_bytes()[i] == mark {
        i += 1;
      }
      while i < src.len() && src.as_bytes()[i] == b' ' {
        i += 1;
      }
      if i < src.len() {
        if src.as_bytes()[i] == b'\n' {
          // 允许其后连续换行（`(?:\n+|$)`），无需再检。
        } else {
          return None;
        }
      }
    }
    let c = exec(&rules().block.lheading, src)?;
    let raw = c.get(0)?.as_str().to_string();
    let text = cap(&c, 1)?.to_string();
    let depth = if cap(&c, 2)?.starts_with('=') { 1 } else { 2 };
    Some((raw, depth, text))
  }

  /// marked `tokenizer.paragraph` — (raw, text).
  ///
  /// 首字节守卫（修复原理：`block.paragraph` 是本文件最巨的正则，
  /// 但其首字符类 `[^\n]` 恒成立要求首字节非 `\n`；空格行已由
  /// `t_space` 消费，此守卫让巨正则只在可能命中时运行，
  /// paragraph/table/html 保持尝试顺序垫底）。
  fn t_paragraph(&self, src: &str) -> Option<(String, String)> {
    if src.as_bytes().first() == Some(&b'\n') {
      return None;
    }
    // Use hand-written paragraph scanner (scanners.rs) instead of the
    // expensive fancy-regex block.paragraph rule — O(n) single-pass,
    // byte-exact parity verified by 120+ differential test cases.
    let m = crate::scanners::paragraph_match(src)?;
    let raw = src[..m.end].to_string();
    let g1_str = &src[m.g1.0..m.g1.1];
    let text = if g1_str.ends_with('\n') {
      g1_str[..g1_str.len() - 1].to_string()
    } else {
      g1_str.to_string()
    };
    Some((raw, text))
  }

  /// marked `tokenizer.text` (block) — (raw, text).
  fn t_block_text(&self, src: &str) -> Option<(String, String)> {
    if src.as_bytes().first() == Some(&b'\n') {
      return None;
    }
    let c = exec(&rules().block.text, src)?;
    let m0 = c.get(0)?.as_str();
    if m0.is_empty() {
      return None;
    }
    Some((m0.to_string(), m0.to_string()))
  }

  /// marked `tokenizer.table`.
  ///
  /// 分隔行预检（修复原理：`block.table` 巨正则要求第二行为
  /// `|:-` 分隔行；先用 memchr 定位首个换行并检查次行首个
  /// 非空字符 ∈ {`|`, `:`, `-`}，不符直接跳过 exec。捕获仍走
  /// 正则，保证 parity）。
  fn t_table(&mut self, src: &str) -> Option<Value> {
    {
      let b = src.as_bytes();
      let nl = match b.iter().position(|&c| c == b'\n') {
        Some(nl) => nl,
        None => return None,
      };
      let mut i = nl + 1;
      let mut sp = 0usize;
      while i < b.len() && b[i] == b' ' && sp < 3 {
        sp += 1;
        i += 1;
      }
      if i >= b.len() || !matches!(b[i], b'|' | b':' | b'-') {
        return None;
      }
    }
    let c = exec(&rules().block.table, src)?;
    let raw = c.get(0)?.as_str().to_string();
    let g1 = cap(&c, 1)?.to_string();
    let g2 = cap(&c, 2)?.to_string();
    if !rules().other.table_delimiter.test(&g2) {
      return None;
    }
    let headers = split_cells(&g1, None);
    let aligns_row = remove_all(&g2, &rules().other.table_align_chars);
    let aligns: Vec<&str> = aligns_row.split('|').collect();
    let rows_raw = match cap(&c, 3) {
      Some(g3) if !js_trim(g3).is_empty() => {
        let cleaned = replace_first_empty(g3, &rules().other.table_row_blank_line);
        cleaned
          .split('\n')
          .map(|x| x.to_string())
          .collect::<Vec<_>>()
      }
      _ => Vec::new(),
    };
    if headers.len() != aligns.len() {
      return None;
    }
    let mut aligns_out: Vec<Option<&str>> = Vec::with_capacity(aligns.len());
    for a in &aligns {
      if rules().other.table_align_right.test(a) {
        aligns_out.push(Some("right"));
      } else if rules().other.table_align_center.test(a) {
        aligns_out.push(Some("center"));
      } else if rules().other.table_align_left.test(a) {
        aligns_out.push(Some("left"));
      } else {
        aligns_out.push(None);
      }
    }
    let mut m = Map::new();
    m.insert("type".into(), sv("table"));
    m.insert("raw".into(), sv(raw));
    let mut header = Vec::new();
    for (i, h) in headers.iter().enumerate() {
      let mut cell = Map::new();
      cell.insert("text".into(), sv(h.clone()));
      cell.insert("tokens".into(), self.queue_inline(h));
      cell.insert("header".into(), Value::Bool(true));
      cell.insert("align".into(), align_json(aligns_out[i]));
      header.push(tok(cell));
    }
    let mut rows = Vec::new();
    for row in rows_raw {
      let cells = split_cells(&row, Some(headers.len()));
      let mut cells_out = Vec::new();
      for (i, cell_str) in cells.iter().enumerate() {
        let mut cell = Map::new();
        cell.insert("text".into(), sv(cell_str.clone()));
        cell.insert("tokens".into(), self.queue_inline(cell_str));
        cell.insert("header".into(), Value::Bool(false));
        cell.insert(
          "align".into(),
          align_json(aligns_out.get(i).copied().flatten()),
        );
        cells_out.push(tok(cell));
      }
      rows.push(Value::Array(cells_out));
    }
    m.insert(
      "align".into(),
      Value::Array(aligns_out.iter().map(|a| align_json(*a)).collect()),
    );
    m.insert("header".into(), Value::Array(header));
    m.insert("rows".into(), Value::Array(rows));
    Some(tok(m))
  }

  /// marked `tokenizer.blockquote` — (raw, text, children array id).
  fn t_blockquote(&mut self, src_in: &str) -> Option<(String, String, usize)> {
        let b0 = *src_in.as_bytes().first()?;
    if !matches!(b0, b' ' | b'>') {
      return None;
    }
    let c = exec(&rules().block.blockquote, src_in)?;
    let cap0 = c.get(0)?.as_str().to_string();
    let mut lines: Vec<String> = rtrim(&cap0, '\n')
      .split('\n')
      .map(|x| x.to_string())
      .collect();
    let mut raw = String::new();
    let mut text = String::new();
    let id = self.new_array();
    loop {
      let mut in_bq = false;
      let mut current_lines: Vec<String> = Vec::new();
      let mut consumed = lines.len();
      for idx in 0..lines.len() {
        if rules().other.blockquote_start.test(&lines[idx]) {
          current_lines.push(lines[idx].clone());
          in_bq = true;
        } else if !in_bq {
          current_lines.push(lines[idx].clone());
        } else {
          consumed = idx;
          break;
        }
      }
      lines.drain(..consumed);

      let current_raw = current_lines.join("\n");
      let current_text = replace_all_prefixed_g1(
        &current_raw,
        &rules().other.blockquote_setext_replace,
        "\n    ",
      );
      let current_text =
        replace_all_literal(&current_text, &rules().other.blockquote_setext_replace2, "");
      if raw.is_empty() {
        raw = current_raw.clone();
      } else {
        raw.push('\n');
        raw.push_str(&current_raw);
      }
      if text.is_empty() {
        text = current_text.clone();
      } else {
        text.push('\n');
        text.push_str(&current_text);
      }

      let saved_top = self.state.top;
      self.state.top = true;
      self.block_tokens(&current_text, id, true);
      self.state.top = saved_top;

      if lines.is_empty() {
        break;
      }

      let (last_type, last_raw, last_text) = match self.arena[id].last() {
        Some(t) => (
          token_type(t).to_string(),
          get_str(t, "raw").to_string(),
          get_str(t, "text").to_string(),
        ),
        None => break,
      };
      if last_type == "code" {
        // blockquote continuation cannot be preceded by a code block
        break;
      } else if last_type == "blockquote" {
        let new_text = format!("{last_raw}\n{}", lines.join("\n"));
        let Some((nraw, ntext, nid)) = self.t_blockquote(&new_text) else {
          break;
        };
        *self.arena[id].last_mut().unwrap() = blockquote_token(nraw.clone(), ntext.clone(), nid);
        raw.truncate(raw.len().saturating_sub(last_raw.len()));
        raw.push_str(&nraw);
        text.truncate(text.len().saturating_sub(last_text.len()));
        text.push_str(&ntext);
        break;
      } else if last_type == "list" {
        let new_text = format!("{last_raw}\n{}", lines.join("\n"));
        let Some((lraw, lval)) = self.t_list(&new_text) else {
          break;
        };
        *self.arena[id].last_mut().unwrap() = lval;
        // marked truncates both by the OLD raw length and appends the new
        // raw (quirk preserved verbatim).
        raw.truncate(raw.len().saturating_sub(last_raw.len()));
        raw.push_str(&lraw);
        text.truncate(text.len().saturating_sub(last_raw.len()));
        text.push_str(&lraw);
        let rest = substring0(&new_text, lraw.len() as i64).to_string();
        lines = rest.split('\n').map(|x| x.to_string()).collect();
        continue;
      }
      // any other last token: loop continues with the remaining lines
    }
    Some((raw, text, id))
  }

  /// marked `tokenizer.list` — (list.raw, list token).
  fn t_list(&mut self, src_in: &str) -> Option<(String, Value)> {
        let b0 = *src_in.as_bytes().first()?;
    if !matches!(b0, b' ' | b'*' | b'+' | b'-' | b'0'..=b'9') {
      return None;
    }
    let c = exec(&rules().block.list, src_in)?;
    let bull0 = js_trim(cap(&c, 1)?).to_string();
    let is_ordered = bull0.len() > 1;
    let start_val = if is_ordered {
      let digits = &bull0[..bull0.len() - 1];
      Value::Number(digits.parse::<i64>().ok()?.into())
    } else {
      sv("")
    };
    let bull_re = if is_ordered {
      format!(r"\d{{1,9}}\{}", &bull0[bull0.len() - 1..])
    } else {
      format!(r"\{}", bull0)
    };
    let item_re = list_item_regex(&bull_re);
    let mut ends_with_blank_line = false;
    let mut list_raw = String::new();
    let mut loose = false;
    let mut items: Vec<Item> = Vec::new();
    let mut src: &str = src_in;

    while !src.is_empty() {
      let Some(ic) = exec(&item_re, src) else {
        break;
      };
      if rules().block.hr.test(src) {
        // end list if the bullet was actually an hr
        break;
      }
      let mut item_raw = ic.get(0)?.as_str().to_string();
      let cap1 = cap(&ic, 1).unwrap_or("").to_string();
      let cap2 = cap(&ic, 2).unwrap_or("").to_string();
      src = &src[item_raw.len()..];

      // line = first line of cap[2] with leading tabs expanded 1→3 spaces
      let line_raw = first_line(&cap2);
      let mut leading_tabs = 0usize;
      for ch in line_raw.chars() {
        if ch == '\t' {
          leading_tabs += 1;
        } else {
          break;
        }
      }
      let mut line = format!("{}{}", " ".repeat(leading_tabs * 3), &line_raw[leading_tabs..]);
      let next_line = first_line(src).to_string();
      let mut blank_line = js_trim(&line).is_empty();
      let mut indent: usize;
      let mut item_contents = String::new();
      if blank_line {
        indent = cap1.len() + 1;
      } else {
        let found = search_first(&rules().other.non_space_char, &cap2).unwrap_or(0);
        indent = if found > 4 { 1 } else { found };
        item_contents = slice_from(&line, indent).to_string();
        indent += cap1.len();
      }

      let mut end_early = false;
      if blank_line && rules().other.blank_line.test(&next_line) {
        // items begin with at most one blank line
        item_raw.push_str(&next_line);
        item_raw.push('\n');
        let consume = next_line.len() + 1;
        src = if consume > src.len() {
          ""
        } else {
          &src[consume..]
        };
        end_early = true;
      }

      if !end_early {
        let next_bullet = next_bullet_regex(indent);
        let hr_r = hr_regex(indent);
        let fences_begin = fences_begin_regex(indent);
        let heading_begin = heading_begin_regex(indent);
        let html_begin = html_begin_regex(indent);
        while !src.is_empty() {
          let raw_line = first_line(src);
          // non-pedantic: nextLine stays raw; tabs are expanded only for the
          // dedent arithmetic and the running `line`.
          let next_line_no_tabs =
            replace_all_literal(raw_line, &rules().other.tab_char_global, "    ");

          // end list item on fences / heading / html / new bullet / hr
          if fences_begin.test(raw_line) {
            break;
          }
          if heading_begin.test(raw_line) {
            break;
          }
          if html_begin.test(raw_line) {
            break;
          }
          if next_bullet.test(raw_line) {
            break;
          }
          if hr_r.test(raw_line) {
            break;
          }

          let indented_ok = matches!(
            search_first(&rules().other.non_space_char, &next_line_no_tabs),
            Some(p) if p >= indent
          );
          if indented_ok || js_trim(raw_line).is_empty() {
            // dedent if possible
            item_contents.push('\n');
            item_contents.push_str(slice_from(&next_line_no_tabs, indent));
          } else {
            // not enough indentation
            if blank_line {
              break;
            }
            let line_tabs = replace_all_literal(&line, &rules().other.tab_char_global, "    ");
            if matches!(
              search_first(&rules().other.non_space_char, &line_tabs),
              Some(p) if p >= 4
            ) {
              // indented code block
              break;
            }
            if fences_begin.test(&line) {
              break;
            }
            if heading_begin.test(&line) {
              break;
            }
            if hr_r.test(&line) {
              break;
            }
            item_contents.push('\n');
            item_contents.push_str(raw_line);
          }

          if !blank_line && js_trim(raw_line).is_empty() {
            blank_line = true;
          }

          item_raw.push_str(raw_line);
          item_raw.push('\n');
          let consume = raw_line.len() + 1;
          src = if consume > src.len() {
            ""
          } else {
            &src[consume..]
          };
          line = slice_from(&next_line_no_tabs, indent).to_string();
        }
      }

      if !loose {
        if ends_with_blank_line {
          loose = true;
        } else if rules().other.double_blank_line.test(&item_raw) {
          ends_with_blank_line = true;
        }
      }
      let task = rules().other.list_is_task.test(&item_contents);
      items.push(Item {
        raw: item_raw.clone(),
        task,
        text: item_contents,
      });
      list_raw.push_str(&item_raw);
    }

    // "not a list since there were no items"
    let last = items.last_mut()?;
    // Do not consume newlines at end of final item (and of list.raw).
    last.raw = js_trim_end(&last.raw).to_string();
    last.text = js_trim_end(&last.text).to_string();
    let list_raw = js_trim_end(&list_raw).to_string();

    // Item child tokens are handled after the final item is trimmed.
    let mut item_values: Vec<(usize, Value, bool, String)> = Vec::new();
    for item in &items {
      self.state.top = false;
      let id = self.block_tokens_new(&item.text);
      let mut im = Map::new();
      im.insert("type".into(), sv("list_item"));
      im.insert("raw".into(), sv(item.raw.clone()));
      im.insert("task".into(), Value::Bool(item.task));
      im.insert("loose".into(), Value::Bool(false));
      im.insert("text".into(), sv(item.text.clone()));
      im.insert("tokens".into(), pend(id));
      if item.task {
        // Remove checkbox markdown from item tokens.
        let new_text = replace_first_empty(&item.text, &rules().other.list_replace_task);
        im.insert("text".into(), sv(new_text));
        let first_ty = self.arena[id].first().map(token_type);
        if matches!(first_ty, Some("text") | Some("paragraph")) {
          let first = self.arena[id].first_mut().unwrap();
          let nr = replace_first_empty(get_str(first, "raw"), &rules().other.list_replace_task);
          let nt = replace_first_empty(get_str(first, "text"), &rules().other.list_replace_task);
          first["raw"] = sv(nr);
          first["text"] = sv(nt);
          for job in self.queue.iter_mut().rev() {
            if rules().other.list_is_task.test(&job.src) {
              job.src = replace_first_empty(&job.src, &rules().other.list_replace_task);
              break;
            }
          }
        }
        if let Some(tr) = exec(&rules().other.list_task_checkbox, &item.raw) {
          let tr0 = tr.get(0)?.as_str().to_string();
          let checked = tr0 != "[ ]";
          let mut cb = Map::new();
          cb.insert("type".into(), sv("checkbox"));
          cb.insert("raw".into(), sv(format!("{tr0} ")));
          cb.insert("checked".into(), Value::Bool(checked));
          im.insert("checked".into(), Value::Bool(checked));
          if loose {
            let first_ty = self.arena[id].first().map(token_type);
            if matches!(first_ty, Some("text") | Some("paragraph")) {
              let cb_raw = format!("{tr0} ");
              let first = self.arena[id].first_mut().unwrap();
              first["raw"] = sv(format!("{}{}", cb_raw, get_str(first, "raw")));
              first["text"] = sv(format!("{}{}", cb_raw, get_str(first, "text")));
              let inner = pending_id(&first["tokens"]);
              match inner {
                Some(tid) => self.arena[tid].insert(0, tok(cb)),
                None => {
                  if let Some(Value::Array(a)) = first.get_mut("tokens") {
                    a.insert(0, tok(cb));
                  }
                }
              }
            } else {
              let mut pm = Map::new();
              pm.insert("type".into(), sv("paragraph"));
              pm.insert("raw".into(), sv(tr0.clone()));
              pm.insert("text".into(), sv(tr0.clone()));
              pm.insert("tokens".into(), Value::Array(vec![tok(cb)]));
              self.arena[id].insert(0, tok(pm));
            }
          } else {
            self.arena[id].insert(0, tok(cb));
          }
        }
      }
      if !loose {
        // Check if list should be loose
        let has_spaces = self.arena[id].iter().any(|t| token_type(t) == "space");
        let has_multiple = has_spaces
          && self.arena[id]
            .iter()
            .any(|t| token_type(t) == "space" && rules().other.any_line.test(get_str(t, "raw")));
        loose = has_multiple;
      }
      item_values.push((id, tok(im), item.task, item.text.clone()));
    }

    // Set all items to loose if list is loose.
    if loose {
      for (id, im, ..) in item_values.iter_mut() {
        im["loose"] = Value::Bool(true);
        for t in self.arena[*id].iter_mut() {
          if token_type(t) == "text" {
            t["type"] = sv("paragraph");
          }
        }
      }
    }

    let mut m = Map::new();
    m.insert("type".into(), sv("list"));
    m.insert("raw".into(), sv(list_raw.clone()));
    m.insert("ordered".into(), Value::Bool(is_ordered));
    m.insert("start".into(), start_val);
    m.insert("loose".into(), Value::Bool(loose));
    m.insert(
      "items".into(),
      Value::Array(item_values.into_iter().map(|(_, v, _, _)| v).collect()),
    );
    Some((list_raw, tok(m)))
  }

  // =========================================================================
  // block_tokens — marked `_Lexer#blockTokens`
  // =========================================================================

  fn block_tokens(&mut self, src_in: &str, arr: usize, mut last_paragraph_clipped: bool) {
    let mut src: &str = src_in;
    while !src.is_empty() {
      // newline
      if let Some(raw_len) = self.t_space(src) {
        let raw = &src[..raw_len];
        src = &src[raw_len..];
        if raw_len == 1 && !self.arena[arr].is_empty() {
          // a single \n spacer terminates the last line
          let last = self.arena[arr].last_mut().unwrap();
          append_field(last, "raw", "\n");
        } else {
          let mut m = Map::new();
          m.insert("type".into(), sv("space"));
          m.insert("raw".into(), sv(raw));
          self.arena[arr].push(tok(m));
        }
        continue;
      }

      // code (indented) — cannot interrupt a paragraph
      if let Some((raw, text)) = self.t_code(src) {
        src = &src[raw.len()..];
        let last_ty = self.arena[arr].last().map(token_type);
        if matches!(last_ty, Some("paragraph") | Some("text")) {
          let last = self.arena[arr].last_mut().unwrap();
          if !get_str(last, "raw").ends_with('\n') {
            append_field(last, "raw", "\n");
          }
          append_field(last, "raw", &raw);
          append_field(last, "text", &format!("\n{text}"));
          let new_text = get_str(last, "text").to_string();
          if let Some(j) = self.queue.last_mut() {
            j.src = new_text;
          }
        } else {
          let mut m = Map::new();
          m.insert("type".into(), sv("code"));
          m.insert("raw".into(), sv(raw));
          m.insert("codeBlockStyle".into(), sv("indented"));
          m.insert("text".into(), sv(text));
          self.arena[arr].push(tok(m));
        }
        continue;
      }

      // fences
      if let Some((raw, lang, text)) = self.t_fences(src) {
        src = &src[raw.len()..];
        let mut m = Map::new();
        m.insert("type".into(), sv("code"));
        m.insert("raw".into(), sv(raw));
        m.insert("lang".into(), sv(lang));
        m.insert("text".into(), sv(text));
        self.arena[arr].push(tok(m));
        continue;
      }

      // heading
      if let Some((raw, depth, text)) = self.t_heading(src) {
        src = &src[raw.len()..];
        let tokens = self.queue_inline(&text);
        let mut m = Map::new();
        m.insert("type".into(), sv("heading"));
        m.insert("raw".into(), sv(raw));
        m.insert("depth".into(), Value::Number(depth.into()));
        m.insert("text".into(), sv(text));
        m.insert("tokens".into(), tokens);
        self.arena[arr].push(tok(m));
        continue;
      }

      // hr
      if let Some(raw) = self.t_hr(src) {
        src = &src[raw.len()..];
        let mut m = Map::new();
        m.insert("type".into(), sv("hr"));
        m.insert("raw".into(), sv(raw));
        self.arena[arr].push(tok(m));
        continue;
      }

      // blockquote
      if let Some((raw, text, id)) = self.t_blockquote(src) {
        src = &src[raw.len().min(src.len())..];
        self.arena[arr].push(blockquote_token(raw, text, id));
        continue;
      }

      // list
      if let Some((raw, list_tok)) = self.t_list(src) {
        src = &src[raw.len().min(src.len())..];
        self.arena[arr].push(list_tok);
        continue;
      }

      // html
      if let Some((raw, pre, text)) = self.t_html(src) {
        src = &src[raw.len()..];
        let mut m = Map::new();
        m.insert("type".into(), sv("html"));
        m.insert("block".into(), Value::Bool(true));
        m.insert("raw".into(), sv(raw));
        m.insert("pre".into(), Value::Bool(pre));
        m.insert("text".into(), sv(text));
        self.arena[arr].push(tok(m));
        continue;
      }

      // def (link reference definition)
      if let Some((raw, tag, href, title)) = self.t_def(src) {
        src = &src[raw.len().min(src.len())..];
        let last_ty = self.arena[arr].last().map(token_type);
        if matches!(last_ty, Some("paragraph") | Some("text")) {
          let last = self.arena[arr].last_mut().unwrap();
          if !get_str(last, "raw").ends_with('\n') {
            append_field(last, "raw", "\n");
          }
          append_field(last, "raw", &raw);
          append_field(last, "text", &format!("\n{raw}"));
          let new_text = get_str(last, "text").to_string();
          if let Some(j) = self.queue.last_mut() {
            j.src = new_text;
          }
        } else if !self.links.contains_key(&tag) {
          self.links.insert(
            tag.clone(),
            LinkDef {
              href: href.clone(),
              title: title.clone(),
            },
          );
          let mut m = Map::new();
          m.insert("type".into(), sv("def"));
          m.insert("tag".into(), sv(tag));
          m.insert("raw".into(), sv(raw));
          m.insert("href".into(), sv(href));
          if let Some(t) = title {
            m.insert("title".into(), sv(t));
          }
          self.arena[arr].push(tok(m));
        }
        continue;
      }

      // table (gfm)
      if let Some(t) = self.t_table(src) {
        let raw_len = get_str(&t, "raw").len();
        src = &src[raw_len.min(src.len())..];
        self.arena[arr].push(t);
        continue;
      }

      // lheading
      if let Some((raw, depth, text)) = self.t_lheading(src) {
        src = &src[raw.len().min(src.len())..];
        let tokens = self.queue_inline(&text);
        let mut m = Map::new();
        m.insert("type".into(), sv("heading"));
        m.insert("raw".into(), sv(raw));
        m.insert("depth".into(), Value::Number(depth.into()));
        m.insert("text".into(), sv(text));
        m.insert("tokens".into(), tokens);
        self.arena[arr].push(tok(m));
        continue;
      }

      // top-level paragraph
      if self.state.top {
        if let Some((raw, text)) = self.t_paragraph(src) {
          let tokens = self.queue_inline(&text);
          let raw_len = raw.len();
          let last_ty = self.arena[arr].last().map(token_type);
          if last_paragraph_clipped && last_ty == Some("paragraph") {
            let last = self.arena[arr].last_mut().unwrap();
            if !get_str(last, "raw").ends_with('\n') {
              append_field(last, "raw", "\n");
            }
            append_field(last, "raw", &raw);
            append_field(last, "text", &format!("\n{text}"));
            self.queue.pop();
            let new_text = get_str(last, "text").to_string();
            if let Some(j) = self.queue.last_mut() {
              j.src = new_text;
            }
          } else {
            let mut m = Map::new();
            m.insert("type".into(), sv("paragraph"));
            m.insert("raw".into(), sv(raw));
            m.insert("text".into(), sv(text));
            m.insert("tokens".into(), tokens);
            self.arena[arr].push(tok(m));
          }
          // no extensions: cutSrc === src, so clipped stays false
          last_paragraph_clipped = false;
          src = &src[raw_len.min(src.len())..];
          continue;
        }
      }

      // text
      if let Some((raw, text)) = self.t_block_text(src) {
        let tokens = self.queue_inline(&text);
        let raw_len = raw.len();
        let last_ty = self.arena[arr].last().map(token_type);
        if last_ty == Some("text") {
          let last = self.arena[arr].last_mut().unwrap();
          if !get_str(last, "raw").ends_with('\n') {
            append_field(last, "raw", "\n");
          }
          append_field(last, "raw", &raw);
          append_field(last, "text", &format!("\n{text}"));
          self.queue.pop();
          let new_text = get_str(last, "text").to_string();
          if let Some(j) = self.queue.last_mut() {
            j.src = new_text;
          }
        } else {
          let mut m = Map::new();
          m.insert("type".into(), sv("text"));
          m.insert("raw".into(), sv(raw));
          m.insert("text".into(), sv(text));
          m.insert("tokens".into(), tokens);
          self.arena[arr].push(tok(m));
        }
        src = &src[raw_len.min(src.len())..];
        continue;
      }

      // marked throws 'Infinite loop on byte' here; the text tokenizer above
      // always consumes ≥1 char from non-empty src, so this is unreachable.
      // Keep the raw-concat invariant as a defensive fallback.
      let mut m = Map::new();
      m.insert("type".into(), sv("text"));
      m.insert("raw".into(), sv(src));
      m.insert("text".into(), sv(src));
      let rest = src.to_string();
      let tokens = self.queue_inline(&rest);
      m.insert("tokens".into(), tokens);
      self.arena[arr].push(tok(m));
      src = "";
    }
    self.state.top = true;
  }

  // =========================================================================
  // inline phase — masking + `inlineTokens`
  // =========================================================================

  /// marked `tokenizer.escape`
  fn t_escape(&self, src: &str) -> Option<(Value, usize)> {
    // 手工快路径：内联 escape 规则是 `^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])`
    //（纯 ASCII 字符类，无 backref），逐字节判断即可，与 fancy-regex 的 exec
    // 调用完全等价，但省掉了引擎的建模开销（`\` 在正文中高频出现）。
    let b = src.as_bytes();
    if b.len() >= 2
      && b[0] == b'\\'
      && matches!(
        b[1],
        b'!'
          | b'"'
          | b'#'
          | b'$'
          | b'%'
          | b'&'
          | b'\''
          | b'('
          | b')'
          | b'*'
          | b'+'
          | b','
          | b'-'
          | b'.'
          | b'/'
          | b':'
          | b';'
          | b'<'
          | b'='
          | b'>'
          | b'?'
          | b'@'
          | b'['
          | b'\\'
          | b']'
          | b'^'
          | b'_'
          | b'`'
          | b'{'
          | b'|'
          | b'}'
          | b'~'
      )
    {
      let m0 = &src[..2];
      let mut m = Map::new();
      m.insert("type".into(), sv("escape"));
      m.insert("raw".into(), sv(m0));
      m.insert("text".into(), sv(&src[1..2]));
      return Some((tok(m), 2));
    }
    None
  }

  /// marked `tokenizer.tag` (inline html + link/raw-block state).
  fn t_tag(&mut self, src: &str) -> Option<(Value, usize)> {
    // 快路径预检：tag 规则的每个分支在 `<` 之后都要求是 `!`/`/`/`?` 或
    // ASCII 字母（`<!--`、`</a>`、`<a...`、`<?...`、`<!A...`、`<![CDATA[`），
    // 否则正则必定失败，直接返回以省掉一次 exec。
    let b = src.as_bytes();
    if b.len() < 2
      || !matches!(b[1], b'!' | b'/' | b'?' | b'A'..=b'Z' | b'a'..=b'z')
    {
      return None;
    }
    let c = exec(&rules().inline.tag, src)?;
    let raw_len = c.get(0)?.as_str().len();
    if raw_len == 0 {
      return None;
    }
    let m0 = c.get(0)?.as_str().to_string();
    if !self.state.in_link && rules().other.start_a_tag.test(&m0) {
      self.state.in_link = true;
    } else if self.state.in_link && rules().other.end_a_tag.test(&m0) {
      self.state.in_link = false;
    }
    if !self.state.in_raw_block && rules().other.start_pre_script_tag.test(&m0) {
      self.state.in_raw_block = true;
    } else if self.state.in_raw_block && rules().other.end_pre_script_tag.test(&m0) {
      self.state.in_raw_block = false;
    }
    let mut m = Map::new();
    m.insert("type".into(), sv("html"));
    m.insert("raw".into(), sv(m0.clone()));
    m.insert("inLink".into(), Value::Bool(self.state.in_link));
    m.insert("inRawBlock".into(), Value::Bool(self.state.in_raw_block));
    m.insert("block".into(), Value::Bool(false));
    m.insert("text".into(), sv(m0));
    Some((tok(m), raw_len))
  }

  /// marked `_Tokenizer#outputLink`.
  fn output_link(&mut self, label: &str, href: &str, title: &str, raw: &str) -> Value {
    let text = replace_all_g1(label, &rules().other.output_link_replace);
    self.state.in_link = true;
    let tokens = self.inline_tokens_new(&text);
    self.state.in_link = false;
    let mut m = Map::new();
    m.insert(
      "type".into(),
      if raw.starts_with('!') {
        sv("image")
      } else {
        sv("link")
      },
    );
    m.insert("raw".into(), sv(raw));
    m.insert("href".into(), sv(href));
    m.insert(
      "title".into(),
      if title.is_empty() {
        Value::Null
      } else {
        sv(title)
      },
    );
    m.insert("text".into(), sv(text));
    m.insert("tokens".into(), Value::Array(tokens));
    tok(m)
  }

  /// marked `tokenizer.link`.
  fn t_link(&mut self, src: &str) -> Option<(Value, usize)> {
    let r = rules();
    let c = exec(&r.inline.link, src)?;
    let mut c0 = c.get(0)?.as_str().to_string();
    let c1 = c.get(1)?.as_str().to_string();
    let mut c2 = c.get(2)?.as_str().to_string();
    let mut c3: Option<String> = cap(&c, 3).map(|x| x.to_string());
    if c0.is_empty() {
      return None;
    }
    let trimmed_url = js_trim(&c2).to_string();
    if r.other.start_angle_bracket.test(&trimmed_url) {
      // commonmark requires matching angle brackets
      if !r.other.end_angle_bracket.test(&trimmed_url) {
        return None;
      }
      // ending angle bracket cannot be escaped
      let rtrim_slash = rtrim(substring0(&trimmed_url, trimmed_url.len() as i64 - 1), '\\');
      if (utf16_len(&trimmed_url[..trimmed_url.len() - rtrim_slash.len()]) ) % 2 == 0 {
        return None;
      }
    } else {
      // find closing parenthesis
      let last_paren_index = find_closing_bracket(&c2, '(', ')');
      if last_paren_index == -2 {
        // more open parens than closed
        return None;
      }
      if last_paren_index > -1 {
        let start = if c0.starts_with('!') { 5i64 } else { 4 };
        let link_len = start + c1.len() as i64 + last_paren_index;
        c2 = substring0(&c2, last_paren_index).to_string();
        c0 = js_trim(substring0(&c0, link_len)).to_string();
        c3 = Some(String::new());
      }
    }
    let mut href = js_trim(&c2).to_string();
    let title = match &c3 {
      Some(t) if !t.is_empty() => {
        // slice(1, -1): strip the surrounding ASCII quotes
        let stripped = &t[1..t.len() - 1];
        replace_first_g1(stripped, &r.inline.any_punctuation)
      }
      _ => String::new(),
    };
    if r.other.start_angle_bracket.test(&href) {
      href = if href.len() >= 2 {
        href[1..href.len() - 1].to_string()
      } else {
        String::new()
      };
    }
    let href = if !href.is_empty() {
      replace_first_g1(&href, &r.inline.any_punctuation)
    } else {
      href
    };
    let v = self.output_link(&c1, &href, &title, &c0);
    let len = get_str(&v, "raw").len();
    Some((v, len))
  }

  /// marked `tokenizer.reflink` / `nolink`.
  fn t_reflink(&mut self, src: &str) -> Option<(Value, usize)> {
    let r = rules();
    let c = exec(&r.inline.reflink, src).or_else(|| exec(&r.inline.nolink, src))?;
    let c0 = c.get(0)?.as_str().to_string();
    if c0.is_empty() {
      return None;
    }
    let g1 = cap(&c, 1)?.to_string();
    let label: &str = match cap(&c, 2) {
      Some(g2) if !g2.is_empty() => g2,
      _ => &g1,
    };
    let link_string = replace_all_literal(label, &r.other.multiple_space_global, " ");
    let key = link_string.to_lowercase();
    match self.links.get(&key) {
      None => {
        // first char of cap[0] ('!' or '[' — ASCII)
        let t = &c0[..1];
        let mut m = Map::new();
        m.insert("type".into(), sv("text"));
        m.insert("raw".into(), sv(t));
        m.insert("text".into(), sv(t));
        Some((tok(m), t.len()))
      }
      Some(link) => {
        let href = link.href.clone();
        let title = link.title.clone().unwrap_or_default();
        let v = self.output_link(&g1, &href, &title, &c0);
        let len = get_str(&v, "raw").len();
        Some((v, len))
      }
    }
  }

  /// marked `tokenizer.emStrong`.
  fn t_em_strong(
    &mut self,
    src: &str,
    masked_full: &str,
    prev_char: PC,
  ) -> Option<(Value, usize)> {
    let r = rules();
    let c = exec(&r.inline.em_strong_ldelim, src)?;
    let m0_owned = c.get(0)?.as_str().to_string();
    if m0_owned.is_empty() {
      return None;
    }
    // `_` can't be between two alphanumerics
    if cap(&c, 3).is_some() && prev_char.matches(&r.other.unicode_alpha_numeric) {
      return None;
    }
    let next_char = cap(&c, 1).or(cap(&c, 2)).unwrap_or("");
    if !(next_char.is_empty()
      || prev_char.is_empty()
      || prev_char.matches(&r.inline.punctuation))
    {
      return None;
    }
    // unicode regex counts emoji as 1 char — for the ASCII delimiter run
    // code points == bytes, so the run length is the byte length minus the
    // trailing (single code point) character.
    let last_cp = m0_owned.chars().next_back()?;
    let l_len = m0_owned.len() - last_cp.len_utf8();
    // 中文：热路径替换——闭合定界符原本要跑 `R_INLINE_EM_STRONG_R_DELIM_*`
    // 的回退扫描（80× 富文本实测 ~3.0ms/parse，占全量解析约53%）。
    // 现改用 `emstrong.rs` 手写状态机：同一套 (l, mid)/mod-3 规则、
    // 同一张 `\p{P}\p{S}` 表，6106 组 (masked,src) 差分 0 失配，
    // 实测 ~102µs（约29×）。开 run 与 prevChar 门限仍由上面的 ldelim
    // 正则（锚定、极小）判定，成本可忽略。
    let m = crate::emstrong::find_closing_em_strong(masked_full, src)?;
    let raw = &src[..m.end];
    if raw.is_empty() {
      return None;
    }
    // marked `Math.min(lLength, o_eff) % 2` → em（奇数）否则 strong；
    // `m.length` 即 marked 的 `o_eff`，与原实现的
    // `l_len.min(r_len.min(r_len + delim_total + mid_delim_total))` 恒等。
    let odd = (l_len as i64).min(m.length as i64).rem_euclid(2) == 1;
    let text = m.text;
    let tokens = self.inline_tokens_new(&text);
    let mut m2 = Map::new();
    m2.insert(
      "type".into(),
      if odd { sv("em") } else { sv("strong") },
    );
    m2.insert("raw".into(), sv(raw));
    m2.insert("text".into(), sv(text));
    m2.insert("tokens".into(), Value::Array(tokens));
    let raw_len = raw.len();
    Some((tok(m2), raw_len))
  }

  /// marked `tokenizer.codespan`.
  fn t_codespan(&self, src: &str) -> Option<(Value, usize)> {
    let r = rules();
    // Hand-rolled scan of marked's inline code rule
    // /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/: the opener is the maximal
    // backtick run at 0; the lazy content then ends at the FIRST later
    // maximal backtick run of exactly the same length (runs shorter or
    // longer than the opener are swallowed into the content, because the
    // backref `(?!`) fails inside a longer run and the content's first/last
    // char can never be a backtick). Byte-scan instead of a backtracking
    // regex — verified byte-equal by the parity harness.
    let b = src.as_bytes();
    if b.first() != Some(&b'`') {
      return None;
    }
    let n = b.iter().take_while(|&&c| c == b'`').count();
    if n == b.len() {
      return None;
    }
    let mut close_end = None;
    let mut i = n;
    while i < b.len() {
      if b[i] == b'`' {
        let run = b[i..].iter().take_while(|&&c| c == b'`').count();
        if run == n {
          close_end = Some(i + n);
          break;
        }
        i += run;
      } else {
        i += 1;
      }
    }
    let close_end = close_end?;
    let m0 = &src[..close_end];
    let content = &src[n..close_end - n];
    let mut text = replace_all_literal(content, &r.other.new_line_char_global, " ");
    // nonSpaceChar /[^ ]/, startingSpaceChar /^ /, endingSpaceChar / $/
    let has_non_space = text.bytes().any(|c| c != b' ');
    let has_space_both = text.starts_with(' ') && text.ends_with(' ');
    if has_non_space && has_space_both && text.len() >= 2 {
      text = text[1..text.len() - 1].to_string();
    }
    let mut m = Map::new();
    m.insert("type".into(), sv("codespan"));
    m.insert("raw".into(), sv(m0));
    m.insert("text".into(), sv(text));
    Some((tok(m), m0.len()))
  }

  /// marked `tokenizer.br`.
  fn t_br(&self, src: &str) -> Option<(Value, usize)> {
    // 手工快路径：规则是 `^( {2,}|\\)\n(?!\s*$)`，纯字面结构。
    // `(?!\s*$)` 中的 `\s` 按 JS 语义判定（`js_space`，与 helpers 中
    // `String#trim` 的字符集一致；fancy-regex 的 `\s` 在 U+0085/U+FEFF
    // 上与 JS 有差异，这里以 marked 的 JS 语义为准）。
    let b = src.as_bytes();
    let mut i = 0usize;
    if b.first() == Some(&b'\\') {
      i = 1;
    } else {
      while i < b.len() && b[i] == b' ' {
        i += 1;
      }
      if i < 2 {
        return None;
      }
    }
    if b.get(i) != Some(&b'\n') {
      return None;
    }
    let end = i + 1;
    let mut has_non_space = false;
    for c in src[end..].chars() {
      if !js_space(c) {
        has_non_space = true;
        break;
      }
    }
    if !has_non_space {
      return None;
    }
    let m0 = &src[..end];
    let mut m = Map::new();
    m.insert("type".into(), sv("br"));
    m.insert("raw".into(), sv(m0));
    Some((tok(m), m0.len()))
  }

  /// marked `tokenizer.del` (gfm).
  fn t_del(&mut self, src: &str) -> Option<(Value, usize)> {
    let c = exec(&rules().inline.del, src)?;
    let m0 = c.get(0)?.as_str();
    if m0.is_empty() {
      return None;
    }
    let text = cap(&c, 2)?.to_string();
    let tokens = self.inline_tokens_new(&text);
    let mut m = Map::new();
    m.insert("type".into(), sv("del"));
    m.insert("raw".into(), sv(m0));
    m.insert("text".into(), sv(text));
    m.insert("tokens".into(), Value::Array(tokens));
    Some((tok(m), m0.len()))
  }

  /// marked `tokenizer.autolink`.
  fn t_autolink(&self, src: &str) -> Option<(Value, usize)> {
    // 快路径预检：autolink 形如 `<...>`，若输入中根本没有 `>` 则正则必定
    // 失败，直接返回以省掉一次 fancy-regex 的 exec。
    let b = src.as_bytes();
    if b.len() < 3 || b[0] != b'<' {
      return None;
    }
    if matches!(b[1], b' ' | b'\t' | b'\n' | b'\r' | b'<' | b'>') {
      return None;
    }
    if !src.bytes().any(|c| c == b'>') {
      return None;
    }
    let c = exec(&rules().inline.autolink, src)?;
    let m0 = c.get(0)?.as_str();
    if m0.is_empty() {
      return None;
    }
    let g1 = cap(&c, 1)?;
    let is_email = cap(&c, 2) == Some("@");
    let text = g1;
    let href = if is_email {
      format!("mailto:{text}")
    } else {
      text.to_string()
    };
    let mut inner = Map::new();
    inner.insert("type".into(), sv("text"));
    inner.insert("raw".into(), sv(text));
    inner.insert("text".into(), sv(text));
    let mut m = Map::new();
    m.insert("type".into(), sv("link"));
    m.insert("raw".into(), sv(m0));
    m.insert("text".into(), sv(text));
    m.insert("href".into(), sv(href));
    m.insert("tokens".into(), Value::Array(vec![tok(inner)]));
    Some((tok(m), m0.len()))
  }

  /// marked `tokenizer.url` (gfm extended autolink).
  fn t_url(&self, src: &str) -> Option<(Value, usize)> {
    // 快路径预检：url 规则只可能是 `http(s)://`、`ftp://`（大小写不敏感）、
    // `www.` 前缀或含 `@` 的邮箱形式；不满足任一必要首部/字符条件时正则
    // 必定失败，直接返回以省掉一次 exec。邮箱分支要求 `@` 出现在首个
    // 空白/` <` 之前且首字符是邮箱 atom 字符。
    let b = src.as_bytes();
    let scheme_like = b.len() >= 4
      && ((b[0] | 0x20) == b'h'
        || (b[0] | 0x20) == b'f'
        || b[0] == b'w'
        || b[0] == b'W');
    if !scheme_like {
      let is_atom_first = b[0].is_ascii_alphanumeric() || matches!(b[0], b'.' | b'_' | b'+' | b'-');
      if !is_atom_first {
        return None;
      }
      let mut seen_at = false;
      for &c in b.iter() {
        if c == b'@' {
          seen_at = true;
          break;
        }
        if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' || c == b'<' {
          break;
        }
      }
      if !seen_at {
        return None;
      }
    }
    let r = rules();
    let c = exec(&r.inline.url, src)?;
    let raw_len = c.get(0)?.as_str().len();
    if raw_len == 0 {
      return None;
    }
    let g1 = cap(&c, 1).map(|x| x.to_string());
    let is_email = cap(&c, 2) == Some("@");
    let mut c0 = c.get(0)?.as_str().to_string();
    let (text, href) = if is_email {
      let t = c0.clone();
      let h = format!("mailto:{t}");
      (t, h)
    } else {
      // extended autolink path validation (marked `_backpedal` loop)
      // 快路径：`_backpedal` 只会裁剪结尾的标点/括号/`&` 等特殊字节；若
      // 整个候选串都不含这些字节，第一分支 `[^?!.,:;*_'"~()&]+` 会一次性
      // 匹配全串（leftmost 即全长），循环首轮即收敛，直接跳过正则。
      let all_plain = c0.bytes().all(|c| {
        !matches!(
          c,
          b'?' | b'!' | b'.' | b',' | b':' | b';' | b'*' | b'_' | b'\'' | b'"' | b'~' | b')'
            | b'(' | b'&'
        )
      });
      if !all_plain {
        loop {
          let prev = c0.clone();
          c0 = exec(&r.inline.backpedal, &c0)
            .map(|x| x.get(0).unwrap().as_str().to_string())
            .unwrap_or_default();
          if prev == c0 || c0.is_empty() {
            break;
          }
        }
      }
      let t = c0.clone();
      let h = if g1.as_deref() == Some("www.") {
        format!("http://{t}")
      } else {
        t.clone()
      };
      (t, h)
    };
    let mut inner = Map::new();
    inner.insert("type".into(), sv("text"));
    inner.insert("raw".into(), sv(text.clone()));
    inner.insert("text".into(), sv(text.clone()));
    let mut m = Map::new();
    m.insert("type".into(), sv("link"));
    m.insert("raw".into(), sv(c0.clone()));
    m.insert("text".into(), sv(text));
    m.insert("href".into(), sv(href));
    m.insert("tokens".into(), Value::Array(vec![tok(inner)]));
    let len = c0.len();
    Some((tok(m), len))
  }

  /// marked `tokenizer.inlineText`.
  ///
  /// Hand-rolled scan of the gfm text rule
  /// `^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[email]+@)|[\s\S]*?(?:(?=stop|\b_|http|ftp://|www.|$)|[^ ](?= {2,}\n)|[^email](?=[email]+@)))`:
  /// a leading `` ` ``/`~` run (or one scalar), then the match ends at the
  /// first position where any stop condition holds — a stop char
  /// (\\<![`*~_), a case-insensitive `http`/`ftp://`/`www.` prefix, the end
  /// of input, a non-space followed by `{2,}\n`, or a non-email char followed
  /// by `email+@`. Byte-scan instead of a backtracking regex; stops can only
  /// trigger at ASCII bytes, which are always UTF-8 char boundaries, so byte
  /// scanning is equivalent (verified byte-equal by the parity harness).
  fn t_inline_text(&self, src: &str) -> Option<(Value, usize)> {
    let b = src.as_bytes();
    if b.is_empty() {
      return None;
    }
    // leading [`~]+ or one scalar [^`~]
    let p = if b[0] == b'`' || b[0] == b'~' {
      b.iter()
        .take_while(|&&c| c == b'`' || c == b'~')
        .count()
    } else {
      utf8_scalar_len(b[0])
    };
    let is_email = |c: u8| {
      c.is_ascii_alphanumeric()
        || matches!(
          c,
          b'.' | b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'/' | b'=' | b'?'
            | b'_' | b'`' | b'{' | b'|' | b'}' | b'~' | b'-'
        )
    };
    // (?= {2,}\n) at q: a run of >= 2 spaces directly followed by \n
    let two_spaces_nl = |b: &[u8], q: usize| -> bool {
      if q + 2 > b.len() || b[q] != b' ' || b[q + 1] != b' ' {
        return false;
      }
      let mut k = q + 2;
      while k < b.len() && b[k] == b' ' {
        k += 1;
      }
      k < b.len() && b[k] == b'\n'
    };
    // (?=[email]+@) at q
    let email_at = |b: &[u8], q: usize| -> bool {
      let mut k = q;
      while k < b.len() && is_email(b[k]) {
        k += 1;
      }
      k > q && k < b.len() && b[k] == b'@'
    };
    // case-insensitive "http" prefix at q ([sS]? makes https stop at http)
    let http_at = |b: &[u8], q: usize| -> bool {
      q + 4 <= b.len()
        && (b[q] | 0x20) == b'h'
        && (b[q + 1] | 0x20) == b't'
        && (b[q + 2] | 0x20) == b't'
        && (b[q + 3] | 0x20) == b'p'
    };
    let stop_char = |c: u8| matches!(c, b'\\' | b'<' | b'!' | b'[' | b'`' | b'*' | b'~' | b'_');
    // zero-width alternatives at the position right after the lead run
    let end = if two_spaces_nl(b, p) || email_at(b, p) {
      p
    } else {
      let end;
      let mut q = p;
      loop {
        // alt 1: zero-width stop lookahead (includes (?=$))
        if q == b.len()
          || stop_char(b[q])
          || http_at(b, q)
          || (q + 6 <= b.len() && b[q] | 0x20 == b'f'
            && b[q + 1] | 0x20 == b't'
            && b[q + 2] | 0x20 == b'p'
            && b[q + 3] == b':'
            && b[q + 4] == b'/'
            && b[q + 5] == b'/')
          || (q + 4 <= b.len() && b[q] == b'w'
            && b[q + 1] == b'w'
            && b[q + 2] == b'w'
            && b[q + 3] == b'.')
        {
          end = Some(q);
          break;
        }
        // alt 2: consume one non-space char, then (?= {2,}\n)
        if b[q] != b' ' && two_spaces_nl(b, q + 1) {
          end = Some(q + 1);
          break;
        }
        // alt 3: consume one non-email char, then (?=[email]+@)
        if !is_email(b[q]) && email_at(b, q + 1) {
          end = Some(q + 1);
          break;
        }
        q += 1;
      }
      end?
    };
    let m0 = &src[..end];
    let mut m = Map::new();
    m.insert("type".into(), sv("text"));
    m.insert("raw".into(), sv(m0));
    m.insert("text".into(), sv(m0));
    m.insert("escaped".into(), Value::Bool(self.state.in_raw_block));
    Some((tok(m), m0.len()))
  }

  // =========================================================================
  // inlineTokens — marked `_Lexer#inlineTokens`
  // =========================================================================

  fn inline_tokens_core(&mut self, src_in: &str, out: &mut Vec<Value>) {
    let __t0 = std::time::Instant::now();
    let __r = self.inline_tokens_core_inner(src_in, out);
    crate::INLINE_NS.fetch_add(__t0.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
    __r
  }

  fn inline_tokens_core_inner(&mut self, src_in: &str, out: &mut Vec<Value>) {
    let r = rules();
    // 热路径掩码：原来每次命中都 `masked.replace_range(..)` 拼接
    // `"a".repeat(..)`，每次都会 memmove 后缀（命中 M 次即 O(M·N)，
    // 最坏 O(M^2)）。这里改为位集（`Vec<u64>`，置位 O(1)）记录已掩码
    // 的字节区间，搜索仍顺序进行（语义与原来逐轮在已掩码串上搜索完全
    // 一致），每轮只做原地 ASCII 填充、绝不搬移后缀；填充前后串长度永
    // 远不变，因此 `t_em_strong` 按 `masked` 坐标计算的 `raw_len` 不变，
    // 与原来逐字节相等。
    let mut masked = src_in.to_string();
    // 已掩码字节的位集：`mask[w]>>b` 为 1 表示该字节已被填充为 inert
    // 字符（`a`/`+`/`[`/`]`），仅用于断言各轮填充区间互不重叠、 accessory
    // 调试；掩码串本身通过下面的原地填充得到（单轮 O(命中长度)，无搬移）。
    let mut mask = vec![0u64; src_in.len().div_ceil(64)];
    let mut mask_set = |mask: &mut [u64], mut s: usize, e: usize| {
      while s < e {
        mask[s / 64] |= 1 << (s % 64);
        s += 1;
      }
    };

    // mask out reflinks (only link definitions seen so far)
    if !self.links.is_empty() {
      let mut pos = 0usize;
      while let Some(m) = r.inline.reflink_search.find_from_pos(&masked, pos).ok().flatten() {
        let (m_start, m_end) = (m.start(), m.end());
        let mt = masked[m_start..m_end].to_string();
        pos = m_end;
        let key_start = match mt.rfind('[') {
          Some(i) => i + 1,
          None => 0,
        };
        let key_end = mt.len().saturating_sub(1);
        let key = if key_start <= key_end {
          &mt[key_start..key_end]
        } else {
          ""
        };
        if self.links.contains_key(key) {
          // 原地填充 `[a...a]`（等长；首字节 `[`、尾字节 `]` 均为 ASCII，
          // 填充区间整体被 ASCII 覆盖，UTF-8 合法性不变）。
          mask_fill_brackets(&mut masked, &mut mask_set, &mut mask, m_start, m_end);
        }
      }
    }

    // mask out escaped characters (byte-length preserving: all `+`)
    let mut pos = 0usize;
    while let Some(m) = r.inline.any_punctuation.find_from_pos(&masked, pos).ok().flatten() {
      let (m_start, m_end) = (m.start(), m.end());
      pos = m_end;
      // 原地填充 `+`（等长；匹配是 `\` + 标点字符，整体覆盖为 ASCII）。
      mask_fill_byte(&mut masked, &mut mask_set, &mut mask, m_start, m_end, b'+');
    }

    // mask out other blocks (links, code spans, inline html).
    // Candidate prefilter: block_skip's three alternatives can only start at
    // `[` (link), a backtick (code span) or `<` (html) — jump straight to the
    // next candidate byte instead of letting the backtracking engine scan
    // every position (exact: the engine's unanchored search is "try from
    // each position in order", and it can only start at those bytes).
    let __t = std::time::Instant::now();
    let mut pos = 0usize;
    loop {
      pos += match masked[pos..].find(['[', '`', '<']) {
        Some(off) => off,
        None => break,
      };
      let Some(mc) = r.inline.block_skip.captures_from_pos(&masked, pos).ok().flatten() else {
        pos += 1;
        continue;
      };
      let (start, end, offset) = {
        let m0 = mc.get(0).unwrap();
        let off = match cap(&mc, 2) {
          Some(g) if !g.is_empty() => g.len(),
          _ => 0,
        };
        (m0.start(), m0.end(), off)
      };
      pos = end;
      // 原地填充 `[a...a]`（等长；`replace_range` 在等长时本就只是覆盖，
      // 这里去掉 memmove 与临时 `String` 分配，结果逐字节相同）。
      mask_fill_brackets(&mut masked, &mut mask_set, &mut mask, start + offset, end);
    }
    crate::MASK_NS.fetch_add(__t.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);

    // (hooks.emStrongMask — no hooks with the pinned options)

    let mut keep_prev_char = false;
    let mut prev_char = PC::Empty;
    let mut src: &str = src_in;
    let __it0 = std::time::Instant::now();
    while !src.is_empty() {
      crate::LOOP_ITERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
      if !keep_prev_char {
        prev_char = PC::Empty;
      }
      keep_prev_char = false;

      let __g0 = std::time::Instant::now();
      // Literal-prefix guards: every inline rule's regex starts with a fixed
      // byte, so all but the matching tokenizer are skipped without a
      // fancy-regex exec call (the engine's per-exec overhead dominates for
      // short anchors).
      let b0 = src.as_bytes()[0];

      // escape: /^\\(...)/
      if b0 == b'\\' {
        if let Some((v, len)) = self.t_escape(src) {
          if len > 0 {
            out.push(v);
            src = &src[len..];
            continue;
          }
        }
      }
      // tag: /^<(?:...)/ and autolink: /^<(...)>/
      if b0 == b'<' {
        if let Some((v, len)) = self.t_tag(src) {
          if len > 0 {
            out.push(v);
            src = &src[len..];
            continue;
          }
        }
      }
      // link + reflink/nolink: /^!?\[/
      if b0 == b'[' || b0 == b'!' {
        if let Some((v, len)) = self.t_link(src) {
          if len > 0 {
            out.push(v);
            src = &src[len..];
            continue;
          }
        }
        // reflink, nolink
        if let Some((v, len)) = self.t_reflink(src) {
          if len > 0 {
            let merge = token_type(&v) == "text"
              && out.last().map(token_type) == Some("text");
            if merge {
              // 中文：复用 &str 切片直接追加，避免 raw/text 的 to_string() 中间分配。
              let last = out.last_mut().unwrap();
              append_token_field(last, "raw", &v);
              append_token_field(last, "text", &v);
            } else {
              out.push(v);
            }
            src = &src[len..];
            continue;
          }
        }
      }
      // em & strong: /^(?:\*+...|^_+...)/
      if b0 == b'*' || b0 == b'_' {
        if let Some((v, len)) = self.t_em_strong(src, &masked, prev_char) {
          if len > 0 {
            out.push(v);
            src = &src[len..];
            continue;
          }
        }
      }
      // codespan: /^(`+)/
      if b0 == b'`' {
        if let Some((v, len)) = self.t_codespan(src) {
          if len > 0 {
            out.push(v);
            src = &src[len..];
            continue;
          }
        }
      }
      // br: /^( {2,}|\\)\n/
      if b0 == b' ' || b0 == b'\\' {
        if let Some((v, len)) = self.t_br(src) {
          if len > 0 {
            out.push(v);
            src = &src[len..];
            continue;
          }
        }
      }
      // del (gfm): /^(~~?)/
      if b0 == b'~' {
        if let Some((v, len)) = self.t_del(src) {
          if len > 0 {
            out.push(v);
            src = &src[len..];
            continue;
          }
        }
      }
      // autolink: /^<(scheme:|email)>/
      if b0 == b'<' {
        if let Some((v, len)) = self.t_autolink(src) {
          if len > 0 {
            out.push(v);
            src = &src[len..];
            continue;
          }
        }
      }
      // url (gfm) — not inside links; /^(?:protocol):\/\/|^www\./ with
      // protocol = http(s)|ftp, so the first byte is h/H/f/F/w/W.
      if !self.state.in_link && matches!(b0, b'h' | b'H' | b'f' | b'F' | b'w' | b'W') {
        if let Some((v, len)) = self.t_url(src) {
          if len > 0 {
            out.push(v);
            src = &src[len..];
            continue;
          }
        }
      }
      crate::GUARD_NS.fetch_add(__g0.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
      // text
      let __t = std::time::Instant::now();
      crate::TEXT_CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
      // 纯文本快路径（`[`/反引号/`<` 等触发字节由上面的 b0 守卫与慢速
      // text 覆盖；这里只吞“不可能停机”的邮箱字符段，memchr 式跳过，
      // 不经正则。等价性见 `fast_plain_run` 的论证；合并/prev 逻辑与
      // 下面慢速分支逐字段一致）。
      let fr = fast_plain_run(src);
      if fr > 0 {
        let mut m = Map::new();
        m.insert("type".into(), sv("text"));
        m.insert("raw".into(), sv(&src[..fr]));
        m.insert("text".into(), sv(&src[..fr]));
        m.insert("escaped".into(), Value::Bool(self.state.in_raw_block));
        let v = tok(m);
        crate::TEXT_NS.fetch_add(__t.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
        src = &src[fr..];
        // 快路径段内不可能含 `_`，必然更新 prev（与慢速整 token
        // `!ends_with('_')` 时的取值同为段末字节，见论证）。
        prev_char = PC::from_raw(get_str(&v, "raw"));
        keep_prev_char = true;
        let merge = out.last().map(token_type) == Some("text");
        if merge {
          let last = out.last_mut().unwrap();
          append_token_field(last, "raw", &v);
          append_token_field(last, "text", &v);
        } else {
          out.push(v);
        }
        continue;
      }
      if let Some((v, len)) = self.t_inline_text(src) {
        crate::TEXT_NS.fetch_add(__t.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
        if len > 0 {
          src = &src[len..];
          // 中文：get_str 返回 &str 切片；prevChar 只需借用判断，避免 raw.to_string()。
          let raw = get_str(&v, "raw");
          // Track prevChar before a string of `____` starts.
          if !raw.ends_with('_') {
            prev_char = PC::from_raw(raw);
          }
          keep_prev_char = true;
          let merge = out.last().map(token_type) == Some("text");
          if merge {
            let last = out.last_mut().unwrap();
            append_token_field(last, "raw", &v);
            append_token_field(last, "text", &v);
          } else {
            out.push(v);
          }
          continue;
        }
      }
      crate::TAIL_NS.fetch_add(__t.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
      // marked throws 'Infinite loop on byte' here; inline text always
      // consumes ≥1 char, so this is unreachable.
      break;
    }
    crate::LOOP_NS.fetch_add(__it0.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
  }
}

/// One collected list item (marked's `tokens.items` staging struct).
struct Item {
  raw: String,
  task: bool,
  text: String,
}

/// Length in bytes of the UTF-8 scalar starting with byte `first`
/// (1 for ASCII; continuation bytes 0x80..=0xBF never start a scalar).
fn utf8_scalar_len(first: u8) -> usize {
  if first < 0x80 {
    1
  } else {
    1 + first.trailing_ones().saturating_sub(2) as usize
  }
}

/// 纯文本快路径字节集：ASCII 邮箱 atom 字符去掉一切“触发字节”——停机
/// 字符（`\ < ! [ ` * ~ _`）、`http`/`ftp`/`www` 前缀首字母（`h/H/f/F/w/W`）、
/// 空格与 `@`。注意 `^` 虽非停机字符，但它不是邮箱字符（`[^email]` 可与
/// `(?=[email]+@)` 组成停机条件），故也排除；表中每个字节都是邮箱字符。
fn is_fast_text_byte(b: u8) -> bool {
  matches!(
    b,
    b'A'..=b'G'
      | b'I'..=b'V'
      | b'X'..=b'Z'
      | b'a'..=b'g'
      | b'i'..=b'v'
      | b'x'..=b'z'
      | b'0'..=b'9'
      | b'.'
      | b'#'
      | b'$'
      | b'%'
      | b'&'
      | b'\''
      | b'+'
      | b'/'
      | b'='
      | b'?'
      | b'{'
      | b'|'
      | b'}'
      | b'-'
  )
}

/// `t_inline_text` 中的 `is_email` 判定（字节表形式，供快路径复用）。
fn is_email_byte(b: u8) -> bool {
  b.is_ascii_alphanumeric()
    || matches!(
      b,
      b'.' | b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'/' | b'='
        | b'?' | b'_' | b'`' | b'{' | b'|' | b'}' | b'~' | b'-'
    )
}

/// 纯文本快路径：从 `src` 起点吞掉一段“不可能停机”的文本，返回字节长度
///（0 表示首字节不适合快路径，走慢速 `t_inline_text`）。
///
/// 等价性论证（与 `t_inline_text` 逐字节相同）：记该段为 `[0, k)`。
/// 慢速扫描的 lead 为 1 字节（首字节 ASCII），停机检查只发生在 ASCII
/// 位置：`stop_char`（段内无）、`http`/`ftp://`/`www.`（需首字节
/// `h/f/w`，段内无）、` {2,}\n`（需空格，段内无；`q+1 == k` 处若成立则
/// 停机点恰为 `k`），`(?=[email]+@)`（段内全是邮箱字符，`@` 又被排除在
/// 外，邮箱连续段必延伸过 `k`，下面的前瞻保证它不以 `@` 结尾）以及
/// `[^email](?=[email]+@)`（段内字节全是邮箱字符，前件恒假）。因此慢速
/// 停机点 `end >= k`，先吞 `[0, k)` 再从 `k` 继续慢扫，与一次慢扫合并后
/// 的文本完全相同；`prev_char` 只取 raw 末字符，分段合并后的末字节一致，
/// 中间多出的迭代起点（`k` 等）经上述分析不可能是 `*`/`_`/`h` 等守卫字
/// 节——若是，慢速停机点恰落于该处，两条路径的迭代起点仍然重合。
fn fast_plain_run(src: &str) -> usize {
  let b = src.as_bytes();
  if b.is_empty() || !is_fast_text_byte(b[0]) {
    return 0;
  }
  let mut k = 1usize;
  while k < b.len() && is_fast_text_byte(b[k]) {
    k += 1;
  }
  // 邮箱前瞻：从 k 继续沿邮箱字符走，若紧跟 `@` 则段内可能停机，
  // 放弃快路径（ correctness 优先，`@` 在正文中罕见）。
  let mut j = k;
  while j < b.len() && is_email_byte(b[j]) {
    j += 1;
  }
  if b.get(j) == Some(&b'@') {
    return 0;
  }
  k
}

/// 原地掩码填充（`[a...a]`）：与原来
/// `masked.replace_range(s..e, &format!("[{}]", "a".repeat(len - 2)))`
/// 逐字节相同，但只覆盖、不搬移后缀。调用者保证匹配非空且 `len >= 2`
///（reflink/block_skip 的最短匹配即满足）；退化情况回落到原语义。
fn mask_fill_brackets(
  masked: &mut String,
  set: &mut impl FnMut(&mut [u64], usize, usize),
  mask: &mut [u64],
  s: usize,
  e: usize,
) {
  let len = e.saturating_sub(s);
  if len >= 2 {
    // SAFETY：只把一段正则匹配区间（字符边界）整体覆盖为 ASCII，
    // 不改变长度与字符边界，`masked` 始终是合法 UTF-8。
    let b = unsafe { masked.as_bytes_mut() };
    b[s] = b'[';
    b[s + 1..e - 1].fill(b'a');
    b[e - 1] = b']';
    set(mask, s, e);
  } else if len > 0 {
    let repl = format!("[{}]", "a".repeat(len.saturating_sub(2)));
    masked.replace_range(s..e, &repl);
    set(mask, s, s + repl.len());
  }
}

/// 原地掩码填充（单字节重复，如 escape 的 `+`）：与
/// `masked.replace_range(s..e, &"+".repeat(len))` 逐字节相同且等长，
/// 只覆盖、不搬移。`\\` + 标点整体被 ASCII 覆盖，UTF-8 合法性不变。
fn mask_fill_byte(
  masked: &mut String,
  set: &mut impl FnMut(&mut [u64], usize, usize),
  mask: &mut [u64],
  s: usize,
  e: usize,
  fill: u8,
) {
  if s >= e {
    return;
  }
  // SAFETY：同上，等长 ASCII 覆盖。
  let b = unsafe { masked.as_bytes_mut() };
  b[s..e].fill(fill);
  set(mask, s, e);
}

/// UTF-16 code-unit length (JS `String.length`).
fn utf16_len(s: &str) -> usize {
  s.chars().map(|c| if (c as u32) > 0xFFFF { 2 } else { 1 }).sum()
}

#[cfg(test)]
mod fastpath_parity {
  //! 快路径差分回归：手写扫描 vs 原 fancy-regex 在输入电池上的输出必须
  //! 逐字节一致（修复原理：快路径只允许在“已证明等价”的 ASCII 常见形上
  //! 开火；此测试把等价性钉住，后续改动任一侧都会失败）。
  use super::*;
  use crate::rules::rules;

  fn lx() -> Lexer {
    Lexer::new()
  }

  fn old_space(src: &str) -> Option<usize> {
    let c = exec(&rules().block.newline, src)?;
    let m0 = c.get(0)?.as_str();
    (!m0.is_empty()).then(|| m0.len())
  }

  fn old_code(src: &str) -> Option<(String, String)> {
    let c = exec(&rules().block.code, src)?;
    let raw = c.get(0)?.as_str().to_string();
    let text = remove_all(&raw, &rules().other.code_remove_indent);
    Some((raw, rtrim(&text, '\n').to_string()))
  }

  fn old_hr(src: &str) -> Option<String> {
    let c = exec(&rules().block.hr, src)?;
    Some(rtrim(c.get(0)?.as_str(), '\n').to_string())
  }

  fn old_heading(src: &str) -> Option<(String, usize, String)> {
    let b0 = *src.as_bytes().first()?;
    if !matches!(b0, b' ' | b'#') {
      return None;
    }
    let c = exec(&rules().block.heading, src)?;
    let raw = c.get(0)?.as_str().to_string();
    let depth = cap(&c, 1)?.len();
    let mut text = js_trim(cap(&c, 2)?).to_string();
    if rules().other.ending_hash.test(&text) {
      let trimmed = rtrim(&text, '#').to_string();
      if trimmed.is_empty() || rules().other.ending_space_char.test(&trimmed) {
        text = js_trim(&trimmed).to_string();
      }
    }
    Some((raw, depth, text))
  }

  #[test]
  fn space_code_hr_parity() {
    let cases = [
      "",
      " ",
      "   ",
      "\t \t",
      "\n",
      "\n\n\n",
      "  \n  \n",
      "  \nx",
      "x",
      "  x",
      "\n  \n  \n rest",
      "    code\n    more\n",
      "    \n",
      "\tcode\n",
      "   \tcode\n",
      "    code\n\n    more\n\n",
      "    code\n  not code\n",
      "---\n",
      "***\n",
      "___\n",
      "- - -\n",
      "   ---\n",
      "    ---\n",
      "---   \n",
      "---\n\n\n",
      "--\n",
      "-x-\n",
      "***foo\n",
      "* * *\n",
      "_ _ _\n",
      " -_- \n",
      "-\t-\t-\n",
      "--- foo\n",
      "# h\n",
      "   # h\n",
      "    # h\n",
      "####### h\n",
      "#h\n",
      "# \n",
      "#\n",
      "# a #\n",
      "# a ## \n",
      "## a # b ##\n",
      "# a#b\n",
      "#\u{A0}nbsp\n",
      "x\n",
    ];
    let l = lx();
    for src in cases {
      assert_eq!(l.t_space(src), old_space(src), "space {src:?}");
      assert_eq!(l.t_code(src), old_code(src), "code {src:?}");
      assert_eq!(l.t_hr(src), old_hr(src), "hr {src:?}");
      assert_eq!(l.t_heading(src), old_heading(src), "heading {src:?}");
    }
  }

  #[test]
  fn fences_parity() {
    let cases = [
      "```\ncode\n```\n",
      "```js\nconst x = 1;\n```\n",
      "```js\nno close\n",
      "```\n```\n",
      "   ```rust\nx\n   ```\n",
      "````\n```\n````\n",
      "```\n```extra\n```\n",
      "~~~\ncode\n~~~\n",
      "~~~info `tick`\ncode\n~~~\n",
      "```info `tick`\ncode\n```\n",
      "```\na\n\nb\n```\n",
      "```\na\n",
      "```",
      "  ``\ncode\n  ``\n",
      "```js",
      "text\n",
      "```py\nprint(1)\n```trailing\n```\n",
    ];
    let l = lx();
    for src in cases {
      assert_eq!(l.t_fences(src), old_fences(src), "fences {src:?}");
    }
  }

  fn old_fences(src: &str) -> Option<(String, String, String)> {
    let c = exec(&rules().block.fences, src)?;
    let raw = c.get(0)?.as_str().to_string();
    let lang_raw = cap(&c, 2);
    let lang = if truthy(lang_raw) {
      replace_first_g1(js_trim(lang_raw.unwrap()), &rules().inline.any_punctuation)
    } else {
      lang_raw.unwrap_or("").to_string()
    };
    let text = indent_code_compensation(&raw, cap(&c, 3).unwrap_or(""));
    Some((raw, lang, text))
  }

  #[test]
  fn lheading_table_prefilter_soundness() {
    // 预检返回 None ⇒ 正则必无匹配（单向可靠；反向由正则裁决）。
    let cases = [
      "foo\n===\n",
      "foo\n---\n",
      "foo\nbar\n",
      "foo\n- bar\n",
      "foo\n== bar\n",
      "foo\n---\t\n",
      "foo\n",
      "foo",
      "a | b\n|---|---|\n",
      "a | b\nfoo\n",
      "a\n| b\n",
      "text\n",
      "single",
    ];
    let mut l = lx();
    for src in cases {
      let lh = l.t_lheading(src);
      if lh.is_none() {
        assert!(
          exec(&rules().block.lheading, src).is_none(),
          "lheading prefilter unsound for {src:?}"
        );
      }
      let t = l.t_table(src);
      if t.is_none() {
        // table 预检通过的可能是 delimiter 检查失败等；仅断言
        // “无换行 ⇒ 正则必无匹配”方向。
        if !src.contains('\n') {
          assert!(
            exec(&rules().block.table, src).is_none(),
            "table prefilter unsound for {src:?}"
          );
        }
      }
    }
  }
}
