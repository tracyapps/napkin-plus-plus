'use strict';

/*
 * Renders the dock icon variants, the menu-bar template glyph and the .icns
 * from scripts/icon.html.
 *
 *   ./node_modules/.bin/electron scripts/make-icons.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const ICONS = path.join(ASSETS, 'icons');
const VARIANTS = ['napkin', 'ink', 'grid', 'classic'];
// Colourways. "paper" is the default cream; the rest tint the sheet, the fold
// and the ink together so the Dock icon can follow the accent.
const TINTS = ['paper', 'ember', 'moss', 'ink', 'plum', 'graphite'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(ICONS, { recursive: true });

  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false },
  });
  await win.loadFile(path.join(__dirname, 'icon.html'), { query: { style: 'napkin' } });
  await sleep(400);

  for (const style of VARIANTS) {
    for (const tint of TINTS) {
      win.setContentSize(1024, 1024);
      await win.webContents.executeJavaScript(
        `window.setIconStyle(${JSON.stringify(style)}, false, ${JSON.stringify(tint)})`
      );
      await sleep(200);
      const image = await win.webContents.capturePage();
      const png = image.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG();
      const name = style + '--' + tint;
      fs.writeFileSync(path.join(ICONS, name + '.png'), png);
      execFileSync(
        'sips',
        ['-z', '128', '128', path.join(ICONS, name + '.png'), '--out', path.join(ICONS, name + '@128.png')],
        { stdio: 'ignore' }
      );
      // Keep the legacy filenames pointing at the default colourway.
      if (tint === 'paper') {
        fs.copyFileSync(path.join(ICONS, name + '.png'), path.join(ICONS, style + '.png'));
        fs.copyFileSync(path.join(ICONS, name + '@128.png'), path.join(ICONS, style + '@128.png'));
        if (style === 'napkin') fs.writeFileSync(path.join(ASSETS, 'icon.png'), png);
      }
    }
  }

  win.setContentSize(64, 64);
  await win.webContents.executeJavaScript(`window.setIconStyle('napkin', true, 'paper')`);
  await sleep(300);
  const trayImage = await win.webContents.capturePage();
  const tray2x = trayImage.resize({ width: 32, height: 32, quality: 'best' }).toPNG();
  const tray1x = trayImage.resize({ width: 16, height: 16, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(ASSETS, 'trayTemplate@2x.png'), tray2x);
  fs.writeFileSync(path.join(ASSETS, 'trayTemplate.png'), tray1x);
  win.destroy();

  const iconset = path.join(os.tmpdir(), 'napkin-iconset-' + process.pid + '.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  const sizes = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of sizes) {
    execFileSync(
      'sips',
      ['-z', String(size), String(size), path.join(ASSETS, 'icon.png'), '--out', path.join(iconset, name)],
      { stdio: 'ignore' }
    );
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ASSETS, 'icon.icns')], {
    stdio: 'ignore',
  });
  fs.rmSync(iconset, { recursive: true, force: true });

  process.stdout.write(
    'wrote assets/icon.png, assets/icon.icns, assets/icons/*.png (' +
      VARIANTS.length * TINTS.length +
      ' tinted variants), assets/trayTemplate*.png\n'
  );
  app.exit(0);
}).catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
  app.exit(1);
});
