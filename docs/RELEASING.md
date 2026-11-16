# Releasing napkin++

The runbook for shipping a version. Follow it in order; every command assumes the
repo root and a macOS machine with Node 24, npm, Xcode command line tools, and
push access to `github.com/tracyapps/napkin-plus-plus`.

A release is: one tag on `main`, three zipped builds (arm64, x64, universal), a
`SHA256SUMS.txt`, and release notes taken from `CHANGELOG.md`. The app's own
update check reads the latest GitHub Release, so the assets are the product, not
a side effect.

---

## 1. Pre-flight

```bash
cd /Users/tapps/_dev/apps/napkin++
git switch main
git pull --ff-only
npm ci
npm run check
npm test
NAPKIN_SHOT_DIR="$(mktemp -d)/shots" npm run smoke
npm run package
open "dist/napkin++-darwin-arm64/napkin++.app"
```

What each step proves:

| Command | Proves |
| --- | --- |
| `npm ci` | The lockfile is complete and installs cleanly |
| `npm run check` | Every source file still parses |
| `npm test` | The model, parser, search and store tests pass |
| `npm run smoke` | A real Electron boot: window opens, vault is thrown away, screenshots written, non-zero exit on failure |
| `npm run package` | Icons render, the arm64 `.app` builds, it ad-hoc signs, and `dist/napkin++.zip` is produced |

Notes:

- `npm run smoke` writes screenshots to `docs/` unless `NAPKIN_SHOT_DIR` is set.
  Use a temp directory, as above, so the work tree stays clean.
- `dist/` is gitignored; a stale build from last week is fine to overwrite.
- If the smoke test fails, fix it before going further. A release that cannot
  boot is not a release.

---

## 2. Bump the version

```bash
node scripts/bump-version.mjs 1.0.0
```

It sets `version` in `package.json` and prepends a `## [1.0.0] - <today>` stub to
`CHANGELOG.md`. It refuses to run on a dirty work tree unless you pass `--force`,
and it never edits `package-lock.json`.

Sync the lockfile's version fields (this changes no dependencies):

```bash
npm install --package-lock-only
```

Check both files agree:

```bash
node -p "require('./package.json').version"
node -p "require('./package-lock.json').version"
```

Both should print `1.0.0`. `npm ci` tolerates a stale version field, so a
mismatch will not fail CI - it just leaves the lockfile to be rewritten by some
later `npm install`, which shows up as an unexplained diff. Sync it now.

---

## 3. Write the changelog

The release workflow copies the section whose heading matches the tag's version
into the GitHub Release. Keep the heading shape exact:

```markdown
## [1.0.0] - 2026-11-15

### Added

- Projects can be filed into folders.

### Changed

- The palette now searches account fields.

### Fixed

- The vault no longer rewrites itself when nothing changed.
```

Rules that matter to the extraction:

- The heading starts with `## [` followed by the version, no `v` prefix.
- The section ends at the next `## ` or `# ` heading.
- Delete sections you have nothing to say in. Empty headings produce empty
  release notes.
- If the section is missing, the workflow falls back to `--generate-notes`, which
  is a strictly worse changelog. Do not rely on it.

Write for the person deciding whether to update: what changed for them, not which
files you touched.

---

## 4. Commit and tag

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: napkin++ 1.0.0"
git tag -a v1.0.0 -m "napkin++ 1.0.0"
git push origin main
git push origin v1.0.0
```

The tag must be `v` + the exact `package.json` version. Pushing the tag is what
starts the release; nothing is published by pushing `main` alone.

For a pre-release use a tag with a hyphen, e.g. `v1.0.0-rc.1`. The workflow marks
any tag containing `-` as a GitHub pre-release, and the in-app update check reads
`releases/latest`, which skips pre-releases - so a pre-release is never offered as
an update. It is a test build for people who go to the releases page themselves.

To rehearse without publishing, run the **Release** workflow manually
(`workflow_dispatch`) with `publish` unchecked: it builds and uploads workflow
artifacts only.

---

## 5. What CI produces

| Workflow | Trigger | Output |
| --- | --- | --- |
| `ci.yml` | push to `main`, pull requests | `check`, `test`, `smoke` + screenshots artifact; a packaged build with verified `Info.plist` and an uploaded `dist/napkin++.zip` |
| `release.yml` | tag `v*`, manual dispatch | three zips, `SHA256SUMS.txt`, a GitHub Release with notes from `CHANGELOG.md` |
| `site.yml` | `site/**` changes, manual dispatch | deploys `site/` to Vercel when the Vercel secrets exist |

Release assets for `v1.0.0`:

```
napkin++-1.0.0-darwin-arm64.zip
napkin++-1.0.0-darwin-x64.zip
napkin++-1.0.0-darwin-universal.zip
SHA256SUMS.txt
```

Each `.zip` contains `napkin++.app` at the top level (built with
`ditto --keepParent`), so unpacking it gives you the app bundle, not a folder of
loose files. `SHA256SUMS.txt` lists bare filenames, so it verifies from the
directory you downloaded into:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

The workflow recomputes every checksum after downloading its own artifacts, so a
corrupted upload fails the release instead of shipping.

---

## 6. Verify the download on a clean Mac

Do this on a machine that has never had napkin++ installed, or in a fresh user
account. Download the assets into an empty folder.

```bash
mkdir -p ~/Downloads/napkin-verify
cd ~/Downloads/napkin-verify
shasum -a 256 -c SHA256SUMS.txt
ditto -x -k "napkin++-1.0.0-darwin-universal.zip" .
```

Signature and Gatekeeper:

```bash
codesign --verify --deep --strict --verbose=2 "napkin++.app"
codesign -dv --verbose=4 "napkin++.app" 2>&1 | grep -E 'Identifier|Authority|TeamIdentifier|flags'
spctl --assess --type execute --verbose=4 "napkin++.app"
```

Expected, for the current ad-hoc signed builds:

- `codesign --verify` prints `valid on disk` and `satisfies its Designated
  Requirement`.
- `codesign -dv` shows `Identifier=com.local.napkin-plus-plus` and
  `flags=0x2(adhoc)`, with no `Authority=` and no `TeamIdentifier=`.
- `spctl` prints `rejected`. That is normal for an ad-hoc signature: Gatekeeper
  has no Developer ID to evaluate. It is not a build failure.

Expected, once the build is notarized: `Authority=Developer ID Application: …`,
a `TeamIdentifier=`, and `spctl` prints `accepted` with
`source=Notarized Developer ID`.

Bundle facts:

```bash
lipo -archs "napkin++.app/Contents/MacOS/napkin++"     # universal: x86_64 arm64
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "napkin++.app/Contents/Info.plist"
xattr -l "napkin++.app"
```

- The version must equal the tag minus its `v`.
- `xattr -l` may list `com.apple.quarantine` if a browser downloaded the zip.
  That attribute is what makes macOS say "damaged" on an unsigned build. Remove
  it with `xattr -dr com.apple.quarantine "napkin++.app"`, or right-click the app
  and choose Open.
- Launch it, check the version shown in Settings → About, quit, and confirm the
  vault it creates is empty.

---

## 7. Notarization

Ad-hoc signing is fine for local builds and for people who trust you. It is not
fine for a public download: Gatekeeper rejects it on a clean machine.

The prerequisites (Team ID, Developer ID Application certificate, app-specific
password, CI secrets) are in **[NOTARIZATION.md](NOTARIZATION.md)**. Run
`npm run notarize:check` to see which ones this Mac already has.

### Prerequisites

- A paid Apple Developer Program membership.
- A **Developer ID Application** certificate in your login keychain
  (Xcode → Settings → Accounts → Manage Certificates → + → Developer ID
  Application).
- An app-specific password for your Apple ID, created at `account.apple.com`.
- Your Team ID (developer.apple.com → Membership).

Confirm the certificate is usable:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

### Local notarization

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="ABCDE12345"
bash scripts/notarize.sh "dist/napkin++-darwin-arm64/napkin++.app"
```

`scripts/notarize.sh` is the reference implementation. In order, it:

1. Rejects a path that is not an `.app` bundle, and requires the three Apple
   environment variables.
2. Resolves the signing identity from `MACOS_SIGN_IDENTITY` or the first
   `Developer ID Application` certificate in the keychain.
3. Creates `scripts/entitlements.mac.plist` if it is missing (it is committed, so
   normally it is not).
4. Signs with `codesign --force --deep --options runtime --timestamp
   --entitlements …`.
5. Zips the bundle with `ditto`, then runs `xcrun notarytool submit … --wait`.
6. Staples the ticket (`xcrun stapler staple`) and validates it.
7. Runs `spctl --assess` so a rejection fails the script instead of your users.

Entitlements are the minimum Electron needs for a hardened-runtime build:
`com.apple.security.cs.allow-jit` (V8's JIT),
`com.apple.security.cs.allow-unsigned-executable-memory`, and
`com.apple.security.cs.disable-library-validation`. Add more only when something
breaks, and expect to justify each one.

### Notarization in CI

The release workflow signs and notarizes automatically when these repository
secrets exist **and** a Developer ID identity is available:

| Secret | Value |
| --- | --- |
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password |
| `APPLE_TEAM_ID` | 10-character team id |
| `MACOS_CERT_P12` | base64 of the exported `.p12` |
| `MACOS_CERT_PASSWORD` | password used when exporting the `.p12` |
| `MACOS_SIGN_IDENTITY` | full identity name, e.g. `Developer ID Application: tapps (ABCDE12345)` |

Export and encode the certificate:

```bash
# Keychain Access → My Certificates → right-click the Developer ID Application
# certificate → Export… → save as DeveloperID.p12 (set a password)
base64 -i DeveloperID.p12 | pbcopy    # paste into the MACOS_CERT_P12 secret
```

The workflow imports the certificate into a throwaway keychain, then runs
`scripts/notarize.sh`. If the Apple secrets are set but no Developer ID identity
is present, it prints a notice and ships the ad-hoc build rather than failing the
release — check the log to confirm which one you got.

---

## 8. Switching the app from ad-hoc to notarized

Do this once, deliberately, and keep the identity stable afterwards.

1. Get the Developer ID Application certificate and verify it with
   `security find-identity -v -p codesigning`.
2. Add the six secrets above to the repository.
3. Run the Release workflow manually with `publish` unchecked. Confirm in the
   build log that the notarize step ran and did not print the
   "no Developer ID Application identity" notice.
4. Download that workflow artifact and verify with `codesign -dv` (expect
   `Authority=Developer ID Application: …`) and `spctl` (expect `accepted`).
5. Tag the next version and let the workflow publish it.
6. Update the user-facing text that says the build is ad-hoc and not notarized
   (`README.md` → Install it as a macOS app). The site copy already says
   "ad-hoc signed, not notarized" in the download band; change it in the same
   release that first ships a notarized build.
7. Keep `CFBundleIdentifier` (`com.local.napkin-plus-plus`) and the team
   identity unchanged. Changing either breaks the trust chain for anyone
   updating from an older build.

`scripts/package-macos.sh` uses the same switch as CI: it notarizes when
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are set **and** a
Developer ID identity is in the keychain; otherwise it ad-hoc signs and says so
in the output. So a local build and a CI build of the same commit differ only in
signature, not in contents.

---

## 9. Why updates are not one-click yet

Automatic in-place updates on macOS go through **Squirrel.Mac**, which Electron
exposes as `autoUpdater`. Squirrel.Mac requires all of:

- an HTTPS update feed the app can reach,
- a running app signed with a Developer ID certificate,
- the update archive signed with the same identity, and
- a monotonically increasing `CFBundleVersion` on every release.

An ad-hoc signature cannot satisfy that check: every ad-hoc build is its own
untrusted identity, so Squirrel will refuse to swap the bundle. Notarization is a
prerequisite for one-click updates, not a substitute for them.

What napkin++ does from 1.0.0: it checks GitHub Releases and links to the
release page. Updating means downloading the zip, quitting, and replacing
`/Applications/napkin++.app`. That is why every release must ship a `.zip` of the
`.app`, a `SHA256SUMS.txt`, and readable notes — they are the update mechanism.

If you later add Squirrel.Mac:

- Keep the asset naming stable (`napkin++-<version>-darwin-<arch>.zip`); feeds and
  users both key off it.
- Serve the feed over HTTPS (a public repo can use `update.electronjs.org`).
- Bump `CFBundleVersion` on every release, including pre-releases.
- Test the update path from the previous public version, not from a fresh
  install. Squirrel never runs on a fresh install.

---

## 10. What can go wrong

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "napkin++ is damaged and can't be opened" | Quarantine attribute on an ad-hoc or unsigned build | `xattr -dr com.apple.quarantine "napkin++.app"`, or right-click → Open. Notarize to stop this happening to users. |
| Generic Electron icon in the Dock/Finder | The `electron.icns` → `napkin.icns` rename or the `CFBundleIconFile` update did not run | `ls "napkin++.app/Contents/Resources/napkin.icns"` and `PlistBuddy -c 'Print :CFBundleIconFile' …/Info.plist`. Both CI and the release build check this. |
| CI fails at "Verify bundle identity and version" | `Info.plist` disagrees with `package.json` — a stale `dist/` or a hand-edited version | Delete `dist/`, rebuild. Use `scripts/bump-version.mjs` rather than editing versions by hand. |
| Release workflow fails in the `meta` job | Tag does not equal `v<package.json version>` | Bump, commit, then re-tag. Never move a published tag. |
| Universal zip runs only on one architecture | The `@electron/universal` stitch failed or produced one slice | `lipo -archs "napkin++.app/Contents/MacOS/napkin++"` and the same on `Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`. Both must list `x86_64 arm64`. The workflow checks this. |
| `shasum -c` fails | Partial download, proxy rewriting, or a stale asset | Re-download. Never publish past a checksum mismatch. |
| notarytool returns `Invalid` | Unsigned nested binary, missing hardened runtime or timestamp, or an unjustified entitlement | `xcrun notarytool log <submission-id> --apple-id … --team-id … --password …`. Re-run `scripts/notarize.sh` after fixing. |
| `stapler: ticket not found` | Stapling before notarization finished, or a different bundle id was notarized | Re-run the script; it waits for the verdict before stapling. |
| Release has no assets | The build matrix failed or artifact names changed | Check the `build (arch)` jobs. Asset names come from `VERSION` and `ARCH`; both are printed in the log. |
| Smoke test passes locally, fails in CI | The runner had no usable window session, or Electron failed to launch (partial `npm ci`) | Download the `smoke-screenshots` artifact and read the log. The smoke run uses its own throwaway vault, so a real vault is never the cause. |
| Pre-release was published as "Latest" | Tag lacked a hyphen | Use `v1.0.0-rc.1` style tags; the workflow marks hyphenated tags as pre-releases. |

### Rolling back a bad release

```bash
gh release delete v1.0.0 --yes
git push origin --delete v1.0.0
```

Then re-tag the fixed commit. Deleting a release does not delete downloads people
already have, so also post what was wrong and which version to use instead.

---

## 11. First public launch

One-time order of operations. The download button points at
`releases/latest`, which 404s until the first release exists, so the site must
not be announced before the release is published.

1. **Create the repo** at `github.com/tracyapps/napkin-plus-plus` and push `main`.
   It must be **public**: the download button and the in-app update check are
   unauthenticated, so a private repo returns 404 to every install. Create the
   `hello@napkinplusplus.app` mailbox (or a forward to your own address) at the
   same time — the site, the app's feedback sheet and SECURITY.md all point at
   it.
   If you use a different owner or name, change it in three places and commit:
   `app/config.js` (`REPO`, `RELEASE/SITE` URLs), `site/assets/config.js`
   (`repo`), and `package.json` (`repository`, `homepage`, `bugs`).
2. **Confirm CI is green** on `main`: check, the unit suite, the smoke run, the
   package job, and the site link check.
3. **Bump, changelog, tag** (§2–§4) and let `release.yml` publish.
4. **Download the release yourself** on a clean Mac and follow §6. Do not skip
   the `SHA256SUMS.txt` check.
5. **Deploy the site** with `site/` as the Vercel root, add the
   `napkinplusplus.app` domain, set `RESEND_API_KEY`, `CONTACT_TO` and
   `CONTACT_FROM`, then send one message through the real form.
6. **Check the download button** and the support handles on the deployed site.
7. **Install 1.0.0 in `/Applications`**, open Settings → About, press
   *Check now* and confirm it reports you are on the latest version.
8. **Enable FileVault** on the machine you use every day, and remember the vault
   is plaintext by design (see README).

Post-launch, the update check is the release mechanism: every release must be a
tagged, asset-complete GitHub Release or existing installs will never see it.
