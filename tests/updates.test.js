'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const updates = require('../app/updates.js');

test('compares release versions like a human would', () => {
  assert.equal(updates.compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(updates.compareVersions('v1.2.0', '1.2.0'), 0);
  assert.equal(updates.compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(updates.compareVersions('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(updates.compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(updates.compareVersions('nonsense', '1.0.0'), -1);
  assert.equal(updates.isNewer('1.0.1', '1.0.0'), true);
  assert.equal(updates.isNewer('1.0.0', '1.0.0'), false);
});

test('parses versions with prerelease and build metadata', () => {
  assert.deepEqual(updates.parseVersion('v2.3.4-rc.1+build.5'), {
    parts: [2, 3, 4],
    pre: ['rc', '1'],
  });
  assert.equal(updates.parseVersion('1.0'), null);
  assert.equal(updates.isPrerelease('1.1.0-beta.1'), true);
  assert.equal(updates.isPrerelease('1.1.0'), false);
});

test('picks the universal zip first, then the host architecture', () => {
  const release = {
    assets: [
      { name: 'napkin++-1.0.0-arm64.zip', browser_download_url: 'https://x/arm.zip', size: 1 },
      { name: 'napkin++-1.0.0-x64.zip', browser_download_url: 'https://x/x64.zip', size: 1 },
      { name: 'napkin++-1.0.0-universal.zip', browser_download_url: 'https://x/uni.zip', size: 2 },
    ],
  };
  assert.equal(updates.pickAsset(release, 'arm64').name, 'napkin++-1.0.0-universal.zip');
  const withoutUniversal = { assets: release.assets.slice(0, 2) };
  assert.equal(updates.pickAsset(withoutUniversal, 'arm64').name, 'napkin++-1.0.0-arm64.zip');
  assert.equal(updates.pickAsset(withoutUniversal, 'x64').name, 'napkin++-1.0.0-x64.zip');
});

test('turns a GitHub release into a check result', () => {
  const release = {
    tag_name: 'v1.0.1',
    name: 'napkin++ 1.0.1',
    body: 'Fixes the thing.',
    html_url: 'https://github.com/tapps/napkin-plus-plus/releases/tag/v1.0.1',
    published_at: '2026-11-01T12:00:00Z',
    prerelease: false,
    assets: [
      {
        name: 'napkin++-1.0.1-universal.zip',
        browser_download_url: 'https://github.com/x/y.zip',
        size: 8 * 1024 * 1024,
      },
    ],
  };
  const result = updates.fromRelease(release, '1.0.0', 'arm64');
  assert.equal(result.ok, true);
  assert.equal(result.latest, '1.0.1');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.prerelease, false);
  assert.equal(result.assetUrl, 'https://github.com/x/y.zip');
  assert.equal(result.notes, 'Fixes the thing.');
  assert.equal(updates.fromRelease(release, '1.0.1', 'arm64').updateAvailable, false);
  assert.equal(updates.fromRelease(null, '1.0.0').ok, false);
  assert.equal(updates.fromRelease({ assets: [] }, '1.0.0').ok, false);
});

test('a release without a zip still yields a usable link', () => {
  const result = updates.fromRelease(
    { tag_name: 'v2.0.0', html_url: 'https://github.com/x/y/releases/tag/v2.0.0', assets: [] },
    '1.0.0',
    'arm64'
  );
  assert.equal(result.ok, true);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.assetUrl, '');
  assert.equal(result.url, 'https://github.com/x/y/releases/tag/v2.0.0');
});

test('formats sizes and elapsed time for the about sheet', () => {
  assert.equal(updates.formatBytes(0), '');
  assert.equal(updates.formatBytes(900 * 1024), '900 KB');
  assert.equal(updates.formatBytes(8 * 1024 * 1024), '8.0 MB');
  const now = Date.parse('2026-11-15T12:00:00Z');
  assert.equal(updates.checkedAgo('2026-11-15T11:58:00Z', now), '2m ago');
  assert.equal(updates.checkedAgo('2026-11-15T06:00:00Z', now), '6h ago');
  assert.equal(updates.checkedAgo('', now), 'never');
});
