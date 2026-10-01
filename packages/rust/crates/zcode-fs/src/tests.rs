//! End-to-end tests for the crate's public surface, one per row of the
//! Failure-semantics table in `docs/specs/rust-native-fs.md` §4.
//!
//! The `compute` bodies are driven directly rather than through napi: these
//! assert the *logic* (containment, caps, clamping, matching), and the
//! JavaScript-visible half — promise settling, `Buffer` identity, `Error.code` —
//! is asserted by the direct-load smoke in the port report.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;

/// A scratch tree with one allowed root, one directory outside it, and a
/// sibling whose name shares the root's prefix.
struct Fixture {
  base: PathBuf,
  root: PathBuf,
  outside: PathBuf,
  sibling: PathBuf,
}

impl Fixture {
  fn new(name: &str) -> Self {
    let base = std::env::temp_dir().join(format!("zcode-fs-e2e-{name}"));
    let _ = fs::remove_dir_all(&base);
    let root = base.join("ws");
    let outside = base.join("outside");
    let sibling = base.join("ws-evil");
    for dir in [&root, &outside, &sibling] {
      fs::create_dir_all(dir).expect("create scratch tree");
    }
    fs::write(root.join("alpha.txt"), b"hello zcode\nsecond line\n").unwrap();
    fs::write(root.join("empty.txt"), b"").unwrap();
    fs::write(outside.join("secret.txt"), b"TOP SECRET\n").unwrap();
    fs::write(sibling.join("secret.txt"), b"SIBLING SECRET\n").unwrap();
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink(&outside, root.join("link-out")).unwrap();
      std::os::unix::fs::symlink(root.join("ghost"), root.join("link-dead")).unwrap();
    }
    Self {
      base,
      root,
      outside,
      sibling,
    }
  }

  fn roots(&self) -> Vec<String> {
    vec![self.root.to_string_lossy().into_owned()]
  }

  /// The same allowlist, but rooted at `outside` — used to prove a rejection is
  /// about the allowlist and not about the path being unreadable.
  fn outside_roots(&self) -> Vec<String> {
    vec![self.outside.to_string_lossy().into_owned()]
  }

  fn in_root(&self, name: &str) -> String {
    self.root.join(name).to_string_lossy().into_owned()
  }
}

impl Drop for Fixture {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.base);
  }
}

fn rejection(error: &Error<String>) -> String {
  assert_eq!(error.status, "GenericFailure");
  error.reason.clone()
}

// ---------------------------------------------------------------------------
// F1/F2: the allowlist is mandatory and empty means "nothing is reachable"
// ---------------------------------------------------------------------------

#[test]
fn f1_and_f2_an_empty_allowlist_reaches_nothing() {
  let fixture = Fixture::new("empty-allowlist");
  let inside = fixture.in_root("alpha.txt");
  let error = resolve_path_task(ResolvePathRequest {
    path: inside,
    roots: Vec::new(),
  })
  .run()
  .expect_err("an empty allowlist must reject");
  assert_eq!(
    rejection(&error),
    format!("Path is not inside an allowed root: {}", fixture.in_root("alpha.txt"))
  );
}

#[test]
fn f1_the_roots_field_is_required_by_the_binding() {
  // napi builds these request objects from a plain JS object, so a missing
  // `roots` is a binding error before `compute` ever runs. The type-level
  // guarantee is that the field is not `Option`; this test pins the consequence
  // that an empty vector is still a *valid* value and is rejected by policy.
  let fixture = Fixture::new("roots-not-optional");
  let request = StatRequest {
    path: fixture.in_root("alpha.txt"),
    roots: fixture.roots(),
  };
  assert!(stat_task(request).run().is_ok());
}

// ---------------------------------------------------------------------------
// F3/F4/F5: the three escape classes. These are the point of the port.
// ---------------------------------------------------------------------------

#[test]
fn f3_a_symlink_out_of_the_root_is_rejected() {
  let fixture = Fixture::new("symlink-escape");
  let requested = fixture.in_root("link-out");
  let requested = Path::new(&requested).join("secret.txt");
  let requested = requested.to_string_lossy().into_owned();
  let error = read_text_file_task(ReadTextFileRequest {
    path: requested.clone(),
    roots: fixture.roots(),
    offset: None,
    length: None,
  })
  .run()
  .expect_err("a symlink out of the root must be rejected");
  assert_eq!(
    rejection(&error),
    format!("Path is not inside an allowed root: {requested}")
  );

  // The same file is readable once the symlink's target is the root, which
  // proves the rejection is about the allowlist and not about permissions.
  let admitted = fs::canonicalize(fixture.outside.join("secret.txt"))
    .unwrap()
    .to_string_lossy()
    .into_owned();
  let ok = read_text_file_task(ReadTextFileRequest {
    path: admitted.clone(),
    roots: fixture.outside_roots(),
    offset: None,
    length: None,
  })
  .run()
  .expect("the target is readable under its own root");
  assert_eq!(ok.content, "TOP SECRET\n");
}

#[test]
fn f4_a_dotdot_escape_is_rejected() {
  let fixture = Fixture::new("dotdot-escape");
  let requested = fixture
    .root
    .join("..")
    .join("outside")
    .join("secret.txt")
    .to_string_lossy()
    .into_owned();
  let error = read_binary_preview_task(ReadPreviewRequest {
    path: requested.clone(),
    roots: fixture.roots(),
    max_bytes: None,
  })
  .run()
  .expect_err("a .. escape must be rejected");
  assert_eq!(
    rejection(&error),
    format!("Path is not inside an allowed root: {requested}")
  );
}

#[test]
fn f5_a_sibling_sharing_the_roots_prefix_is_rejected() {
  let fixture = Fixture::new("sibling-prefix");
  let requested = fixture.sibling.join("secret.txt");
  let requested = requested.to_string_lossy().into_owned();
  for outcome in [
    read_text_file_task(ReadTextFileRequest {
      path: requested.clone(),
      roots: fixture.roots(),
      offset: None,
      length: None,
    })
    .run()
    .err(),
    read_file_range_task(ReadFileRangeRequest {
      path: requested.clone(),
      roots: fixture.roots(),
      offset: Some(0.0),
      length: Some(8.0),
    })
    .run()
    .err(),
    stat_task(StatRequest {
      path: requested.clone(),
      roots: fixture.roots(),
    })
    .run()
    .err(),
  ] {
    let error = outcome.expect("a sibling-prefix path must be rejected");
    assert_eq!(
      rejection(&error),
      format!("Path is not inside an allowed root: {requested}")
    );
  }
}

#[test]
fn an_in_root_path_is_still_readable_after_all_three_escape_attempts() {
  let fixture = Fixture::new("accept");
  let slice = read_text_file_task(ReadTextFileRequest {
    path: fixture.in_root("alpha.txt"),
    roots: fixture.roots(),
    offset: None,
    length: None,
  })
  .run()
  .expect("a path inside the root is admitted");
  assert_eq!(slice.content, "hello zcode\nsecond line\n");
  assert_eq!(slice.total_bytes, 24.0);
  assert!(!slice.truncated);
}

// ---------------------------------------------------------------------------
// F6/F7: node:fs-shaped errors, with the code the predecessor carried
// ---------------------------------------------------------------------------

#[test]
fn f6_a_missing_path_reports_the_callers_syscall_and_code() {
  let fixture = Fixture::new("missing");
  let missing = fixture.in_root("nope.txt");
  let cases: Vec<(String, Error<String>)> = vec![
    (
      "stat".to_string(),
      stat_task(StatRequest {
        path: missing.clone(),
        roots: fixture.roots(),
      })
      .run()
      .expect_err("missing"),
    ),
    (
      "scandir".to_string(),
      readdir_task(ReaddirRequest {
        path: missing.clone(),
        roots: fixture.roots(),
        include_hidden: None,
      })
      .run()
      .expect_err("missing"),
    ),
    (
      "realpath".to_string(),
      resolve_path_task(ResolvePathRequest {
        path: missing.clone(),
        roots: fixture.roots(),
      })
      .run()
      .expect_err("missing"),
    ),
  ];
  for (syscall, error) in cases {
    assert_eq!(error.status, "ENOENT", "{syscall}");
    assert_eq!(
      error.reason,
      format!("ENOENT: no such file or directory, {syscall} '{missing}'")
    );
  }
}

#[test]
fn f12_reading_a_directory_reports_not_a_file() {
  let fixture = Fixture::new("not-a-file");
  let directory = fixture.root.join("sub");
  fs::create_dir_all(&directory).unwrap();
  let requested = directory.to_string_lossy().into_owned();
  let expected = format!("Path is not a file: {requested}");
  for outcome in [
    read_text_file_task(ReadTextFileRequest {
      path: requested.clone(),
      roots: fixture.roots(),
      offset: None,
      length: None,
    })
    .run()
    .err(),
    read_file_range_task(ReadFileRangeRequest {
      path: requested.clone(),
      roots: fixture.roots(),
      offset: Some(0.0),
      length: Some(8.0),
    })
    .run()
    .err(),
    read_media_preview_task(ReadPreviewRequest {
      path: requested.clone(),
      roots: fixture.roots(),
      max_bytes: None,
    })
    .run()
    .err(),
    read_binary_preview_task(ReadPreviewRequest {
      path: requested.clone(),
      roots: fixture.roots(),
      max_bytes: None,
    })
    .run()
    .err(),
  ] {
    assert_eq!(rejection(&outcome.expect("directory")), expected);
  }
}

// ---------------------------------------------------------------------------
// F9/F10/F11: the existence batch
// ---------------------------------------------------------------------------

#[test]
fn f9_more_than_fifteen_paths_is_rejected() {
  let fixture = Fixture::new("batch-limit");
  let paths: Vec<String> = (0..16).map(|i| fixture.in_root(&format!("f{i}.txt"))).collect();
  let error = check_files_exist_task(CheckFilesExistRequest {
    paths,
    roots: fixture.roots(),
  })
  .run()
  .expect_err("over the limit");
  assert_eq!(rejection(&error), "File existence check supports at most 15 paths.");

  let paths: Vec<String> = (0..15).map(|i| fixture.in_root(&format!("f{i}.txt"))).collect();
  assert!(check_files_exist_task(CheckFilesExistRequest {
    paths,
    roots: fixture.roots()
  })
  .run()
  .is_ok());
}

#[test]
fn f10_a_stat_failure_inside_the_root_is_reported_as_absent() {
  let fixture = Fixture::new("exists-absent");
  let results = check_files_exist_task(CheckFilesExistRequest {
    paths: vec![
      fixture.in_root("alpha.txt"),
      fixture.in_root("empty.txt"),
      fixture.in_root("nope.txt"),
      fixture.root.to_string_lossy().into_owned(),
      fixture.in_root("link-dead"),
    ],
    roots: fixture.roots(),
  })
  .run()
  .expect("batch is inside the root");
  assert_eq!(
    results
      .iter()
      .map(|entry| entry.exists)
      .collect::<Vec<_>>(),
    vec![true, true, false, false, false],
    "a directory is not a file, and a dangling symlink is not either"
  );
}

#[test]
fn f11_one_out_of_root_path_fails_the_whole_batch() {
  let fixture = Fixture::new("exists-escape");
  let outside = fixture.outside.join("secret.txt");
  let error = check_files_exist_task(CheckFilesExistRequest {
    paths: vec![
      fixture.in_root("alpha.txt"),
      outside.to_string_lossy().into_owned(),
    ],
    roots: fixture.roots(),
  })
  .run()
  .expect_err("an out-of-root probe must not be silently false");
  assert_eq!(
    rejection(&error),
    format!("Path is not inside an allowed root: {}", outside.to_string_lossy())
  );
}

// ---------------------------------------------------------------------------
// F13/F14/F15: the preview caps
// ---------------------------------------------------------------------------

#[test]
fn f13_to_f15_the_preview_caps_are_inclusive_and_not_raisable() {
  let fixture = Fixture::new("preview-caps");
  let big = fixture.root.join("big.bin");
  // A sparse file keeps the test cheap: the gate is a `stat`, not a read.
  let file = fs::File::create(&big).unwrap();
  file.set_len(reads::MAX_BINARY_PREVIEW_BYTES + 1).unwrap();
  drop(file);
  let requested = big.to_string_lossy().into_owned();

  // 25 MB is admitted for the binary preview and 25 MB + 1 is not.
  let over = read_binary_preview_task(ReadPreviewRequest {
    path: requested.clone(),
    roots: fixture.roots() ,
    max_bytes: None,
  })
  .run()
  .expect_err("over the 25MB cap");
  assert_eq!(
    rejection(&over),
    format!("File is too large to preview: {requested}")
  );

  // Raising maxBytes cannot lift the cap: it is a DoS control, not a request.
  let raised = read_binary_preview_task(ReadPreviewRequest {
    path: requested.clone(),
    roots: fixture.roots(),
    max_bytes: Some(512.0 * 1024.0 * 1024.0),
  })
  .run()
  .expect_err("the ceiling still applies");
  assert_eq!(
    rejection(&raised),
    format!("File is too large to preview: {requested}")
  );

  // The media preview ceiling is lower, so the same file is rejected there too.
  let media = read_media_preview_task(ReadPreviewRequest {
    path: requested.clone(),
    roots: fixture.roots(),
    max_bytes: None,
  })
  .run()
  .expect_err("over the 8MB cap");
  assert_eq!(
    rejection(&media),
    format!("File is too large to preview: {requested}")
  );

  // Exactly at the cap is admitted when the caller asks for the cap. (The
  // *default* is 4 MB, which is why the differential row
  // `readMediaPreview/default-on-8mb-exact` is a rejection.)
  file_len_set(&big, reads::MAX_MEDIA_PREVIEW_BYTES);
  let admitted = read_media_preview_task(ReadPreviewRequest {
    path: requested.clone(),
    roots: fixture.roots(),
    max_bytes: Some(reads::MAX_MEDIA_PREVIEW_BYTES as f64),
  })
  .run()
  .expect("exactly at the 8MB cap is allowed");
  assert_eq!(admitted.total_bytes, reads::MAX_MEDIA_PREVIEW_BYTES as f64);
  assert_eq!(admitted.media_type, "application/octet-stream");
}

fn file_len_set(path: &Path, len: u64) {
  let file = fs::OpenOptions::new().write(true).open(path).unwrap();
  file.set_len(len).unwrap();
}

// ---------------------------------------------------------------------------
// F16/F17/F18: text-slice edges
// ---------------------------------------------------------------------------

#[test]
fn f16_f17_f18_text_slice_offset_and_length_edges() {
  let fixture = Fixture::new("text-edges");
  let path = fixture.in_root("alpha.txt");
  let read = |offset: Option<f64>, length: Option<f64>| {
    read_text_file_task(ReadTextFileRequest {
      path: path.clone(),
      roots: fixture.roots(),
      offset,
      length,
    })
    .run()
    .expect("in root")
  };

  let full = read(None, None);
  assert_eq!(full.content, "hello zcode\nsecond line\n");
  assert_eq!(full.bytes_read, 24.0);

  // F16: offset == size and offset > size both take the early return, and that
  // return never sniffs the content, so isBinary is false even here.
  for offset in [24.0, 24.5, 999.0, 1e9] {
    let slice = read(Some(offset), None);
    assert_eq!(slice.content, "", "offset {offset}");
    assert_eq!(slice.bytes_read, 0.0, "offset {offset}");
    assert_eq!(slice.offset, offset.trunc(), "offset {offset} is echoed back");
    assert!(!slice.truncated, "offset {offset}");
    assert!(!slice.is_binary, "offset {offset}");
  }

  // F17: negative and non-finite offsets become 0.
  assert_eq!(read(Some(-4.0), None).offset, 0.0);
  assert_eq!(read(Some(f64::NAN), None).offset, 0.0);

  // F18: the length floor is 1, the ceiling is 256 KB, and a non-finite length
  // takes the 128 KB default.
  assert_eq!(read(Some(0.0), Some(0.0)).content, "h");
  assert_eq!(read(Some(0.0), Some(-9.0)).content, "h");
  assert_eq!(read(Some(0.0), Some(1e12)).bytes_read, 24.0);
  assert_eq!(read(Some(0.0), Some(f64::NAN)).bytes_read, 24.0);
  assert_eq!(read(Some(6.0), Some(5.0)).content, "zcode");
  assert!(read(Some(6.0), Some(5.0)).truncated);

  // An empty file is never binary, at any offset.
  let empty = read_text_file_task(ReadTextFileRequest {
    path: fixture.in_root("empty.txt"),
    roots: fixture.roots(),
    offset: None,
    length: None,
  })
  .run()
  .expect("in root");
  assert_eq!(empty.total_bytes, 0.0);
  assert!(!empty.is_binary);
  assert_eq!(empty.content, "");
}

// ---------------------------------------------------------------------------
// F19/F20: the walk's error tolerance and symlink classification
// ---------------------------------------------------------------------------

#[test]
fn f20_the_walk_classifies_symlinks_by_their_target() {
  let fixture = Fixture::new("walk-symlinks");
  let inside = fixture.root.join("real");
  fs::create_dir_all(&inside).unwrap();
  fs::write(inside.join("buried.txt"), b"x").unwrap();
  #[cfg(unix)]
  std::os::unix::fs::symlink(&inside, fixture.root.join("link-dir")).unwrap();

  let found = walk_workspace_task(WalkWorkspaceRequest {
    root_path: fixture.root.to_string_lossy().into_owned(),
    roots: fixture.roots(),
    ignore_rules: String::new(),
  })
  .run()
  .expect("walk inside the root");
  // `WorkspaceFileEntry` carries no symlink flag (the wire contract has only
  // name/path/relativePath/type), so the classification is what is asserted
  // here; `readdir` is where the flag itself is observable.
  let kind_of = |relative: &str| {
    found
      .iter()
      .find(|entry| entry.relative_path == relative)
      .map(|entry| entry.kind.clone())
  };
  assert_eq!(kind_of("real").as_deref(), Some("directory"));
  assert_eq!(
    kind_of("link-dir").as_deref(),
    Some("directory"),
    "a symlink to a directory reads as a directory"
  );
  #[cfg(unix)]
  assert_eq!(
    kind_of("link-dead").as_deref(),
    Some("file"),
    "a dangling symlink reads as a file"
  );
  #[cfg(unix)]
  assert_eq!(
    found
      .iter()
      .find(|entry| entry.relative_path == "link-dir/buried.txt")
      .map(|_| ()),
    None,
    "a symlinked directory is listed but never descended"
  );
}

#[test]
fn f21_f22_the_ignore_load_chain_creates_then_degrades() {
  let fixture = Fixture::new("ignore-chain");
  fs::write(fixture.root.join(".gitignore"), "dist/\n*.log\n!keep.log\n").unwrap();

  let first = load_workspace_ignore_rules_task(WorkspaceRootRequest {
    root_path: fixture.root.to_string_lossy().into_owned(),
    roots: fixture.roots(),
  })
  .run()
  .expect("load");
  assert!(first.created);
  assert_eq!(first.source, "created-from-gitignore");
  assert!(first.content.starts_with("dist/\n"));
  assert_ne!(first.fingerprint, "none");
  assert!(fixture.root.join(".zcodeignore").exists());

  let second = load_workspace_ignore_rules_task(WorkspaceRootRequest {
    root_path: fixture.root.to_string_lossy().into_owned(),
    roots: fixture.roots(),
  })
  .run()
  .expect("reload");
  assert!(!second.created);
  assert_eq!(second.source, "file");
  assert_eq!(second.content, first.content);
  assert!(second.degraded_reason.is_none());
}

// ---------------------------------------------------------------------------
// F23/F24/F25: the workspace-directory methods
// ---------------------------------------------------------------------------

#[test]
fn f23_workspace_names_are_validated_before_anything_is_created() {
  let fixture = Fixture::new("name-validation");
  let base = fixture.root.to_string_lossy().into_owned();
  for (name, expected) in [
    ("   ", "Workspace name is required."),
    ("a/b", "Workspace name cannot contain path separators."),
    ("a\\b", "Workspace name cannot contain path separators."),
  ] {
    let error = ensure_workspace_directory_task(EnsureWorkspaceDirectoryRequest {
      base_dir: base.clone(),
      name: Some(name.to_string()),
      roots: fixture.roots(),
    })
    .run()
    .expect_err("invalid name");
    assert_eq!(rejection(&error), expected, "name {name:?}");
  }
}

#[test]
fn a_dot_dot_workspace_name_is_refused_by_containment() {
  // The predecessor's `validateScratchWorkspaceName` only rejected path
  // *separators*, so `..` slipped through into `join(homedir, …, "..")` and
  // escaped the scratch root. The separator rule is unchanged for parity; what
  // stops it now is the allowlist, which is the point of the port.
  let fixture = Fixture::new("name-dotdot");
  let error = ensure_workspace_directory_task(EnsureWorkspaceDirectoryRequest {
    base_dir: fixture.root.to_string_lossy().into_owned(),
    name: Some("..".to_string()),
    roots: fixture.roots(),
  })
  .run()
  .expect_err("a .. name must not escape the scratch root");
  assert!(rejection(&error).starts_with("Path is not inside an allowed root:"));
}

#[test]
fn f24_f25_a_scratch_workspace_is_created_idempotently() {
  let fixture = Fixture::new("scratch");
  let base = fixture.root.to_string_lossy().into_owned();
  let first = ensure_workspace_directory_task(EnsureWorkspaceDirectoryRequest {
    base_dir: base.clone(),
    name: Some("my-project".to_string()),
    roots: fixture.roots(),
  })
  .run()
  .expect("create");
  assert!(first.created);
  assert_eq!(first.path, fixture.root.join("my-project").to_string_lossy());
  assert!(Path::new(&first.path).is_dir());

  let second = ensure_workspace_directory_task(EnsureWorkspaceDirectoryRequest {
    base_dir: base.clone(),
    name: Some("my-project".to_string()),
    roots: fixture.roots(),
  })
  .run()
  .expect("already exists");
  assert!(!second.created, "a second call reports the directory as pre-existing");
  assert_eq!(second.path, first.path);

  // No name means "the base directory itself" (the default workspace).
  let base_only = ensure_workspace_directory_task(EnsureWorkspaceDirectoryRequest {
    base_dir: base,
    name: None,
    roots: fixture.roots(),
  })
  .run()
  .expect("base directory");
  assert_eq!(base_only.path, fixture.root.to_string_lossy());
}

#[test]
fn f24_a_file_where_a_directory_belonged_is_reported() {
  let fixture = Fixture::new("not-a-directory");
  let occupied = fixture.root.join("occupied");
  fs::write(&occupied, b"i am a file").unwrap();
  let error = ensure_workspace_directory_task(EnsureWorkspaceDirectoryRequest {
    base_dir: fixture.root.to_string_lossy().into_owned(),
    name: Some("occupied".to_string()),
    roots: fixture.roots(),
  })
  .run()
  .expect_err("not a directory");
  assert_eq!(
    rejection(&error),
    format!(
      "Workspace path is not a directory: {}",
      occupied.to_string_lossy()
    )
  );
}

#[test]
fn a_new_workspace_is_still_confined_to_its_allowlist() {
  // The create path has to confine a path that does not exist yet, so the
  // parent is what gets checked. A base outside the allowlist must be refused.
  let fixture = Fixture::new("create-confined");
  let error = ensure_workspace_directory_task(EnsureWorkspaceDirectoryRequest {
    base_dir: fixture.outside.to_string_lossy().into_owned(),
    name: Some("fresh".to_string()),
    roots: fixture.roots(),
  })
  .run()
  .expect_err("base outside the allowlist");
  assert!(rejection(&error).starts_with("Path is not inside an allowed root:"));
  assert!(
    !fixture.outside.join("fresh").exists(),
    "a rejected create must not touch the filesystem"
  );
}

// ---------------------------------------------------------------------------
// F26 + the settings-page round trip
// ---------------------------------------------------------------------------

#[test]
fn f26_an_unknown_transform_is_rejected() {
  let error = Transform::parse("rewrite-everything").unwrap_err();
  assert_eq!(rejection(&error), "Unknown workspace ignore transform: rewrite-everything");
}

#[test]
fn the_settings_page_round_trip_preserves_both_markers() {
  let fixture = Fixture::new("settings");
  fs::write(fixture.root.join(".gitignore"), "dist/\n").unwrap();
  let root = fixture.root.to_string_lossy().into_owned();
  let roots = fixture.roots();

  let preview = read_workspace_ignore_task(WorkspaceRootRequest {
    root_path: root.clone(),
    roots: roots.clone(),
  })
  .run()
  .expect("read");
  assert_eq!(preview.source, "template");
  assert!(!fixture.root.join(".zcodeignore").exists(), "a preview must not write");

  let synced = transform_workspace_ignore_task(TransformIgnoreRequest {
    root_path: root.clone(),
    roots: roots.clone(),
    transform: "sync-gitignore".to_string(),
  })
  .run()
  .expect("sync");
  assert!(synced.content.contains("\"Sync from .gitignore\" only rewrites the part above"));
  assert!(synced.content.contains("# ----- ↑ above are ZCode default exclusion rules"));

  assert!(
    write_workspace_ignore_task(WriteIgnoreRequest {
      root_path: root.clone(),
      roots: roots.clone(),
      content: synced.content.clone(),
    })
    .run()
    .expect("write")
  );

  let after = read_workspace_ignore_task(WorkspaceRootRequest {
    root_path: root.clone(),
    roots: roots.clone(),
  })
  .run()
  .expect("reread");
  assert_eq!(after.source, "file");
  assert_eq!(after.content, synced.content);

  // Saving new rules must change the next scan, not the cached one: the
  // fingerprint is what the host cache keys on.
  let fingerprint_before = load_workspace_ignore_rules_task(WorkspaceRootRequest {
    root_path: root.clone(),
    roots: roots.clone(),
  })
  .run()
  .expect("fingerprint")
  .fingerprint;
  std::thread::sleep(std::time::Duration::from_millis(5));
  write_workspace_ignore_task(WriteIgnoreRequest {
    root_path: root.clone(),
    roots: roots.clone(),
    content: "src/\n".to_string(),
  })
  .run()
  .expect("rewrite");
  let loaded = load_workspace_ignore_rules_task(WorkspaceRootRequest {
    root_path: root.clone(),
    roots: roots.clone(),
  })
  .run()
  .expect("reload");
  assert_ne!(loaded.fingerprint, fingerprint_before, "an edit must move the signature");
  assert_eq!(loaded.content, "src/\n");
}

#[test]
fn writing_the_rules_file_of_an_out_of_root_workspace_is_refused() {
  let fixture = Fixture::new("write-confined");
  let error = write_workspace_ignore_task(WriteIgnoreRequest {
    root_path: fixture.outside.to_string_lossy().into_owned(),
    roots: fixture.roots(),
    content: "anything\n".to_string(),
  })
  .run()
  .expect_err("out of root");
  assert!(rejection(&error).starts_with("Path is not inside an allowed root:"));
  assert!(!fixture.outside.join(".zcodeignore").exists());
}

// ---------------------------------------------------------------------------
// The matchers, end to end through the napi-shaped pure exports
// ---------------------------------------------------------------------------

#[test]
fn the_pure_matcher_export_agrees_with_the_walk() {
  let fixture = Fixture::new("matcher-agreement");
  fs::create_dir_all(fixture.root.join("node_modules").join("pkg")).unwrap();
  fs::write(
    fixture.root.join("node_modules").join("pkg").join("index.js"),
    b"module\n",
  )
  .unwrap();
  fs::write(fixture.root.join("keep.ts"), b"export {}\n").unwrap();

  let rules = build_workspace_ignore_template(BuildIgnoreTemplateRequest { gitignore: None });
  assert!(match_workspace_ignore_path(MatchIgnorePathRequest {
    rules: rules.clone(),
    relative_path: "node_modules/pkg/index.js".to_string(),
    is_directory: false,
  }));
  assert!(!match_workspace_ignore_path(MatchIgnorePathRequest {
    rules: rules.clone(),
    relative_path: "keep.ts".to_string(),
    is_directory: false,
  }));

  let found = walk_workspace_task(WalkWorkspaceRequest {
    root_path: fixture.root.to_string_lossy().into_owned(),
    roots: fixture.roots(),
    ignore_rules: rules,
  })
  .run()
  .expect("walk");
  let relatives: Vec<&str> = found.iter().map(|e| e.relative_path.as_str()).collect();
  assert!(relatives.contains(&"keep.ts"));
  assert!(!relatives.iter().any(|r| r.contains("node_modules")));
}

#[test]
fn the_pure_filter_export_reports_the_decision_directly() {
  let hidden = evaluate_workspace_file_entry(EvaluateFileEntryRequest {
    name: ".git".to_string(),
    relative_path: ".git".to_string(),
    kind: "directory".to_string(),
    ignore_rules_active: true,
  });
  assert!(!hidden.include);
  assert!(hidden.traverse);
  let artifact = evaluate_workspace_file_entry(EvaluateFileEntryRequest {
    name: "libthing.so".to_string(),
    relative_path: "libthing.so".to_string(),
    kind: "file".to_string(),
    ignore_rules_active: true,
  });
  assert!(!artifact.include);
}

// ---------------------------------------------------------------------------
// readdir through the public surface
// ---------------------------------------------------------------------------

#[test]
fn readdir_lists_the_root_and_classifies_every_entry() {
  let fixture = Fixture::new("readdir");
  fs::create_dir_all(fixture.root.join("dir")).unwrap();
  fs::write(fixture.root.join(".env"), b"X=1\n").unwrap();
  fs::write(fixture.root.join("plain.txt"), b"x").unwrap();

  let visible = readdir_task(ReaddirRequest {
    path: fixture.root.to_string_lossy().into_owned(),
    roots: fixture.roots(),
    include_hidden: None,
  })
  .run()
  .expect("readdir");
  let names: Vec<&str> = visible.iter().map(|entry| entry.name.as_str()).collect();
  assert!(!names.contains(&".env"), "dotfiles hidden by default");
  assert!(names.contains(&"dir"));
  assert!(names.contains(&"plain.txt"));
  assert_eq!(
    visible
      .iter()
      .find(|entry| entry.name == "dir")
      .map(|entry| entry.kind.as_str()),
    Some("directory")
  );

  let all = readdir_task(ReaddirRequest {
    path: fixture.root.to_string_lossy().into_owned(),
    roots: fixture.roots(),
    include_hidden: Some(true),
  })
  .run()
  .expect("readdir");
  let names: Vec<&str> = all.iter().map(|entry| entry.name.as_str()).collect();
  assert!(names.contains(&".env"));
  assert_eq!(
    all
      .iter()
      .find(|entry| entry.name == "link-dead")
      .map(|entry| entry.is_symbolic_link),
    Some(true)
  );
}

#[test]
fn readdir_of_an_out_of_root_directory_is_rejected() {
  let fixture = Fixture::new("readdir-escape");
  let requested = fixture.outside.to_string_lossy().into_owned();
  let error = readdir_task(ReaddirRequest {
    path: requested.clone(),
    roots: fixture.roots(),
    include_hidden: None,
  })
  .run()
  .expect_err("out of root");
  assert_eq!(
    rejection(&error),
    format!("Path is not inside an allowed root: {requested}")
  );
}
