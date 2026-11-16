#!/usr/bin/env bash
#
# notarize.sh - sign a built napkin++.app with a Developer ID identity, notarize
# it with Apple, staple the ticket, and prove Gatekeeper accepts it.
#
#   export APPLE_ID="you@example.com"
#   export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
#   export APPLE_TEAM_ID="ABCDE12345"
#   bash scripts/notarize.sh "dist/napkin++-darwin-arm64/napkin++.app"
#
# Optional:
#   MACOS_SIGN_IDENTITY   full identity name; auto-detected from the keychain if unset
#   ENTITLEMENTS_PLIST    entitlements file; defaults to scripts/entitlements.mac.plist
#                         (created on first run if it does not exist)
#
# This script is intentionally not run by CI unless the Apple secrets are set,
# and it needs a real Developer ID certificate. Ad-hoc signing cannot be
# notarized.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_PATH=""
IDENTITY_ARG=""
ENTITLEMENTS_ARG=""

usage() {
  cat <<'EOF'
Usage: bash scripts/notarize.sh <path/to/App.app> [options]

Options:
  --identity <name>      Codesign identity (default: $MACOS_SIGN_IDENTITY, then
                         the first "Developer ID Application" cert in the keychain)
  --entitlements <file>  Entitlements plist (default: $ENTITLEMENTS_PLIST, then
                         scripts/entitlements.mac.plist)
  -h, --help             Show this message

Required environment:
  APPLE_ID                      Apple developer account email
  APPLE_APP_SPECIFIC_PASSWORD   app-specific password for that account
  APPLE_TEAM_ID                 Apple team id (10 characters)
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "$name is not set. See the header of this script for the required variables."
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --identity)
      [ $# -ge 2 ] || fail "--identity needs a value"
      IDENTITY_ARG="$2"
      shift 2
      ;;
    --entitlements)
      [ $# -ge 2 ] || fail "--entitlements needs a value"
      ENTITLEMENTS_ARG="$2"
      shift 2
      ;;
    -*)
      fail "unknown option: $1"
      ;;
    *)
      if [ -n "$APP_PATH" ]; then
        fail "unexpected argument: $1"
      fi
      APP_PATH="$1"
      shift
      ;;
  esac
done

if [ -z "$APP_PATH" ]; then
  usage >&2
  exit 2
fi

# --- environment and tool checks -------------------------------------------

[ "$(uname -s)" = "Darwin" ] || fail "notarization only works on macOS"

require_env APPLE_ID
require_env APPLE_APP_SPECIFIC_PASSWORD
require_env APPLE_TEAM_ID

if ! printf '%s' "$APPLE_TEAM_ID" | grep -Eq '^[A-Z0-9]{10}$'; then
  printf 'warning: APPLE_TEAM_ID "%s" does not look like a 10-character team id\n' "$APPLE_TEAM_ID" >&2
fi

command -v codesign >/dev/null 2>&1 || fail "codesign not found (install Xcode command line tools)"
command -v xcrun >/dev/null 2>&1 || fail "xcrun not found (install Xcode command line tools)"
command -v spctl >/dev/null 2>&1 || fail "spctl not found"
xcrun -f notarytool >/dev/null 2>&1 || fail "notarytool not found; it ships with Xcode 13 or newer"

case "$APP_PATH" in
  *.app) ;;
  *) fail "expected a path ending in .app, got: $APP_PATH" ;;
esac
[ -d "$APP_PATH" ] || fail "no such app bundle: $APP_PATH"
[ -f "$APP_PATH/Contents/Info.plist" ] || fail "not a macOS app bundle (missing Contents/Info.plist): $APP_PATH"

APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo unknown)"
printf '• app: %s (version %s)\n' "$APP_PATH" "$APP_VERSION"

# --- signing identity ------------------------------------------------------

IDENTITY="${IDENTITY_ARG:-${MACOS_SIGN_IDENTITY:-}}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' \
    | head -n 1)"
fi
[ -n "$IDENTITY" ] || fail "no 'Developer ID Application' certificate found. Install one, or set MACOS_SIGN_IDENTITY."
printf '• identity: %s\n' "$IDENTITY"

# --- entitlements ----------------------------------------------------------

ENTITLEMENTS="${ENTITLEMENTS_ARG:-${ENTITLEMENTS_PLIST:-$SCRIPT_DIR/entitlements.mac.plist}}"
if [ ! -f "$ENTITLEMENTS" ]; then
  printf '• writing default entitlements to %s\n' "$ENTITLEMENTS"
  cat >"$ENTITLEMENTS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- V8 needs JIT pages; Electron's helper processes need the rest. -->
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
PLIST
fi
[ -f "$ENTITLEMENTS" ] || fail "entitlements file missing: $ENTITLEMENTS"

# --- sign ------------------------------------------------------------------

# --deep is deprecated and leaves loose binaries inside Electron Framework and
# Squirrel ad-hoc signed. Notarization then fails with "Record not found" at
# staple time. @electron/osx-sign walks the bundle inside-out instead.
printf '• signing with Developer ID, hardened runtime and timestamp\n'
MACOS_SIGN_IDENTITY="$IDENTITY" \
ENTITLEMENTS_PLIST="$ENTITLEMENTS" \
node "$SCRIPT_DIR/sign-mac.js" "$APP_PATH"

codesign --verify --deep --strict "$APP_PATH"
printf '  signature verifies\n'

printf '• checking every executable is Developer ID signed\n'
NESTED_ISSUES="$(mktemp "${TMPDIR:-/tmp}/napkin-nested.XXXXXX")"
find "$APP_PATH" -type f -perm +111 | while IFS= read -r file; do
  info="$(codesign -dvv "$file" 2>&1 || true)"
  printf '%s' "$info" | grep -q "Authority=Developer ID Application" || \
    printf '  not Developer ID: %s\n' "${file#$APP_PATH/}"
  printf '%s' "$info" | grep -q "Timestamp=" || \
    printf '  no secure timestamp: %s\n' "${file#$APP_PATH/}"
done > "$NESTED_ISSUES"
if [ -s "$NESTED_ISSUES" ]; then
  cat "$NESTED_ISSUES" >&2
  rm -f "$NESTED_ISSUES"
  fail "nested code is not notarization-ready; nothing was submitted."
fi
rm -f "$NESTED_ISSUES"

# --- notarize --------------------------------------------------------------

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/napkin-notarize.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

SUBMISSION_ZIP="$WORK_DIR/$(basename "$APP_PATH" .app).zip"
printf '• zipping for submission: %s\n' "$SUBMISSION_ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$SUBMISSION_ZIP"

printf '• submitting to Apple (this waits for the verdict)\n'
SUBMIT_JSON="$WORK_DIR/submit.json"
SUBMIT_ERR="$WORK_DIR/submit.err"
set +e
xcrun notarytool submit "$SUBMISSION_ZIP" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --wait \
  --output-format json \
  --no-progress > "$SUBMIT_JSON" 2> "$SUBMIT_ERR"
SUBMIT_CODE=$?
set -e

if [ "$SUBMIT_CODE" -ne 0 ]; then
  cat "$SUBMIT_JSON" 2>/dev/null || true
  cat "$SUBMIT_ERR" 2>/dev/null || true
  fail "notarytool could not submit the archive. Nothing was stapled."
fi
if [ ! -s "$SUBMIT_JSON" ]; then
  fail "notarytool returned no JSON; cannot confirm the verdict."
fi

NOTARY_ID="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.id||""))' "$SUBMIT_JSON")"
NOTARY_STATUS="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.status||""))' "$SUBMIT_JSON")"
printf '  id: %s\n  status: %s\n' "${NOTARY_ID:-unknown}" "${NOTARY_STATUS:-unknown}"

if [ "$NOTARY_STATUS" != "Accepted" ]; then
  printf '\n• Apple did not accept this build. Fetching the log\n'
  LOG_JSON="$WORK_DIR/notary-log.json"
  if xcrun notarytool log "$NOTARY_ID" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    "$LOG_JSON" >/dev/null 2>&1 && [ -s "$LOG_JSON" ]; then
    node -e 'const fs=require("fs");try{console.log(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8")),null,2))}catch(e){console.log(fs.readFileSync(process.argv[1],"utf8"))}' "$LOG_JSON"
  else
    printf '  Could not fetch the log. Run:\n'
    printf '  xcrun notarytool log %s --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"\n' "$NOTARY_ID"
  fi
  fail "notarization status was ${NOTARY_STATUS:-unknown}. Nothing was stapled."
fi

# --- staple and verify -----------------------------------------------------

printf '• stapling the ticket\n'
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"

printf '• checking Gatekeeper\n'
spctl --assess --type execute --verbose=4 "$APP_PATH"

printf '\nNotarized and stapled: %s\n' "$APP_PATH"
printf 'Ship it zipped with: ditto -c -k --sequesterRsrc --keepParent "%s" <name>.zip\n' "$APP_PATH"
