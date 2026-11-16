'use strict';

/*
 * Renders the social card once, in the same Chromium that ships with the app.
 *
 *   npm run og
 *
 * Writes site/assets/og.png (1200×630) and docs/og.png. Keeping the card as
 * HTML means it can be re-rendered after a copy change without a design tool.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const WIDTH = 1200;
const HEIGHT = 630;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    useContentSize: true,
    backgroundColor: '#f4efe7',
    webPreferences: { offscreen: false, contextIsolation: true, sandbox: true },
  });
  await win.loadFile(path.join(__dirname, 'og.html'));
  // Give the system font a beat to settle before the capture.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const shot = await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
  // capturePage follows the display scale; the card itself must be exactly
  // 1200×630 for link unfurls.
  const image = shot.resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
  const png = image.toPNG();
  if (!png || !png.length) {
    process.stderr.write('og: capture was empty\n');
    app.exit(1);
    return;
  }
  const site = path.join(__dirname, '..', 'site', 'assets', 'og.png');
  const docs = path.join(__dirname, '..', 'docs', 'og.png');
  fs.mkdirSync(path.dirname(site), { recursive: true });
  fs.writeFileSync(site, png);
  fs.writeFileSync(docs, png);
  process.stdout.write(`og: wrote ${site} and ${docs} (${Math.round(png.length / 1024)} KB)\n`);
  app.exit(0);
});
