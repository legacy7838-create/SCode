//! 手写 `block.paragraph` 行扫描器 —— marked 17.0.1 gfm 段落规则
//! （`marked.esm.js` 变量 `_e`，即 `Q` 模板做 hr/heading/blockquote/fences/
//! list/html/table 替换、去掉 `lheading` 槽之后的产物）的字节级等价实现。
//!
//! # 修复原理（为什么不用正则）
//! `rules::R_BLOCK_PARAGRAPH` 是本 crate 最昂贵的一条规则：它的结构是
//! `^([^\n]+(?:\n(?! 8 条块起始)[^\n]+)*)`，8 条块起始各自又带嵌套否定前瞻
//! （尤其 table 槽里还嵌了整段 body 负前瞻）。fancy-regex 在 3KB 段落上每次
//! exec 约 2.07ms，而该模式的**语义**其实只有一句话：
//!
//! > 从偏移 0 起逐行前进：第 1 行整体并入段落；此后每遇到 `\n`，若“下一行”
//! > 不是块起始、且下一行非空（至少 1 个非 `\n` 字符），就把 `\n` 与该行一并
//! > 并入；否则停在该 `\n` 处。
//!
//! 因为整条模式没有尾随内容，贪婪的 `(?:...)*` 永远取“尽可能多的行”，不存在
//! 回溯出更长匹配的可能 —— 所以手写单遍扫描与正则是**逐字节等价**的，且 O(n)
//! 无回溯、无捕获分配。本文件的差分测试（`mod tests`）用
//! `crate::rules::rules().block.paragraph.exec()` 逐例断言 `end` 与 `g1` 一致。
//!
//! # 必须逐字节复刻的细节（都来自 `rules.rs` 的字节源）
//! - ` {0,3}` / ` *` / ` +` 全部是**字面空格**，`\t` 不算（>3 个空格即整条备选失败，
//!   因为正则回退到 2/1/0 个空格后下一个字符仍是空格，凑不出 `-`/`#`/`>` 等）。
//! - `.`（JS，无 `s` 标志）排除 `\n \r U+2028 U+2029`，见 [`dot_stop`]。
//! - heading 的 `\s` 是 JS 空白类：U+0085 **不算**、U+FEFF **算**（与 `rules.rs`
//!   `JS_SPACE_CLASS` 一致），见 [`is_js_space`]。
//! - `$` 只表示输入末尾；本模式里 `$` 只出现在 hr 与 table 槽，两处都有 `\n`
//!   分支兜底，因此“末尾换行前”的宽松语义差异不影响结果。
//! - html 槽**没有**前导 ` {0,3}`，且整条 paragraph 规则**没有** `i` 标志，
//!   所以 `<DIV>` 不算块起始（`block.html` 规则带 `i`、大小写不敏感，两者相反）。
//! - table 槽 `(?:\n(body)\n*|$)` 中 `body` 在 `*` 内可以为 0 次、`\n*` 可为 0 次，
//!   所以该备选**只要求 header 行 + 分隔行，且分隔行止于 `\n` 或输入末尾**；
//!   body 的内容永远不影响“能否命中”，无需扫描。
//! - table 分隔行的 ` {0,3}` 之后，`(?:\| *)?` 等贪心部件的回退方向唯一（见
//!   [`delim_end`] 的逐段注释），因此按贪心实现即等价。

// 中文：本任务只落地扫描器本身（`mod scanners;` + `scanners.rs`），lexer 侧
// 换用 `paragraph_match` 属后续接线；在此之前模块内各项在非测试构建里尚未
// 被引用，先整体允许 dead_code，避免给仓库新增 22 条编译警告。
#![allow(dead_code)]

/// `block.paragraph` 的一次命中结果。
///
/// 该模式整体被 group 1 包裹（`^(` 开头、`)` 结尾），所以 `g1 == (0, end)`、
/// `end == m.end()`；保留两个字段是为了让调用方直接照抄 `helpers::exec`
/// 之后的 `m.get(0)`/`m.get(1)` 用法，不必再碰正则。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParagraphMatch {
  /// 整段（group 0 / group 1）结束字节偏移，即 `m.end()`。
  pub end: usize,
  /// group 1 的字节区间，恒为 `(0, end)`。
  pub g1: (usize, usize),
}

/// `block.paragraph` 在 `src` 上的匹配：`None` 当且仅当 `^([^\n]+...)`
/// 在偏移 0 处无法起匹配（输入为空或以 `\n` 开头）。
///
/// 中文：返回值的 `end` 直接可当作 `src[..end]` 用作段落 raw，
/// 与 `helpers::exec(&rules().block.paragraph, src)` 的 `m.get(0)`/`m.get(1)`
/// 完全一致，`lexer::t_paragraph` 换用本函数时无需改任何取值逻辑。
pub fn paragraph_match(src: &str) -> Option<ParagraphMatch> {
  let b = src.as_bytes();
  // 中文：`[^\n]+` 要求首字符非 `\n` 且非空 —— 这两条直接决定“能否起匹配”，
  // 也是正则唯一的失败入口（后续每行的失败只会截断，不会让整体变 None）。
  if b.is_empty() || b[0] == b'\n' {
    return None;
  }
  let len = b.len();
  // 中文：第 1 行整体并入（`[^\n]+` 贪婪到行尾）。
  let mut end = line_end(b, 0);
  // 中文：逐行判断“能否再吞一个 `\n` + 下一行”。
  while end < len {
    let next = end + 1;
    // 末尾的 `\n` 后面没有字符 → `[^\n]+` 无法继续。
    if next >= len {
      break;
    }
    // 空行（`\n\n`）→ `[^\n]+` 无法继续。
    if b[next] == b'\n' {
      break;
    }
    // 下一行是块起始 → 负前瞻 `(?!...)` 失败。
    if at_block_start(&src[next..]) {
      break;
    }
    end = line_end(b, next);
  }
  Some(ParagraphMatch { end, g1: (0, end) })
}

/// 负前瞻谓词：在 `pos` 处是否起一个块（8 条备选任一可匹配）。
///
/// 与正则 `(?! hr | heading | blockquote | fences | list | html | table | ' '+\n )`
/// 的“任一备选在该偏移可匹配”语义一一对应；`pos` 越界或非字符边界时返回 `false`
/// （正则只会在真实位置求值，这类 `pos` 不会出现在合法调用链上）。
pub fn is_paragraph_block_start(src: &str, pos: usize) -> bool {
  match src.get(pos..) {
    Some(rest) => at_block_start(rest),
    None => false,
  }
}

// ---------------------------------------------------------------------------
// 8 条块起始备选（顺序照抄 `R_BLOCK_PARAGRAPH` 的负前瞻内部顺序）。
// 每个函数的入参 `s` 是“从求值位置到输入末尾”的切片，`b` 是它的字节视图。
// ---------------------------------------------------------------------------

/// 负前瞻 1：hr
/// ` {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)`
///
/// 中文：三类横线不能混用（每个分支各自 `{3,}`），`[\t ]*` 只在两次横线之间
/// 与末尾吃空白，因此每一步的位置都是唯一确定的 —— 无需回溯，按步前进并在
/// 第 3 次之后检查“停在 `\n` 或输入末尾”即可。
fn at_hr(b: &[u8]) -> bool {
  let n = spaces(b, 0);
  if n > MAX_INDENT {
    return false;
  }
  let mut i = n;
  if i >= b.len() {
    return false;
  }
  let c = b[i];
  if c != b'-' && c != b'_' && c != b'*' {
    return false;
  }
  let mut run = 0usize;
  loop {
    if i >= b.len() || b[i] != c {
      return false;
    }
    i += 1;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
      i += 1;
    }
    run += 1;
    // 中文：`(?:\n+|$)` 在第 3 次横线之后即可满足；不足 3 次时即使已到
    // 输入末尾也要继续（凑不够 `{3,}` 即失败）。
    if run >= 3 && (i >= b.len() || b[i] == b'\n') {
      return true;
    }
  }
}

/// 负前瞻 2：heading
/// ` {0,3}#{1,6}(?=\s|$)`
///
/// 中文：`#{1,6}` 贪心取到 6 个时若后面还是 `#`，回退只会把前瞻位置停在 `#`
/// 上（`#` 不是 `\s`），所以“能命中”的唯一候选就是**全部** `#` 恰好 ≤ 6 个。
fn at_heading(b: &[u8], s: &str) -> bool {
  let n = spaces(b, 0);
  if n > MAX_INDENT {
    return false;
  }
  let mut i = n;
  let mut hashes = 0usize;
  while i < b.len() && b[i] == b'#' {
    i += 1;
    hashes += 1;
  }
  if hashes == 0 || hashes > 6 {
    return false;
  }
  if i >= b.len() {
    // `$`：输入末尾。
    return true;
  }
  // 中文：`i` 前面全是 ASCII 空格与 `#`，必为字符边界，可安全解码。
  matches!(s.get(i..).and_then(|t| t.chars().next()), Some(c) if is_js_space(c))
}

/// 负前瞻 3：blockquote —— ` {0,3}>`
fn at_blockquote(b: &[u8]) -> bool {
  let n = spaces(b, 0);
  if n > MAX_INDENT {
    return false;
  }
  n < b.len() && b[n] == b'>'
}

/// 负前瞻 4：fences
/// ` {0,3}(?:`{3,}(?=[^`\n]*\n)|~{3,})[^\n]*\n`
///
/// 中文：反引号分支的前瞻要求“首个 `\n` 之前不能再有反引号”，而把 `{3,}`
/// 提前结束只会让前瞻位置落在反引号上（`[^`\n]*` 匹配空后必须见 `\n`，
/// 却是反引号），因此只有**整段连续反引号**这一个候选；波浪线分支没有该前瞻，
/// 只要求后面存在 `\n`（本备选没有 `$` 分支，输入末尾不算）。
fn at_fences(b: &[u8]) -> bool {
  let n = spaces(b, 0);
  if n > MAX_INDENT || n >= b.len() {
    return false;
  }
  match b[n] {
    b'`' => {
      let mut k = 0usize;
      while n + k < b.len() && b[n + k] == b'`' {
        k += 1;
      }
      if k < 3 {
        return false;
      }
      let mut j = n + k;
      while j < b.len() && b[j] != b'`' && b[j] != b'\n' {
        j += 1;
      }
      // 停在 `\n` 才说明“到行尾都没有反引号”，随后 `[^\n]*\n` 必然可吃掉这一行。
      j < b.len() && b[j] == b'\n'
    }
    b'~' => {
      let mut k = 0usize;
      while n + k < b.len() && b[n + k] == b'~' {
        k += 1;
      }
      if k < 3 {
        return false;
      }
      let mut j = n + k;
      while j < b.len() && b[j] != b'\n' {
        j += 1;
      }
      j < b.len()
    }
    _ => false,
  }
}

/// 负前瞻 5：list —— ` {0,3}(?:[*+-]|1[.)]) `（符号后是**字面单空格**）
///
/// 中文：只认 `1.`/`1)`，`2.` 或 `10.` 不算；空格也不能是 `\t`。
fn at_list(b: &[u8]) -> bool {
  let n = spaces(b, 0);
  if n > MAX_INDENT || n >= b.len() {
    return false;
  }
  match b[n] {
    b'*' | b'+' | b'-' => n + 1 < b.len() && b[n + 1] == b' ',
    b'1' => n + 2 < b.len() && (b[n + 1] == b'.' || b[n + 1] == b')') && b[n + 2] == b' ',
    _ => false,
  }
}

/// 负前瞻 6：html —— `</?(TAG)(?: +|\n|\/?>)|<(?:script|pre|style|textarea|!--)`
///
/// 中文：本备选**没有**前导 ` {0,3}`（与 hr/heading 等不同），且整条规则无 `i`
/// 标志，标签名必须小写匹配。`{...}` 标签是正则里的有序交替且**没有任何尾随
/// 约束跟随整条备选**，所以只要“存在某个标签是前缀且后面接上分隔符”即可命中
/// —— 与尝试顺序无关，这里对全部标签做存在性检查。第二个分支
/// （script/pre/style/textarea/!--）后面什么都不需要。
fn at_html(b: &[u8]) -> bool {
  if b.first() != Some(&b'<') {
    return false;
  }
  // `<(?:script|pre|style|textarea|!--)`：无分隔符要求，纯前缀。
  for t in HTML_RAW_TAGS {
    if starts_at(b, 1, t) {
      return true;
    }
  }
  for t in HTML_BLOCK_TAGS {
    // `<tag` 分隔符
    if starts_at(b, 1, t) && html_delim(b, 1 + t.len()) {
      return true;
    }
    // `</tag` 分隔符（`\/?` 只回退一次，所以只存在这两条路径）
    if b.len() > 1 && b[1] == b'/' && starts_at(b, 2, t) && html_delim(b, 2 + t.len()) {
      return true;
    }
  }
  false
}

/// html 标签名之后的 `(?: +|\n|\/?>)`：≥1 个字面空格、换行、`>`、或 `/>`。
/// 中文：` +` 之后没有任何跟随约束，所以“见到空格”本身即成功。
fn html_delim(b: &[u8], p: usize) -> bool {
  if p >= b.len() {
    return false;
  }
  match b[p] {
    b' ' | b'\n' | b'>' => true,
    b'/' => p + 1 < b.len() && b[p + 1] == b'>',
    _ => false,
  }
}

/// 负前瞻 7：table
/// ` *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n(body)\n*|$)`
///
/// 中文：`(?:\n(body)\n*|$)` 的第一个分支里 `body` 位于 `*`（可 0 次）之后、
/// `\n*` 也可 0 次，因此只要分隔行后面有一个 `\n`，该分支就**必定**成立；
/// 只有“分隔行直接到输入末尾”才走 `$` 分支。也就是说 `body` 的内容（空行、
/// hr、缩进代码……）对“能否命中”毫无影响 —— 这就是本实现不扫描 body 的原因。
/// 于是条件收敛为：header 行 + ` {0,3}` + 分隔行，且分隔行止于 `\n` 或输入末尾。
fn at_table(b: &[u8]) -> bool {
  let n = spaces(b, 0);
  // header 首字符 `[^\n ]`（前面的空格已全部吃掉，故只需排除 `\n`）。
  if n >= b.len() || b[n] == b'\n' {
    return false;
  }
  // `([^\n ].*)`：首字符由 `[^\n ]` 吃掉（`\r`/U+2028/U+2029 也允许），
  // 从第 2 个字符起才是 `.` —— 所以停止扫描必须从 `n + 1` 开始，
  // 否则会把“首字符恰好是 U+2028”的合法 header 误判成失败。
  // 中文：修复原理——首字节位置的 `\r`/U+2028 不能停表，否则与正则不一致。
  let j = dot_stop(b, n + 1);
  if j >= b.len() || b[j] != b'\n' {
    return false;
  }
  let m = spaces(b, j + 1);
  if m > MAX_INDENT {
    return false;
  }
  match delim_end(b, j + 1 + m) {
    Some(q) => q >= b.len() || b[q] == b'\n',
    None => false,
  }
}

/// table 分隔行 `(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?` 的贪心终点。
///
/// 中文：这里的回退方向全部唯一，逐段贪心即等价：
/// - ` {0,3}` 与 ` *` 若少取一个空格，下一个字符仍是空格，`-+`/`|` 都起不来；
/// - `-+` 少取一个 `-` 会让后续（或整条备选的收尾）停在 `-` 上，而收尾只接受
///   `\n`/输入末尾；
/// - `:?` 取与不取的后继位置分别是“继续”与“停在 `:`”，后者必然不满足收尾；
/// - `(?:\| *:?-+:? *)*` 少迭代一次会停在下一轮 `|` 之后的 `:`/`-` 上，
///   同样不满足收尾；迭代失败则整轮作罷（正则正是这样回退）；
/// - 末尾 `(?:\| *)?` 若不取，会停在 `|` 上（既非 `\n` 也非末尾），所以有 `|`
///   必取。
/// 返回 `None` 表示分隔行根本不成立（缺 `-+`）。
fn delim_end(b: &[u8], mut i: usize) -> Option<usize> {
  // (?:\| *)?
  if i < b.len() && b[i] == b'|' {
    i += 1;
    while i < b.len() && b[i] == b' ' {
      i += 1;
    }
  }
  // :?
  if i < b.len() && b[i] == b':' {
    i += 1;
  }
  // -+（必须 ≥1，否则整条分隔行不成立）
  let mut dashes = 0usize;
  while i < b.len() && b[i] == b'-' {
    i += 1;
    dashes += 1;
  }
  if dashes == 0 {
    return None;
  }
  // :? * （贪心：见 `:` 必取、空格吃到不能再吃）
  if i < b.len() && b[i] == b':' {
    i += 1;
  }
  while i < b.len() && b[i] == b' ' {
    i += 1;
  }
  // (?:\| *:?-+:? *)* —— 每轮必须以 `|` 开头且凑出 `-+`，否则整轮回退并停止。
  loop {
    let mut j = i;
    if j >= b.len() || b[j] != b'|' {
      break;
    }
    j += 1;
    while j < b.len() && b[j] == b' ' {
      j += 1;
    }
    if j < b.len() && b[j] == b':' {
      j += 1;
    }
    let mut inner = 0usize;
    while j < b.len() && b[j] == b'-' {
      j += 1;
      inner += 1;
    }
    if inner == 0 {
      break;
    }
    if j < b.len() && b[j] == b':' {
      j += 1;
    }
    while j < b.len() && b[j] == b' ' {
      j += 1;
    }
    i = j;
  }
  // (?:\| *)?
  if i < b.len() && b[i] == b'|' {
    i += 1;
    while i < b.len() && b[i] == b' ' {
      i += 1;
    }
  }
  Some(i)
}

/// 负前瞻 8：` +\n` —— 一整行只有 ≥1 个空格然后换行（`\t` 行、真空行都不算）。
fn at_space_lf(b: &[u8]) -> bool {
  let n = spaces(b, 0);
  n > 0 && n < b.len() && b[n] == b'\n'
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/// 8 条备选的合取入口（顺序照抄正则，便于逐条比对源码）。
fn at_block_start(s: &str) -> bool {
  let b = s.as_bytes();
  at_hr(b)
    || at_heading(b, s)
    || at_blockquote(b)
    || at_fences(b)
    || at_list(b)
    || at_html(b)
    || at_table(b)
    || at_space_lf(b)
}

/// 正则里 ` {0,3}` 的上限（同 ` {0,3}`，超过 3 个空格整条备选即失败）。
const MAX_INDENT: usize = 3;

/// 从 `i` 起数**字面空格**（不含 `\t`）的个数。
fn spaces(b: &[u8], i: usize) -> usize {
  let mut n = 0usize;
  while i + n < b.len() && b[i + n] == b' ' {
    n += 1;
  }
  n
}

/// 从 `from` 起找到首个 `\n` 的下标（没有则返回 `b.len()`）。
fn line_end(b: &[u8], from: usize) -> usize {
  let mut i = from;
  while i < b.len() && b[i] != b'\n' {
    i += 1;
  }
  i
}

/// JS `.`（无 `s` 标志）的停止位置：`\n`、`\r`、U+2028、U+2029，没有则到末尾。
///
/// 中文：UTF-8 下 0xE2 只会作为三字节序列的首字节出现（续字节恒为 0x80..=0xBF），
/// 所以按字节前移不会把 U+2028/U+2029 拆错，也不必逐字解码。
fn dot_stop(b: &[u8], mut i: usize) -> usize {
  while i < b.len() {
    let c = b[i];
    if c == b'\n' || c == b'\r' {
      return i;
    }
    if c == 0xE2 && i + 2 < b.len() && b[i + 1] == 0x80 && (b[i + 2] == 0xA8 || b[i + 2] == 0xA9) {
      return i;
    }
    i += 1;
  }
  i
}

/// JS `\s`（WhiteSpace ∪ LineTerminator）。与 `rules.rs` 的 `JS_SPACE_CLASS`
/// 同集合：U+0085 不属于 JS 空白，U+FEFF 属于。
fn is_js_space(c: char) -> bool {
  matches!(c,
    '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' '
      | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
      | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

/// `b[i..]` 是否以 `tag` 开头（`b` 是 `&str` 的字节视图，前缀比较即字节比较）。
fn starts_at(b: &[u8], i: usize, tag: &str) -> bool {
  let t = tag.as_bytes();
  b.len() >= i + t.len() && &b[i..i + t.len()] == t
}

/// `block.html` 之外的裸标签分支：`<(?:script|pre|style|textarea|!--)`。
const HTML_RAW_TAGS: &[&str] = &["script", "pre", "style", "textarea", "!--"];

/// `R_BLOCK_PARAGRAPH` html 槽里的 `TAGS` 交替（`h[1-6]` 已展开为 h1..h6）。
/// 顺序与正则一致，测试 `html_tag_list_matches_rule_source` 负责与字节源对账。
const HTML_BLOCK_TAGS: &[&str] = &[
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "meta",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul",
];

// ---------------------------------------------------------------------------
// 差分测试：与 `rules().block.paragraph`（fancy-regex 执行 marked 的字节源）
// 逐例比对 `end` 与 group 1 区间。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::Instant;

  /// 单例差分：手写扫描器必须与正则给出相同的 `m.end()` 与 `m.get(1)` 区间。
  fn diff(src: &str) {
    let rules = crate::rules::rules();
    let m = crate::helpers::exec(&rules.block.paragraph, src);
    let hand = paragraph_match(src);
    match (m, hand) {
      (None, None) => {}
      (Some(m), Some(h)) => {
        let m0 = m.get(0).expect("group 0");
        let g0 = (m0.start(), m0.end());
        let g1m = m.get(1).expect("group 1");
        let g1 = (g1m.start(), g1m.end());
        assert_eq!(g0, g1, "group0 != group1 for {src:?}: {g0:?} vs {g1:?}");
        assert_eq!(h.end, g0.1, "end mismatch for {src:?}");
        assert_eq!(h.g1, g1, "g1 mismatch for {src:?}");
      }
      (Some(m), None) => panic!(
        "regex matched {src:?} at {:?} but hand scanner returned None",
        (m.get(0).expect("group 0").start(), m.get(0).expect("group 0").end())
      ),
      (None, Some(h)) => panic!(
        "hand scanner matched {src:?} with end={} but regex returned None",
        h.end
      ),
    }
  }

  /// 全量输入样本：空/单行/多行 + 8 条块起始的“停/不停”两面 + 边界回退。
  const CASES: &[&str] = &[
    // —— 基础形状：空串、单行、段后空行、段后提前结束 ——
    "",
    "a",
    "hello world",
    "  leading spaces on first line",
    "\ttab first line",
    "# heading-looking first line (line 1 is never lookahead-checked)",
    "- - - first line is not checked either",
    "para\n",
    "para\n\n",
    "para\nb",
    "para\nb\n",
    "para\nb\n\n",
    "para\nb\n\n\nc",
    "para\nb\nc\nd",
    "\npara",
    "\n",
    " \n",
    "a\n\nb\n\nc\n",
    "para\n \n \n",
    // —— hr ——
    "para\n---",
    "para\n---\n",
    "para\n---\nx",
    "para\n- - -\nx",
    "para\n- - - -\nmore",
    "para\n___\n",
    "para\n___",
    "para\n***\n",
    "para\n* * *\n",
    "para\n ---\n",
    "para\n  ---\n",
    "para\n   ---\n",
    "para\n    ---\n",
    "para\n----\n",
    "para\n---   \n",
    "para\n---   ",
    "para\n- -\n",
    "para\n-- \n",
    "para\n--",
    "para\n_\t_\t_\n",
    // —— heading ——
    "para\n# h\n",
    "para\n#\n",
    "para\n## h\n",
    "para\n###### h\n",
    "para\n####### h\n",
    "para\n#h\n",
    "para\n# h",
    "para\n#",
    "para\n   # h\n",
    "para\n    # h\n",
    "para\n #h\n",
    "para\n # h\n",
    "para\n#\u{A0}h\n",
    "para\n#\u{FEFF}\n",
    "para\n#\u{85}h\n",
    // —— blockquote ——
    "para\n> quote\n",
    "para\n>\n",
    "para\n  >q\n",
    "para\n   >q\n",
    "para\n    >q\n",
    "para\n> q",
    "para\n   >引用\n",
    // —— fences ——
    "para\n```js\ncode\n```\n",
    "para\n```\n",
    "para\n````info\n",
    "para\n```a`b\n",
    "para\n```",
    "para\n~~~\n",
    "para\n~~~x\ncode\n",
    "para\n~~\n",
    "para\n~~~",
    "para\n ```\n",
    // —— list ——
    "para\n* item\n",
    "para\n+ item\n",
    "para\n- item\n",
    "para\n1. item\n",
    "para\n1) item\n",
    "para\n1.item\n",
    "para\n2. item\n",
    "para\n10. item\n",
    "para\n* \n",
    "para\n * item\n",
    "para\n    * item\n",
    "para\n*\n",
    "para\n1) ",
    "para\n1. \n",
    "para\n- 中文列表\n",
    // —— html（无前导空格、大小写敏感、script/pre/style/textarea/!-- 无分隔符）——
    "para\n<div>\n",
    "para\n<div \n",
    "para\n<div/>\n",
    "para\n</div>\n",
    "para\n<p>\n",
    "para\n<h1>\n",
    "para\n<h7>\n",
    "para\n<DIV>\n",
    "para\n<div",
    "para\n<div>",
    "para\n<script>\n",
    "para\n<script",
    "para\n<pre\n",
    "para\n<!-- c -->\n",
    "para\n<!--",
    "para\n<code>\n",
    "para\n<textarea>\n",
    "para\n</script>\n",
    "para\n<li>\n",
    "para\n<table>\n",
    "para\n<hr>\n",
    "para\n<iframe >\n",
    // —— table（header + 分隔行即可命中；body 不影响命中）——
    "para\ncol\n-\n",
    "para\ncol\n-\nbody",
    "para\ncol\n-\n\n\n",
    "para\ncol1|col2\n:-|-:\nx|y\n",
    "para\na\n-x\n",
    "para\na\n::\n",
    "para\nh\n",
    "para\nh\n-",
    "para\nh\n- \n",
    "para\n  h\n   -  \n",
    "para\n  h\n    -  \n",
    "para\nh\n|-\n",
    "para\nh\n-|\n",
    "para\nh\n--|\n",
    "para\nh\n|\n",
    "para\na\nb\n-\n",
    "para\n甲\n-\n",
    "para\nh \n-\n",
    "para\nh\n-\n\n\nbody",
    "para\n |\n-\n",
    "para\nh\n:-\n",
    "para\nh\n-:\n",
    "para\nh\n:-:\n",
    "para\nh\nx\n",
    "para\nh\n-|\n \n",
    // —— ` +\n`（整行只有空格）——
    "para\n \n",
    "para\n   \n",
    "para\n\t\n",
    "para\na \nb\n",
    // —— 缩进代码不在负前瞻里：不能停 ——
    "para\n\tcode line\n",
    "para\n\t    indented\n",
    "para\n\t- item\n",
    "para\n\t# h\n",
    // —— Unicode ——
    "你好\n世界\n",
    "para\n你好\n# x\n",
    "para\n🚀\n",
    "para\nemoji🎉 here\n",
    // U+2028/U+2029 是 JS `.` 的停止字符：会让 table header 行提前断掉。
    "para\n甲\u{2028}乙\n-\n",
    "para\n甲\u{2029}\n-\n",
    "para\na\u{2028}\n-\n",
    "para\n\u{2028}x\n-\n",
    "para\n甲\u{2028}乙\n# x\n",
    "para\n#\u{2028}\n",
  ];

  #[test]
  fn paragraph_match_is_byte_exact_vs_regex() {
    assert!(CASES.len() >= 60, "样本量不足: {}", CASES.len());
    for src in CASES {
      diff(src);
    }
    // 长多行样本（无任何块起始 → 整体并入，end == len）。
    diff(&"alpha beta gamma delta\n".repeat(40));
    diff(&"段落内容继续续写\n".repeat(30));
  }

  /// 负前瞻谓词的差分桥：对非空且不以 `\n` 开头的候选行 `c`，
  /// `is_paragraph_block_start(c, 0)` ⟺ `"x\n{c}"` 的正则命中在 2 处停住
  /// （即 `m.end() == 2`，也就是段落只吞掉首行 `x`）。
  const SECOND_LINE_CASES: &[&str] = &[
    "plain continuation",
    "---",
    " ---",
    "    ---",
    "- - -",
    "___",
    "***",
    "# h",
    "#h",
    "#",
    "####### h",
    " # h",
    " #h",
    "> q",
    "    > q",
    "```",
    "```js",
    "```a`b",
    "~~~",
    "~~",
    "* item",
    "- item",
    "1. item",
    "1) item",
    "1.item",
    "2. item",
    "* ",
    "*",
    "<div>",
    "<div \nnext",
    "</div>",
    "<script",
    "<!--",
    "<code>",
    "<DIV>",
    "h\n-\nbody",
    "h\n-",
    "h\n-x",
    "h\n::",
    "a\nb\n-\n",
    " \n",
    "   \n",
    "\t\n",
    "tab\tindent line",
    "trailing space \nnext",
    "你好\n-\n",
    "1)",
    "- ",
    "-- ",
    "    1. item",
    "|-\n|-\n",
    "h\n|-\n",
    "h\n-|\n",
    "h\n-|\n \nx",
    " :\n- ",
    "   h \n  -  \n",
    "p",
    ">",
    "h2",
    "#\u{A0}x",
    "#\u{85}x",
    "<h7>",
    "<h1>",
    "hr>",
    "ul>",
    "textarea ",
    "li\n\n",
    " \tx",
    "-  ",
    "___ ",
    "~~~x\n",
    "````\n",
    "1.",
    "1)",
    "a\n-\n\nbody\n",
    "col1|col2\n:-|-:\n",
    "\ttab code\n",
    "text\n",
    "  \n  \n",
    "#\u{2028}",
    "a\u{2028}\n-\n",
    "\u{2028}x\n-\n",
    "h\n-\u{2028}x\n",
  ];

  #[test]
  fn block_start_predicate_matches_paragraph_interruption() {
    assert!(SECOND_LINE_CASES.len() >= 40, "样本量不足: {}", SECOND_LINE_CASES.len());
    for cand in SECOND_LINE_CASES {
      assert!(!cand.is_empty() && !cand.starts_with('\n'), "非法候选 {cand:?}");
      let src = format!("x\n{cand}");
      let m = crate::helpers::exec(&crate::rules::rules().block.paragraph, &src)
        .expect("首行 x 必定命中段落规则");
      // 首行 `x` 结束于偏移 1：正则在 1 处停住 ⟺ 下一行是块起始。
      let regex_blocks = m.get(0).expect("group 0").end() == 1;
      assert_eq!(
        is_paragraph_block_start(cand, 0),
        regex_blocks,
        "谓词与正则负前瞻不一致: {cand:?} (regex end = {})",
        m.get(0).expect("group 0").end()
      );
    }
  }

  /// 非 0 偏移的求值 + 越界/非边界入参的兜底行为。
  #[test]
  fn block_start_at_arbitrary_offsets() {
    let src = "para\n# h\nnot a block\n";
    assert!(!is_paragraph_block_start(src, 0), "首行本身不是块起始");
    assert!(is_paragraph_block_start(src, 5), "偏移 5 落在 `# h` 上");
    assert!(!is_paragraph_block_start(src, 10), "偏移 10 落在 `not a block` 上");
    assert!(!is_paragraph_block_start(src, src.len()), "末尾偏移恒为 false");
    assert!(!is_paragraph_block_start(src, src.len() + 1), "越界兜底返回 false");
    let uni = "para\n# 你好";
    assert!(!is_paragraph_block_start(uni, 0), "首行本身不是块起始");
    assert!(is_paragraph_block_start(uni, 5), "字符边界正常求值（heading）");
    assert!(!is_paragraph_block_start("para\n你好", 5), "非块起始的 Unicode 行");
    // 「你」= E4 BD A0：偏移 6 落在续字节上，非字符边界 → 兜底 false。
    assert!(!is_paragraph_block_start("para\n你好", 6), "非字符边界兜底返回 false");
  }

  /// html 标签表与 `rules.rs` 的字节源对账，防止手抄清单漂移。
  #[test]
  fn html_tag_list_matches_rule_source() {
    let pat = crate::rules::R_BLOCK_PARAGRAPH;
    let start_marker = "<\\/?(?:";
    let start = pat.find(start_marker).expect("html 槽存在") + start_marker.len();
    let end = pat[start..].find(")(?: +|").expect("html 槽结束") + start;
    let mut expected: Vec<&str> = Vec::new();
    for t in pat[start..end].split('|') {
      if t == "h[1-6]" {
        expected.extend(["h1", "h2", "h3", "h4", "h5", "h6"]);
      } else {
        expected.push(t);
      }
    }
    assert_eq!(HTML_BLOCK_TAGS, expected.as_slice(), "html 标签表与字节源不一致");
    let raw = format!("<(?:{})", HTML_RAW_TAGS.join("|"));
    assert!(pat.contains(&raw), "裸标签分支与字节源不一致: {raw}");
  }

  /// 手写扫描器的性能 bench（与 `lib.rs::bench2` 的 3KB 样本、50 次迭代一致）。
  /// 对照数字：同一样本的 `BENCH paragraph-regex` 约 2.074574ms/exec。
  #[test]
  #[ignore]
  fn bench_paragraph_hand() {
    let plain = "plain words no delimiters at all here. ".repeat(80);
    let t = Instant::now();
    for _ in 0..50 {
      assert!(paragraph_match(&plain).is_some());
    }
    println!("BENCH paragraph-hand: {:?}/exec", t.elapsed() / 50);
  }

  /// 确定性随机差分（固定种子的 xorshift64*，无外部依赖）：在“块起始字符密集”
  /// 且含 JS 边界字符（`\r`、U+0085、U+FEFF、U+2028/U+2029、CJK、emoji）的字符表上
  /// 随机抽样，逐例比对 `end` 与 `g1`。专打手写实现里最脆的回退路径：hr 的
  /// `{3,}`+`[\t ]*`、table 分隔行的 ` {0,3}`+交替与 header 的 `.` 停止字符、
  /// html 的标签回退、fences 的前瞻、`#{1,6}(?=\s|$)` 的空白类边界。
  /// 默认 `#[ignore]`（约 1.5s）：`cargo test -p zcode-markdown -- --ignored fuzz`。
  #[test]
  #[ignore]
  fn fuzz_paragraph_match_is_byte_exact_vs_regex() {
    const ALPHABET: &[char] = &[
      'a', 'b', '1', ' ', '\n', '\t', '\r', '-', '_', '*', '#', '>', '`', '~', '+', '.', '|', ':',
      '/', '<', '(', ')', '!', 'h', 'p', 'd', 's', 'c', '\u{A0}', '\u{85}', '\u{2028}', '\u{2029}',
      '\u{FEFF}', '你', '好', '🚀',
    ];
    let seeds: [u64; 3] = [0x9E37_79B9_7F4A_7C15, 0x1234_5678_9ABC_DEF0, 0xDEAD_BEEF_CAFE_1234];
    let mut checked = 0usize;
    for seed in seeds {
      let mut state = seed;
      let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state.wrapping_mul(0x2545_F491_4F6C_DD1D)
      };
      for _ in 0..10_000 {
        let len = (next() % 64) as usize;
        let mut buf = String::with_capacity(len * 4);
        for _ in 0..len {
          buf.push(ALPHABET[(next() % ALPHABET.len() as u64) as usize]);
        }
        diff(&buf);
        checked += 1;
      }
    }
    println!("BENCH paragraph-fuzz: {checked} cases");
  }
}
