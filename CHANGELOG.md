# Changelog

All notable changes to napkin++ are recorded here. The version in this file and
`package.json` must match the tag: the release workflow refuses to publish a
bundle that disagrees with itself.

## 1.0.0 — 2026-11-15

The first release with a public home, a download, and a way to tell me when
something is wrong.

### Previews and the grid

- Add a live site or repo link and napkin++ captures the page's own social
  preview image, resizes it once, and keeps it beside the vault. Projects
  without an image get a paper letter tile instead of a broken box.
- The project list switches between rows and a thumbnail grid (`⌘⇧G`, or the
  button beside the filter). The choice is remembered.
- Right-click a project → **Refresh preview**, or use the card on Overview.
  Settings can capture every preview at once or clear the cache.
- Previews are fetched only from the URLs you recorded. Local and private
  addresses are refused, responses are capped at 2 MB of HTML and 8 MB of
  image, and there is no headless browser and no screenshot of a signed-in page.

### Detect details from links

- Add a repo link and napkin++ reads the repo's metadata, languages, file tree
  and a handful of small files (`package.json`, `requirements.txt`,
  `vercel.json`, `prisma/schema.prisma`, `.env.example`, …) to suggest the stack.
- Add a live link and it reads the response headers, the page markup, and the
  domain's DNS records: CNAME/NS/MX/TXT are enough to recognise Vercel,
  Netlify, Cloudflare, Namecheap, Route 53, Google Workspace, Resend, SendGrid
  and friends.
- Suggestions arrive in a review sheet with the evidence beside each one.
  Nothing is written until you tick it. Applying is additive: existing stack,
  tags and services are never replaced, and a blank service URL is filled in
  rather than duplicated.
- Detection runs quietly after a link is added and offers a toast; it can be
  turned off in Settings, and works without a GitHub token (a token just raises
  the API limit).

### Feedback, updates, and the way out

- **Feedback & bugs** in the sidebar and the Help menu: write a report, review
  the diagnostics, then open a prefilled GitHub issue, send it by mail, or copy
  it. Diagnostics are version, macOS, settings, counts and the last renderer
  error — never project names, links or secret values.
- **About & updates** shows the build, checks GitHub Releases, offers the
  download, and can skip a version. The check runs once a day and can be turned
  off. Updates are a download and replace: silent install needs a Developer ID
  signature and notarization (see `docs/RELEASING.md`).
- Menu bar and Dock menus gained Feedback, Website and Support entries.

### Under the hood

- Vault schema 4: `thumb` and `detectedAt` per project, plus `previews`,
  `detectOnAdd`, `checkUpdates`, `projectView`, `updateSkipped` and an optional
  `githubToken` in settings. Older vaults normalise on load.
- New pure modules (`app/detect.js`, `app/updates.js`, `app/feedback.js`) with
  unit tests, and a main-process network layer (`app/net.js`) that refuses
  private addresses and caps every response.
- `npm run verify` and `scripts/verify-release.sh`: syntax, tests, a real boot,
  the packaged bundle's identity, icon, signature and a smoke run inside the
  `.app`.
- GitHub Actions for CI, tagged releases (arm64, x64, universal, checksums,
  optional notarization) and the site; issue templates, security policy and a
  release runbook.
- Project initials now ignore parentheticals (`lu-app (2)` is `LA`, not `L(`).

## 0.2.0 — 2026-11-06

- Folders with a colour, filtering, drag-and-drop and a context menu.
- Project merge with a surviving name, alias handling and conflict counts.
- Project capture box: paste a blob and file env vars, snippets, links, logins
  and prose into the current project in one go.
- Inline environment variable editing, copy ticks that survive tab switches,
  and the `.env` export.
- Import previews with per-block line counts; single-project import.
- Eight palettes, custom accents, six Dock colourways, menu-bar icon and
  open-at-login.

## 0.1.0

- First working build: projects, accounts with typed fields, environments,
  notes and snippets with folding, links and services, the command palette,
  quick capture and the local JSON vault with daily backups.
