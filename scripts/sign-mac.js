#!/usr/bin/env node
/*
 * Sign a packaged napkin++.app the way Electron apps are supposed to be signed.
 *
 *   node scripts/sign-mac.js "dist/napkin++-darwin-universal/napkin++.app"
 *
 * `codesign --deep` is deprecated and, on Electron's layout, leaves a few loose
 * binaries ad-hoc signed (`libffmpeg.dylib`, `libvk_swiftshader.dylib`, Squirrel's
 * `ShipIt`). Apple's notary service rejects the whole bundle for that, and the
 * only symptom is "Record not found" when stapling. @electron/osx-sign walks
 * the bundle inside-out, signs frameworks, helpers and loose dylibs with the
 * Developer ID identity, applies the hardened runtime and a secure timestamp.
 *
 * Environment:
 *   MACOS_SIGN_IDENTITY   optional full identity name; auto-detected otherwise
 *   ENTITLEMENTS_PLIST    optional; defaults to scripts/entitlements.mac.plist
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sign } = require('@electron/osx-sign');

const app = process.argv[2];
if (!app) {
  process.stderr.write('usage: node scripts/sign-mac.js <path/to/App.app>\n');
  process.exit(2);
}
if (!app.endsWith('.app') || !fs.existsSync(path.join(app, 'Contents', 'Info.plist'))) {
  process.stderr.write('not an .app bundle: ' + app + '\n');
  process.exit(2);
}

const entitlements =
  process.env.ENTITLEMENTS_PLIST || path.join(__dirname, 'entitlements.mac.plist');
if (!fs.existsSync(entitlements)) {
  process.stderr.write('entitlements file missing: ' + entitlements + '\n');
  process.exit(2);
}

const options = {
  app: path.resolve(app),
  platform: 'darwin',
  hardenedRuntime: true,
  entitlements,
};
if (process.env.MACOS_SIGN_IDENTITY) options.identity = process.env.MACOS_SIGN_IDENTITY;

sign(options)
  .then(() => {
    process.stdout.write('signed with @electron/osx-sign: ' + options.app + '\n');
  })
  .catch((error) => {
    process.stderr.write('signing failed: ' + (error && error.message ? error.message : error) + '\n');
    process.exit(1);
  });
