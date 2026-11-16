/*
 * napkin++ — pure vault model.
 *
 * Everything here is side-effect free and runs both in Node (tests, main
 * process) and in the renderer (via the global NapkinModel). The store owns
 * persistence; the reducer owns meaning.
 *
 * A vault is one plain-JSON document:
 *   { schemaVersion, createdAt, updatedAt, settings, ui, projects[] }
 *
 * A project is a dossier: links, services, environments, accounts, entries.
 * Accounts and env sets are arrays on purpose — dev/staging/prod *and* the
 * three test accounts you made on a Tuesday all belong to the same project.
 *
 * Accounts carry typed fields rather than a fixed password column: a login, a
 * PIN, an API token and a recovery code are the same shape, and different
 * accounts need different ones. `hidden` means "mask this in the UI".
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NapkinModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 4;
  const STATUSES = ['active', 'paused', 'shipped', 'archived'];
  const ENTRY_TYPES = ['note', 'snippet', 'command', 'secret', 'recovery', 'instruction'];
  const LINK_KINDS = ['repo', 'live', 'staging', 'docs', 'dashboard', 'other'];

  // Appearance is theme (system/light/dark) × palette (the paper stock) ×
  // accent (the ink colour). Palettes carry their own light and dark values in
  // the stylesheet; only the id lives in the vault.
  const PALETTES = ['paper', 'slate', 'nord', 'forest', 'ocean', 'rose', 'sand', 'graphite'];
  const ACCENTS = ['ember', 'moss', 'ink', 'plum'];
  const ICON_STYLES = ['napkin', 'ink', 'grid', 'classic'];
  const ICON_TINTS = ['paper', 'ember', 'moss', 'ink', 'plum', 'graphite'];

  /** Folder colours are the six accents plus two neutrals, kept legible. */
  const FOLDER_COLORS = [
    '#b2531f',
    '#c08a2e',
    '#5c7a4f',
    '#2f7d75',
    '#3f5f82',
    '#7a4f72',
    '#a34b5f',
    '#7b7466',
  ];

  const ICON_TINT_COLORS = {
    paper: '#f4efe7',
    ember: '#e8965f',
    moss: '#8fa881',
    ink: '#5c7b9c',
    plum: '#a67c9e',
    graphite: '#9a9a9a',
  };

  const DEFAULT_SETTINGS = {
    theme: 'system',
    palette: 'paper',
    accent: 'ember',
    accentCustom: '#b2531f',
    iconStyle: 'napkin',
    iconTint: 'auto',
    menuBar: true,
    copyClearSeconds: 45,
    sortBy: 'recent',
    projectView: 'list',
    previews: true,
    detectOnAdd: true,
    checkUpdates: true,
    updateSkipped: '',
    githubToken: '',
  };

  const THUMB_SOURCES = ['live', 'staging', 'repo', 'manual'];

  // ---------------------------------------------------------------- helpers

  function uid(prefix) {
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    let hex;
    if (c && typeof c.randomUUID === 'function') {
      hex = c.randomUUID().replace(/-/g, '').slice(0, 16);
    } else {
      hex =
        Math.random().toString(16).slice(2, 10) +
        Math.random().toString(16).slice(2, 10);
    }
    return (prefix || 'id') + '_' + hex;
  }

  function now() {
    return new Date().toISOString();
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function str(value, max) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    return max ? s.slice(0, max) : s;
  }

  function cleanList(list, max) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
      const s = str(item, max || 60).trim();
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  }

  function normalizeKey(value) {
    return str(value).toLowerCase().trim();
  }

  function isHttpUrl(value) {
    return /^https?:\/\/[^\s]+$/i.test(str(value).trim());
  }

  function hexColor(value) {
    const s = str(value).trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(s) ? s : '';
  }

  /** Resolve a custom accent to the closest shipped icon colourway. */
  function nearestIconTint(value) {
    const rgb = (hex) => {
      const s = hexColor(hex);
      if (!s) return null;
      return [0, 2, 4].map((i) => parseInt(s.slice(i + 1, i + 3), 16));
    };
    const target = rgb(value);
    if (!target) return 'paper';
    let best = 'paper';
    let bestDistance = Infinity;
    for (const [tint, color] of Object.entries(ICON_TINT_COLORS)) {
      const candidate = rgb(color);
      if (!candidate) continue;
      const distance = candidate.reduce(
        (sum, channel, i) => sum + (channel - target[i]) ** 2,
        0
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = tint;
      }
    }
    return best;
  }

  function hostOf(value) {
    try {
      return new URL(str(value).trim()).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------------ vault

  function createVault() {
    const ts = now();
    return {
      schemaVersion: SCHEMA_VERSION,
      createdAt: ts,
      updatedAt: ts,
      settings: { ...DEFAULT_SETTINGS },
      ui: { recent: [] },
      folders: [],
      projects: [],
    };
  }

  function normalizeThumb(thumb) {
    if (!thumb) return { url: '', source: '', at: '' };
    const url = str(thumb.url, 2000).trim();
    if (!url || !isHttpUrl(url)) return { url: '', source: '', at: '' };
    return {
      url,
      source: THUMB_SOURCES.includes(thumb.source) ? thumb.source : 'manual',
      at: str(thumb.at, 40) || now(),
    };
  }

  function createProject(input) {
    const ts = now();
    const name = str(input && input.name, 90).trim() || 'Untitled project';
    return {
      id: uid('prj'),
      name,
      aliases: cleanList(input && input.aliases, 90),
      description: str(input && input.description, 2000),
      status: STATUSES.includes(input && input.status) ? input.status : 'active',
      favorite: Boolean(input && input.favorite),
      folderId: str(input && input.folderId, 80),
      tags: cleanList(input && input.tags, 40),
      stack: cleanList(input && input.stack, 40),
      links: normalizeList(input && input.links, normalizeLink),
      services: normalizeList(input && input.services, normalizeService),
      envs: normalizeList(input && input.envs, normalizeEnv),
      accounts: normalizeList(input && input.accounts, normalizeAccount),
      entries: normalizeList(input && input.entries, normalizeEntry),
      thumb: normalizeThumb(input && input.thumb),
      detectedAt: str(input && input.detectedAt, 40),
      createdAt: ts,
      updatedAt: ts,
    };
  }

  function normalizeList(list, fn) {
    if (!Array.isArray(list)) return [];
    return list.map((item) => fn(item)).filter(Boolean);
  }

  function normalizeLink(link) {
    if (!link) return null;
    const url = str(link.url, 2000).trim();
    if (!url) return null;
    return {
      id: link.id || uid('lnk'),
      label: str(link.label, 80).trim() || hostOf(url) || 'Link',
      kind: LINK_KINDS.includes(link.kind) ? link.kind : 'other',
      url,
    };
  }

  function normalizeService(service) {
    if (!service) return null;
    const provider = str(service.provider, 60).trim();
    if (!provider) return null;
    return {
      id: service.id || uid('svc'),
      provider,
      role: str(service.role, 80).trim(),
      url: str(service.url, 2000).trim(),
      notes: str(service.notes, 2000),
    };
  }

  function normalizeFolder(folder) {
    if (!folder) return null;
    const name = str(folder.name, 60).trim();
    if (!name) return null;
    return {
      id: folder.id || uid('fdr'),
      name,
      color: hexColor(folder.color) || FOLDER_COLORS[0],
    };
  }

  function normalizeEnv(env) {
    if (!env) return null;
    return {
      id: env.id || uid('env'),
      name: str(env.name, 40).trim() || 'dev',
      url: str(env.url, 2000).trim(),
      vars: normalizeList(env.vars, normalizeVar),
    };
  }

  function normalizeVar(item) {
    if (!item) return null;
    const key = str(item.key, 120).trim();
    if (!key) return null;
    const value = str(item.value, 8000);
    return {
      id: item.id || uid('var'),
      key,
      value,
      hidden: item.hidden === undefined ? looksSensitive(key) : Boolean(item.hidden),
    };
  }

  /** A typed account field: Password, PIN, API token, recovery code… */
  function normalizeField(field) {
    if (!field) return null;
    const label = str(field.label, 60).trim();
    const value = str(field.value, 8000);
    if (!label && !value) return null;
    return {
      id: field.id || uid('fld'),
      label: label || 'Field',
      value,
      hidden: field.hidden === undefined ? looksSensitive(label) : Boolean(field.hidden),
    };
  }

  function normalizeAccount(account) {
    if (!account) return null;
    const out = {
      id: account.id || uid('acc'),
      label: str(account.label, 60).trim(),
      email: str(account.email, 200).trim(),
      username: str(account.username, 200).trim(),
      service: str(account.service, 60).trim(),
      env: str(account.env, 30).trim(),
      notes: str(account.notes, 2000),
      tags: cleanList(account.tags, 30),
      fields: normalizeList(account.fields, normalizeField),
      createdAt: account.createdAt || now(),
    };
    if (!out.label && !out.email && !out.username && !out.fields.length) return null;
    return out;
  }

  function normalizeEntry(entry) {
    if (!entry) return null;
    const body = str(entry.body, 200000);
    const title = str(entry.title, 160).trim() || firstLine(body) || 'Untitled';
    if (!body && !entry.title) return null;
    return {
      id: entry.id || uid('ent'),
      type: ENTRY_TYPES.includes(entry.type) ? entry.type : 'note',
      title,
      body,
      language: str(entry.language, 30).trim(),
      pinned: Boolean(entry.pinned),
      tags: cleanList(entry.tags, 30),
      createdAt: entry.createdAt || now(),
      updatedAt: entry.updatedAt || now(),
    };
  }

  function firstLine(text) {
    const line = str(text).split(/\r?\n/).find((l) => l.trim());
    return line ? line.trim().slice(0, 80) : '';
  }

  function normalizeVault(input) {
    const base = createVault();
    if (!input || typeof input !== 'object') return base;
    const vault = {
      schemaVersion: SCHEMA_VERSION,
      createdAt: str(input.createdAt) || base.createdAt,
      updatedAt: str(input.updatedAt) || base.updatedAt,
      settings: { ...DEFAULT_SETTINGS, ...(input.settings || {}) },
      ui: { recent: [] },
      folders: [],
      projects: [],
    };
    if (!['system', 'light', 'dark'].includes(vault.settings.theme)) {
      vault.settings.theme = 'system';
    }
    if (!PALETTES.includes(vault.settings.palette)) {
      vault.settings.palette = 'paper';
    }
    if (![...ACCENTS, 'custom'].includes(vault.settings.accent)) {
      vault.settings.accent = 'ember';
    }
    vault.settings.accentCustom = hexColor(vault.settings.accentCustom) || DEFAULT_SETTINGS.accentCustom;
    if (!ICON_STYLES.includes(vault.settings.iconStyle)) {
      vault.settings.iconStyle = 'napkin';
    }
    if (!['auto', ...ICON_TINTS].includes(vault.settings.iconTint)) {
      vault.settings.iconTint = 'auto';
    }
    vault.settings.menuBar = vault.settings.menuBar !== false;
    const seconds = Number(vault.settings.copyClearSeconds);
    vault.settings.copyClearSeconds = Number.isFinite(seconds)
      ? Math.max(0, Math.min(600, Math.round(seconds)))
      : DEFAULT_SETTINGS.copyClearSeconds;
    if (!['recent', 'name'].includes(vault.settings.sortBy)) {
      vault.settings.sortBy = 'recent';
    }
    if (!['list', 'grid'].includes(vault.settings.projectView)) {
      vault.settings.projectView = 'list';
    }
    vault.settings.previews = vault.settings.previews !== false;
    vault.settings.detectOnAdd = vault.settings.detectOnAdd !== false;
    vault.settings.checkUpdates = vault.settings.checkUpdates !== false;
    vault.settings.updateSkipped = str(vault.settings.updateSkipped, 40).trim();
    vault.settings.githubToken = str(vault.settings.githubToken, 200).trim();
    const recent = input.ui && Array.isArray(input.ui.recent) ? input.ui.recent : [];
    vault.ui.recent = cleanList(recent, 80).slice(0, 12);
    const folders = Array.isArray(input.folders) ? input.folders : [];
    const folderNames = new Set();
    for (const raw of folders) {
      const folder = normalizeFolder(raw);
      if (!folder) continue;
      const key = normalizeKey(folder.name);
      if (folderNames.has(key)) continue;
      folderNames.add(key);
      vault.folders.push(folder);
    }
    const folderIds = new Set(vault.folders.map((f) => f.id));
    const projects = Array.isArray(input.projects) ? input.projects : [];
    for (const raw of projects) {
      if (!raw || !raw.id) continue;
      vault.projects.push({
        id: str(raw.id, 80),
        name: str(raw.name, 90).trim() || 'Untitled project',
        aliases: cleanList(raw.aliases, 90),
        description: str(raw.description, 4000),
        status: STATUSES.includes(raw.status) ? raw.status : 'active',
        favorite: Boolean(raw.favorite),
        folderId: folderIds.has(str(raw.folderId, 80)) ? str(raw.folderId, 80) : '',
        tags: cleanList(raw.tags, 40),
        stack: cleanList(raw.stack, 40),
        links: normalizeList(raw.links, normalizeLink),
        services: normalizeList(raw.services, normalizeService),
        envs: normalizeList(raw.envs, normalizeEnv),
        accounts: normalizeList(raw.accounts, normalizeAccount),
        entries: normalizeList(raw.entries, normalizeEntry),
        thumb: normalizeThumb(raw.thumb),
        detectedAt: str(raw.detectedAt, 40),
        createdAt: str(raw.createdAt) || base.createdAt,
        updatedAt: str(raw.updatedAt) || base.updatedAt,
      });
    }
    vault.ui.recent = vault.ui.recent.filter((id) =>
      vault.projects.some((p) => p.id === id)
    );
    return vault;
  }

  // -------------------------------------------------------------- utilities

  function looksSensitive(key) {
    return /(secret|token|password|passwd|pwd|key|credential|private|auth|dsn|webhook|salt|hash|signature|session|cookie|pin|code)/i.test(
      str(key)
    );
  }

  function getProject(vault, id) {
    return (vault.projects || []).find((p) => p.id === id) || null;
  }

  function projectStats(project) {
    const vars = project.envs.reduce((n, env) => n + env.vars.length, 0);
    const fields = project.accounts.reduce((n, a) => n + a.fields.length, 0);
    const masked = project.accounts.reduce(
      (n, a) => n + a.fields.filter((f) => f.hidden).length,
      0
    );
    return {
      accounts: project.accounts.length,
      envs: project.envs.length,
      vars,
      links: project.links.length,
      services: project.services.length,
      entries: project.entries.length,
      fields,
      masked,
    };
  }

  /** What is missing from this dossier? Powers the Overview "gaps" card. */
  function projectGaps(project) {
    const gaps = [];
    if (!project.links.some((l) => l.kind === 'repo')) gaps.push('No code repo link');
    if (!project.links.some((l) => l.kind === 'live')) gaps.push('No live URL');
    if (!project.envs.some((e) => e.vars.length)) gaps.push('No env vars');
    if (!project.accounts.length) gaps.push('No accounts');
    if (!project.stack.length) gaps.push('No stack recorded');
    return gaps;
  }

  function touch(vault) {
    vault.updatedAt = now();
  }

  // --------------------------------------------------------- name similarity

  function normalizeName(value) {
    return str(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '')
      .trim();
  }

  function tokensOf(value) {
    return str(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);
  }

  function jaccard(a, b) {
    const A = new Set(tokensOf(a));
    const B = new Set(tokensOf(b));
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const t of A) if (B.has(t)) shared += 1;
    return shared / (A.size + B.size - shared);
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j += 1) prev[j] = j;
    for (let i = 1; i <= a.length; i += 1) {
      cur[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[b.length];
  }

  function ratio(a, b) {
    if (!a && !b) return 1;
    const max = Math.max(a.length, b.length);
    return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
  }

  /**
   * 0..1 similarity between a candidate name and an existing project.
   * Normalized equality wins, then containment, then edit distance blended
   * with token overlap so "lu-app" ~ "lu app" ~ "luapp" all land together.
   */
  function nameSimilarity(a, b) {
    const na = normalizeName(a);
    const nb = normalizeName(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (na.length > 2 && nb.length > 2 && (na.includes(nb) || nb.includes(na))) {
      return 0.9;
    }
    const lev = ratio(na, nb);
    const jac = jaccard(a, b);
    return Math.max(lev * 0.92, jac * 0.85, Math.min(lev, jac) * 0.6);
  }

  function projectMatch(project, name) {
    let best = nameSimilarity(project.name, name);
    const reasons = [];
    if (normalizeName(project.name) === normalizeName(name)) reasons.push('same name');
    for (const alias of project.aliases || []) {
      const s = nameSimilarity(alias, name);
      if (s > best) {
        best = s;
        reasons.length = 0;
        reasons.push('known alias');
      }
    }
    return { score: best, reasons };
  }

  /**
   * Duplicate candidates for a name (and optional repo/emails), strongest first.
   * Signals beyond the name matter: the same repo URL or the same login email
   * is a much stronger hint than a fuzzy name.
   */
  function findDuplicates(vault, candidate) {
    const name = typeof candidate === 'string' ? candidate : str(candidate && candidate.name);
    const repoUrl = str(candidate && candidate.repoUrl);
    const emails = cleanList(candidate && candidate.emails, 200).map(normalizeKey);
    const tags = cleanList(candidate && candidate.tags, 40).map(normalizeKey);
    const results = [];
    for (const project of vault.projects) {
      if (candidate && candidate.excludeId === project.id) continue;
      const match = projectMatch(project, name);
      const reasons = [...match.reasons];
      let score = match.score;
      if (repoUrl) {
        const repo = project.links.find(
          (l) => l.kind === 'repo' && normalizeKey(l.url) === normalizeKey(repoUrl)
        );
        if (repo) {
          score = Math.max(score, 0.97);
          reasons.push('same repo');
        }
      }
      if (emails.length) {
        const shared = project.accounts
          .map((a) => normalizeKey(a.email))
          .filter((e) => e && emails.includes(e));
        if (shared.length) {
          score = Math.max(score, 0.9);
          reasons.push('same account email');
        }
      }
      if (tags.length) {
        const shared = project.tags.filter((t) => tags.includes(normalizeKey(t)));
        if (shared.length >= 2) reasons.push('shared tags');
      }
      if (score >= 0.55 || reasons.length) {
        results.push({
          project,
          score: Math.round(score * 100) / 100,
          reasons: reasons.length ? reasons : ['similar name'],
        });
      }
    }
    results.sort((a, b) => b.score - a.score || b.project.updatedAt.localeCompare(a.project.updatedAt));
    return results.slice(0, 5);
  }

  // ------------------------------------------------------------------- merge

  function mergeCounts(target) {
    return {
      accounts: target.accounts.length,
      entries: target.entries.length,
      links: target.links.length,
      services: target.services.length,
      envs: target.envs.length,
      vars: target.envs.reduce((n, e) => n + e.vars.length, 0),
      fields: target.accounts.reduce((n, a) => n + a.fields.length, 0),
    };
  }

  function accountSignature(account) {
    return JSON.stringify([
      normalizeKey(account.label),
      normalizeKey(account.email),
      normalizeKey(account.username),
      account.fields.map((f) => [normalizeKey(f.label), f.value]),
    ]);
  }

  /**
   * Merge source into target in place. Accounts are only de-duplicated when
   * they are the same login *and* the same fields — duplicate test accounts
   * are a feature, not a bug. Everything else unions.
   */
  function mergeProjects(target, source, options) {
    const opts = options || {};
    const preferSource = opts.prefer === 'source';

    target.aliases = cleanList(
      [...(target.aliases || []), source.name, ...(source.aliases || [])].filter(
        (a) => normalizeName(a) !== normalizeName(target.name)
      ),
      90
    );

    if (preferSource ? source.description : !target.description) {
      if (source.description) target.description = source.description;
    }

    target.tags = cleanList([...(target.tags || []), ...(source.tags || [])], 40);
    target.stack = cleanList([...(target.stack || []), ...(source.stack || [])], 40);
    target.favorite = target.favorite || source.favorite;
    if (!target.folderId && source.folderId) target.folderId = source.folderId;
    if (target.status === 'archived' && source.status !== 'archived') {
      target.status = source.status;
    }
    if (source.createdAt && source.createdAt < target.createdAt) {
      target.createdAt = source.createdAt;
    }

    for (const link of source.links) {
      // Same URL is the same place. A shared label on github.com is not:
      // two repos on the same host are two different repos.
      const twin = target.links.find((l) => normalizeKey(l.url) === normalizeKey(link.url));
      if (!twin) target.links.push({ ...link });
    }

    for (const service of source.services) {
      // Provider + role, with a compatible URL. Two different dashboards are
      // both worth keeping; a missing URL is a gap to fill, not a duplicate.
      const twin = target.services.find(
        (s) =>
          normalizeKey(s.provider) === normalizeKey(service.provider) &&
          normalizeKey(s.role) === normalizeKey(service.role) &&
          (normalizeKey(s.url) === normalizeKey(service.url) || !s.url || !service.url)
      );
      if (twin) {
        if (!twin.url && service.url) twin.url = service.url;
        if (!twin.notes && service.notes) twin.notes = service.notes;
      } else {
        target.services.push({ ...service });
      }
    }

    for (const env of source.envs) {
      const twin = target.envs.find((e) => normalizeKey(e.name) === normalizeKey(env.name));
      if (!twin) {
        target.envs.push({ ...env, vars: env.vars.map((v) => ({ ...v })) });
        continue;
      }
      if (!twin.url && env.url) twin.url = env.url;
      for (const v of env.vars) {
        const existing = twin.vars.find((x) => x.key === v.key);
        if (!existing) twin.vars.push({ ...v });
        else if (preferSource) existing.value = v.value;
      }
    }

    for (const account of source.accounts) {
      const signature = accountSignature(account);
      const twin = target.accounts.find((a) => accountSignature(a) === signature);
      if (!twin) {
        target.accounts.push({
          ...account,
          tags: [...(account.tags || [])],
          fields: account.fields.map((f) => ({ ...f })),
        });
      }
    }

    for (const entry of source.entries) {
      const twin = target.entries.find(
        (e) =>
          e.type === entry.type &&
          normalizeKey(e.title) === normalizeKey(entry.title) &&
          e.body === entry.body
      );
      if (!twin) target.entries.push({ ...entry, tags: [...(entry.tags || [])] });
    }

    target.updatedAt = now();
    return mergeCounts(target);
  }

  function envConflicts(target, source) {
    const out = [];
    for (const env of source.envs) {
      const twin = target.envs.find((e) => normalizeKey(e.name) === normalizeKey(env.name));
      if (!twin) continue;
      for (const item of env.vars) {
        const existing = twin.vars.find((v) => v.key === item.key);
        if (existing && existing.value !== item.value) {
          out.push(env.name + ' · ' + item.key);
        }
      }
    }
    return out;
  }

  function mergeProjectsByIds(vault, targetId, sourceIds, options) {
    const opts = options || {};
    const target = getProject(vault, targetId);
    if (!target) return { ok: false, error: 'Merge target not found.' };
    const sources = (sourceIds || [])
      .map((id) => getProject(vault, id))
      .filter((p) => p && p.id !== target.id);
    if (!sources.length) return { ok: false, error: 'Nothing to merge.' };
    const before = mergeCounts(target);
    const conflicts = [];
    for (const source of sources) {
      if (opts.prefer !== 'source') conflicts.push(...envConflicts(target, source));
      mergeProjects(target, source);
    }
    const removed = new Set(sources.map((s) => s.id));
    vault.projects = vault.projects.filter((p) => !removed.has(p.id));
    vault.ui.recent = (vault.ui.recent || []).filter((id) => !removed.has(id));

    // The kept project's name is a choice, not an accident: keep the old name
    // as an alias so search and quick capture still land here.
    const desired = str(opts.name, 90).trim();
    if (desired && desired !== target.name) {
      if (
        vault.projects.some(
          (p) => p.id !== target.id && normalizeName(p.name) === normalizeName(desired)
        )
      ) {
        return { ok: false, error: 'Another project already uses that name.' };
      }
      target.aliases = cleanList(
        [...(target.aliases || []), target.name].filter(
          (a) => a.trim().toLowerCase() !== desired.trim().toLowerCase()
        ),
        90
      );
      target.name = desired;
    }

    target.updatedAt = now();
    return {
      ok: true,
      result: {
        targetId: target.id,
        sourceIds: [...removed],
        before,
        after: mergeCounts(target),
        names: sources.map((s) => s.name),
        name: target.name,
        conflicts: conflicts.slice(0, 20),
        conflictCount: conflicts.length,
      },
    };
  }

  // ---------------------------------------------------------------- reducer

  const UPDATABLE = [
    'name',
    'description',
    'status',
    'favorite',
    'folderId',
    'tags',
    'stack',
    'aliases',
  ];

  function fail(error) {
    return { ok: false, error };
  }

  /**
   * Apply one action to a deep clone of the vault and return the new state.
   * Pure: the caller (the store) decides whether to persist the result.
   */
  function applyAction(vault, action) {
    if (!action || typeof action.type !== 'string') return fail('Missing action type.');
    const next = clone(vault);
    const ts = now();
    const type = action.type;
    const payload = action.payload || {};

    switch (type) {
      case 'project.create': {
        const name = str(payload.name, 90).trim();
        if (!name) return fail('A project needs a name.');
        if (next.projects.some((p) => normalizeName(p.name) === normalizeName(name))) {
          return fail('A project with that name already exists.');
        }
        const project = createProject({ ...payload, name });
        if (project.folderId && !next.folders.some((f) => f.id === project.folderId)) {
          project.folderId = '';
        }
        next.projects.unshift(project);
        next.ui.recent = cleanList([project.id, ...next.ui.recent], 80).slice(0, 12);
        touch(next);
        return { ok: true, state: next, result: { projectId: project.id, project } };
      }

      case 'project.update': {
        const project = getProject(next, payload.id);
        if (!project) return fail('Project not found.');
        const patch = payload.patch || {};
        for (const key of UPDATABLE) {
          if (!(key in patch)) continue;
          const value = patch[key];
          if (key === 'name') {
            const name = str(value, 90).trim();
            if (!name) return fail('A project needs a name.');
            if (
              next.projects.some(
                (p) => p.id !== project.id && normalizeName(p.name) === normalizeName(name)
              )
            ) {
              return fail('Another project already uses that name.');
            }
            project.name = name;
          } else if (key === 'description') {
            project.description = str(value, 4000);
          } else if (key === 'status') {
            if (!STATUSES.includes(value)) return fail('Unknown status.');
            project.status = value;
          } else if (key === 'favorite') {
            project.favorite = Boolean(value);
          } else if (key === 'folderId') {
            const folderId = str(value, 80);
            if (folderId && !next.folders.some((f) => f.id === folderId)) {
              return fail('Folder not found.');
            }
            project.folderId = folderId;
          } else if (key === 'tags') {
            project.tags = cleanList(value, 40);
          } else if (key === 'stack') {
            project.stack = cleanList(value, 40);
          } else if (key === 'aliases') {
            project.aliases = cleanList(value, 90).filter(
              (a) => normalizeName(a) !== normalizeName(project.name)
            );
          }
        }
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: { projectId: project.id } };
      }

      case 'project.delete': {
        const project = getProject(next, payload.id);
        if (!project) return fail('Project not found.');
        next.projects = next.projects.filter((p) => p.id !== project.id);
        next.ui.recent = next.ui.recent.filter((id) => id !== project.id);
        touch(next);
        return { ok: true, state: next, result: { deleted: project.name } };
      }

      /** The cached preview for a project. An empty url clears it. */
      case 'project.thumb': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        const url = str(payload.url, 2000).trim();
        if (!url) {
          project.thumb = { url: '', source: '', at: '' };
          project.updatedAt = ts;
          touch(next);
          return { ok: true, state: next, result: { cleared: true } };
        }
        if (!isHttpUrl(url)) return fail('A preview needs an http(s) URL.');
        project.thumb = {
          url,
          source: THUMB_SOURCES.includes(payload.source) ? payload.source : 'manual',
          at: str(payload.at, 40) || ts,
        };
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: { thumb: project.thumb } };
      }

      /**
       * Apply reviewed detection results. Additive by design: nothing that is
       * already set is replaced, services fill in blanks instead of overwriting,
       * and the same note is never added twice.
       */
      case 'project.enrich': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        const counts = { stack: 0, tags: 0, services: 0, links: 0, note: false };
        for (const name of cleanList(payload.stack, 40)) {
          if (project.stack.length >= 40) break;
          if (project.stack.some((item) => normalizeKey(item) === normalizeKey(name))) continue;
          project.stack.push(name);
          counts.stack += 1;
        }
        for (const tag of cleanList(payload.tags, 40)) {
          if (project.tags.length >= 40) break;
          if (project.tags.some((item) => normalizeKey(item) === normalizeKey(tag))) continue;
          project.tags.push(tag);
          counts.tags += 1;
        }
        for (const raw of Array.isArray(payload.services) ? payload.services : []) {
          const service = normalizeService(raw);
          if (!service) continue;
          const twin = project.services.find(
            (item) =>
              normalizeKey(item.provider) === normalizeKey(service.provider) &&
              normalizeKey(item.role) === normalizeKey(service.role)
          );
          if (twin) {
            if (!twin.url && service.url) twin.url = service.url;
            if (!twin.notes && service.notes) twin.notes = service.notes;
            continue;
          }
          project.services.push(service);
          counts.services += 1;
        }
        for (const raw of Array.isArray(payload.links) ? payload.links : []) {
          const link = normalizeLink(raw);
          if (!link || !isHttpUrl(link.url)) continue;
          if (project.links.some((item) => normalizeKey(item.url) === normalizeKey(link.url))) continue;
          project.links.push(link);
          counts.links += 1;
        }
        const note = str(payload.note, 4000).trim();
        if (note) {
          const title = 'Detected setup';
          const twin = project.entries.find(
            (entry) => entry.type === 'note' && entry.title === title && entry.body === note
          );
          if (!twin) {
            project.entries.unshift(
              normalizeEntry({ type: 'note', title, body: note, tags: ['detected'] })
            );
            counts.note = true;
          }
        }
        project.detectedAt = ts;
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: counts };
      }

      case 'folder.create': {
        const name = str(payload.name, 60).trim();
        if (!name) return fail('A folder needs a name.');
        if (next.folders.some((f) => normalizeKey(f.name) === normalizeKey(name))) {
          return fail('A folder with that name already exists.');
        }
        const folder = {
          id: uid('fdr'),
          name,
          color: hexColor(payload.color) || FOLDER_COLORS[next.folders.length % FOLDER_COLORS.length],
        };
        next.folders.push(folder);
        touch(next);
        return { ok: true, state: next, result: { folder } };
      }

      case 'folder.update': {
        const folder = next.folders.find((f) => f.id === payload.id);
        if (!folder) return fail('Folder not found.');
        const patch = payload.patch || {};
        if ('name' in patch) {
          const name = str(patch.name, 60).trim();
          if (!name) return fail('A folder needs a name.');
          if (
            next.folders.some(
              (f) => f.id !== folder.id && normalizeKey(f.name) === normalizeKey(name)
            )
          ) {
            return fail('Another folder already uses that name.');
          }
          folder.name = name;
        }
        if ('color' in patch) {
          const color = hexColor(patch.color);
          if (!color) return fail('That is not a hex colour.');
          folder.color = color;
        }
        touch(next);
        return { ok: true, state: next, result: { folder } };
      }

      case 'folder.delete': {
        const folder = next.folders.find((f) => f.id === payload.id);
        if (!folder) return fail('Folder not found.');
        next.folders = next.folders.filter((f) => f.id !== folder.id);
        for (const project of next.projects) {
          if (project.folderId === folder.id) project.folderId = '';
        }
        touch(next);
        return { ok: true, state: next, result: { deleted: folder.name } };
      }

      case 'project.merge': {
        const merged = mergeProjectsByIds(
          next,
          payload.targetId,
          Array.isArray(payload.sourceIds) ? payload.sourceIds : [],
          { name: payload.name }
        );
        if (!merged.ok) return fail(merged.error);
        touch(next);
        return { ok: true, state: next, result: merged.result };
      }

      case 'project.recent': {
        if (!getProject(next, payload.id)) return fail('Project not found.');
        next.ui.recent = cleanList([payload.id, ...next.ui.recent], 80).slice(0, 12);
        return { ok: true, state: next, result: { recent: next.ui.recent }, quiet: true };
      }

      case 'link.upsert': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        const link = normalizeLink(payload.link);
        if (!link) return fail('A link needs a URL.');
        if (!isHttpUrl(link.url)) return fail('That does not look like an http(s) URL.');
        const existing = project.links.find((l) => l.id === link.id);
        if (existing) Object.assign(existing, link);
        else project.links.push(link);
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: { link } };
      }

      case 'link.delete': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        project.links = project.links.filter((l) => l.id !== payload.id);
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: {} };
      }

      case 'service.upsert': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        const service = normalizeService(payload.service);
        if (!service) return fail('A service needs a provider.');
        const existing = project.services.find((s) => s.id === service.id);
        if (existing) Object.assign(existing, service);
        else project.services.push(service);
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: { service } };
      }

      case 'service.delete': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        project.services = project.services.filter((s) => s.id !== payload.id);
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: {} };
      }

      case 'env.upsert': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        const env = normalizeEnv(payload.env);
        if (!env) return fail('Invalid environment.');
        const existing = project.envs.find((e) => e.id === env.id);
        if (existing) {
          existing.name = env.name;
          existing.url = env.url;
          existing.vars = env.vars;
        } else {
          if (project.envs.some((e) => normalizeKey(e.name) === normalizeKey(env.name))) {
            return fail('That environment already exists.');
          }
          project.envs.push(env);
        }
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: { env } };
      }

      case 'env.delete': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        project.envs = project.envs.filter((e) => e.id !== payload.id);
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: {} };
      }

      case 'env.vars.add': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        let env = payload.envId
          ? project.envs.find((e) => e.id === payload.envId)
          : project.envs.find((e) => normalizeKey(e.name) === normalizeKey(payload.envName || 'dev'));
        if (!env) {
          if (payload.envId) return fail('Environment not found.');
          env = { id: uid('env'), name: payload.envName || 'dev', url: '', vars: [] };
          project.envs.push(env);
        }
        const incoming = (payload.vars || []).map(normalizeVar).filter(Boolean);
        let added = 0;
        let updated = 0;
        for (const v of incoming) {
          const existing = env.vars.find((x) => x.key === v.key);
          if (existing) {
            existing.value = v.value;
            existing.hidden = v.hidden;
            updated += 1;
          } else {
            env.vars.push(v);
            added += 1;
          }
        }
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: { envId: env.id, added, updated } };
      }

      case 'var.delete': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        const env = project.envs.find((e) => e.id === payload.envId);
        if (!env) return fail('Environment not found.');
        env.vars = env.vars.filter((v) => v.id !== payload.id);
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: {} };
      }

      case 'var.update': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        const env = project.envs.find((e) => e.id === payload.envId);
        if (!env) return fail('Environment not found.');
        const item = env.vars.find((v) => v.id === payload.id);
        if (!item) return fail('Variable not found.');
        if ('key' in payload) {
          const key = str(payload.key, 120).trim();
          if (!key) return fail('A variable needs a key.');
          if (env.vars.some((v) => v.id !== item.id && v.key === key)) {
            return fail('Another variable already uses that key.');
          }
          item.key = key;
          // Renaming PORT to DB_PASSWORD should start masking it, otherwise
          // the new secret is shown and exported in the clear.
          if (!('hidden' in payload) && !item.hidden && looksSensitive(key)) {
            item.hidden = true;
          }
        }
        if ('value' in payload) item.value = str(payload.value, 8000);
        if ('hidden' in payload) item.hidden = Boolean(payload.hidden);
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: { var: item } };
      }

      case 'account.upsert': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        const account = normalizeAccount(payload.account);
        if (!account) return fail('An account needs a label, email or field.');
        const existing = project.accounts.find((a) => a.id === account.id);
        if (existing) {
          Object.assign(existing, account, { createdAt: existing.createdAt });
        } else {
          project.accounts.push(account);
        }
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: { account } };
      }

      case 'account.delete': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        project.accounts = project.accounts.filter((a) => a.id !== payload.id);
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: {} };
      }

      case 'entry.upsert': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        const entry = normalizeEntry(payload.entry);
        if (!entry) return fail('An entry needs a title or body.');
        const existing = project.entries.find((e) => e.id === entry.id);
        if (existing) {
          Object.assign(existing, entry, { createdAt: existing.createdAt });
        } else {
          project.entries.unshift(entry);
        }
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: { entry } };
      }

      case 'entry.delete': {
        const project = getProject(next, payload.projectId);
        if (!project) return fail('Project not found.');
        project.entries = project.entries.filter((e) => e.id !== payload.id);
        project.updatedAt = ts;
        touch(next);
        return { ok: true, state: next, result: {} };
      }

      case 'settings.update': {
        const patch = payload.patch || {};
        if ('theme' in patch) {
          if (!['system', 'light', 'dark'].includes(patch.theme)) return fail('Unknown theme.');
          next.settings.theme = patch.theme;
        }
        if ('accent' in patch) {
          if (![...ACCENTS, 'custom'].includes(patch.accent)) return fail('Unknown accent.');
          next.settings.accent = patch.accent;
        }
        if ('accentCustom' in patch) {
          const color = hexColor(patch.accentCustom);
          if (!color) return fail('Pick a hex colour like #b2531f.');
          next.settings.accentCustom = color;
        }
        if ('palette' in patch) {
          if (!PALETTES.includes(patch.palette)) return fail('Unknown palette.');
          next.settings.palette = patch.palette;
        }
        if ('iconStyle' in patch) {
          if (!ICON_STYLES.includes(patch.iconStyle)) {
            return fail('Unknown icon style.');
          }
          next.settings.iconStyle = patch.iconStyle;
        }
        if ('iconTint' in patch) {
          if (!['auto', ...ICON_TINTS].includes(patch.iconTint)) return fail('Unknown icon tint.');
          next.settings.iconTint = patch.iconTint;
        }
        if ('menuBar' in patch) {
          next.settings.menuBar = Boolean(patch.menuBar);
        }
        if ('copyClearSeconds' in patch) {
          const n = Number(patch.copyClearSeconds);
          if (!Number.isFinite(n)) return fail('Invalid clipboard timeout.');
          next.settings.copyClearSeconds = Math.max(0, Math.min(600, Math.round(n)));
        }
        if ('sortBy' in patch) {
          if (!['recent', 'name'].includes(patch.sortBy)) return fail('Unknown sort order.');
          next.settings.sortBy = patch.sortBy;
        }
        if ('projectView' in patch) {
          if (!['list', 'grid'].includes(patch.projectView)) return fail('Unknown list style.');
          next.settings.projectView = patch.projectView;
        }
        if ('previews' in patch) next.settings.previews = Boolean(patch.previews);
        if ('detectOnAdd' in patch) next.settings.detectOnAdd = Boolean(patch.detectOnAdd);
        if ('checkUpdates' in patch) next.settings.checkUpdates = Boolean(patch.checkUpdates);
        if ('updateSkipped' in patch) {
          next.settings.updateSkipped = str(patch.updateSkipped, 40).trim();
        }
        if ('githubToken' in patch) {
          next.settings.githubToken = str(patch.githubToken, 200).trim();
        }
        touch(next);
        return { ok: true, state: next, result: {} };
      }

      case 'vault.replaceProjects': {
        // Used by the importer: append normalized projects in one save.
        for (const raw of payload.projects || []) {
          next.projects.unshift(normalizeVault({ projects: [raw] }).projects[0]);
        }
        touch(next);
        return { ok: true, state: next, result: { count: next.projects.length } };
      }

      default:
        return fail('Unknown action: ' + type);
    }
  }

  // ------------------------------------------------------------- formatting

  function serializeEnv(vars) {
    return (vars || [])
      .filter((v) => v && v.key)
      .map((v) => envLine(v.key, v.value))
      .join('\n');
  }

  function envLine(key, value) {
    const v = str(value);
    if (!/[\s#"'\\]/.test(v) && v !== '') return key + '=' + v;
    return key + '="' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"';
  }

  function mask(value) {
    if (!value) return '';
    return '•'.repeat(Math.min(14, Math.max(8, str(value).length)));
  }

  function exportProjectMarkdown(project, options) {
    const opts = options || {};
    const redact = opts.redact !== false;
    const lines = [];
    lines.push('# ' + project.name);
    if (project.aliases.length) lines.push('*Also known as: ' + project.aliases.join(', ') + '*');
    lines.push('');
    if (project.description) {
      lines.push(project.description);
      lines.push('');
    }
    lines.push('**Status:** ' + project.status + (project.favorite ? ' · ★ favorite' : ''));
    if (project.stack.length) lines.push('**Stack:** ' + project.stack.join(', '));
    if (project.tags.length) lines.push('**Tags:** ' + project.tags.join(', '));
    lines.push('**Updated:** ' + project.updatedAt);
    lines.push('');

    lines.push('## Links');
    if (!project.links.length) lines.push('_none_');
    for (const link of project.links) {
      lines.push('- **' + link.label + '** (' + link.kind + ') — ' + link.url);
    }
    lines.push('');

    lines.push('## Services');
    if (!project.services.length) lines.push('_none_');
    for (const s of project.services) {
      const bits = [s.role, s.url].filter(Boolean).join(' — ');
      lines.push('- **' + s.provider + '**' + (bits ? ' — ' + bits : ''));
      if (s.notes) lines.push('  - ' + s.notes);
    }
    lines.push('');

    if (project.accounts.length) {
      lines.push('## Accounts');
      for (const account of project.accounts) {
        const who = [account.label, account.email, account.username].filter(Boolean).join(' · ');
        lines.push('### ' + (who || 'Account'));
        if (account.env || account.service) {
          lines.push('_' + [account.service, account.env].filter(Boolean).join(' · ') + '_');
          lines.push('');
        }
        for (const field of account.fields) {
          const value = redact && field.hidden ? '••••••' : field.value;
          lines.push('- **' + field.label + ':** ' + value);
        }
        if (account.notes) lines.push('- Notes: ' + account.notes);
        lines.push('');
      }
    }

    for (const env of project.envs) {
      lines.push('## Env: ' + env.name);
      if (env.url) lines.push(env.url);
      lines.push('');
      lines.push('```env');
      for (const v of env.vars) {
        lines.push(redact && v.hidden ? v.key + '=••••••' : envLine(v.key, v.value));
      }
      lines.push('```');
      lines.push('');
    }

    for (const entry of project.entries) {
      lines.push('## ' + entry.title + ' (' + entry.type + ')');
      if (entry.language) lines.push('_' + entry.language + '_');
      lines.push('');
      if (entry.type === 'secret' && redact) {
        lines.push('_redacted — ' + entry.body.length + ' characters_');
      } else {
        lines.push('```' + (entry.language || ''));
        lines.push(entry.body);
        lines.push('```');
      }
      lines.push('');
    }
    return lines.join('\n').trim() + '\n';
  }

  return {
    SCHEMA_VERSION,
    STATUSES,
    ENTRY_TYPES,
    LINK_KINDS,
    PALETTES,
    ACCENTS,
    ICON_STYLES,
    ICON_TINTS,
    THUMB_SOURCES,
    FOLDER_COLORS,
    ICON_TINT_COLORS,
    DEFAULT_SETTINGS,
    uid,
    now,
    createVault,
    createProject,
    normalizeVault,
    normalizeFolder,
    normalizeAccount,
    normalizeEntry,
    normalizeLink,
    normalizeService,
    normalizeEnv,
    normalizeVar,
    normalizeField,
    normalizeThumb,
    looksSensitive,
    getProject,
    projectStats,
    projectGaps,
    normalizeName,
    nameSimilarity,
    findDuplicates,
    mergeProjects,
    mergeProjectsByIds,
    applyAction,
    serializeEnv,
    envLine,
    mask,
    hexColor,
    nearestIconTint,
    exportProjectMarkdown,
    clone,
  };
});
