# napkinplusplus.app

The public site: the landing page, support, contact, privacy, changelog, and a
404. No framework, no build step, no analytics. The app it describes requires macOS
13+; that number comes from Electron's `LSMinimumSystemVersion`.

## Deploy

Vercel, with **this folder as the project root**.

1. Import `tapps/napkin-plus-plus` in Vercel.
2. Root Directory: `site`. Framework Preset: **Other**. Build command: empty.
   Output directory: `.` (the files are already static).
3. Add `napkinplusplus.app` as the production domain and point the DNS records
   Vercel shows at your registrar (or move the nameservers to Vercel).
4. Set the environment variables below, then redeploy.

`.github/workflows/site.yml` deploys with the CLI when `VERCEL_TOKEN`,
`VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are present; otherwise it runs the
internal-link check and skips the deploy with a notice. The Vercel Git
integration is the simpler path — pick one, not both.

## Contact form

`contact.html` posts JSON to `/api/contact` (a Vercel Node function in
`api/contact.js`). It sends through [Resend](https://resend.com).

| Variable | Value |
| --- | --- |
| `RESEND_API_KEY` | a Resend API key for the verified `napkinplusplus.app` domain |
| `CONTACT_TO` | `hello@napkinplusplus.app` (default) |
| `CONTACT_FROM` | `napkin++ <hello@napkinplusplus.app>` — must be on the verified domain |

Without `RESEND_API_KEY` the endpoint returns 503 and the page falls back to a
`mailto:` link with the message already filled in. That is deliberate: a form
that pretends to send is worse than one that says it cannot.

Reply-to is the sender's address, so hitting reply in the inbox works.

## Local preview

There is no build step, but the contact endpoint needs a server. Any static
server works for the pages; the form will show its fallback.

```bash
python3 -m http.server 4173 --directory site
open http://localhost:4173
```

`vercel dev --cwd site` also runs the function locally.

## Screenshots

`assets/shots/` is generated from `docs/` by `npm run shots`, which crops the
empty bottom of the accounts and env captures and resizes the rest to 1600px:

```
docs/preview.png            → assets/shots/overview.png
docs/preview-grid.png       → assets/shots/grid.png
docs/preview-accounts.png   → assets/shots/accounts.png
docs/preview-env.png        → assets/shots/env.png
docs/preview-palette.png    → assets/shots/palette.png
docs/preview-quick.png      → assets/shots/quick.png
docs/preview-settings.png   → assets/shots/settings.png
docs/preview-folders.png    → assets/shots/folders.png
docs/preview-detect.png     → assets/shots/detect.png
```

Regenerate them with `npm run smoke && npm run shots`. The social card is
rendered by `npm run og` into `assets/og.png` (1200×630).

## About the tone

Lowercase headings, one accent, no user counts or testimonials. The app is free
and made by one person; the site should sound like that. Support handles live in
`assets/config.js` — the same ones as the other apps.
