'use strict';

/*
 * napkin++ — the only place the app touches the network for link inspection.
 *
 * Rules, in order: only http(s); never an obvious local address; small size
 * caps; short timeouts; a redirect chain is re-checked at every hop. Nothing
 * here runs unless the person added a link, asked for a preview, or pressed
 * "Detect". NAPKIN_OFFLINE=1 turns all of it into a clean failure so tests and
 * smoke runs stay deterministic.
 */

const dns = require('node:dns').promises;

const DEFAULTS = {
  timeout: 9000,
  maxBytes: 3 * 1024 * 1024,
  redirects: 4,
  userAgent: 'napkin++/inspect (+https://napkinplusplus.app)',
};

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', '0.0.0.0', '::1', '[::1]']);

function offline() {
  return process.env.NAPKIN_OFFLINE === '1';
}

function isPrivateAddress(host) {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true; // unique local IPv6
  if (/^fe80:/.test(value)) return true;
  if (value === '169.254.169.254') return true; // cloud metadata
  const v4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function checkUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, error: 'Only http(s) URLs can be inspected.' };
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: 'Local addresses are not inspected.' };
  }
  if (isPrivateAddress(host)) {
    return { ok: false, error: 'Private network addresses are not inspected.' };
  }
  return { ok: true, url };
}

async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    return { ok: false, error: 'That response is larger than ' + Math.round(maxBytes / 1024) + ' KB.' };
  }
  if (!response.body) return { ok: true, buffer: Buffer.alloc(0) };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* the stream is already gone */
      }
      return { ok: false, error: 'That response is larger than ' + Math.round(maxBytes / 1024) + ' KB.' };
    }
    chunks.push(Buffer.from(value));
  }
  return { ok: true, buffer: Buffer.concat(chunks) };
}

/**
 * GET a URL with manual redirects, a byte cap and a total timeout.
 * @returns {Promise<{ok:boolean,status?:number,headers?:object,body?:Buffer,finalUrl?:string,error?:string}>}
 */
async function request(url, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  if (offline()) return { ok: false, error: 'Network access is off (NAPKIN_OFFLINE=1).' };
  const first = checkUrl(url);
  if (!first.ok) return first;

  let current = first.url.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);
  try {
    for (let hop = 0; hop <= opts.redirects; hop += 1) {
      const response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: Object.assign(
          {
            'user-agent': opts.userAgent || DEFAULTS.userAgent,
            accept: opts.accept || 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
            'accept-language': 'en',
          },
          opts.headers || {}
        ),
      });
      const status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers.get('location');
        if (!location) return { ok: false, status, error: 'Redirect without a location.' };
        const next = checkUrl(new URL(location, current).toString());
        if (!next.ok) return next;
        current = next.url.toString();
        continue;
      }
      const read = await readCapped(response, opts.maxBytes);
      if (!read.ok) return read;
      return {
        ok: status >= 200 && status < 400,
        status,
        headers: Object.fromEntries(response.headers.entries()),
        body: read.buffer,
        finalUrl: current,
        error: status >= 400 ? 'HTTP ' + status : '',
      };
    }
    return { ok: false, error: 'Too many redirects.' };
  } catch (err) {
    let message =
      err && err.name === 'AbortError'
        ? 'That request took too long.'
        : (err && err.message) || 'Network request failed.';
    // Node's fetch reports almost every connection problem as "fetch failed",
    // which is not a sentence to show a person.
    if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|certificate/i.test(message)) {
      message = 'Could not reach ' + (hostOf(url) || 'that address') + '.';
    }
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise.catch(() => []),
    new Promise((resolve) => setTimeout(() => resolve([]), ms)),
  ]);
}

/**
 * DNS records worth knowing: who runs the nameservers, what the domain points
 * at, who handles mail, and the TXT records that name an email or payment
 * provider. Missing records resolve to an empty list, never a throw.
 */
async function resolveDns(host) {
  const name = String(host || '').replace(/^www\./, '');
  if (!name || !/^[a-z0-9.-]+$/i.test(name)) return null;
  if (offline()) return { host: name, cname: [], ns: [], mx: [], txt: [], skipped: true };
  const [cname, ns, mx, txt] = await Promise.all([
    withTimeout(dns.resolveCname(name), 2500),
    withTimeout(dns.resolveNs(name), 2500),
    withTimeout(dns.resolveMx(name), 2500),
    withTimeout(dns.resolveTxt(name), 2500),
  ]);
  return {
    host: name,
    cname: (cname || []).map(String),
    ns: (ns || []).map(String),
    mx: (mx || []).map((record) => record.exchange || ''),
    txt: (txt || []).map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks))),
  };
}

async function fetchJson(url, options) {
  const res = await request(
    url,
    Object.assign(
      {
        accept: 'application/vnd.github+json, application/json;q=0.9',
        maxBytes: 1024 * 1024,
      },
      options || {}
    )
  );
  if (!res.ok) return { ok: false, error: res.error || 'HTTP ' + (res.status || '?') };
  try {
    return { ok: true, json: JSON.parse(res.body.toString('utf8')), headers: res.headers };
  } catch {
    return { ok: false, error: 'That endpoint did not return JSON.' };
  }
}

function fetchText(url, options) {
  return request(url, options).then((res) => {
    if (!res.ok) return { ok: false, error: res.error || 'HTTP ' + (res.status || '?'), status: res.status };
    return {
      ok: true,
      text: res.body.toString('utf8'),
      headers: res.headers,
      finalUrl: res.finalUrl,
      status: res.status,
    };
  });
}

function hostOf(value) {
  try {
    return new URL(String(value)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** A hostname that belongs to a hosted platform: DNS there says nothing. */
function isPlatformHost(host) {
  return /(^|\.)(vercel\.app|now\.sh|netlify\.app|pages\.dev|github\.io|herokuapp\.com|onrender\.com|fly\.dev|railway\.app|up\.railway\.app|web\.app|firebaseapp\.com|azurestaticapps\.net|amplifyapp\.com|ondigitalocean\.app|surge\.sh|webflow\.io)$/i.test(
    String(host || '')
  );
}

module.exports = {
  request,
  fetchJson,
  fetchText,
  resolveDns,
  checkUrl,
  isPrivateAddress,
  isPlatformHost,
  hostOf,
  offline,
  DEFAULTS,
};
