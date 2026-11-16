'use strict';

/*
 * napkin++ — project previews.
 *
 * A link becomes a card: fetch the page, take the image it already publishes as
 * its social preview (og:image / twitter:image / a large touch icon), shrink it
 * once, and keep it next to the vault. No headless browser, no screenshot of
 * someone's signed-in dashboard, no caching anything but the image.
 *
 * Previews live in <userData>/previews/<projectId>.png and are served to the
 * renderer through the napkin-thumb:// protocol.
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('./net.js');
const detect = require('./detect.js');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TARGET_WIDTH = 720;

function isSafeId(value) {
  return /^[A-Za-z0-9_-]{6,80}$/.test(String(value || ''));
}

function sniffImage(buffer, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('image/svg')) return 'svg';
  if (type.startsWith('image/')) return type.slice(6).split(';')[0];
  const head = buffer.subarray(0, 12);
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpeg';
  if (head.slice(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (head.slice(0, 4).toString('ascii') === 'RIFF' && head.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'bmp';
  return '';
}

class PreviewStore {
  constructor(options) {
    const opts = options || {};
    this.dir = opts.dir || path.join(process.cwd(), 'previews');
    this.cache = new Map();
  }

  ensure() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(projectId) {
    if (!isSafeId(projectId)) return '';
    return path.join(this.dir, projectId + '.png');
  }

  has(projectId) {
    const file = this.file(projectId);
    return Boolean(file && fs.existsSync(file));
  }

  clear(projectId) {
    const file = this.file(projectId);
    if (!file) return false;
    try {
      fs.unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }

  clearAll() {
    let removed = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!/^[A-Za-z0-9_-]+\.png$/.test(name)) continue;
        try {
          fs.unlinkSync(path.join(this.dir, name));
          removed += 1;
        } catch {
          /* keep going */
        }
      }
    } catch {
      /* no directory yet */
    }
    return removed;
  }

  size(projectId) {
    const file = this.file(projectId);
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  /**
   * Capture the social preview for one project.
   * @param {{projectId:string, pageUrl:string}} input
   * @returns {Promise<{ok:boolean,error?:string,imageUrl?:string,bytes?:number}>}
   */
  async capture(input) {
    const projectId = input && input.projectId;
    const pageUrl = input && input.pageUrl;
    if (!isSafeId(projectId)) return { ok: false, error: 'Unknown project.' };
    if (!pageUrl) return { ok: false, error: 'Add a live or repo link first.' };
    if (net.offline()) return { ok: false, error: 'Previews are off while offline.' };

    const cached = this.cache.get(projectId);
    const nowMs = Date.now();
    if (cached && cached.url === pageUrl && nowMs - cached.at < 10 * 60 * 1000) {
      return cached.result;
    }

    const page = await net.request(pageUrl, {
      maxBytes: 2 * 1024 * 1024,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.4',
    });
    if (!page.ok) {
      const result = { ok: false, error: page.error || 'Could not load that page.' };
      this.cache.set(projectId, { url: pageUrl, at: nowMs, result });
      return result;
    }
    const html = page.body.toString('utf8');
    const imageUrl = detect.pickPreviewImage(html, page.finalUrl || pageUrl);
    if (!imageUrl) {
      const result = { ok: false, error: 'That page has no social preview image.' };
      this.cache.set(projectId, { url: pageUrl, at: nowMs, result });
      return result;
    }

    const image = await net.request(imageUrl, {
      maxBytes: MAX_IMAGE_BYTES,
      accept: 'image/png,image/jpeg,image/webp,image/*;q=0.8',
    });
    if (!image.ok) {
      const result = { ok: false, error: image.error || 'Could not download the preview image.' };
      this.cache.set(projectId, { url: pageUrl, at: nowMs, result });
      return result;
    }
    const type = sniffImage(image.body, (image.headers || {})['content-type']);
    if (!type || type === 'svg') {
      const result = { ok: false, error: 'The preview image is not in a format napkin++ can resize.' };
      this.cache.set(projectId, { url: pageUrl, at: nowMs, result });
      return result;
    }

    let nativeImage;
    try {
      nativeImage = require('electron').nativeImage;
    } catch {
      return { ok: false, error: 'Preview rendering is only available in the app.' };
    }
    const decoded = nativeImage.createFromBuffer(image.body);
    if (decoded.isEmpty()) {
      const result = { ok: false, error: 'That image could not be decoded.' };
      this.cache.set(projectId, { url: pageUrl, at: nowMs, result });
      return result;
    }
    const size = decoded.getSize();
    const scaled =
      size.width > TARGET_WIDTH
        ? decoded.resize({ width: TARGET_WIDTH, quality: 'good' })
        : decoded;
    const png = scaled.toPNG();
    if (!png || !png.length) {
      return { ok: false, error: 'That image could not be resized.' };
    }

    this.ensure();
    const file = this.file(projectId);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, png);
    fs.renameSync(tmp, file);
    const result = {
      ok: true,
      imageUrl,
      bytes: png.length,
      width: scaled.getSize().width,
      height: scaled.getSize().height,
    };
    this.cache.set(projectId, { url: pageUrl, at: nowMs, result });
    return result;
  }
}

/** Which link should become the card? Live first, then staging, then the repo. */
function previewSource(project) {
  if (!project || !Array.isArray(project.links)) return null;
  const live = project.links.find((link) => link.kind === 'live' && /^https?:/i.test(link.url));
  if (live) return { url: live.url, source: 'live' };
  const staging = project.links.find((link) => link.kind === 'staging' && /^https?:/i.test(link.url));
  if (staging) return { url: staging.url, source: 'staging' };
  const repo = project.links.find((link) => link.kind === 'repo' && /^https?:/i.test(link.url));
  if (repo) return { url: repo.url, source: 'repo' };
  return null;
}

module.exports = { PreviewStore, previewSource, sniffImage, TARGET_WIDTH };
