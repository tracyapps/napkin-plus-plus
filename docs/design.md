# napkin++ — design notes

## The problem, in one sentence

Development knowledge is scattered across a text file, a password manager that
cannot hold a `.env` block, six dashboards, and your head — and the moment you
need a value, you are guessing which of those it is in.

The tool that fixes this is not a password manager with a notes field. It is a
**project dossier** with copy buttons and a search box.

## Principles

1. **A project is the unit, not an item.** You think “what does lu app run on?”,
   not “which vault entry has the Resend key?”. The project is the folder; links,
   services, environments, accounts, notes and snippets are its contents.
2. **Copying is the primary verb.** Every value has a one-click copy: a field, a
   `KEY=value` line, a whole `.env`, a URL, a snippet. `⌘↵` copies straight from
   search results without opening anything.
3. **Search is the navigation.** The sidebar and list are for browsing; `⌘K` is
   how you actually get somewhere. Search indexes values, not just titles:
   searching `resend` surfaces the service, the project, and the env var.
4. **Create first, organize later.** A project can be a name. No required
   fields, no wizard. Details accrete.
5. **Accounts are a list.** Test users, client logins, dev/prod identities — all
   shown at once. Collapsing them behind a “primary account” is the wrong
   default for development.
6. **Merge is a repair action, not a workflow.** Creating `lu-app` when `lu app`
   exists should offer to merge, not silently make a second project. Merging
   adds the old name as an alias and unions the contents.
7. **Local means local.** No account, no sync, no telemetry. The vault is a
   file you can read, grep, back up and move. The network is used only when the
   person points the app at a link (previews, detection) or asks about updates;
   there is no background sync and no analytics. `NAPKIN_OFFLINE=1` turns all of
   it off, and both behaviours have a switch in Settings.

## Data model

```
vault
  settings, ui.recent
  projects[]
    name, aliases, description, status, favorite, tags, stack
    links[]        label, kind (repo/live/staging/docs/dashboard), url
    services[]     provider, role, url, notes
    envs[]         name, url, vars[] { key, value, hidden }
    accounts[]     label, email, username, service, env, notes, fields[]
    entries[]      type, title, body, language, tags, pinned
```

`accounts[].fields[]` is `{ label, value, hidden }`, not `password`. A login, a
PIN, an API token and a recovery code are the same shape, and different accounts
need different ones. The account dialog presets a **Password** field because
that is the common case; “Add field” covers the rest. Hidden fields are masked
in lists, redacted in Markdown export by default, and copied with the clipboard
timeout.

`entries[].type` covers `note`, `snippet`, `command`, `secret`, `recovery`,
`instruction`. Snippets and commands get the code viewer (line numbers,
folding); notes can too.

### Why not Markdown files per project?

Round-tripping structured data (multiple envs, ordered accounts, fields) through
Markdown is lossy and fragile. One JSON document keeps edits atomic and makes
merging deterministic. Markdown is the **export** format, redacted by default.
The JSON is human-readable, diffable and greppable when you need it.

### Why one document instead of SQLite?

The vault is small (single-digit MB at worst), and a single document makes
backups, undo snapshots, corruption recovery and cross-window consistency
trivial. If it ever grows past that, the reducer boundary makes a SQLite store a
contained change.

## Interaction design

**Three panes, fixed responsibilities.** Sidebar = where you are (views, tags,
tools). List = which project. Detail = the dossier. No modals for navigation.

**The palette is a first-class surface.** It opens over everything, shows a
badge per result type, highlights matches, and puts the copy action on `⌘↵`.
`⇥` cycles type filters. It is deliberately not the same component as the
project filter.

**Quick capture is a different tool.** Summoned globally, it is for *writing*,
not browsing: one omnibox, four modes, a target project, and a live inference
(“looks like 6 env vars”). `↵` does the obvious thing; near-duplicates open the
existing project first. It never blocks on a form.

**Accounts are a table, not cards.** You compare test accounts by email/env; a
table with a fields column is denser and more scannable. Masked values keep the
row height stable.

**Env vars are a table plus an inline add row.** Pasting is the common path;
typing a single variable should not require a dialog. `Copy .env` is always one
click from the tab.

**Line numbers and folding are table stakes for code.** A 60-line JSON blob or a
curl command should collapse. Folding is computed locally: braces for JS/CSS/
JSON, indentation for Python/YAML, strings and comments respected. No syntax
highlighting in v1 — the mono type and the gutter carry the structure without
the noise.

**Import is a preview, not a commitment.** The importer reads hand-written
notes in the order the writer actually used: dashed rules first (they are the
strongest signal), then Markdown/`Project:` headings, then blank-line blocks.
Short ALL-CAPS section labels are only treated as headings when the file has no
dividers at all — otherwise `WP ADMIN:`, `SUPABASE` and `BEGIN PUBLIC KEY`
become data inside a block, not thirteen accidental projects. Every block shows
its line count and what was detected (vars, accounts, links), and a single
toggle collapses the whole file into one project with the raw text preserved as
a note. Naming skips credential shorthand (`user: …`, `p: …`), DSNs, access key
IDs and base64 so a password does not become a project title.

**Paper you choose, not another blue dashboard.** The default light theme is
paper (`#f4efe7`), ink, and burnt orange; dark is graphite with the same accent.
Eight paper stocks (Paper, Slate, Nord, Forest, Ocean, Rose, Sand, Graphite) each
carry a light and a dark set of surfaces, and the accent is either a preset or
any hex colour. Type badges still carry color per entity so the palette is
scannable without reading every line. System theme follows macOS; the palette
and accent overrides are in Settings.

## Merge semantics

- The kept project and its name are chosen explicitly. Other names become
  aliases (deduped, never equal to the kept name).
- Links dedupe by URL (or label + kind). Services dedupe by provider + role.
- Env sets match by name; variables match by key. Target values win unless the
  merge explicitly prefers the source.
- Accounts dedupe only when label, email, username **and** all field values
  match. Two test accounts with the same email but different passwords are
  different accounts.
- Entries dedupe by type + title + body.
- Sources are removed after merging; the whole operation is one undo step.

On create, “keep separate” must still respect unique names, so it appends ` (2)`
when normalization collides (`lu app` vs `lu-app`). The merge sheet is the better
path and says so.

## Storage and safety

- Atomic write: temp file, `fsync`, rename.
- Daily backup plus a previous-save backup; corruption keeps the evidence and
  restores the newest good file.
- Secret copies schedule a clipboard clear after 45s (configurable), and only
  clear if the clipboard still contains that exact value.
- Markdown export redacts hidden fields and secret entries by default.
- No encryption at rest in v1. FileVault is the mitigation; encryption is the
  next security milestone.

## Shipping and chrome

- The distributable is an `.app` built with `@electron/packager` for arm64,
  x64 or universal, zipped with a checksum. Ad-hoc signed by default; the same
  script and CI notarize when Developer ID credentials are present. Updates are
  a version check plus a download link, not a silent install. The app bundle carries
  the Paper icon as its `.icns`; runtime Dock-icon changes use `app.dock.setIcon`
  with the 1024px tinted PNGs. Right-clicking the Dock icon opens a menu with
  Quick Capture, Search, New Project and Settings (`app.dock.setMenu`).
- The menu bar is the always-available surface: a 16/32px monochrome template
  glyph (`++` only — a napkin outline turns to mush at 18px), with Show, Quick
  Capture, Search, Settings, Open at Login and Quit. The tray keeps the app
  alive after the window closes.
- Login startup is opt-in and only shown when packaged. Electron 45 no longer
  uses `openAsHidden`; the app detects `wasOpenedAtLogin` and keeps the initial
  window hidden, leaving the menu bar icon as the entry point.
- Four dock icon forms share one family: Paper (cream sheet, ink `++`), Ink
  (charcoal, cream `++`), Grid (faint graph paper), Classic (the old `n++`).
  Each comes in six colourways (Paper, Ember, Moss, Ink, Plum, Graphite), and
  `Auto` follows the accent. The mark is hand-drawn in SVG with round caps and
  slightly bowed strokes; the paper is 800/1024, tilted 4.5°, with a single
  folded-corner cue so it survives 32px without texture.
- The dev build and the packaged app deliberately share one vault and one
  single-instance lock. Running both at once is prevented; quit the dev copy
  before opening the app.

## 1.0: recognition, not automation

Two features were added for the first public release, and both follow the same
rule: the app may *notice* things, but the person decides what becomes part of
the dossier.

**Previews.** A project should be recognisable before its name is read. The
image is the one the site already publishes for link unfurls (Open Graph,
Twitter card, a large touch icon) — not a browser screenshot. A screenshot
would require rendering someone's page, would capture whatever state it was in,
and would be wrong the moment the site changed. The published card is
intentional, stable, and cheap to fetch. When there is none, a paper letter tile
is better than a grey rectangle or a spinner that never resolves.

The grid is a second reading of the same list, not a separate destination. Same
filter, same sort, same folders, same right-click. `⌘⇧G` toggles it; the choice
is a setting because people browse in moods, not modes.

**Detection.** The alternative — a form asking for “hosting, database, auth” —
is a form nobody fills in. But silently writing guesses into a dossier is worse:
it makes the vault less trustworthy, and the point of the vault is trust.
So detection collects evidence (a response header, a CNAME, a dependency, a
file in the repo), shows that evidence next to each suggestion, and applies only
what is ticked. Applying is additive: a service fills in a blank URL instead of
replacing a real one, an existing stack entry is never renamed.

The sources are deliberately small: response headers, the page markup, DNS
records, GitHub's metadata/languages/tree plus a handful of manifest files. No
headless browser, no third-party scanner, no account. It will miss things — a
monorepo, a private repo, an env var only set in a dashboard — and it says so
with a warning rather than guessing.

**Feedback and updates.** A local-first app still needs a way to hear that it
broke. The report is composed in the app, redacted by construction, and sent by
the person through GitHub or mail; the app makes no request of its own. Update
checks are one GET to GitHub Releases, once a day, and the result is a download
link — because an ad-hoc signed bundle cannot replace itself safely. That limit
is stated in the UI rather than hidden behind an “Update” button that fails.

## Deliberately left out of 1.0

- Encryption at rest and a lock screen.
- TOTP generation (codes change; storing the seed is a different feature).
- Sync, sharing, teams.
- Browser extension and autofill.
- Attachments and images in notes.
- Silent in-place auto-update (needs a notarized Developer ID build; the check
  and download path ships instead).
- Rich text; notes are plain text/markdown.

## Next, in order

1. **Encryption at rest** with a passphrase and a recovery key (Argon2id or
   scrypt + AES-256-GCM), opt-in, with a clear lockout warning.
2. **Import adapters** for 1Password/Bitwarden CSV and `.env` folders.
3. **TOTP** with a copyable current code.
4. **Clipboard-capture hotkey** and a “capture selection” flow from the menu bar.
5. **Project templates** (Next.js + Vercel + Neon) to prefill services.
6. **In-place updates** once the release is notarized and the update feed has
   been stable for a few versions.
7. **Vault diff/history** (append-only operation log) if undo needs to survive
   relaunch.

## What we would measure

- Time from summon to copied value (target: under 3 seconds).
- Fraction of projects with a repo, live URL, env vars and at least one account
  (the “setup complete” card is the instrument).
- Duplicate merges per month (are names converging or drifting?).
- Import completion rate (does the old text file actually get in?).
