'use strict';

/*
 * Copies the smoke run's screenshots into the site, cropped to the part that
 * actually has something in it.
 *
 *   npm run smoke && npm run shots
 *
 * The app window is 16:10; tabs with two rows of content leave the bottom half
 * empty, which reads as a broken image in a marketing page. Cropping is done
 * here, per file, instead of in CSS so the source in docs/ stays untouched.
 */

const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', 'docs');
const TARGET = path.join(__dirname, '..', 'site', 'assets', 'shots');

// [source, output, cropHeight (px, from the top) or 0 for the whole frame, width]
const SHOTS = [
  ['preview.png', 'overview.png', 0, 1600],
  ['preview-grid.png', 'grid.png', 0, 1600],
  ['preview-accounts.png', 'accounts.png', 980, 1600],
  ['preview-env.png', 'env.png', 860, 1600],
  ['preview-folders.png', 'folders.png', 0, 1600],
  ['preview-palette.png', 'palette.png', 0, 1600],
  ['preview-quick.png', 'quick.png', 0, 1320],
  ['preview-settings.png', 'settings.png', 0, 1600],
  ['preview-detect.png', 'detect.png', 0, 1600],
];

app.whenReady().then(() => {
  fs.mkdirSync(TARGET, { recursive: true });
  let written = 0;
  for (const [source, output, cropHeight, width] of SHOTS) {
    const file = path.join(SOURCE, source);
    if (!fs.existsSync(file)) {
      process.stderr.write(`shots: missing ${file} - run npm run smoke first\n`);
      continue;
    }
    let image = nativeImage.createFromPath(file);
    const size = image.getSize();
    if (!size.width) {
      process.stderr.write(`shots: could not read ${file}\n`);
      continue;
    }
    if (cropHeight > 0 && cropHeight < size.height) {
      image = image.crop({ x: 0, y: 0, width: size.width, height: cropHeight });
    }
    const cropped = image.getSize();
    if (cropped.width > width) {
      image = image.resize({ width, quality: 'good' });
    }
    const png = image.toPNG();
    fs.writeFileSync(path.join(TARGET, output), png);
    written += 1;
    process.stdout.write(`shots: ${output} (${image.getSize().width}×${image.getSize().height})\n`);
  }
  process.stdout.write(`shots: ${written}/${SHOTS.length} written to ${TARGET}\n`);
  app.exit(written === SHOTS.length ? 0 : 1);
});
