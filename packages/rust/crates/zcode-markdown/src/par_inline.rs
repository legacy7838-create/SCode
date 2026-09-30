//! 行内分词的并行执行骨架（data-parallel inline tokenization）。
//!
//! 设计前提（与 `lexer.rs` 的约束一致）：
//! - **块级**分词必须串行：块规则靠渐进消费 `src`（偏移量、链接定义注册），
//!   无法并行；本模块不触碰块级路径。
//! - **行内**任务彼此独立：`Job { src, arr }` 只共享只读的链接定义表与
//!   行内状态快照，没有跨任务的写入顺序依赖，因此可以按任务扇出。
//!
//! 中文说明为什么要快照（snapshot）而不是共享引用：并行的前提是
//! 「每个任务只读同一份上下文」。把 `links` 克隆一份、把三个布尔状态
//! 拷贝成值之后，`InlineCtxSnapshot` 就是不可变的，可以安全地被任意多
//! 个 rayon worker 同时借用，无需锁、也不会出现数据竞争。

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::OnceLock;

use rayon::prelude::*;
use serde_json::Value;

/// 低于该任务数一律走串行：rayon 的分发（闭包捕获、任务入队、work-stealing
/// 开销）是常数级但非零的，1~4 个任务时它的成本会吃掉并行收益。
///
/// 中文：4 个任务的场景（一次小文档、或只有几个 heading/table cell 的
/// 渲染）必须走串行，否则「并行反而更慢」。阈值取 8 是保守经验值：既能
/// 覆盖常见的多段落文档，又不会在小输入上倒贴分发成本。
pub const PARALLEL_MIN_JOBS: usize = 8;

/// 低于该总字节数一律走串行。inline 正则扫描的成本近似与字节数线性相关，
/// 只有当总量足够大时，单次分发的固定成本才可能被摊薄。
///
/// 中文：总字节数 < 2KB 时，即使任务数达标，单个任务的平均工作量也小于
/// 一次闭包调用 + 一次结果搬运，直接串行更快。
pub const PARALLEL_MIN_BYTES: usize = 2048;

/// 是否值得并行。任务数与总字节数两个条件是「与」关系：任一不达标就串行。
///
/// 中文：这里用 `>=`（而非 `>`），使得恰好等于阈值的输入也走并行，边界
/// 行为对测试可预测。
#[inline]
pub fn should_parallel(jobs: usize, bytes: usize) -> bool {
  jobs >= PARALLEL_MIN_JOBS && bytes >= PARALLEL_MIN_BYTES
}

/// 只读的行内上下文快照：`links` 是链接定义表（label -> (href, title)）的
/// 克隆，`in_link` / `in_raw_block` / `top` 是 `lexer::State` 的三个布尔
/// 字段的**值拷贝**。
///
/// 中文：不直接持有 `lexer::State`，因为它没有实现 `Clone`/`Copy`，而且
/// 行内阶段真正需要的语义就是这三个布尔量。用值拷贝换来「快照创建一次、
/// 多 worker 只读共享」，避免每个任务都去 clone 一整张 HashMap。
#[derive(Debug, Clone, Default)]
pub struct InlineCtxSnapshot {
  /// 标签 -> (href, title)；只读，行内阶段不会写入（写入只发生在块级
  /// `def` 规则里，而块级阶段在本模块之前已经跑完）。
  pub links: HashMap<String, (String, Option<String>)>,
}

impl InlineCtxSnapshot {
  /// 空快照（无链接定义、全部标志复位），用于测试与无链接文档。
  pub fn empty() -> Self {
    Self::default()
  }
}

/// 排空行内任务队列，顺序保持不变。
///
/// - `jobs`：`(src, arr)` 列表；`arr` 是目标 arena 下标。
/// - `ctx`：只读快照，所有任务共享。
/// - `lex_one`：单个任务的行内词法入口（由 `lexer.rs` 注入，避免这里反向
///   依赖 `Lexer` 的可变状态）。
///
/// 中文（关于 `Send + Sync`）：rayon 要求每个任务的闭包 `Send + Sync`，
/// 而 `&dyn Fn` 不是。签名里显式加上 `+ Send + Sync` 而不是内部做
/// `unsafe impl` 桥接：调用方注入的闭包必须真的只捕获只读上下文
/// （`links` 快照 + 每个任务自建的 `Lexer`），把它交给 rayon 才是安全的；
/// 用 unsafe 掩盖这个约束等于把数据竞争留给调用方。
///
/// 中文（顺序保持）：`Vec::into_par_iter()` 是 *indexed* parallel iterator，
/// `map` 之后 `collect::<Vec<_>>()` 会按输入下标回填结果，因此输出顺序与
/// 入队顺序逐项相等，调用方仍可按 `arr` 顺序消费结果。用
/// `par_iter().map(...).unzip()` 之类的写法会破坏顺序，禁止替换。
pub fn drain_parallel(
  jobs: Vec<(String, usize)>,
  ctx: &InlineCtxSnapshot,
  lex_one: &(dyn Fn(&str, &InlineCtxSnapshot) -> Vec<Value> + Send + Sync),
) -> Vec<(usize, Vec<Value>)> {
  init_pool();
  let total_bytes: usize = jobs.iter().map(|(s, _)| s.len()).sum();
  if !should_parallel(jobs.len(), total_bytes) {
    // 中文：低于阈值直接串行，避免 rayon 的分发成本成为瓶颈。
    return jobs
      .into_iter()
      .map(|(src, arr)| {
        let tokens = lex_one(&src, ctx);
        (arr, tokens)
      })
      .collect();
  }
  jobs
    .into_par_iter()
    .map(|(src, arr)| {
      let tokens = lex_one(&src, ctx);
      (arr, tokens)
    })
    .collect()
}

/// 懒初始化一个自定义全局 rayon 池，线程数 = `available_parallelism()`，
/// 并夹到 `1..=8`。
///
/// 中文：napi 的 `AsyncTask` 跑在 libuv 线程池上（默认 4 线程），如果
/// rayon 再按 CPU 核数（比如 32 核）开满线程，就会和 libuv 一起超额订阅
/// 同一个机器，导致上下文切换和调度延迟反而上升——对「把解析挪出事件
/// 循环」这个目标来说是负优化。夹到 8 是折中：足够并行，又不会把 libuv
/// 池挤爆。
///
/// 用 `OnceLock` 而非 `Once`：`Once::call_once` 的闭包无法返回值，而这里
/// 需要把池的线程数读出来（测试/bench 需要打印）。
static POOL_THREADS: OnceLock<usize> = OnceLock::new();

/// 幂等：多次调用只有第一次生效。已存在 rayon 全局池时直接返回（不 panic）。
pub fn init_pool() -> usize {
  *POOL_THREADS.get_or_init(|| {
    let detected = std::thread::available_parallelism()
      .map(|n| n.get())
      .unwrap_or(1);
    let threads = detected.clamp(1, 8);
    match rayon::ThreadPoolBuilder::new()
      .num_threads(threads)
      .thread_name(|i| format!("zcode-md-inline-{i}"))
      .build_global()
    {
      Ok(()) => threads,
      // 中文：`build_global` 在已存在池时返回 `Err`（例如单元测试里别的
      // crate 先建过池）。这属于可恢复情形：沿用已存在的池即可。
      Err(_) => rayon::current_num_threads().max(1),
    }
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::lexer;
  use std::time::Instant;

  /// 测试用的单任务词法入口：走真实的 `lexer::lex`（块+行内），只为验证
  /// 「并行结果 == 串行结果」这个不变量，不复刻 `inline_tokens_core`。
  fn lex_one(src: &str, _ctx: &InlineCtxSnapshot) -> Vec<Value> {
    lexer::lex(src)
  }

  fn serial_reference(
    jobs: Vec<(String, usize)>,
    ctx: &InlineCtxSnapshot,
    lex_one: &(dyn Fn(&str, &InlineCtxSnapshot) -> Vec<Value> + Send + Sync),
  ) -> Vec<(usize, Vec<Value>)> {
    jobs
      .into_iter()
      .map(|(src, arr)| (arr, lex_one(&src, ctx)))
      .collect()
  }

  /// 四类 fixture：heading 文本、list item、table cell、blockquote 内部文本。
  fn fixtures() -> Vec<(usize, String)> {
    vec![
      (
        0,
        "# Heading with *em* and **strong** plus `code`\n".to_string(),
      ),
      (
        3,
        "- item one with [a link](https://example.com) and _em_\n".to_string(),
      ),
      (
        7,
        "| col a | col b |\n| --- | --- |\n| **x** | `y` |\n".to_string(),
      ),
      (
        11,
        "> quoted *inner* text with ~~strike~~\n".to_string(),
      ),
      (
        19,
        "plain paragraph number five, no markup at all here.\n".to_string(),
      ),
    ]
  }

  #[test]
  fn parallel_matches_serial_and_preserves_order() {
    let ctx = InlineCtxSnapshot::empty();
    // 中文：放大到阈值以上才会真的走 rayon 分支，否则测的是串行腿。
    let mut jobs: Vec<(String, usize)> = fixtures()
      .into_iter()
      .cycle()
      .take(PARALLEL_MIN_JOBS + 4)
      .enumerate()
      .map(|(_, (arr, src))| (src, arr))
      .collect();
    jobs[0] = (fixtures()[0].1.clone(), fixtures()[0].0);
    // 保证入队下标与 arr 都严格递增，从而可以逐项对比。
    for (i, j) in jobs.iter_mut().enumerate() {
      j.0 = j.0.trim_end().to_string();
      j.1 = i * 2;
    }

    let expected = serial_reference(jobs.clone(), &ctx, &lex_one);
    let actual = drain_parallel(jobs, &ctx, &lex_one);
    assert_eq!(expected.len(), actual.len());
    for (i, (e, a)) in expected.iter().zip(actual.iter()).enumerate() {
      assert_eq!(e.0, a.0, "arr order broken at {i}");
      assert_eq!(e.1, a.1, "token mismatch at {i}");
    }
  }

  #[test]
  fn serial_below_threshold_matches_parallel_above() {
    let ctx = InlineCtxSnapshot::empty();
    let jobs: Vec<(String, usize)> = fixtures().into_iter().enumerate().map(|(i, (_, s))| (s, i)).collect();
    let ser = drain_parallel(jobs.clone(), &ctx, &lex_one);
    let refv = serial_reference(jobs, &ctx, &lex_one);
    assert_eq!(ser, refv, "serial path must equal the reference too");
    assert!(!should_parallel(refv.len(), 4096), "fixtures are below job threshold");
  }

  #[test]
  fn empty_job_list_is_ok() {
    let ctx = InlineCtxSnapshot::empty();
    assert!(drain_parallel(vec![], &ctx, &lex_one).is_empty());
  }

  #[test]
  fn threshold_unit() {
    assert!(!should_parallel(0, 1 << 20));
    assert!(!should_parallel(PARALLEL_MIN_JOBS - 1, 1 << 20));
    assert!(should_parallel(PARALLEL_MIN_JOBS, PARALLEL_MIN_BYTES));
    assert!(!should_parallel(PARALLEL_MIN_JOBS, PARALLEL_MIN_BYTES - 1));
    assert!(should_parallel(64, 64 * 1024));
    // 中文：4 个 1KB 任务必须串行——这是 bench 里要证明的反例。
    assert!(!should_parallel(4, 4 * 1024));
  }

  #[test]
  fn init_pool_is_idempotent_and_clamped() {
    let a = init_pool();
    let b = init_pool();
    assert_eq!(a, b, "init_pool must be idempotent");
    assert!((1..=8).contains(&a), "threads clamped to 1..=8, got {a}");
  }

  /// `#[ignore]` 的 bench：64x1KB 应显著快于串行，4x1KB 则说明阈值有意义。
  #[test]
  #[ignore]
  fn bench_par_drain() {
    let threads = init_pool();
    let mk = |n: usize, bytes: usize| -> Vec<(String, usize)> {
      (0..n)
        .map(|i| {
          let body = "text with `code` and *em* and [a](b) here. ".repeat(bytes / 36);
          (format!("# h{i}\n\n{body}\n"), i)
        })
        .collect()
    };
    for (jobs_n, bytes) in [(64usize, 1024usize), (4, 1024)] {
      let jobs = mk(jobs_n, bytes);
      let total: usize = jobs.iter().map(|(s, _)| s.len()).sum();
      let par = should_parallel(jobs.len(), total);
      let ctx = InlineCtxSnapshot::empty();

      let t = Instant::now();
      let a = serial_reference(jobs.clone(), &ctx, &lex_one);
      let serial = t.elapsed();

      let t = Instant::now();
      let b = drain_parallel(jobs, &ctx, &lex_one);
      let taken = t.elapsed();
      assert_eq!(a, b, "bench must not change results");

      println!(
        "BENCH par-drain: jobs={jobs_n} bytes={total} threads={threads} rayon={par} serial={serial:?} par={taken:?} speedup={:.2}x",
        serial.as_secs_f64() / taken.as_secs_f64().max(1e-9)
      );
    }
  }
}
