# macOS packaging notes

Verified against Electron 45.2.1 on macOS arm64, November 2026.

## Build

```bash
./node_modules/.bin/electron-packager . "napkin++" \
  --platform=darwin --arch=arm64 \
  --app-bundle-id=com.local.napkin-plus-plus \
  --app-version=0.1.0 \
  --icon=assets/icon.icns \
  --out=dist --overwrite --prune=true \
  --ignore="^/(docs|tests|dist|scripts|\.zwork|node_modules)($|/)"
```

Output: `dist/napkin++-darwin-arm64/napkin++.app`. The `++` in the app name is
kept verbatim, including the executable name in `Contents/MacOS/napkin++`.

Packager logs a warning that it cannot find `assets/icon.icns` with extension
`.icon`. That is Apple's newer Icon Composer format; it is optional. Packager
then copies the `.icns` under the default `CFBundleIconFile` name
(`electron.icns`). The package script renames that file to `napkin.icns` and
updates the plist before signing, so the bundle reads correctly.

`--asar` is on by default in this version. `fs`, `nativeImage` and renderer
`file://` asset loads all work from inside the archive; the settings icon
thumbnails and the tray/dock smoke checks pass in the packaged build.

## Signing and Gatekeeper

- An unsigned build launches locally, but ad-hoc signing is cheap and removes a
  class of “app is damaged” failures: `codesign --force --deep --sign - "$APP"`.
- Do **not** add `--options runtime` to the ad-hoc signature; without a real
  Team ID it can fail dynamic loading.
- Locally built apps are not quarantined. If the `.zip` is copied between
  machines, right-click → Open is the fallback.
- No notarization or auto-update in v1.

## Login item

- `app.setLoginItemSettings({ openAtLogin: true })` works for the packaged app,
  including outside `/Applications` (ad-hoc signed). It is deliberately disabled
  when `!app.isPackaged`.
- Electron 45 dropped `openAsHidden`. Use `app.getLoginItemSettings().wasOpenedAtLogin`
  to detect a login launch and keep the initial window hidden; the menu-bar icon
  becomes the entry point.
- `getLoginItemSettings()` also exposes `status` (macOS 13+); surface it if the
  registration needs approval in System Settings.
- Registering from a temporary build path is fragile. Move the `.app` to
  `/Applications` before enabling “Open at login”.

## Menu bar

- Tray template images should be 16×16 and 32×32 (`trayTemplate.png`,
  `trayTemplate@2x.png`), pure black with alpha.
- Call `image.setTemplateImage(true)` on the `nativeImage` (not on the Tray).
- Menu items: Show, Quick Capture, Search, Settings, Open at Login (checkbox),
  Quit. A settings role does not exist; use a custom item with `Cmd+,` in the
  app menu.
- Destroying the Tray when the user turns the menu-bar icon off is safe; recreate
  it when they turn it back on.

## Dock icon

- `app.dock.setIcon(path)` accepts a PNG and can be called repeatedly; the
  packaged app resolves paths inside `app.asar`.
- `setIcon(null)` reverts to the bundle icon on current macOS but is
  undocumented; the app always sets an explicit variant instead.
- Cache the last applied style so normal vault writes do not re-decode the PNG.

## Single instance

- The lock is keyed per `userData` directory. Dev (`npm start`) and the packaged
  app share `~/Library/Application Support/napkin++`, so they collide by design:
  quit the dev copy before opening the app.
- Finder `open` sends `activate`, not `second-instance`; the `activate` handler
  must clear the “started hidden” flag and show the window.
