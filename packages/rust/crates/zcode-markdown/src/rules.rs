//! Generated from marked 17.0.1's own rule objects (source map
//! node_modules/@mbears/opentui-core/node_modules/marked/lib/marked.esm.js.map,
//! final regex `.source` strings dumped via `Lexer.rules`). Options pinned:
//! gfm=true, breaks=false, pedantic=false => block.gfm + inline.gfm.
//! JS flag translation: `i` becomes a `(?i)` prefix; `u`/`g` are engine-side
//! (`g` handled by explicit iteration, `u` is the default in fancy-regex).

pub const R_BLOCK_BLOCKQUOTE: &str = r#"^( {0,3}> ?(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*\n)|~{3,})[^\n]*\n| {0,3}(?:[*+-]|1[.)]) |<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:script|pre|style|textarea|!--)| +\n)[^\n]+)*)|[^\n]*)(?:\n|$))+"#; // flags: 
pub const R_BLOCK_CODE: &str = r#"^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+"#; // flags: 
pub const R_BLOCK_DEF: &str = r#"^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\])+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))))? *(?:\n+|$)"#; // flags: 
pub const R_BLOCK_FENCES: &str = r#"^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)"#; // flags: 
pub const R_BLOCK_HEADING: &str = r#"^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)"#; // flags: 
pub const R_BLOCK_HR: &str = r#"^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)"#; // flags: 
pub const R_BLOCK_HTML: &str = r#"(?i)^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n+|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>\n*|$)|<![A-Z][\s\S]*?(?:>\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<(?!script|pre|style|textarea)([a-z][\w-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<\/(?!script|pre|style|textarea)[a-z][\w-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$))"#; // flags: i
pub const R_BLOCK_LHEADING: &str = r#"^(?!(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n|(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+) *(?:\n+|$)"#; // flags: 
pub const R_BLOCK_LIST: &str = r#"^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]+?)?(?:\n|$)"#; // flags: 
pub const R_BLOCK_NEWLINE: &str = r#"^(?:[ \t]*(?:\n|$))+"#; // flags: 
pub const R_BLOCK_PARAGRAPH: &str = r#"^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*\n)|~{3,})[^\n]*\n| {0,3}(?:[*+-]|1[.)]) |<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:script|pre|style|textarea|!--)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*\n)|~{3,})[^\n]*\n| {0,3}(?:[*+-]|1[.)]) |<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:script|pre|style|textarea|!--)).*(?:\n|$))*)\n*|$)| +\n)[^\n]+)*)"#; // flags: 
pub const R_BLOCK_TABLE: &str = r#"^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*\n)|~{3,})[^\n]*\n| {0,3}(?:[*+-]|1[.)]) |<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:script|pre|style|textarea|!--)).*(?:\n|$))*)\n*|$)"#; // flags: 
pub const R_BLOCK_TEXT: &str = r#"^[^\n]+"#; // flags: 

pub const R_INLINE_ANY_PUNCTUATION: &str = r#"\\([\p{P}\p{S}])"#; // flags: gu
pub const R_INLINE_AUTOLINK: &str = r#"^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>"#; // flags: 
pub const R_INLINE_BLOCK_SKIP: &str = r#"\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>"#; // flags: g
pub const R_INLINE_DEL: &str = r#"^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)"#; // flags: 
pub const R_INLINE_EM_STRONG_L_DELIM: &str = r#"^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|[^\s*]))|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))"#; // flags: u
pub const R_INLINE_EM_STRONG_R_DELIM_AST: &str = r#"^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))"#; // flags: gu
pub const R_INLINE_EM_STRONG_R_DELIM_UND: &str = r#"^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])"#; // flags: gu
pub const R_INLINE_LINK: &str = r#"^!?\[((?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+[^`]*?`+(?!`)|[^\[\]\\`])*?)\]\(\s*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*)(?:(?:[ \t]*(?:\n[ \t]*)?)("(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)))?\s*\)"#; // flags: 
pub const R_INLINE_NOLINK: &str = r#"^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\])+)\](?:\[\])?"#; // flags: 
pub const R_INLINE_PUNCTUATION: &str = r#"^((?![*_])[\s\p{P}\p{S}])"#; // flags: u
pub const R_INLINE_REFLINK: &str = r#"^!?\[((?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+[^`]*?`+(?!`)|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\])+)\]"#; // flags: 
pub const R_INLINE_REFLINK_SEARCH: &str = r#"!?\[((?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+[^`]*?`+(?!`)|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\])+)\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\])+)\](?:\[\])?(?!\()"#; // flags: g
pub const R_INLINE_TAG: &str = r#"^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][\w:-]*\s*>|^<[a-zA-Z][\w-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>"#; // flags: 
pub const R_INLINE_URL: &str = r#"^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])"#; // flags: 
pub const R_INLINE__BACKPEDAL: &str = r#"(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+"#; // flags: 

// ---------------------------------------------------------------------------
// Compiled rule tables (options pinned: gfm=true, breaks=false, pedantic=false).
// ---------------------------------------------------------------------------

use fancy_regex::Regex;
use std::sync::OnceLock;

macro_rules! compile {
  ($pat:expr) => {{
    let pat_in: String = ::core::convert::Into::into($pat);
    let pat: String = js_regex_fix(&pat_in);
    Regex::new(&pat).unwrap_or_else(|e| panic!("zcode-markdown rule failed to compile: {e}: {pat}"))
  }};
}

/// Exact JS `\s` character set: WhiteSpace production (TAB, VT, FF, SP, NBSP,
/// ZWNBSP, Zs) plus LineTerminator. Differs from the Rust engine's Unicode
/// `\s` at U+0085 (JS: no) and U+FEFF (JS: yes).
const JS_SPACE_CLASS: &str = r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
/// Negated form for JS `\S`.
const JS_NOSPACE_CLASS: &str = r"[^\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
/// JS `\w` (ASCII only, even under the `u` flag).
const JS_WORD_CLASS: &str = r"[0-9A-Za-z_]";
const JS_NOTWORD_CLASS: &str = r"[^0-9A-Za-z_]";
/// JS `.` — excludes LineTerminator (\\n, \\r, U+2028, U+2029) without the `s` flag.
const JS_DOT: &str = r"[^\n\r\u{2028}\u{2029}]";
/// JS `\\b` word boundary (ASCII `\\w`-based), as a zero-width alternation.
const JS_WORD_BOUNDARY: &str = r"(?:(?<![0-9A-Za-z_])(?=[0-9A-Za-z_])|(?<=[0-9A-Za-z_])(?![0-9A-Za-z_]))";
const JS_NOT_WORD_BOUNDARY: &str = r"(?:(?<![0-9A-Za-z_])(?![0-9A-Za-z_])|(?<=[0-9A-Za-z_])(?=[0-9A-Za-z_]))";

/// Rewrite JS regex flavor to the fancy-regex engine, preserving JS semantics:
/// `\\s`/`\\S`/`\\d`/`\\D`/`\\w`/`\\W`/`\\b`/`\\B` and unescaped `.` (outside
/// character classes) mean JS things, not Unicode-engine things.
fn js_regex_fix(pat: &str) -> String {
  let b = pat.as_bytes();
  let mut out = String::with_capacity(pat.len() + 32);
  let mut i = 0;
  let mut in_class = false;
  let mut class_depth = 0usize;
  while i < b.len() {
    let c = b[i];
    if c == b'\\' && i + 1 < b.len() {
      let n = b[i + 1];
      let rep = match n {
        b's' => Some(JS_SPACE_CLASS),
        b'S' => Some(JS_NOSPACE_CLASS),
        b'd' => Some("[0-9]"),
        b'D' => Some("[^0-9]"),
        b'w' => Some(JS_WORD_CLASS),
        b'W' => Some(JS_NOTWORD_CLASS),
        b'b' => Some(JS_WORD_BOUNDARY),
        b'B' => Some(JS_NOT_WORD_BOUNDARY),
        _ => None,
      };
      match rep {
        Some(r) => out.push_str(r),
        None => {
          // copy the escape verbatim (two ASCII bytes, e.g. \\n, \\\\, \\x41)
          out.push(b'\\' as char);
          out.push(n as char);
        }
      }
      i += 2;
      continue;
    }
    if in_class {
      match c {
        b'[' => {
          class_depth += 1;
          out.push('[');
        }
        b']' => {
          if class_depth == 0 {
            in_class = false;
          } else {
            class_depth -= 1;
          }
          out.push(']');
        }
        _ => push_byte(&mut out, b, &mut i),
      }
      if !matches!(c, b'[' | b']') {
        continue;
      }
      i += 1;
      continue;
    }
    match c {
      b'[' => {
        in_class = true;
        out.push('[');
        i += 1;
      }
      b'.' => {
        out.push_str(JS_DOT);
        i += 1;
      }
      _ => push_byte(&mut out, b, &mut i),
    }
  }
  out
}

fn push_byte(out: &mut String, b: &[u8], i: &mut usize) {
  let start = *i;
  let c = b[start];
  let len = if c >= 0xF0 {
    4
  } else if c >= 0xE0 {
    3
  } else if c >= 0xC0 {
    2
  } else {
    1
  };
  out.push_str(std::str::from_utf8(&b[start..(start + len).min(b.len())]).unwrap_or("\u{FFFD}"));
  *i = start + len;
}

pub struct BlockRules {
  pub blockquote: Regex,
  #[allow(dead_code)] // used in fastpath_parity tests
  pub code: Regex,
  pub def: Regex,
  pub fences: Regex,
  pub heading: Regex,
  pub hr: Regex,
  pub html: Regex,
  pub lheading: Regex,
  pub list: Regex,
  #[allow(dead_code)] // used in fastpath_parity tests
  pub newline: Regex,
  #[allow(dead_code)] // used in bench/scanner differential tests
  pub paragraph: Regex,
  pub table: Regex,
  pub text: Regex,
}

pub struct InlineRules {
  pub any_punctuation: Regex,
  pub autolink: Regex,
  pub block_skip: Regex,
  pub del: Regex,
  pub em_strong_ldelim: Regex,
  // 中文（bug fix 说明）：这两条闭合定界符正则只被 `emstrong.rs` 测试模块里的
  // 参照实现 `ref_find_closing` 读取（差分对拍 / marked 金标）。生产热路径已改走
  // 手写状态机 `find_closing_em_strong`，不再触碰它们，因此非测试构建（cdylib）会报
  // dead_code。与上面的 `code`/`newline`/`paragraph` 同惯例，显式允许而不是删除：
  // 参照实现仍要跑对拍，删掉规则会让差分测试失去对照。
  #[allow(dead_code)] // used by emstrong.rs differential tests (ref_find_closing)
  pub em_strong_rdelim_ast: Regex,
  #[allow(dead_code)] // used by emstrong.rs differential tests (ref_find_closing)
  pub em_strong_rdelim_und: Regex,
  pub link: Regex,
  pub nolink: Regex,
  pub punctuation: Regex,
  pub reflink: Regex,
  pub reflink_search: Regex,
  pub tag: Regex,
  pub url: Regex,
  pub backpedal: Regex,
}

/// marked `other` rules used by the lexer path (see Tokenizer.ts usage scan;
/// renderer/parser/hooks/pedantic-only rules are intentionally not ported).
pub struct OtherRules {
  pub code_remove_indent: Regex,
  pub output_link_replace: Regex,
  pub indent_code_compensation: Regex,
  pub beginning_space: Regex,
  pub ending_hash: Regex,
  pub ending_space_char: Regex,
  pub non_space_char: Regex,
  pub new_line_char_global: Regex,
  pub tab_char_global: Regex,
  pub multiple_space_global: Regex,
  pub blank_line: Regex,
  pub double_blank_line: Regex,
  pub blockquote_start: Regex,
  pub blockquote_setext_replace: Regex,
  pub blockquote_setext_replace2: Regex,
  pub list_is_task: Regex,
  pub list_replace_task: Regex,
  pub list_task_checkbox: Regex,
  pub any_line: Regex,
  pub href_brackets: Regex,
  pub slash_pipe: Regex,
  pub carriage_return: Regex,
  pub table_delimiter: Regex,
  pub table_align_chars: Regex,
  pub table_row_blank_line: Regex,
  pub table_align_right: Regex,
  pub table_align_center: Regex,
  pub table_align_left: Regex,
  pub start_a_tag: Regex,
  pub end_a_tag: Regex,
  pub start_pre_script_tag: Regex,
  pub end_pre_script_tag: Regex,
  pub start_angle_bracket: Regex,
  pub end_angle_bracket: Regex,
  pub unicode_alpha_numeric: Regex,
}

pub struct Rules {
  pub block: BlockRules,
  pub inline: InlineRules,
  pub other: OtherRules,
}

static RULES: OnceLock<Rules> = OnceLock::new();

pub fn rules() -> &'static Rules {
  RULES.get_or_init(|| Rules {
    block: BlockRules {
      blockquote: compile!(R_BLOCK_BLOCKQUOTE),
      code: compile!(R_BLOCK_CODE),
      def: compile!(R_BLOCK_DEF),
      fences: compile!(R_BLOCK_FENCES),
      heading: compile!(R_BLOCK_HEADING),
      hr: compile!(R_BLOCK_HR),
      html: compile!(R_BLOCK_HTML),
      lheading: compile!(R_BLOCK_LHEADING),
      list: compile!(R_BLOCK_LIST),
      newline: compile!(R_BLOCK_NEWLINE),
      paragraph: compile!(R_BLOCK_PARAGRAPH),
      table: compile!(R_BLOCK_TABLE),
      text: compile!(R_BLOCK_TEXT),
    },
    inline: InlineRules {
      any_punctuation: compile!(R_INLINE_ANY_PUNCTUATION),
      autolink: compile!(R_INLINE_AUTOLINK),
      block_skip: compile!(R_INLINE_BLOCK_SKIP),
      del: compile!(R_INLINE_DEL),
      em_strong_ldelim: compile!(R_INLINE_EM_STRONG_L_DELIM),
      em_strong_rdelim_ast: compile!(R_INLINE_EM_STRONG_R_DELIM_AST),
      em_strong_rdelim_und: compile!(R_INLINE_EM_STRONG_R_DELIM_UND),
      link: compile!(R_INLINE_LINK),
      nolink: compile!(R_INLINE_NOLINK),
      punctuation: compile!(R_INLINE_PUNCTUATION),
      reflink: compile!(R_INLINE_REFLINK),
      reflink_search: compile!(R_INLINE_REFLINK_SEARCH),
      tag: compile!(R_INLINE_TAG),
      url: compile!(R_INLINE_URL),
      backpedal: compile!(R_INLINE__BACKPEDAL),
    },
    other: OtherRules {
      // marked src/rules.ts `other` — exact JS sources, `g` = our global loop.
      code_remove_indent: compile!(r"(?m)^(?: {1,4}| {0,3}\t)"),
      output_link_replace: compile!(r#"\\([\[\]])"#),
      indent_code_compensation: compile!(r"^(\s+)(?:```)"),
      beginning_space: compile!(r"^\s+"),
      ending_hash: compile!(r"#$"),
      ending_space_char: compile!(r" $"),
      non_space_char: compile!(r"[^ ]"),
      new_line_char_global: compile!(r"\n"),
      tab_char_global: compile!(r"\t"),
      multiple_space_global: compile!(r"\s+"),
      blank_line: compile!(r"^[ \t]*$"),
      double_blank_line: compile!(r"\n[ \t]*\n[ \t]*$"),
      blockquote_start: compile!(r"^ {0,3}>"),
      blockquote_setext_replace: compile!(r"\n {0,3}((?:=+|-+) *)(?=\n|$)"),
      blockquote_setext_replace2: compile!(r"(?m)^ {0,3}>[ \t]?"),
      list_is_task: compile!(r"^\[[ xX]\] +\S"),
      list_replace_task: compile!(r"^\[[ xX]\] +"),
      list_task_checkbox: compile!(r"\[[ xX]\]"),
      any_line: compile!(r"\n.*\n"),
      href_brackets: compile!(r"^<(.*)>$"),
      slash_pipe: compile!(r"\\\|"),
      carriage_return: compile!(r"\r\n|\r"),
      table_delimiter: compile!(r"[:|]"),
      table_align_chars: compile!(r"^\||\| *$"),
      table_row_blank_line: compile!(r"\n[ \t]*$"),
      table_align_right: compile!(r"^ *-+: *$"),
      table_align_center: compile!(r"^ *:-+: *$"),
      table_align_left: compile!(r"^ *:-+ *$"),
      start_a_tag: compile!(r"(?i)^<a "),
      end_a_tag: compile!(r"(?i)^</a>"),
      start_pre_script_tag: compile!(r"(?i)^<(pre|code|kbd|script)(\s|>)"),
      end_pre_script_tag: compile!(r"(?i)^</(pre|code|kbd|script)(\s|>)"),
      start_angle_bracket: compile!(r"^<"),
      end_angle_bracket: compile!(r">$"),
      unicode_alpha_numeric: compile!(r"[\p{L}\p{N}]"),
    },
  })
}

/// Cache for the dynamically-built list rules. marked builds `new RegExp`
/// per list item, which V8 makes cheap; fancy-regex compilation is expensive
/// (the list loop rebuilds up to 6 rules per item), so compiled patterns are
/// memoized by pattern string. The patterns are pure functions of the marked
/// arguments, so caching cannot change semantics.
fn cached_dynamic(pattern: String) -> Regex {
  use std::collections::HashMap;
  use std::sync::LazyLock;
  static CACHE: LazyLock<parking_lot::Mutex<HashMap<String, Regex>>> =
    LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));
  let mut cache = CACHE.lock();
  cache
    .entry(pattern.clone())
    .or_insert_with(|| compile!(pattern))
    .clone()
}

/// `other.listItemRegex(bull)` — built per list, like marked's `new RegExp`.
pub fn list_item_regex(bull: &str) -> Regex {
  cached_dynamic(format!(r"^( {{0,3}}{bull})((?:[\t ][^\n]*)?(?:\n|$))"))
}

fn indent_bound(indent: usize) -> usize {
  // marked: Math.min(3, indent - 1); list tokenizer guarantees indent >= 1.
  3.min(indent.saturating_sub(1))
}

/// `other.nextBulletRegex(indent)`.
pub fn next_bullet_regex(indent: usize) -> Regex {
  cached_dynamic(format!(
    r"^ {{0,{}}}(?:[*+-]|\d{{1,9}}[.)])((?:[ \t][^\n]*)?(?:\n|$))",
    indent_bound(indent)
  ))
}

/// `other.hrRegex(indent)`.
pub fn hr_regex(indent: usize) -> Regex {
  cached_dynamic(format!(
    r"^ {{0,{}}}((?:- *){{3,}}|(?:_ *){{3,}}|(?:\* *){{3,}})(?:\n+|$)",
    indent_bound(indent)
  ))
}

/// `other.fencesBeginRegex(indent)`.
pub fn fences_begin_regex(indent: usize) -> Regex {
  cached_dynamic(format!(r"^ {{0,{}}}(?:```|~~~)", indent_bound(indent)))
}

/// `other.headingBeginRegex(indent)`.
pub fn heading_begin_regex(indent: usize) -> Regex {
  cached_dynamic(format!(r"^ {{0,{}}}#", indent_bound(indent)))
}

/// `other.htmlBeginRegex(indent)`.
pub fn html_begin_regex(indent: usize) -> Regex {
  cached_dynamic(format!(r"(?i)^ {{0,{}}}<(?:[a-z].*>|!--)", indent_bound(indent)))
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Every embedded marked rule must compile under fancy-regex, including the
  /// JS-only constructs: named backrefs (`\k<a>`), lookbehind `(?<!`)`,
  /// capture backrefs, and `\p{...}` classes.
  #[test]
  fn all_rules_compile_and_anchor() {
    let r = rules();
    // named group + backref + lookbehind (blockSkip)
    let m = r.inline.block_skip.find_iter("a `co`de [l](u)").next().unwrap().unwrap();
    assert_eq!(m.start(), 2, "blockSkip should mask the codespan");
    // (inline code is hand-scanned, not regex-backed)
    // case-insensitive html backref
    assert!(caps(&r.block.html, "<SCRIPT>var x;</SCRIPT>\n").is_some());
    // unicode classes with gfm em delims
    assert!(caps(&r.inline.em_strong_ldelim, "**a").is_some());
    // $ must be end-of-input (JS semantics): heading needs real end/newline
    assert!(caps(&r.block.heading, "# hi").is_some());
    assert_eq!(caps(&r.block.newline, "\n\n").unwrap()[0].as_deref(), Some("\n\n"));
    // dynamic list rules
    let _ = list_item_regex(r"\\d{1,9}\.");
    let _ = next_bullet_regex(3);
    let _ = hr_regex(2);
    let _ = fences_begin_regex(4);
    let _ = heading_begin_regex(1);
    let _ = html_begin_regex(2);
  }

  /// JS `RegExp.exec` capture semantics: non-participating groups are undefined.
  pub fn caps(re: &Regex, s: &str) -> Option<Vec<Option<String>>> {
    let m = re.captures(s).ok().flatten()?;
    let mut out = Vec::with_capacity(m.len());
    for i in 0..m.len() {
      out.push(m.get(i).map(|x| x.as_str().to_string()));
    }
    Some(out)
  }
}

#[cfg(test)]
mod ws_probe {
  use fancy_regex::Regex;
  const JS: &str = r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
  #[test]
  fn nested_class_and_js_space() {
    // nested class union (would be [\s\S] transformed)
    let re = Regex::new(&format!("[[{0}][^{0}]]*?x", JS)).unwrap();
    assert_eq!(re.find("é中x").unwrap().unwrap().as_str(), "é中x");
    // negated class with \s swapped for JS set: [^\s*] must match NEL (JS \s excludes it)
    let re = Regex::new(&format!("[^{0}*]", JS)).unwrap();
    assert!(re.is_match("").unwrap());
    // ... and must NOT match FEFF (JS \s includes it)
    assert!(!re.is_match("\u{FEFF}").unwrap());
    // anchored set inside alternation lookahead
    let re = Regex::new(&format!("(?={0}|$)", JS)).unwrap();
    assert!(re.find("x\u{FEFF}").unwrap().is_some());
  }
}
