#!/usr/bin/env bash
# Prove the release before uploading it.
#
#   bash scripts/verify-release.sh
#
# Runs the same gates CI runs, builds the app, then boots the *packaged* binary
# against a throwaway vault and checks the bundle's identity, icon and version.
# Nothing here needs the network.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m• %s\033[0m\n' "$1"; }

step "syntax gates"
npm run check

step "unit tests"
npm test

step "smoke test (real Electron boot)"
NAPKIN_OFFLINE=1 npm run smoke

step "package"
NAPKIN_ARCH="${NAPKIN_ARCH:-$(uname -m)}" npm run package

VERSION="$(node -p "require('./package.json').version")"
ARCH="${NAPKIN_ARCH:-$(uname -m)}"
if [ "$ARCH" = "x86_64" ]; then ARCH="x64"; fi
APP="dist/napkin++-darwin-${ARCH}/napkin++.app"
ZIP="dist/napkin++-${VERSION}-darwin-${ARCH}.zip"

fail() { echo "FAIL: $*" >&2; exit 1; }

step "bundle identity"
[ -d "$APP" ] || fail "no .app bundle in dist/"
BUNDLE_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
ICON="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$APP/Contents/Info.plist")"
[ "$BUNDLE_VERSION" = "$VERSION" ] || fail "bundle version $BUNDLE_VERSION != $VERSION"
[ "$BUNDLE_ID" = "com.local.napkin-plus-plus" ] || fail "unexpected bundle id $BUNDLE_ID"
[ -f "$APP/Contents/Resources/$ICON" ] || fail "icon $ICON missing from the bundle"
echo "  $BUNDLE_ID $BUNDLE_VERSION · icon $ICON"
codesign --verify --deep --strict "$APP" || fail "code signature does not verify"

step "bundle contents"
ASAR="$APP/Contents/Resources/app.asar"
[ -f "$ASAR" ] || fail "missing app.asar"
node - "$ASAR" <<'NODE'
const asar = require('@electron/asar');
const files = asar.listPackage(process.argv[2]);
const has = (name) => files.includes(name);
const missing = ['/main.js', '/preload.js', '/index.html', '/quick.html', '/app/app.js', '/app/config.js', '/app/detect.js'].filter((name) => !has(name));
if (missing.length) {
  console.error('missing from app.asar: ' + missing.join(', '));
  process.exit(1);
}
const leaked = files.filter((name) => /^\/(tests|docs|site|\.github)(\/|$)/.test(name));
if (leaked.length) {
  console.error('leaked into app.asar: ' + leaked.slice(0, 5).join(', '));
  process.exit(1);
}
console.log('  ' + files.length + ' files in app.asar · no tests, docs, site or CI files');
NODE
if [ "$ICON" = "napkin.icns" ]; then
  cmp -s "assets/icon.icns" "$APP/Contents/Resources/napkin.icns" || fail "bundle icon is not assets/icon.icns"
fi

step "zip"
[ -f "$ZIP" ] || fail "missing $ZIP"
ZIP_LIST="$(unzip -l "$ZIP")"
case "$ZIP_LIST" in
  *"napkin++.app/Contents/MacOS/napkin++"*) ;;
  *) fail "zip has no executable at napkin++.app/Contents/MacOS/napkin++" ;;
esac
case "$ZIP_LIST" in
  *"napkin++.app/Contents/Resources/app.asar"*) ;;
  *) fail "zip has no app.asar" ;;
esac
( cd dist && shasum -a 256 -c "$(basename "$ZIP").sha256" )

step "packaged boot (smoke inside the .app)"
TMP_VAULT="$(mktemp -d)"
TMP_SHOTS="$(mktemp -d)"
if ! NAPKIN_SMOKE=1 NAPKIN_OFFLINE=1 \
  NAPKIN_DATA_DIR="$TMP_VAULT" \
  NAPKIN_SHOT_DIR="$TMP_SHOTS" \
  NAPKIN_DETECT_FIXTURE="$PWD/tests/fixtures/detect.json" \
  "$APP/Contents/MacOS/napkin++" > "$TMP_SHOTS/smoke.json" 2>"$TMP_SHOTS/smoke.err"; then
  tail -40 "$TMP_SHOTS/smoke.json" >&2 || true
  tail -20 "$TMP_SHOTS/smoke.err" >&2 || true
  fail "packaged smoke run failed (outputs in $TMP_SHOTS)"
fi
node -e '
  const fs = require("node:fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  const start = raw.indexOf("{");
  const report = JSON.parse(raw.slice(start));
  if (!report.ok) {
    console.error(report.checks.filter((c) => !c.ok));
    process.exit(1);
  }
  console.log("  " + report.checks.length + " checks passed in the packaged app");
' "$TMP_SHOTS/smoke.json"

printf '\n\033[1mRelease verified:\033[0m %s\n' "$ZIP"
printf 'Upload that zip, its .sha256 and SHA256SUMS.txt to the GitHub release.\n'
printf 'Smoke output kept at %s\n' "$TMP_SHOTS"
