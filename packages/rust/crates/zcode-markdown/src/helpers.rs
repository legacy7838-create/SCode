//! JS-semantics string/regex helpers for the marked 17.0.1 port.
//!
//! Conventions: byte offsets everywhere (JS uses UTF-16 units; every arithmetic
//! site has been checked to be ASCII-boundary-equivalent or self-consistent in
//! its own coordinate system).

use fancy_regex::{Captures, Regex};

/// JS `RegExp.exec` — first match with capture groups.
pub fn exec<'t>(re: &Regex, s: &'t str) -> Option<Captures<'t>> {
  re.captures(s).ok().flatten()
}

/// JS `RegExp.prototype.test` — a runtime engine error counts as "no match"
/// (the port stays total over strings; marked's JS engine has no such error
/// class, so this only fires on adversarial backtracking cases).
pub trait RegexJs {
  fn test(&self, s: &str) -> bool;
}

impl RegexJs for Regex {
  fn test(&self, s: &str) -> bool {
    self.is_match(s).unwrap_or(false)
  }
}

/// Group value as JS sees it: `undefined` for non-participating groups.
pub fn cap<'a>(c: &'a Captures<'a>, i: usize) -> Option<&'a str> {
  c.get(i).map(|m| m.as_str())
}

/// JS truthiness for strings (`undefined` and `""` are falsy).
pub fn truthy(s: Option<&str>) -> bool {
  matches!(s, Some(x) if !x.is_empty())
}

// ---------------------------------------------------------------------------
// Whitespace: JS `WhiteSpace ∪ LineTerminator` (also the `String#trim` set).
// Differs from Rust's `char::is_whitespace` at U+0085 (JS: no) and U+FEFF
// (JS: yes); both verified against node.
// ---------------------------------------------------------------------------

pub fn js_space(c: char) -> bool {
  matches!(
    c,
    '\t' | '\n'
      | '\u{B}'
      | '\u{C}'
      | '\r'
      | ' '
      | '\u{A0}'
      | '\u{1680}'
      | '\u{2000}'..='\u{200A}'
      | '\u{2028}'
      | '\u{2029}'
      | '\u{202F}'
      | '\u{205F}'
      | '\u{3000}'
      | '\u{FEFF}'
  )
}

/// JS `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
  js_trim_end(js_trim_start(s))
}

pub fn js_trim_start(s: &str) -> &str {
  for (i, c) in s.char_indices() {
    if !js_space(c) {
      return &s[i..];
    }
  }
  ""
}

pub fn js_trim_end(s: &str) -> &str {
  let mut end = s.len();
  while end > 0 {
    let ch = s[..end].chars().next_back().unwrap();
    if js_space(ch) {
      end -= ch.len_utf8();
    } else {
      break;
    }
  }
  &s[..end]
}

// ---------------------------------------------------------------------------
// JS `String.replace` variants used by the port
// ---------------------------------------------------------------------------

/// `str.replace(re, '')` — first match only (JS non-global replace).
pub fn replace_first_empty(s: &str, re: &Regex) -> String {
  match re.find(s).ok().flatten() {
    Some(m) => format!("{}{}", &s[..m.start()], &s[m.end()..]),
    None => s.to_string(),
  }
}

/// `str.replace(re, '$1')` — first match, group 1 substituted (missing group
/// becomes `""`, matching JS `$1` on a non-participating group).
pub fn replace_first_g1(s: &str, re: &Regex) -> String {
  match re.captures(s).ok().flatten() {
    Some(c) => {
      let m = c.get(0).unwrap();
      let g1 = c.get(1).map(|x| x.as_str()).unwrap_or("");
      format!("{}{}{}", &s[..m.start()], g1, &s[m.end()..])
    }
    None => s.to_string(),
  }
}

/// `str.replace(re, '$1')` with the `g` flag.
pub fn replace_all_g1(s: &str, re: &Regex) -> String {
  let mut out = String::with_capacity(s.len());
  let mut pos = 0usize;
  while pos <= s.len() {
    let c = match re.captures_from_pos(s, pos).ok().flatten() {
      Some(c) => c,
      None => break,
    };
    let m0 = c.get(0).unwrap();
    out.push_str(&s[pos..m0.start()]);
    out.push_str(c.get(1).map(|x| x.as_str()).unwrap_or(""));
    if m0.end() == m0.start() {
      // empty match: JS replaces it and advances lastIndex by one code unit
      match s[m0.end()..].chars().next() {
        Some(ch) => pos = m0.end() + ch.len_utf8(),
        None => {
          pos = m0.end();
          break;
        }
      }
    } else {
      pos = m0.end();
    }
  }
  out.push_str(&s[pos.min(s.len())..]);
  out
}

/// `str.replace(re, literal)` with the `g` flag (including `(?m)^...` forms).
pub fn replace_all_literal(s: &str, re: &Regex, lit: &str) -> String {
  let mut out = String::with_capacity(s.len());
  let mut pos = 0usize;
  while let Some(m) = re.find_from_pos(s, pos).ok().flatten() {
    out.push_str(&s[pos..m.start()]);
    out.push_str(lit);
    pos = m.end();
    if m.start() == m.end() {
      // empty match: JS copies one char and advances
      match s[pos..].chars().next() {
        Some(c) => {
          out.push(c);
          pos += c.len_utf8();
        }
        None => break,
      }
    }
  }
  out.push_str(&s[pos.min(s.len())..]);
  out
}

/// `str.split(/\n/)`-style removal of every match: `replace(re, '')` with `g`.
pub fn remove_all(s: &str, re: &Regex) -> String {
  replace_all_literal(s, re, "")
}

// ---------------------------------------------------------------------------
// marked helpers (Tokenizer.ts imports): rtrim, findClosingBracket, splitCells
// ---------------------------------------------------------------------------

/// marked `rtrim(str, c)` — remove trailing `c` chars (invert never used).
pub fn rtrim(s: &str, c: char) -> &str {
  let mut end = s.len();
  while end > 0 {
    let ch = s[..end].chars().next_back().unwrap();
    if ch == c {
      end -= ch.len_utf8();
    } else {
      break;
    }
  }
  &s[..end]
}

/// marked `findClosingBracket(str, b)` — forward scan; `\\` escapes the next
/// char, an `open` increments the level, and the returned index is the FIRST
/// `close` that drops the level below 0 (an unmatched trailing `close`).
/// `-2` when opens never close, `-1` when there is no closing bracket at all.
/// Returns a byte index (JS returns a UTF-16 unit index; brackets and the
/// backslash are ASCII, so the byte index is the correct slice bound for the
/// byte-space port — callers slice the same string they searched).
pub fn find_closing_bracket(s: &str, open: char, close: char) -> i64 {
  if !s.contains(close) {
    return -1;
  }
  let mut level: i64 = 0;
  let mut skip_next = false;
  for (i, ch) in s.char_indices() {
    if skip_next {
      skip_next = false;
    } else if ch == '\\' {
      skip_next = true;
    } else if ch == open {
      level += 1;
    } else if ch == close {
      level -= 1;
      if level < 0 {
        return i as i64;
      }
    }
  }
  if level > 0 {
    -2
  } else {
    -1
  }
}

/// marked `splitCells(tableRow, count?)`.
pub fn split_cells(table_row: &str, count: Option<usize>) -> Vec<String> {
  let rules = crate::rules::rules();
  // findPipe replacement: prefix unescaped `|` with a space (JS replacer fn).
  let mut row = String::with_capacity(table_row.len() + 8);
  let mut last = 0usize;
  for (i, ch) in table_row.char_indices() {
    if ch != '|' {
      continue;
    }
    let mut escaped = false;
    let mut j = i;
    while j > 0 {
      let prev = table_row[..j].chars().next_back().unwrap();
      if prev == '\\' {
        escaped = !escaped;
        j -= prev.len_utf8();
      } else {
        break;
      }
    }
    if !escaped {
      row.push_str(&table_row[last..i]);
      row.push_str(" |");
      last = i + ch.len_utf8();
    }
  }
  row.push_str(&table_row[last..]);

  // row.split(other.splitPipe) — splitPipe = / \|/
  let mut cells: Vec<String> = Vec::new();
  let mut rest: &str = &row;
  while let Some(idx) = rest.find(" |") {
    cells.push(rest[..idx].to_string());
    rest = &rest[idx + 2..];
  }
  cells.push(rest.to_string());

  if !cells.is_empty() {
    if js_trim(&cells[0]).is_empty() {
      cells.remove(0);
    }
    if !cells.is_empty() && js_trim(cells.last().unwrap()).is_empty() {
      cells.pop();
    }
  }

  if let Some(n) = count {
    if n > 0 {
      if cells.len() > n {
        cells.truncate(n);
      } else {
        while cells.len() < n {
          cells.push(String::new());
        }
      }
    }
  }

  for cell in cells.iter_mut() {
    let trimmed = js_trim(cell);
    *cell = replace_all_literal(trimmed, &rules.other.slash_pipe, "|");
  }
  cells
}

/// First byte index matching `re` (JS `String.prototype.search`).
pub fn search_first(re: &Regex, s: &str) -> Option<usize> {
  re.find(s).ok().flatten().map(|m| m.start())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn js_trim_matches_node() {
    // node: "\u{85} ".trim() === "\u{85}" — NEL is not JS whitespace, the
    // trailing space is.
    assert_eq!(js_trim("\u{85} "), "\u{85}");
    assert_eq!(js_trim("\u{FEFF}x\u{FEFF}"), "x");
    assert_eq!(js_trim("  hi \n"), "hi");
    assert_eq!(js_trim(""), "");
    assert_eq!(js_trim_start("  a"), "a");
    assert_eq!(js_trim_end("a  "), "a");
  }

  #[test]
  fn brackets_and_cells() {
    // Expectations verified against marked 17.0.1 `findClosingBracket`
    // (forward scan; the returned index is the close that drops below 0).
    assert_eq!(find_closing_bracket("b(c))", '(', ')'), 4);
    assert_eq!(find_closing_bracket("b(c)", '(', ')'), -1);
    assert_eq!(find_closing_bracket("b(c", '(', ')'), -1);
    assert_eq!(find_closing_bracket("a(b(c))", '(', ')'), -1);
    // byte index: "é" is 2 bytes, ")" sits at byte 2
    assert_eq!(find_closing_bracket("é)", '(', ')'), 2);
    assert_eq!(split_cells("a | b", None), vec!["a", "b"]);
    assert_eq!(split_cells("| a | b |", None), vec!["a", "b"]);
    // escaped pipe never splits the cell; marked strips the backslash via
    // slashPipe only after the split — cell text becomes "a | b"
    assert_eq!(split_cells("a \\| b", None), vec!["a | b"]);
    assert_eq!(split_cells("a \\| b | c", None), vec!["a | b", "c"]);
    assert_eq!(split_cells("a | b | c", Some(2)), vec!["a", "b"]);
    assert_eq!(split_cells("a | b", Some(3)), vec!["a", "b", ""]);
  }

  #[test]
  fn rtrim_skips_only_target_char() {
    assert_eq!(rtrim("hi ###", '#'), "hi ");
    assert_eq!(rtrim("a\n\n", '\n'), "a");
    assert_eq!(rtrim("ab", '#'), "ab");
  }

  #[test]
  fn replace_helpers_match_js() {
    let rules = crate::rules::rules();
    assert_eq!(
      replace_first_g1("<href>", &rules.other.href_brackets),
      "href"
    );
    assert_eq!(
      replace_all_literal("a\tb\tc", &rules.other.tab_char_global, "    "),
      "a    b    c"
    );
    assert_eq!(remove_all("  ab  ", &rules.other.code_remove_indent), "ab  ");
    assert_eq!(
      replace_all_g1("\\[x\\]y\\[", &rules.other.output_link_replace),
      "[x]y["
    );
  }
}
