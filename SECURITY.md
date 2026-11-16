# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | Yes - security fixes ship in the next 1.x release |
| < 1.0 | No |

Only the latest release is supported. There are no backports to older tags and no
patches for pre-1.0 builds.

## Reporting a vulnerability

Email **hello@napkinplusplus.app**. Please do not open a public issue for
anything that could be exploited before there is a fix.

Include:

- the app version (Settings → About) and your macOS version
- what an attacker gains, and what they need to start (a crafted vault file? a
  malicious link in a project? a release asset?)
- reproduction steps, or a minimal vault file with fake values
- whether vault contents or network requests are involved

We aim to acknowledge every report within 72 hours. If you do not hear back in
that window, send it again - assume the mail was lost, not ignored.

Please redact real credentials. A screenshot of the structure is enough; never
attach a working vault.

## How napkin++ handles your data

This is the context you need to judge whether something is a bug:

- **The vault is a plain JSON file** in Electron's `userData` directory, usually
  `~/Library/Application Support/napkin++/vault.json` (`NAPKIN_DATA_DIR` overrides
  the directory). There is no encryption at rest.
  Your macOS account, its file permissions and FileVault are the boundary. Treat
  a copied `vault.json` as compromised.
- **No account, no server, no telemetry.** Nothing is uploaded in the background.
  A feedback report is composed locally (`app/feedback.js`) and sent by you, or
  not at all; diagnostics deliberately exclude project names, links and values.
- **Network access is limited to two things.** The update check reads
  `https://api.github.com/repos/tracyapps/napkin-plus-plus/releases/latest`, and link
  inspection fetches the public URLs in a project (the page itself, its DNS
  records, and GitHub metadata for GitHub links). Those requests go to the sites
  involved and are visible to them.

## In scope

- Vault data leaving the machine through a feature you did not ask for.
- A crafted vault file reading or writing files outside the vault: path
  traversal, symlinks, malicious preview or export paths.
- Renderer compromise: text from a vault or a fetched page executing script with
  access to the preload bridge.
- Release integrity: a substituted asset, a checksum that does not match, or an
  update check pointing anywhere other than the release page.
- Secret exposure: clipboard lifetime, screenshots, logs, or diagnostics that
  include values instead of counts.
- The local preview protocol handler serving something it did not write itself.

## Out of scope

- Someone with your unlocked macOS account, physical access to the machine, or a
  copy of `vault.json`. The vault is not encrypted; that is a documented design
  choice, not a vulnerability.
- macOS malware, keyloggers, screen recording, or a compromised OS.
- Vulnerabilities in Electron, Chromium or Node with no napkin++-specific
  exploit path. Report those upstream, and tell us so we can bump the version.
- Automated scanner output with no reproduction.
- Social engineering, or anything requiring the user to paste a secret into a
  field that is clearly not for secrets.

## What happens next

We reproduce it, fix it in the next release, and credit you if you want credit.
We will ask before public disclosure and will not ask you to stay quiet
indefinitely. There is no bug bounty.
