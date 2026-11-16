# Notarizing napkin++

Notarization is Apple's automated malware scan for software distributed outside
the App Store. Without it, a downloaded build is quarantined and macOS says the
app "cannot be opened because the developer cannot be verified". With it, the
first launch is a normal one.

Four things are needed. Check which are already in place:

| Thing | Where it comes from | Used by |
| --- | --- | --- |
| **Developer ID Application** certificate | Xcode / Apple Developer portal | `codesign` |
| **Team ID** (10 characters) | Apple Developer portal | `notarytool` |
| **Apple ID email** | your Apple developer account | `notarytool` |
| **App-specific password** | `account.apple.com` | `notarytool` |

Run:

```bash
npm run notarize:check
```

It reads the keychain and the environment, prints the Team ID on your
certificate, and tells you exactly what is missing. It never signs, uploads, or
prints a password.

---

## 1. Team ID

1. Open <https://developer.apple.com/account>.
2. Sign in, then **Membership details** (or **Membership** in the sidebar).
3. Copy **Team ID** — ten letters and digits, e.g. `A1B2C3D4E5`.

The same ID is in the certificate's name in parentheses:
`Developer ID Application: tracy apps (A1B2C3D4E5)`.

## 2. Developer ID Application certificate

Check first:

```bash
security find-identity -v -p codesigning
```

You want a line containing **Developer ID Application**. An *Apple Development*
certificate is not enough — it only signs for your own machines.

### If it is already there

Nothing to do. `npm run notarize:check` will print its name and Team ID.

### If it is missing

**Through Xcode** (simplest):

1. Xcode → **Settings** → **Accounts**.
2. Select your Apple ID and team, then **Manage Certificates…**.
3. Click **+** → **Developer ID Application**.
4. It appears in the login keychain immediately.

**Through the portal** (if you do not use Xcode):

1. Keychain Access → **Certificate Assistant** → **Request a Certificate From a
   Certificate Authority…** → save the `.certSigningRequest` to disk.
2. <https://developer.apple.com/account/resources/certificates> → **+** →
   **Developer ID Application** → upload the CSR → **Continue** → **Download**.
3. Double-click the downloaded `.cer` to install it in the login keychain.

Confirm:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

Only the certificate is in the keychain — its private key was created with the
CSR and stays there. Exporting the pair for CI is step 5.

## 3. App-specific password

Not your Apple ID password. Apple requires a separate password for each tool.

1. Open <https://account.apple.com> and sign in.
2. **Sign-In and Security** → **App-Specific Passwords**.
3. **+** → name it `napkin++ notarytool` → **Create**.
4. Copy the `xxxx-xxxx-xxxx-xxxx` value. It is shown once; if you lose it,
   revoke it and make another.

The **name** you give the password is only a label in Apple's list. Renaming it
to `napkin-plus-plus notarytool` changes nothing about authentication, and it is
not related to a stapling error.

Two-factor authentication must be on for the Apple ID (it almost certainly is).

## 4. Build and notarize locally

Put the three values in the environment for this shell only. `read -s` keeps the
password out of your shell history:

```bash
export APPLE_ID="you@example.com"
read -s "APPLE_APP_SPECIFIC_PASSWORD?App-specific password: "
export APPLE_APP_SPECIFIC_PASSWORD
export APPLE_TEAM_ID="A1B2C3D4E5"
```

Then build. `scripts/package-macos.sh` sees the credentials, signs with the
hardened runtime, notarizes, staples, and only then zips:

```bash
NAPKIN_ARCH=universal npm run package
```

What happens, in order:

1. `@electron/packager` builds the `.app` (universal = arm64 + x64).
2. `scripts/notarize.sh` signs `napkin++.app` inside-out with
   `@electron/osx-sign` (Developer ID, hardened runtime, timestamp,
   `scripts/entitlements.mac.plist`) and checks that every executable in the
   bundle carries that signature before uploading anything.
3. It zips the bundle with `ditto` and submits it with
   `xcrun notarytool submit --wait`, reading the JSON verdict. Anything other
   than `Accepted` stops the script and prints Apple's reason from the notary
   log.
4. It staples the ticket (`xcrun stapler staple`) so the app validates offline.
5. It runs `spctl --assess`; a rejection fails the script.
6. The package script zips the stapled app and writes the checksum.

Verify:

```bash
APP="dist/napkin++-darwin-universal/napkin++.app"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E 'Authority|TeamIdentifier|flags'
spctl --assess --type execute --verbose=4 "$APP"
xcrun stapler validate "$APP"
```

Expected: `Authority=Developer ID Application: …`, a `TeamIdentifier`, `flags=0x10000(runtime)`,
`accepted … source=Notarized Developer ID`, and `The validate action worked`.

> Notarizing an arm64 and a universal build separately is fine; each bundle gets
> its own ticket. The GitHub release workflow does this per architecture.

## 5. GitHub Actions secrets

CI can sign and notarize if you give it the certificate and the same three
values. The release workflow requires Developer ID signing and notarization to
publish. Build-only dry runs can produce ad-hoc ZIPs when no signing identity
is available.

### Export the certificate as .p12

1. Keychain Access → **My Certificates** (not "Certificates").
2. Find **Developer ID Application: …**, expand it, and select **both** the
   certificate and its private key.
3. Right-click → **Export 2 items…** → format **Personal Information Exchange
   (.p12)** → save as `DeveloperID.p12` → set an export password.
4. Base64 it for the secret:

```bash
base64 -i DeveloperID.p12 | pbcopy
rm DeveloperID.p12
```

The clipboard now holds the certificate. The export password is
`MACOS_CERT_PASSWORD`; it is not your Apple ID password.

### Add the secrets

Repository → **Settings** → **Secrets and variables** → **Actions** → **New
repository secret**:

| Secret | Value |
| --- | --- |
| `APPLE_ID` | your Apple developer email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the `xxxx-xxxx-xxxx-xxxx` password from step 3 |
| `APPLE_TEAM_ID` | the 10-character Team ID |
| `MACOS_CERT_P12` | the base64 output from above |
| `MACOS_CERT_PASSWORD` | the export password you chose |
| `MACOS_SIGN_IDENTITY` | optional; full name, e.g. `Developer ID Application: tracy apps (A1B2C3D4E5)` |

Or with the GitHub CLI:

```bash
gh secret set APPLE_ID
gh secret set APPLE_APP_SPECIFIC_PASSWORD
gh secret set APPLE_TEAM_ID
gh secret set MACOS_CERT_P12 < <(base64 -i DeveloperID.p12)
gh secret set MACOS_CERT_PASSWORD
gh secret set MACOS_SIGN_IDENTITY
```

Push a tag (`v1.0.0`) and the release workflow imports the certificate into a
temporary keychain, signs, notarizes, staples and uploads the zips. The job log
says whether notarization ran or was skipped.

## 6. After the first notarized release

- Download the published ZIP on a clean Mac, check its SHA-256, unzip it, and
  validate the staple and Gatekeeper assessment. Launch it from Applications.
- Notarization is a prerequisite for one-click updates, not the whole feature.
  The app still checks and links to the release; see
  [RELEASING.md](RELEASING.md#9-why-updates-are-not-one-click-yet).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `no 'Developer ID Application' certificate found` | Only an Apple Development cert, or the cert is in another keychain | Log in to the right account in Xcode, or `security list-keychains -d user` |
| `codesign` says `code object is not signed at all` for a nested item | A previous partial signing pass | Delete `dist/`, rebuild; the script signs inside-out |
| `notarytool` returns `Invalid` | Usually an unsigned nested binary, missing hardened runtime, or a forbidden entitlement | `xcrun notarytool log <id> --apple-id … --team-id … --password …` and read the JSON |
| `401 Unauthorized` / `authentication failed` | Apple ID email, or the account password instead of the app-specific password | Make a new app-specific password; use the email, not a nickname |
| `The specified item could not be found in the keychain` during CI import | Wrong `.p12` password, or a `.p12` exported without the private key | Re-export from **My Certificates** with both items selected |
| `CloudKit query … failed due to "Record not found"` / `Error 65` when stapling | Apple has no ticket for that exact build. The usual cause on Electron apps is `codesign --deep` leaving loose binaries (`libffmpeg.dylib`, `libvk_swiftshader.dylib`, Squirrel's `ShipIt`) ad-hoc signed, so notarization was rejected even though signing looked valid. | `notarize.sh` now signs with `@electron/osx-sign` and refuses to submit if any executable lacks a Developer ID signature or timestamp. Rerun it; if it still fails, the status and Apple's log are printed. |
| `stapler: ticket not found` | Stapling before the submission finished, or notarizing a different bundle | Let `notarytool --wait` finish; staple the exact `.app` that was submitted |
| `spctl` rejects a notarized build | Ticket not stapled, or the build was modified after signing | Re-run `notarize.sh`; never edit the bundle after signing |
| Notarization passes, but the app is slow to launch first time | Gatekeeper is checking a large universal bundle | Normal once; subsequent launches are cached |

## What notarization does not do

- It does not encrypt your vault, sandbox the app, or review the code for bugs.
- It does not make the app installable via the App Store.
- It does not enable silent updates by itself. Squirrel.Mac additionally needs an
  update feed and a monotonic `CFBundleVersion`; that is future work.
- It does not remove the need for users to trust the download. It removes the
  scary dialog, not the judgment.

## Hygiene

- The `.p12` and its password are signing keys. Do not commit them; `dist/` and
  `*.p12` are ignored.
- Revoke an app-specific password at `account.apple.com` if it leaks, then
  update the GitHub secret.
- The certificate expires (usually after five years). Note the date; renew
  before it lapses or releases stop signing.
- `APPLE_APP_SPECIFIC_PASSWORD` is per-tool. Do not reuse a personal one.
