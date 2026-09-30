// zcode-diff: native structured patch + edit-fuzzy primitives.
// Spec: docs/specs/rust-native-diff.md. The diff engine is an exact port of
// jsdiff v9's base.js Myers variant (path selection, diagonal pruning,
// extractCommon tie-breaks) over jsdiff-compatible line tokens, plus the
// diffLinesResultToPatch hunk assembly with context=3 — ported 1:1 so hunk
// boundaries are identical by construction (parent invariant 3). The fuzzy
// primitives replicate JS string semantics over UTF-16 code units. There is
// no JS fallback by design.

use std::rc::Rc;

use napi_derive::napi;

const CONTEXT_LINES_DEFAULT: u32 = 3;

// ---------------------------------------------------------------------------
// Line tokenization (jsdiff tokenize + removeEmpty, newlineIsToken = false)
// ---------------------------------------------------------------------------

fn tokenize_lines(value: &str) -> Vec<String> {
  // JS: value.split(/(\n|\r\n)/) — separators become their own entries.
  let bytes = value.as_bytes();
  let mut parts: Vec<String> = Vec::new();
  let mut current = String::new();
  let mut i = 0usize;
  while i < bytes.len() {
    let separator_len = if bytes[i] == b'\n' {
      1
    } else if bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
      2
    } else {
      0
    };
    if separator_len > 0 {
      parts.push(std::mem::take(&mut current));
      parts.push(value[i..i + separator_len].to_string());
      i += separator_len;
    } else {
      let mut char_len = 1;
      while i + char_len < bytes.len() && (bytes[i + char_len] & 0xC0) == 0x80 {
        char_len += 1;
      }
      current.push_str(&value[i..i + char_len]);
      i += char_len;
    }
  }
  parts.push(current);

  // JS: ignore the final empty token that occurs if the string ends with a newline.
  if parts.last().is_some_and(|last| last.is_empty()) {
    parts.pop();
  }

  // JS: merge separators into the preceding content token (i % 2 && !newlineIsToken).
  let mut tokens: Vec<String> = Vec::with_capacity(parts.len());
  for (index, part) in parts.into_iter().enumerate() {
    if index % 2 == 1 {
      if let Some(last) = tokens.last_mut() {
        last.push_str(&part);
      }
    } else {
      tokens.push(part);
    }
  }

  // JS: removeEmpty — drop falsy (empty) tokens.
  tokens.retain(|token| !token.is_empty());
  tokens
}

// ---------------------------------------------------------------------------
// Myers engine — exact port of jsdiff base.js (sync mode, no timeout)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Component {
  count: u32,
  added: bool,
  removed: bool,
  previous: Option<Rc<Component>>,
}

#[derive(Clone)]
struct PathState {
  old_pos: i64,
  last_component: Option<Rc<Component>>,
}

struct DiffEngine<'a> {
  old_tokens: &'a [String],
  new_tokens: &'a [String],
}

impl<'a> DiffEngine<'a> {
  // Port of addToPath: extend the last component when the change kind matches.
  fn add_to_path(
    &self,
    path: &PathState,
    added: bool,
    removed: bool,
    old_pos_inc: i64,
  ) -> PathState {
    let new_old_pos = path.old_pos + old_pos_inc;
    match &path.last_component {
      Some(last) if last.added == added && last.removed == removed => PathState {
        old_pos: new_old_pos,
        last_component: Some(Rc::new(Component {
          count: last.count + 1,
          added,
          removed,
          previous: last.previous.clone(),
        })),
      },
      last => PathState {
        old_pos: new_old_pos,
        last_component: Some(Rc::new(Component {
          count: 1,
          added,
          removed,
          previous: last.clone(),
        })),
      },
    }
  }

  // Port of extractCommon: consume the run of equal tokens after the path head.
  fn extract_common(&self, base_path: &mut PathState, diagonal_path: i64) -> i64 {
    let old_len = self.old_tokens.len() as i64;
    let new_len = self.new_tokens.len() as i64;
    let mut old_pos = base_path.old_pos;
    let mut new_pos = old_pos - diagonal_path;
    let mut common_count: u32 = 0;
    while new_pos + 1 < new_len
      && old_pos + 1 < old_len
      && self.old_tokens[(old_pos + 1) as usize] == self.new_tokens[(new_pos + 1) as usize]
    {
      new_pos += 1;
      old_pos += 1;
      common_count += 1;
    }
    if common_count > 0 {
      base_path.last_component = Some(Rc::new(Component {
        count: common_count,
        added: false,
        removed: false,
        previous: base_path.last_component.clone(),
      }));
    }
    base_path.old_pos = old_pos;
    new_pos
  }

  // Port of buildValues: linked list → ordered components → joined values.
  fn build_values(&self, last_component: Option<&Rc<Component>>) -> Vec<Change> {
    let mut components: Vec<&Rc<Component>> = Vec::new();
    let mut next = last_component;
    while let Some(component) = next {
      components.push(component);
      next = component.previous.as_ref();
    }
    components.reverse();

    let mut changes: Vec<Change> = Vec::with_capacity(components.len());
    let mut new_pos = 0usize;
    let mut old_pos = 0usize;
    for component in components {
      if component.removed {
        let value = self.old_tokens[old_pos..old_pos + component.count as usize].join("");
        old_pos += component.count as usize;
        changes.push(Change {
          added: false,
          removed: true,
          value,
        });
      } else {
        let value = self.new_tokens[new_pos..new_pos + component.count as usize].join("");
        new_pos += component.count as usize;
        if !component.added {
          old_pos += component.count as usize;
        }
        changes.push(Change {
          added: component.added,
          removed: false,
          value,
        });
      }
    }
    changes
  }

  // Returns None only when the edit-length bound is exhausted (legacy returned
  // undefined → empty patch). jsdiff's 5s timeout is intentionally not ported
  // (spec: documented divergence, authorized).
  fn diff(&self) -> Option<Vec<Change>> {
    let old_len = self.old_tokens.len() as i64;
    let new_len = self.new_tokens.len() as i64;
    let max_edit_length = new_len + old_len;
    // Diagonal index offset. JS uses a sparse array where bestPath[-max-1] is
    // simply undefined; the +1 margin gives the Vec the same slack.
    let offset = max_edit_length + 1;
    let mut best_path: Vec<Option<PathState>> = vec![None; (2 * max_edit_length + 3) as usize];

    let mut seed = PathState {
      old_pos: -1,
      last_component: None,
    };
    let mut new_pos = self.extract_common(&mut seed, 0);
    if seed.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
      return Some(self.build_values(seed.last_component.as_ref()));
    }
    best_path[(0 + offset) as usize] = Some(seed);

    let mut min_diagonal_to_consider = i64::MIN;
    let mut max_diagonal_to_consider = i64::MAX;
    let mut edit_length: i64 = 1;

    while edit_length <= max_edit_length {
      let mut completed: Option<Vec<Change>> = None;
      let diagonal_start = min_diagonal_to_consider.max(-edit_length);
      let diagonal_end = max_diagonal_to_consider.min(edit_length);
      let mut diagonal_path = diagonal_start;
      while diagonal_path <= diagonal_end {
        let remove_path = best_path[(diagonal_path - 1 + offset) as usize].take();
        let add_path = best_path[(diagonal_path + 1 + offset) as usize].clone();

        let add_path_new_pos = add_path.as_ref().map(|path| path.old_pos - diagonal_path);
        let can_add = add_path_new_pos.is_some_and(|new_pos| 0 <= new_pos && new_pos < new_len);
        let can_remove = remove_path
          .as_ref()
          .is_some_and(|path| path.old_pos + 1 < old_len);

        if !can_add && !can_remove {
          best_path[(diagonal_path + offset) as usize] = None;
          diagonal_path += 2;
          continue;
        }

        let mut base_path =
          if !can_remove || (can_add && remove_path.as_ref().unwrap().old_pos < add_path.as_ref().unwrap().old_pos)
          {
            self.add_to_path(add_path.as_ref().unwrap(), true, false, 0)
          } else {
            self.add_to_path(remove_path.as_ref().unwrap(), false, true, 1)
          };

        new_pos = self.extract_common(&mut base_path, diagonal_path);
        if base_path.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
          completed = Some(self.build_values(base_path.last_component.as_ref()));
          break;
        }

        if base_path.old_pos + 1 >= old_len {
          max_diagonal_to_consider = max_diagonal_to_consider.min(diagonal_path - 1);
        }
        if new_pos + 1 >= new_len {
          min_diagonal_to_consider = min_diagonal_to_consider.max(diagonal_path + 1);
        }
        best_path[(diagonal_path + offset) as usize] = Some(base_path);
        diagonal_path += 2;
      }

      if let Some(changes) = completed {
        return Some(changes);
      }
      edit_length += 1;
    }
    None
  }
}

struct Change {
  added: bool,
  removed: bool,
  value: String,
}

// ---------------------------------------------------------------------------
// Hunk assembly — exact port of jsdiff structuredPatch/diffLinesResultToPatch
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct DiffHunk {
  pub old_start: u32,
  pub old_lines: u32,
  pub new_start: u32,
  pub new_lines: u32,
  pub lines: Vec<String>,
}

// JS splitLines: keep the trailing newline on every line; a final line without
// a newline keeps no separator; an empty value yields a single empty line.
fn split_lines(text: &str) -> Vec<String> {
  let has_trailing_newline = text.ends_with('\n');
  let mut result: Vec<String> = text.split('\n').map(|line| format!("{line}\n")).collect();
  if has_trailing_newline {
    result.pop();
  } else if let Some(last) = result.pop() {
    result.push(last[..last.len() - 1].to_string());
  }
  result
}

fn context_lines(lines: &[String]) -> Vec<String> {
  lines.iter().map(|line| format!(" {line}")).collect()
}

fn diff_to_hunks(changes: Vec<Change>, context: u32) -> Vec<DiffHunk> {
  // jsdiff appends an empty sentinel component before assembly.
  let mut diff: Vec<(bool, bool, Vec<String>)> = changes
    .into_iter()
    .map(|change| (change.added, change.removed, split_lines(&change.value)))
    .collect();
  diff.push((false, false, Vec::new()));

  let mut hunks: Vec<DiffHunk> = Vec::new();
  let mut old_range_start: u32 = 0;
  let mut new_range_start: u32 = 0;
  let mut cur_range: Vec<String> = Vec::new();
  let mut old_line: u32 = 1;
  let mut new_line: u32 = 1;

  let total = diff.len();
  for (i, (added, removed, lines)) in diff.iter().enumerate() {
    if *added || *removed {
      if old_range_start == 0 {
        old_range_start = old_line;
        new_range_start = new_line;
        if i > 0 {
          let prev = &diff[i - 1].2;
          let context_len = if context > 0 { prev.len().min(context as usize) } else { 0 };
          let start = prev.len() - context_len;
          cur_range = prev[start..].iter().map(|line| format!(" {line}")).collect();
          old_range_start -= cur_range.len() as u32;
          new_range_start -= cur_range.len() as u32;
        }
      }
      for line in lines {
        cur_range.push(format!("{}{line}", if *added { "+" } else { "-" }));
      }
      if *added {
        new_line += lines.len() as u32;
      } else {
        old_line += lines.len() as u32;
      }
    } else {
      if old_range_start != 0 {
        if lines.len() <= (context * 2) as usize && i < total - 2 {
          // Overlapping ranges are joined.
          for line in context_lines(lines) {
            cur_range.push(line);
          }
        } else {
          let context_size = (lines.len() as u32).min(context);
          for line in context_lines(&lines[..context_size as usize]) {
            cur_range.push(line);
          }
          hunks.push(DiffHunk {
            old_start: old_range_start,
            old_lines: old_line - old_range_start + context_size,
            new_start: new_range_start,
            new_lines: new_line - new_range_start + context_size,
            lines: std::mem::take(&mut cur_range),
          });
          old_range_start = 0;
          new_range_start = 0;
        }
      }
      old_line += lines.len() as u32;
      new_line += lines.len() as u32;
    }
  }

  // Step 2: strip the trailing newline; insert the no-newline-at-eof marker.
  for hunk in &mut hunks {
    let mut lines = std::mem::take(&mut hunk.lines);
    let mut i = 0usize;
    while i < lines.len() {
      if lines[i].ends_with('\n') {
        lines[i].pop();
      } else {
        lines.insert(i + 1, "\\ No newline at end of file".to_string());
        i += 1;
      }
      i += 1;
    }
    hunk.lines = lines;
  }

  hunks
}

/// Structured patch with jsdiff line-diff semantics (context defaults to 3).
/// Returns an empty vec when no differences exist.
#[napi]
pub fn structured_patch(
  old_content: String,
  new_content: String,
  context: Option<u32>,
) -> Vec<DiffHunk> {
  let context = context.unwrap_or(CONTEXT_LINES_DEFAULT);
  let old_tokens = tokenize_lines(&old_content);
  let new_tokens = tokenize_lines(&new_content);
  let engine = DiffEngine {
    old_tokens: &old_tokens,
    new_tokens: &new_tokens,
  };
  match engine.diff() {
    Some(changes) => diff_to_hunks(changes, context),
    None => Vec::new(),
  }
}

// ---------------------------------------------------------------------------
// Edit-fuzzy primitives — JS parity over UTF-16 code units
// ---------------------------------------------------------------------------

fn js_trim(value: &str) -> &str {
  // ECMAScript String.prototype.trim: WhiteSpace + LineTerminator.
  // Includes U+FEFF; excludes U+0085 (Rust's char::is_whitespace includes it).
  let is_js_whitespace = |c: char| {
    matches!(
      c,
      '\u{0009}'
        | '\u{000A}'
        | '\u{000B}'
        | '\u{000C}'
        | '\u{000D}'
        | '\u{0020}'
        | '\u{00A0}'
        | '\u{1680}'
        | '\u{2000}'..='\u{200A}'
        | '\u{2028}'
        | '\u{2029}'
        | '\u{202F}'
        | '\u{205F}'
        | '\u{3000}'
        | '\u{FEFF}'
    )
  };
  value.trim_matches(is_js_whitespace)
}

fn utf16_units(value: &str) -> Vec<u16> {
  value.encode_utf16().collect()
}

fn line_similarity_str(left: &str, right: &str) -> f64 {
  if left == right {
    return 1.0;
  }
  let left_units = utf16_units(left);
  let right_units = utf16_units(right);
  let max_length = left_units.len().max(right_units.len());
  if max_length == 0 {
    return 1.0;
  }
  1.0 - (levenshtein_u16(&left_units, &right_units) as f64) / (max_length as f64)
}

fn levenshtein_u16(left: &[u16], right: &[u16]) -> u32 {
  // Same DP shape as the deleted TS implementation (single rolling row).
  let mut previous: Vec<u32> = (0..=right.len() as u32).collect();
  let mut current: Vec<u32> = vec![0; right.len() + 1];
  for left_index in 1..=(left.len() as u32) {
    current[0] = left_index;
    for right_index in 1..=(right.len() as u32) {
      let cost = u32::from(left[(left_index - 1) as usize] != right[(right_index - 1) as usize]);
      current[right_index as usize] = (previous[right_index as usize] + 1)
        .min(current[(right_index - 1) as usize] + 1)
        .min(previous[(right_index - 1) as usize] + cost);
    }
    std::mem::swap(&mut previous, &mut current);
  }
  previous[right.len()]
}

/// Levenshtein distance over UTF-16 code units (JS string indexing).
#[napi]
pub fn levenshtein(left: String, right: String) -> u32 {
  levenshtein_u16(&utf16_units(&left), &utf16_units(&right))
}

/// 1 - levenshtein / max(UTF-16 length); identical strings → 1.
#[napi]
pub fn line_similarity(left: String, right: String) -> f64 {
  line_similarity_str(&left, &right)
}

/// Mean lineSimilarity over the middle lines (JS-trimmed) of the candidate
/// window; length ≤ 2 → 1. Mirrors the deleted TS implementation exactly.
#[napi]
pub fn average_middle_similarity(actual: Vec<String>, expected: Vec<String>) -> f64 {
  if actual.len() <= 2 {
    return 1.0;
  }
  let mut total = 0.0f64;
  let mut count = 0u32;
  for index in 1..actual.len() - 1 {
    // Callers always pass equal-length windows (block slices); the get() guard
    // only avoids a cross-FFI panic on contract violations.
    let Some(expected_line) = expected.get(index) else {
      return 0.0;
    };
    total += line_similarity_str(js_trim(&actual[index]), js_trim(expected_line));
    count += 1;
  }
  if count == 0 {
    1.0
  } else {
    total / count as f64
  }
}
