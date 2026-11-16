/*
 * Every internal href/src in site/*.html must resolve to a real file.
 *
 *   node scripts/check-site-links.mjs
 *
 * Catches the classic static-site mistake: a page renamed, a screenshot not
 * copied, a link that only works with the host's clean-URL rewrite. External
 * URLs are not fetched — CI should not depend on the network for this.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const pages = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.html')) pages.push(full);
  }
}

walk(root);

const attrPattern = /(?:href|src)\s*=\s*["']([^"']*)["']/gi;
const isExternal = (target) => /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
const problems = [];
let checked = 0;

for (const page of pages) {
  const html = fs.readFileSync(page, 'utf8');
  const pageRel = path.relative(root, page);
  for (const match of html.matchAll(attrPattern)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith('#')) continue;
    if (isExternal(raw)) continue;

    const withoutSuffix = raw.split('#')[0].split('?')[0];
    if (!withoutSuffix) continue;

    let decoded;
    try {
      decoded = decodeURIComponent(withoutSuffix);
    } catch {
      problems.push(pageRel + ': malformed URL encoding in "' + raw + '"');
      continue;
    }

    const target = decoded.startsWith('/')
      ? path.join(root, decoded)
      : path.resolve(path.dirname(page), decoded);
    const targetRel = path.relative(root, target);

    if (targetRel.startsWith('..')) {
      problems.push(pageRel + ': "' + raw + '" points outside site/');
      continue;
    }

    checked += 1;
    const candidates = [target, path.join(target, 'index.html')];
    const found = candidates.some(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    );
    if (!found) problems.push(pageRel + ': "' + raw + '" -> missing ' + targetRel);
  }
}

if (problems.length) {
  console.error(`x ${problems.length} broken internal link(s) in ${pages.length} page(s):`);
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}
console.log(`ok: ${checked} internal link(s) across ${pages.length} page(s) resolve to files`);
