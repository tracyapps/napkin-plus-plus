## What changed

<!-- One or two sentences. Link the issue if there is one: Fixes #123 -->

## Why

<!-- The problem this solves, not the mechanism. -->

## Verification

CI runs these too, but run them locally before pushing:

- [ ] `npm run check` passes
- [ ] `npm test` passes
- [ ] `npm run smoke` passes (and I looked at the screenshots it wrote)
- [ ] If this touches UI: screenshots attached below, light and dark
- [ ] `npm run package` still produces a working `dist/napkin++.zip` (only if this touches packaging)

## Scope

- [ ] One change per PR - no unrelated refactors or drive-by reformatting
- [ ] No new runtime dependencies (or: discussed in an issue first, link above)
- [ ] No vault data, `.env` files, keys or tokens in the diff
- [ ] Version numbers untouched - releases bump them via `scripts/bump-version.mjs`

## Notes for review

<!-- Anything the reviewer should know: tradeoffs, follow-ups, what you did not do. -->
