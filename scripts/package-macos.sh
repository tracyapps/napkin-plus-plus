#!/usr/bin/env bash
# Build a distributable napkin++ for macOS.
#
#   npm run package                     # host architecture
#   NAPKIN_ARCH=universal npm run package
#   NAPKIN_ARCH=arm64 NAPKIN_SKIP_SIGN=1 npm run package
#
# Ad-hoc signs by default: that is enough to launch on the machine that built it
# and for a direct download. Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and
# APPLE_TEAM_ID (plus a Developer ID Application identity in the keychain) to
# sign with the hardened runtime and notarize — see docs/RELEASING.md.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
ARCH="${NAPKIN_ARCH:-${1:-$(uname -m)}}"
if [ "$ARCH" = "x86_64" ]; then ARCH="x64"; fi
case "$ARCH" in
  arm64|x64|universal) ;;
  *) echo "unsupported arch: $ARCH (use arm64, x64 or universal)" >&2; exit 1 ;;
esac

if [ ! -f assets/icon.icns ]; then
  echo "• rendering icons"
  npm run icons >/dev/null
fi

echo "• packaging napkin++ $VERSION ($ARCH)"
./node_modules/.bin/electron-packager . "napkin++" \
  --platform=darwin \
  --arch="$ARCH" \
  --app-bundle-id=com.local.napkin-plus-plus \
  --app-version="$VERSION" \
  --app-category-type=public.app-category.developer-tools \
  --icon=assets/icon.icns \
  --out=dist \
  --overwrite \
  --prune=true \
  --quiet \
  --ignore="^/(docs|tests|dist|scripts|site|\\.github|\\.zwork|node_modules)($|/)" \
  --ignore="^/(README\\.md|CONTRIBUTING\\.md|SECURITY\\.md|LICENSE\\.md|CHANGELOG\\.md|package-lock\\.json|\\.gitignore|\\.editorconfig|\\.gitattributes)$"

APP="dist/napkin++-darwin-${ARCH}/napkin++.app"
if [ ! -d "$APP" ]; then
  echo "build failed: $APP is missing" >&2
  exit 1
fi

BUILT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
if [ "$BUILT_VERSION" != "$VERSION" ]; then
  echo "version mismatch: bundle says $BUILT_VERSION, package.json says $VERSION" >&2
  exit 1
fi

echo "• cleaning extended attributes"
xattr -cr "$APP" || true

# Packager copies Electron's icon under its default filename. Rename it so the
# bundle reads as napkin++, then sign the modified Info.plist.
if [ -f "$APP/Contents/Resources/electron.icns" ]; then
  mv "$APP/Contents/Resources/electron.icns" "$APP/Contents/Resources/napkin.icns"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile napkin.icns" "$APP/Contents/Info.plist"
fi

SIGNED="ad-hoc"
IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"
if [ "${NAPKIN_SKIP_SIGN:-0}" = "1" ]; then
  SIGNED="unsigned"
  echo "• skipping signing (NAPKIN_SKIP_SIGN=1)"
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] \
  && printf '%s' "$IDENTITIES" | grep -q "Developer ID Application"; then
  echo "• signing with Developer ID and notarizing"
  bash scripts/notarize.sh "$APP"
  SIGNED="notarized"
else
  echo "• ad-hoc signing"
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep --strict "$APP"
fi

ZIP_NAME="napkin++-${VERSION}-darwin-${ARCH}.zip"
echo "• zipping $ZIP_NAME"
ditto -c -k --sequesterRsrc --keepParent "$APP" "dist/$ZIP_NAME"
cp "dist/$ZIP_NAME" "dist/napkin++.zip"
( cd dist && shasum -a 256 "$ZIP_NAME" > "$ZIP_NAME.sha256" )
cp "dist/$ZIP_NAME.sha256" "dist/SHA256SUMS.txt"

cat <<EOF

Built ($SIGNED):
  $APP
  dist/$ZIP_NAME
  dist/SHA256SUMS.txt

Verify on a clean Mac:
  codesign -dv --verbose=2 "$APP"
  spctl -a -vvv -t install "$APP"     # notarized builds only

Move napkin++.app to /Applications, open it once, then enable
"Open at login" in Settings if you want it to start with macOS.
EOF
