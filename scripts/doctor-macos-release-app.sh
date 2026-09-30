#!/usr/bin/env bash

set -euo pipefail

APP_PATH="${1:-${ZCODE_MACOS_RELEASE_APP_PATH:-/Applications/ZCode.app}}"
# Separate the installation package identity and backend environment: ZCODE_PREVIEW_IDENTITY=1 so that the production backend build is still ZCode Preview.
# Only "1" is recognized, which has the same semantics as the precise comparison of CI workflow / release gates (other spellings are regarded as not enabled).
is_preview_identity_requested() {
  [[ "${ZCODE_PREVIEW_IDENTITY:-}" = "1" ]]
}
APP_BUNDLE_NAME="$(basename "$APP_PATH")"
APP_DISPLAY_NAME="${APP_BUNDLE_NAME%.app}"
APP_EXECUTABLE_NAME="${ZCODE_APP_EXECUTABLE_NAME:-$APP_DISPLAY_NAME}"

if [ "${APP_PATH:-}" = "--help" ] || [ "${APP_PATH:-}" = "-h" ]; then
  cat <<'USAGE'
Usage:
  bash scripts/doctor-macos-release-app.sh /Applications/ZCode.app
  ZCODE_MACOS_RELEASE_APP_PATH=/Applications/ZCode.app pnpm run doctor:macos-release

Always validates the installed macOS release app with:
  codesign --verify --deep --strict <app>
  spctl -a -vv -t exec <app>
USAGE
  exit 0
fi

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "[macos-release-doctor] missing required command: $command_name" >&2
    exit 1
  fi
}

assert_bundle_dir() {
  local label="$1"
  local bundle_path="$2"
  if [ -z "$bundle_path" ]; then
    echo "[macos-release-doctor] ${label} missing: <no app path provided>" >&2
    exit 1
  fi
  if [ ! -d "$bundle_path" ]; then
    echo "[macos-release-doctor] ${label} missing: $bundle_path" >&2
    exit 1
  fi
}

assert_executable() {
  local label="$1"
  local executable_path="$2"
  if [ ! -x "$executable_path" ]; then
    echo "[macos-release-doctor] ${label} executable missing or not executable: $executable_path" >&2
    exit 1
  fi
}

assert_macho_executable() {
  local label="$1"
  local executable_path="$2"
  local magic
  magic="$(od -An -N4 -tx1 -v "$executable_path" | tr -d ' \n')"
  case "$magic" in
    feedface|feedfacf|cafebabe|cafebabf|cffaedfe|cefaedfe|bebafeca|bfbafeca) ;;
    *)
      echo "[macos-release-doctor] ${label} is not a Mach-O executable: $executable_path" >&2
      exit 1
      ;;
  esac
}

run_quiet_validation() {
  local label="$1"
  shift
  local output_file
  output_file="$(mktemp "${TMPDIR:-/tmp}/zcode-macos-release-doctor.XXXXXX")"
  if "$@" >"$output_file" 2>&1; then
    rm -f "$output_file"
    return 0
  fi

  echo "[macos-release-doctor] ${label} failed" >&2
  cat "$output_file" >&2
  rm -f "$output_file"
  return 1
}

validate_release_bundle() {
  local label="$1"
  local bundle_path="$2"
  local require_notarization_staple="${3:-0}"

  echo "[macos-release-doctor] validating ${label}: $bundle_path"
  run_quiet_validation "${label} codesign verify" codesign --verify --deep --strict "$bundle_path"
  run_quiet_validation "${label} Gatekeeper exec assessment" spctl -a -vv -t exec "$bundle_path"
  if [ "$require_notarization_staple" = "1" ]; then
    # xcrun is only used for macOS staple acceptance. It will be checked after the target bundle exists and the basic signature verification passes.
    # Avoid missing xcrun errors that cover up missing bundles or incorrect signatures.
    require_command xcrun
    # Checking only spctl may rely on network ticketing or caching, but still needs to verify the local staple of the target bundle.
    run_quiet_validation "${label} notarization staple" xcrun stapler validate "$bundle_path"
  fi
}

require_command codesign
require_command spctl

# In the past, successful release/notarization only meant that the DMG passed the gate, but could not prove the main app after installation.
# Can be released by Gatekeeper with exec type. Here first fail-closed checks the bundle structure and main executable
# file, and then run codesign/spctl to avoid false positives of successful release when the installation is incomplete or the signature is damaged.
assert_bundle_dir "$APP_BUNDLE_NAME" "$APP_PATH"
assert_executable "$APP_BUNDLE_NAME" "$APP_PATH/Contents/MacOS/$APP_EXECUTABLE_NAME"
validate_release_bundle "$APP_BUNDLE_NAME" "$APP_PATH"


echo "[macos-release-doctor] done"
