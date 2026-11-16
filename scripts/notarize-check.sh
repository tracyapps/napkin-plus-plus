#!/usr/bin/env bash
# What do I still need before notarization can run?
#
#   npm run notarize:check
#
# Reads only: keychain identities, tool versions, and whether the three Apple
# environment variables are set. It never prints a password, and it never signs
# or uploads anything.
set -uo pipefail
cd "$(dirname "$0")/.."

ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
missing() { printf '  \033[31m✗\033[0m %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }

echo
echo "napkin++ notarization check"
echo "───────────────────────────"

# --- tools -----------------------------------------------------------------

echo
echo "tools"
TOOLS_OK=1
if xcrun -f notarytool >/dev/null 2>&1; then
  ok "notarytool ($(xcrun notarytool --version 2>/dev/null | head -n 1))"
else
  missing "notarytool — install Xcode 13 or newer, then: xcode-select --install"
  TOOLS_OK=0
fi
if command -v stapler >/dev/null 2>&1 || xcrun -f stapler >/dev/null 2>&1; then
  ok "stapler (ships with Xcode)"
else
  missing "stapler — reinstall Xcode command line tools"
  TOOLS_OK=0
fi
if command -v codesign >/dev/null 2>&1; then
  ok "codesign"
else
  missing "codesign"
  TOOLS_OK=0
fi

# --- certificate -----------------------------------------------------------

echo
echo "signing certificate"
IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"
DEVELOPER_ID="$(printf '%s\n' "$IDENTITIES" | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -n 1)"
TEAM_FROM_CERT="$(printf '%s' "$DEVELOPER_ID" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')"

if [ -n "$DEVELOPER_ID" ]; then
  ok "Developer ID Application found"
  note "$DEVELOPER_ID"
  if [ -n "$TEAM_FROM_CERT" ]; then
    note "Team ID on the certificate: $TEAM_FROM_CERT"
  fi
else
  missing "no 'Developer ID Application' certificate in the keychain"
  note "Xcode → Settings → Accounts → your team → Manage Certificates → + → Developer ID Application"
  note "or developer.apple.com → Certificates, Identifiers & Profiles → Certificates → +"
  if printf '%s\n' "$IDENTITIES" | grep -q "Apple Development"; then
    note "You do have an Apple Development certificate; that one cannot notarize a distributed build."
  fi
fi

# --- environment -----------------------------------------------------------

echo
echo "environment"
if [ -n "${APPLE_ID:-}" ]; then
  ok "APPLE_ID is set"
else
  missing "APPLE_ID — your Apple developer account email"
  note "export APPLE_ID=\"you@example.com\""
fi

if [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  case "$APPLE_APP_SPECIFIC_PASSWORD" in
    *-*-*-*) ok "APPLE_APP_SPECIFIC_PASSWORD is set (app-specific format)" ;;
    *) ok "APPLE_APP_SPECIFIC_PASSWORD is set"; note "it does not look like xxxx-xxxx-xxxx-xxxx — is it the account password?" ;;
  esac
else
  missing "APPLE_APP_SPECIFIC_PASSWORD — not your Apple ID password"
  note "account.apple.com → Sign-In and Security → App-Specific Passwords → +"
fi

if [ -n "${APPLE_TEAM_ID:-}" ]; then
  if printf '%s' "$APPLE_TEAM_ID" | grep -Eq '^[A-Z0-9]{10}$'; then
    ok "APPLE_TEAM_ID is set"
  else
    missing "APPLE_TEAM_ID is set but is not 10 letters/digits"
  fi
  if [ -n "$TEAM_FROM_CERT" ] && [ "$APPLE_TEAM_ID" != "$TEAM_FROM_CERT" ]; then
    note "warning: it does not match the team on the certificate ($TEAM_FROM_CERT)"
  fi
else
  missing "APPLE_TEAM_ID — the 10-character team id"
  note "developer.apple.com/account → Membership details → Team ID"
fi

if [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
  ok "MACOS_SIGN_IDENTITY is set"
fi

# --- verdict ---------------------------------------------------------------

echo
echo "next"
if [ "$TOOLS_OK" = "1" ] && [ -n "$DEVELOPER_ID" ] && [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "  Everything is here. Build, notarize and zip in one go:"
  echo
  echo "    NAPKIN_ARCH=universal npm run package"
  echo
  echo "  Then verify:"
  echo
  echo "    spctl -a -vvv -t install \"dist/napkin++-darwin-universal/napkin++.app\""
  echo "    xcrun stapler validate \"dist/napkin++-darwin-universal/napkin++.app\""
else
  echo "  Follow docs/NOTARIZATION.md for the missing pieces, then re-run:"
  echo
  echo "    npm run notarize:check"
  echo
  echo "  For GitHub Actions, add these repository secrets:"
  echo "    APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID"
  echo "    MACOS_CERT_P12 (base64 .p12), MACOS_CERT_PASSWORD, MACOS_SIGN_IDENTITY"
fi
echo
