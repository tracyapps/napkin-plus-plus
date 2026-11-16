/*
 * napkin++ — update checks.
 *
 * The app is ad-hoc signed, so Squirrel.Mac cannot install an update silently:
 * a self-replacing build needs a Developer ID signature and notarization. What
 * this module does instead is honest and works unsigned — read the latest
 * GitHub release, compare versions, and point the user at the download.
 *
 * Pure: no network, no Electron. `main.js` fetches; this decides.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NapkinUpdates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function parseVersion(value) {
    const raw = String(value || '')
      .trim()
      .replace(/^v/i, '');
    const match = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
    if (!match) return null;
    return {
      parts: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] ? match[4].split('.') : [],
    };
  }

  function comparePre(a, b) {
    // No pre-release outranks any pre-release: 1.0.0 > 1.0.0-beta.1
    if (!a.length && !b.length) return 0;
    if (!a.length) return 1;
    if (!b.length) return -1;
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
      const left = a[i];
      const right = b[i];
      if (left === undefined) return -1;
      if (right === undefined) return 1;
      const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
      const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
      if (leftNumber !== null && rightNumber !== null) {
        if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
        continue;
      }
      if (leftNumber !== null) return -1;
      if (rightNumber !== null) return 1;
      if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
  }

  /** Semantic-ish compare: returns -1, 0 or 1. Unparseable versions sort low. */
  function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left && !right) return String(a || '').localeCompare(String(b || ''));
    if (!left) return -1;
    if (!right) return 1;
    for (let i = 0; i < 3; i += 1) {
      if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1;
    }
    return comparePre(left.pre, right.pre);
  }

  function isNewer(candidate, current) {
    return compareVersions(candidate, current) > 0;
  }

  function isPrerelease(version) {
    const parsed = parseVersion(version);
    return Boolean(parsed && parsed.pre.length);
  }

  function zipAssets(release) {
    const assets = Array.isArray(release && release.assets) ? release.assets : [];
    return assets.filter((asset) => /\.zip$/i.test(String(asset && asset.name)));
  }

  /**
   * Pick the best download for this Mac. Universal first, then the host arch,
   * then anything ending in .zip so an old release still has a usable link.
   */
  function pickAsset(release, arch) {
    const assets = zipAssets(release);
    const pattern = arch === 'x64' ? /(x64|x86_64|intel)/i : /(arm64|aarch64|apple)/i;
    return (
      assets.find((asset) => /universal/i.test(asset.name)) ||
      assets.find((asset) => pattern.test(asset.name)) ||
      assets[0] ||
      null
    );
  }

  /**
   * @param {object} release GitHub `releases/latest` JSON
   * @param {string} currentVersion the running app's version
   * @param {string} arch process.arch
   */
  function fromRelease(release, currentVersion, arch) {
    if (!release || typeof release !== 'object') {
      return { ok: false, error: 'No release information yet.' };
    }
    const latest = String(release.tag_name || release.name || '')
      .replace(/^v/i, '')
      .trim();
    if (!latest) return { ok: false, error: 'That release has no version tag.' };
    const asset = pickAsset(release, arch);
    return {
      ok: true,
      current: String(currentVersion || ''),
      latest,
      updateAvailable: isNewer(latest, currentVersion),
      prerelease: Boolean(release.prerelease) || isPrerelease(latest),
      name: release.name || 'v' + latest,
      url: release.html_url || '',
      notes: String(release.body || '').slice(0, 8000),
      publishedAt: release.published_at || '',
      assetUrl: asset ? asset.browser_download_url : '',
      assetName: asset ? asset.name : '',
      assetBytes: asset ? asset.size : 0,
    };
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /** "Checked 4m ago" without pulling in a date library. */
  function checkedAgo(iso, nowMs) {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return 'never';
    const seconds = Math.max(0, Math.round(((nowMs || Date.now()) - then) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.round(minutes / 60);
    if (hours < 48) return hours + 'h ago';
    return Math.round(hours / 24) + 'd ago';
  }

  return {
    parseVersion,
    compareVersions,
    isNewer,
    isPrerelease,
    pickAsset,
    fromRelease,
    formatBytes,
    checkedAgo,
  };
});
