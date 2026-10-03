//! Golden parity for the git runtime-context safety check.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3).
//!
//! The golden records the VERDICT for fixtures built from a layout, not the temp path, so the
//! test rebuilds the same trees and compares the decisions.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use zcode_subagent_profile::gitruntimesafety::{
    analysis_contains_git_and_directory_change, analysis_contains_git_command,
    is_git_runtime_context_unsafe, normalized_simple_command_name,
};

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/git-runtime-safety-golden.json");
    path
}

fn fixture(root: &Path) -> Option<(PathBuf, bool)> {
    let dir = |name: &str| {
        let path = root.join(name);
        fs::create_dir_all(&path).unwrap();
        path
    };
    let work_tree = |name: &str| -> PathBuf {
        let workspace = dir(name);
        let git = workspace.join(".git");
        fs::create_dir_all(git.join("objects")).unwrap();
        fs::create_dir_all(git.join("refs")).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        workspace
    };

    let trusted = work_tree("trusted");
    fs::create_dir_all(trusted.join("src/deep")).unwrap();

    dir("plain");

    let outside = dir("outside-repo");
    let outside_git = outside.join(".git");
    fs::create_dir_all(outside_git.join("objects")).unwrap();
    fs::create_dir_all(outside_git.join("refs")).unwrap();
    fs::write(outside_git.join("HEAD"), "ref: refs/heads/main\n").unwrap();

    let escaped = dir("escaped");
    fs::write(escaped.join(".git"), format!("gitdir: {}\n", outside.display())).unwrap();

    let symlinked = dir("symlinked");
    let symlink_ok = create_dir_symlink(&outside, &symlinked.join(".git"));

    let bare = dir("bare");
    fs::write(bare.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    fs::create_dir_all(bare.join("objects")).unwrap();
    fs::create_dir_all(bare.join("refs")).unwrap();

    let incomplete = dir("incomplete");
    fs::create_dir_all(incomplete.join(".git")).unwrap();
    fs::write(incomplete.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();

    let _ = (escaped, symlinked, bare, incomplete, outside, trusted);
    Some((root.to_path_buf(), symlink_ok))
}

/// 中文：修复 Windows 编译失败（E0433）＋ 无权限时的用例处理。原实现无条件
/// `std::os::unix::fs::symlink`，Windows 上根本编译不过；而 Windows 创建目录符号链接
/// 需要管理员/开发者模式（本机实测 EPERM），所以这里按平台拆开：unix 上目录 symlink
/// 必然可用（失败就是真回归，直接 unwrap），Windows 上用 `symlink_dir` 尝试、权限不足
/// 时返回 false，由测试跳过 `symlinked_git_dir` 这一个 golden 用例并打印原因。
/// 跳过的是测试环境的权限能力，不是产品行为分支——运行时的 symlink 判断无条件保留；
/// 判定规则见 spec（subagent-rust-port.md §3.2i "Fixture rule"）。
fn create_dir_symlink(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).unwrap();
        true
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link).is_ok()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        false
    }
}

#[test]
fn git_runtime_context_safety_matches_typescript() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> = serde_json::from_str(&raw).expect("valid JSON");

    let root = std::env::temp_dir().join(format!("git-runtime-safety-rust-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (_root, symlink_ok) = fixture(&root).expect("fixtures");

    // (golden case name, fixture sub-path inside `root`); `None` means "no working directory".
    let cases: [(&str, Option<&str>); 9] = [
        ("normal_work_tree", Some("trusted")),
        ("nested_in_work_tree", Some("trusted/src/deep")),
        ("no_git_at_all", Some("plain")),
        ("gitdir_points_outside", Some("escaped")),
        ("symlinked_git_dir", Some("symlinked")),
        ("bare_repo_layout", Some("bare")),
        ("incomplete_git_dir", Some("incomplete")),
        ("no_working_directory", None),
        ("missing_directory", Some("does-not-exist")),
    ];
    let mut failures = Vec::new();
    for (name, relative) in cases {
        if name == "symlinked_git_dir" && !symlink_ok {
            // 中文：本机没有创建目录符号链接的权限，仅跳过这一个用例，其余 8 个照常比对。
            eprintln!("skip [{name}]: directory symlink unavailable on this host (EPERM)");
            continue;
        }
        let entry = corpus.get(name).unwrap_or_else(|| panic!("missing case {name}"));
        let expected = entry["unsafe"].as_bool().expect("verdict");
        let cwd = relative.map(|relative| root.join(relative).to_string_lossy().into_owned());
        let actual = is_git_runtime_context_unsafe(cwd.as_deref());
        if actual != expected {
            failures.push(format!("[{name}] rust={actual} ts={expected}"));
        }
    }
    let _ = std::fs::remove_dir_all(&root);
    assert!(failures.is_empty(), "git runtime safety diverged:\n{}", failures.join("\n"));
}

#[test]
fn predicates_match_the_golden() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> = serde_json::from_str(&raw).expect("valid JSON");
    let predicates = &corpus["predicates"];

    let names = |argv: &[&str]| -> Vec<String> { argv.iter().map(|s| s.to_string()).collect() };
    let simple = |argv: &[&str]| -> Option<String> { normalized_simple_command_name(&names(argv)) };

    assert_eq!(
        analysis_contains_git_command(&[simple(&["git", "status"])]),
        predicates["git_present"].as_bool().unwrap()
    );
    assert_eq!(
        analysis_contains_git_command(&[simple(&["command", "git", "status"])]),
        predicates["git_wrapped"].as_bool().unwrap()
    );
    assert_eq!(
        analysis_contains_git_command(&[simple(&["ls"])]),
        predicates["no_git"].as_bool().unwrap()
    );

    let parts = |v: &[&str]| -> Vec<Option<String>> { v.iter().map(|s| Some((*s).to_string())).collect() };
    assert_eq!(
        analysis_contains_git_and_directory_change(&parts(&["git", "cd"])),
        predicates["git_and_cd"].as_bool().unwrap()
    );
    assert_eq!(
        analysis_contains_git_and_directory_change(&parts(&["git", "pushd"])),
        predicates["git_and_pushd"].as_bool().unwrap()
    );
    assert_eq!(
        analysis_contains_git_and_directory_change(&parts(&["git", "popd"])),
        predicates["git_and_popd"].as_bool().unwrap()
    );
    assert_eq!(
        analysis_contains_git_and_directory_change(&parts(&["cd"])),
        predicates["cd_without_git"].as_bool().unwrap()
    );
    assert_eq!(
        analysis_contains_git_and_directory_change(&parts(&["git"])),
        predicates["git_without_directory_change"].as_bool().unwrap()
    );
}
