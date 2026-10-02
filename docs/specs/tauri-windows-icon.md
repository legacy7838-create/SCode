# Spec: Tauri Windows icon asset (`icons/icon.ico`)

Status: active. Written before the fix per `AGENTS.md`. Owner: `apps/zcode-tauri/src-tauri/` build assets.

## Problem (root cause, confirmed)

Windows builds of `zcode-tauri` failed in the **build script stage**, before any Rust crate compiled:

```
error: failed to run custom build command for `zcode-tauri v3.14.3 (src-tauri)`
  `src-tauri/icons/icon.ico` not found; required for generating a Windows Resource file during tauri-build
```

`tauri-build` 2.7.x (see its `src/lib.rs`, window-icon search): when no window icon is set via
`WindowsAttributes`, it searches `bundle > icon` in `tauri.conf.json` for a file ending in `.ico`,
then falls back to the hardcoded default `icons/icon.ico`. This repository's `bundle.icon` listed
only PNGs and no `icon.ico` file was tracked — so **every** Windows target (`x86_64-pc-windows-msvc`,
etc.) failed at `cargo` compile time.

## Rule and ownership

- Owner of build assets: `apps/zcode-tauri/src-tauri/`. No other module may own or generate icons.
- Invariant: `apps/zcode-tauri/src-tauri/icons/icon.ico` is a **tracked repository asset**, not a
  build-time artifact. It must contain sizes 256/128/64/48/32/16 derived from `icons/icon.png`
  (512×512 source artwork).
- `apps/zcode-tauri/src-tauri/tauri.conf.json` → `bundle.icon` must include `icons/icon.ico`, so
  both the `tauri-build` search and Windows bundling resolve an `.ico`.
- Regeneration command when the artwork changes (ImageMagick):

  ```
  magick icons/icon.png -define icon:auto-resize=256,128,64,48,32,16 icons/icon.ico
  ```

- Linux (`deb`/`appimage`/`rpm`) and macOS bundling filter `bundle.icon` by platform format; an
  `.ico` entry is ignored there. Listing all formats in `bundle.icon` is the standard Tauri layout.

## Failure semantics

- If `icon.ico` is deleted or removed from `bundle.icon`, Windows compiles fail at build-script
  stage (exit code 1) with "icons/icon.ico not found" — treat the file as a required tracked asset
  in review and CI. Linux/macOS builds are unaffected, so the failure only surfaces on Windows.

## Acceptance scenarios

1. On Windows, `pnpm dev:desktop` and `cargo build` in `src-tauri` no longer emit
   "icons/icon.ico not found"; the build script prints `permission files: ok` and proceeds.
2. `magick identify icons/icon.ico` reports a multi-frame ICO with frames 256/128/64/48/32/16.
3. `tauri.conf.json` `bundle.icon` contains `icons/icon.ico` in addition to the existing PNGs.

## 修复原因（中文）

- 失败根因（已确认，非猜测）：Windows 下 `tauri_build::build()` 生成 Windows 资源文件时需要
  `.ico` 图标；本仓库 `bundle.icon` 只列出了 PNG，且 `icons/icon.ico` 文件不存在，
  导致构建脚本阶段直接失败（exit code 1）。
- 修复方式：用现有 `icons/icon.png`（512×512）生成多尺寸 `icons/icon.ico` 并纳入版本库，
  同时把 `icons/icon.ico` 加入 `bundle.icon`；不引入构建时生成步骤，避免不同机器的环境差异。
- 该文件是纯资产修复：`tauri.conf.json` 为 JSON 不支持注释，中文原因记录在本 spec 中。
