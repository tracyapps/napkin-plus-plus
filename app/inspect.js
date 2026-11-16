'use strict';

/*
 * napkin++ — collect signals for one project's links.
 *
 * One site page, its DNS records, and (for a GitHub repo) the repo metadata,
 * language bytes, file tree and a few small files such as package.json. The
 * decisions live in app/detect.js; this file only fetches.
 *
 * Every request is best-effort: a missing page, a private repo or a DNS server
 * that refuses to answer leaves a warning, never a failed detection.
 */

const net = require('./net.js');
const detect = require('./detect.js');

const TTL_MS = 15 * 60 * 1000;
const MAX_FILE_BYTES = 160 * 1024;

// Files small enough to read and useful enough to name a service.
const CANDIDATE_FILES = [
  'package.json',
  'tsconfig.json',
  'requirements.txt',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'composer.json',
  'vercel.json',
  'netlify.toml',
  'wrangler.toml',
  'fly.toml',
  'render.yaml',
  'railway.json',
  'docker-compose.yml',
  'Dockerfile',
  'prisma/schema.prisma',
  'supabase/config.toml',
  '.env.example',
];

const cache = new Map();
const inFlight = new Map();

function cacheKey(project, settings) {
  const links = (project.links || [])
    .map((link) => link.kind + ':' + link.url)
    .sort()
    .join('|');
  return project.id + '|' + links + '|' + (settings && settings.githubToken ? 'token' : 'anon');
}

function ghHeaders(token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = 'Bearer ' + token;
  return headers;
}

async function githubRepo(ref, token) {
  const base = 'https://api.github.com/repos/' + ref.owner + '/' + ref.name;
  const headers = ghHeaders(token);
  const [meta, languages] = await Promise.all([
    net.fetchJson(base, { headers }),
    net.fetchJson(base + '/languages', { headers }),
  ]);
  if (!meta.ok) {
    return {
      kind: 'github',
      owner: ref.owner,
      name: ref.name,
      url: ref.url,
      meta: {},
      languages: {},
      files: {},
      error: meta.error || 'GitHub did not return that repo.',
    };
  }
  const branch = meta.json.default_branch || 'main';
  // Probing raw.githubusercontent.com for the handful of files we care about is
  // both cheaper on the API limit and safer on huge monorepos than asking for
  // a recursive tree: a 50k-file tree is megabytes of JSON we would throw away.
  const files = {};
  await Promise.all(
    CANDIDATE_FILES.map(async (file) => {
      const raw =
        'https://raw.githubusercontent.com/' +
        ref.owner +
        '/' +
        ref.name +
        '/' +
        branch +
        '/' +
        file.split('/').map(encodeURIComponent).join('/');
      const res = await net.request(raw, {
        maxBytes: MAX_FILE_BYTES,
        accept: 'text/plain,*/*;q=0.5',
      });
      if (res.ok) files[file] = res.body.toString('utf8');
    })
  );

  return {
    kind: 'github',
    owner: ref.owner,
    name: ref.name,
    url: ref.url,
    meta: meta.json || {},
    languages: languages.ok ? languages.json || {} : {},
    files,
    branch,
    error: '',
  };
}

async function gitlabRepo(ref) {
  const id = encodeURIComponent(ref.owner + '/' + ref.name);
  const [meta, languages] = await Promise.all([
    net.fetchJson('https://gitlab.com/api/v4/projects/' + id, {}),
    net.fetchJson('https://gitlab.com/api/v4/projects/' + id + '/languages', {}),
  ]);
  if (!meta.ok) {
    return {
      kind: 'gitlab',
      owner: ref.owner,
      name: ref.name,
      url: ref.url,
      meta: {},
      languages: {},
      files: {},
      error: meta.error || 'GitLab did not return that project.',
    };
  }
  return {
    kind: 'gitlab',
    owner: ref.owner,
    name: ref.name,
    url: ref.url,
    meta: {
      description: meta.json.description || '',
      homepage: meta.json.web_url || '',
      default_branch: meta.json.default_branch || 'main',
      stargazers_count: meta.json.star_count || 0,
      topics: meta.json.topics || [],
    },
    languages: languages.ok ? languages.json || {} : {},
    files: {},
  };
}

function siteLinks(project) {
  const visible = (project.links || []).filter((link) => /^https?:/i.test(link.url));
  return {
    live: visible.find((link) => link.kind === 'live') || visible.find((link) => link.kind === 'staging') || null,
    repo: visible.find((link) => link.kind === 'repo') || null,
  };
}

async function collect(project, settings) {
  const links = siteLinks(project);
  const repoRef = links.repo ? detect.parseRepoUrl(links.repo.url) : null;
  const warnings = [];
  const signals = {
    site: null,
    dns: null,
    repo: null,
    offline: net.offline(),
    warnings,
  };

  const pageUrl = links.live ? links.live.url : '';
  const isRepoHost = Boolean(repoRef && links.live && detect.parseRepoUrl(links.live.url));

  if (pageUrl && !isRepoHost) {
    const page = await net.fetchText(pageUrl, { maxBytes: 2.5 * 1024 * 1024 });
    if (page.ok) {
      signals.site = {
        url: pageUrl,
        finalUrl: page.finalUrl || pageUrl,
        headers: page.headers || {},
        html: page.text,
      };
    } else {
      warnings.push('Could not read ' + net.hostOf(pageUrl) + ': ' + (page.error || 'no response'));
    }
  }

  const dnsHost = net.hostOf(pageUrl || (repoRef ? '' : ''));
  if (dnsHost && !net.isPlatformHost(dnsHost)) {
    signals.dns = await net.resolveDns(dnsHost);
  }

  if (repoRef) {
    if (repoRef.kind === 'github') {
      signals.repo = await githubRepo(repoRef, settings && settings.githubToken);
    } else if (repoRef.kind === 'gitlab') {
      signals.repo = await gitlabRepo(repoRef);
    } else {
      signals.repo = {
        kind: repoRef.kind,
        owner: repoRef.owner,
        name: repoRef.name,
        url: repoRef.url,
        meta: {},
        languages: {},
        files: {},
      };
    }
    if (signals.repo.error) warnings.push(signals.repo.error);
  }

  const findings = detect.classify(signals);
  findings.warnings = [...new Set([...(findings.warnings || []), ...warnings])];
  findings.fetchedAt = new Date().toISOString();
  return findings;
}

/**
 * Cached, de-duplicated inspection for one project.
 * @returns {Promise<object>} findings (see app/detect.js)
 */
async function inspectProject(project, settings) {
  const opts = settings || {};
  const key = cacheKey(project, opts);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Object.assign({ cached: true }, hit.findings);
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = collect(project, opts)
    .catch((err) => ({
      hosting: [],
      dns: [],
      email: [],
      cdn: [],
      services: [],
      stack: [],
      languages: [],
      tags: [],
      evidence: [],
      sources: [],
      warnings: [err && err.message ? err.message : 'Detection failed.'],
      offline: net.offline(),
      fetchedAt: new Date().toISOString(),
    }))
    .then((findings) => {
      cache.set(key, { at: Date.now(), findings });
      inFlight.delete(key);
      return findings;
    });
  inFlight.set(key, promise);
  return promise;
}

function forget(projectId) {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(projectId + '|')) cache.delete(key);
  }
}

module.exports = {
  inspectProject,
  forget,
  cacheKey,
  githubRepo,
  CANDIDATE_FILES,
};
