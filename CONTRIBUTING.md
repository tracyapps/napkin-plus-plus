# Contributing

napkin++ is a small, local-first macOS app. Contributions are welcome, but the
bar for adding surface area is high and the bar for breaking the vault is
absolute.

## Before you write code

- **Open an issue first** for anything larger than a typo or a one-line fix. Bug
  reports use the template; features need agreement before implementation,
  because most "small additions" are a new permanent surface.
- **One change per PR.** A bug fix that also renames files is two PRs. Reviewers
  cannot reason about scope they cannot see.
- **macOS only.** Do not add Windows/Linux branches or cross-platform
  abstractions. There is no build step, no bundler, and no transpiler.

## Before you push

```bash
npm ci
npm run check
npm test
NAPKIN_SHOT_DIR="$(mktemp -d)/shots" npm run smoke
```

`npm run verify` runs the same three gates in one command, but it writes smoke
screenshots into `docs/`; use the explicit form above if you want to keep the
work tree clean.

- If you changed UI, attach before/after screenshots, light and dark.
- If you touched packaging, run `npm run package` and open the app.
- CI runs all of this on `macos-latest`. A PR that only passes on your machine is
  not passing.

## Code style

- **CommonJS.** `require` and `module.exports`. No ESM in app code.
- **Semicolons on every statement.** The codebase uses them throughout; do not
  omit them.
- **Two-space indent**, single quotes, `'use strict'` at the top of each module.
- Keep logic pure and testable in `app/*.js`; keep DOM work in `app/app.js` and
  `app/dom.js`. The renderer files use the existing wrapper so the same file works
  in the window and under `node --test`.
- **No new runtime dependencies without discussion.** `package.json` has none,
  and that is deliberate: every dependency is code you ship to people's Macs.
  A devDependency needs a sentence explaining why the alternative is worse.
- Tests use `node --test`, write to temp directories, and never touch a real
  vault.

## Never commit a vault

The vault is a plain JSON file full of real API keys and passwords.

- Do not add `vault.json`, `.env` files, exported markdown of a real project, or
  backups to the repo.
- Do not paste real credentials into issues, PR descriptions, or test fixtures.
- Screenshots count: blur or replace anything that looks like a key.

## Do not

- Bump the version or hand-edit `CHANGELOG.md` in a PR. Releases go through
  `scripts/bump-version.mjs`; see [docs/RELEASING.md](docs/RELEASING.md).
- Reformat files you did not otherwise change.
- Weaken or delete a test, or edit CI, to turn a check green.

## License of contributions

By opening a PR you agree that your contribution can be included in napkin++ and
licensed under the terms in [LICENSE.md](LICENSE.md). Only submit code you have
the right to submit.
