# CI and releases

Three workflows, all in `.github/workflows/`. Nothing here needs to be installed
locally to run — this page is for understanding a red check and for reproducing
it on your own Mac.

## What runs where

| Workflow | Trigger | Jobs | Artifacts |
| --- | --- | --- | --- |
| `ci.yml` | push to `main`, any pull request, manual | `verify`: `npm run check`, `npm test`, `npm run smoke`. `package`: `npm run package`, then bundle and version checks | `smoke-screenshots` (kept even on failure), `napkin-plus-plus-zip` |
| `release.yml` | tag `v*`, manual dispatch | `meta`: version/tag agreement. `build`: arm64, x64, universal via `electron-packager`. `release`: checksums, notes, `gh release create` | three zips + `SHA256SUMS.txt` |
| `site.yml` | changes under `site/`, manual | `preflight` (secrets + `site/` existence), `linkcheck`, `deploy` (Vercel) | none; prints the deployment URL |

Details worth knowing:

- All builds run on `macos-latest` with Node 24 and `npm ci`. npm's cache is keyed
  on `package-lock.json`; the Electron binary download is not cached, so the
  first `npm ci` of a run is the slow part.
- `ci.yml` sets `concurrency` with `cancel-in-progress: true`: pushing again to
  the same branch or PR cancels the superseded run.
- `release.yml` sets `cancel-in-progress: false`. Half-cancelled releases leave
  tags without assets.
- `release.yml` runs builds with `fail-fast: false`, so one broken architecture
  still leaves the other logs readable.
- The smoke test is a real boot: it opens a window, discards its vault, writes
  screenshots to `$NAPKIN_SHOT_DIR`, and exits non-zero on failure. GitHub's macOS
  runners have a window server, which is why this can run there at all.
- `ci.yml` uploads the screenshots with `if: always()`, so a failed smoke test
  still gives you pictures of what it rendered.
- The package job asserts three things beyond "the command exited 0": the zip
  contains `napkin++.app`, `CFBundleShortVersionString` equals `package.json`'s
  version, and `CFBundleIdentifier` is `com.local.napkin-plus-plus`.
- The release workflow refuses to publish when the tag is not `v<version>` from
  `package.json`. A tag containing `-` becomes a GitHub pre-release. With
  `publish` unchecked on a manual dispatch it builds and uploads artifacts only —
  that is the dry run.

## Required secrets

The CI workflow needs no secrets. Public releases require Apple notarization
credentials and a Developer ID Application identity. Build-only dry runs can
use an ad-hoc signature when those are absent.

| Secret | Used by | Effect when missing |
| --- | --- | --- |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | `release.yml` | Publishing builds fail |
| `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD` | `release.yml` | Hosted runners cannot import the Developer ID identity, so publishing builds fail |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | `site.yml` | Deploy job is skipped with a notice; the link check still runs |

`MACOS_SIGN_IDENTITY` is optional. The signing script can detect the identity.

`GITHUB_TOKEN` is provided by Actions. The release job needs `contents: write`
for it, which is declared on that job.

Notarization setup is in [RELEASING.md](RELEASING.md#7-notarization).

## Reproducing CI locally

```bash
npm ci
npm run check
npm test
NAPKIN_SHOT_DIR="$(mktemp -d)/shots" npm run smoke
npm run package
```

`npm run verify` chains `check`, `test` and `smoke` in one command, but its smoke
run writes screenshots into `docs/` - use the explicit form above to keep the
work tree clean. `bash scripts/verify-release.sh` is the full local gate: it
packages, checks the bundle, and runs the smoke suite *inside* the built `.app`
against a throwaway vault.

`npm run package` renders icons if needed, builds for the host architecture,
ad-hoc signs (or notarizes with credentials), and writes a versioned zip plus
`dist/napkin++.zip`. To reproduce a specific release architecture:

```bash
./node_modules/.bin/electron-packager . "napkin++" \
  --platform=darwin --arch=universal \
  --app-bundle-id=com.local.napkin-plus-plus \
  --app-version="$(node -p "require('./package.json').version")" \
  --app-category-type=public.app-category.developer-tools \
  --icon=assets/icon.icns \
  --out=dist --overwrite --prune=true --quiet \
  --ignore="^/(docs|tests|dist|scripts|site|\.github|\.zwork|node_modules)($|/)" \
  --ignore="^/(README\.md|CONTRIBUTING\.md|SECURITY\.md|LICENSE\.md|CHANGELOG\.md|package-lock\.json|\.gitignore|\.editorconfig|\.gitattributes)$"
```

Then check the same things CI checks:

```bash
APP="dist/napkin++-darwin-universal/napkin++.app"
lipo -archs "$APP/Contents/MacOS/napkin++"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist"
codesign --verify --deep --strict --verbose=2 "$APP"
```

## Site link check

```bash
npm run site:check
```

`scripts/check-site-links.mjs` walks every `site/*.html`, resolves each internal
`href`/`src` (including `#fragment` and `?query` forms) to a file, and fails with
the page and the missing path. It also evaluates `site/assets/config.js` and
fails if the random footer tagline list is missing, duplicated, too short, or
absent from a page. `ci.yml` runs it on every push; `site.yml` runs it before
deploying. External URLs are not fetched, so the check is offline and
deterministic.

## Checking workflow YAML locally

Workflow files are ordinary YAML, but GitHub's parser is stricter than most. A
fast syntax check on macOS (Python here has no PyYAML):

```bash
ruby -ryaml -e 'ARGV.each { |f| YAML.load_file(f); puts "ok #{f}" }' .github/workflows/*.yml
```

That catches indentation and quoting mistakes. It does not validate the Actions
schema — a wrong input name for an action still passes. For that, install
[actionlint](https://github.com/rhysd/actionlint) and run it in the repo root.

## Costs and limits

- The release matrix builds three architectures on three macOS runners. A release
  is the expensive workflow; do not run it for fun.
- macOS runners are the scarcest hosted runners. If CI queues, look at
  `concurrency` first — a stuck run holds its group.
- Artifacts expire: screenshots after 14 days, the CI zip after 7, release zips
  after 14 (the GitHub Release keeps its copies indefinitely).
