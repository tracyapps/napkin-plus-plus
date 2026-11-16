/*
 * napkin++ — search.
 *
 * One flat index over everything in the vault, because the real question is
 * "where did I put the Resend key for lu app?" — not "which project am I in?".
 * Weighted fields + subsequence fallback + `#tag`, `type:`, `project:` filters.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NapkinSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KIND_ALIASES = {
    project: 'project',
    projects: 'project',
    proj: 'project',
    account: 'account',
    accounts: 'account',
    acct: 'account',
    login: 'account',
    field: 'accountfield',
    fields: 'accountfield',
    cred: 'accountfield',
    credential: 'accountfield',
    var: 'envvar',
    vars: 'envvar',
    envvar: 'envvar',
    envvars: 'envvar',
    env: 'environment',
    envs: 'environment',
    environment: 'environment',
    entry: 'entry',
    entries: 'entry',
    note: 'entry',
    notes: 'entry',
    snippet: 'entry',
    link: 'link',
    links: 'link',
    service: 'service',
    services: 'service',
    svc: 'service',
  };

  const KIND_RANK = {
    project: 0,
    account: 1,
    accountfield: 2,
    envvar: 3,
    entry: 4,
    link: 5,
    service: 6,
    environment: 7,
  };

  const BADGE = {
    project: 'PROJ',
    account: 'ACCT',
    accountfield: 'CRED',
    envvar: 'VAR',
    entry: 'NOTE',
    link: 'LINK',
    service: 'SVC',
    environment: 'ENV',
  };

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function norm(value) {
    return text(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function hiddenKey(key) {
    return /(secret|token|password|passwd|pwd|key|credential|private|auth|dsn|webhook|salt|hash|signature|session|cookie)/i.test(
      text(key)
    );
  }

  // ------------------------------------------------------------------- index

  function buildIndex(vault) {
    const docs = [];
    const projects = (vault && vault.projects) || [];
    for (const project of projects) {
      const tags = (project.tags || []).slice();
      const linkText = project.links
        .map((l) => l.label + ' ' + l.kind + ' ' + l.url)
        .join('\n');
      const serviceText = project.services
        .map((s) => s.provider + ' ' + s.role + ' ' + s.notes + ' ' + s.url)
        .join('\n');
      const accountText = project.accounts
        .map((a) =>
          [
            a.label,
            a.email,
            a.username,
            a.service,
            a.env,
            a.tags.join(' '),
            a.fields.map((f) => f.label + ' ' + f.value).join(' '),
          ].join(' ')
        )
        .join('\n');
      const entryText = project.entries.map((e) => e.title).join('\n');
      const live = project.links.find((l) => l.kind === 'live');
      const repo = project.links.find((l) => l.kind === 'repo');

      docs.push({
        kind: 'project',
        id: project.id,
        projectId: project.id,
        projectName: project.name,
        title: project.name,
        subtitle:
          [project.status, project.stack.slice(0, 3).join(' · '), project.accounts.length + ' accounts']
            .filter(Boolean)
            .join(' · ') || 'project',
        badge: BADGE.project,
        tags,
        favorite: project.favorite,
        updatedAt: project.updatedAt,
        hidden: false,
        copyLabel: live ? 'live URL' : repo ? 'repo URL' : 'project name',
        copyValue: live ? live.url : repo ? repo.url : project.name,
        fields: [
          { t: project.name, w: 6 },
          { t: project.aliases.join(' '), w: 5 },
          { t: project.tags.join(' '), w: 3 },
          { t: project.stack.join(' '), w: 2.6 },
          { t: project.description, w: 1.5 },
          { t: serviceText, w: 2.2 },
          { t: linkText, w: 2 },
          { t: accountText, w: 1.4 },
          { t: entryText, w: 1.2 },
        ],
      });

      for (const link of project.links) {
        docs.push({
          kind: 'link',
          id: link.id,
          projectId: project.id,
          projectName: project.name,
          title: link.label,
          subtitle: link.url,
          badge: BADGE.link,
          tags,
          favorite: project.favorite,
          updatedAt: project.updatedAt,
          hidden: false,
          copyLabel: 'URL',
          copyValue: link.url,
          fields: [
            { t: link.label, w: 4.5 },
            { t: link.url, w: 3 },
            { t: link.kind, w: 2.4 },
            { t: project.name + ' ' + project.aliases.join(' '), w: 2 },
            { t: project.tags.join(' '), w: 1.6 },
          ],
        });
      }

      for (const service of project.services) {
        docs.push({
          kind: 'service',
          id: service.id,
          projectId: project.id,
          projectName: project.name,
          title: service.provider,
          subtitle: [service.role, service.url].filter(Boolean).join(' · ') || 'service',
          badge: BADGE.service,
          tags,
          favorite: project.favorite,
          updatedAt: project.updatedAt,
          hidden: false,
          copyLabel: service.url ? 'service URL' : 'provider',
          copyValue: service.url || service.provider,
          fields: [
            { t: service.provider, w: 5 },
            { t: service.role, w: 3 },
            { t: service.notes, w: 1.5 },
            { t: service.url, w: 2.2 },
            { t: project.name + ' ' + project.aliases.join(' '), w: 2 },
            { t: project.tags.join(' '), w: 1.6 },
          ],
        });
      }

      for (const env of project.envs) {
        if (env.url) {
          docs.push({
            kind: 'environment',
            id: env.id,
            projectId: project.id,
            projectName: project.name,
            title: project.name + ' · ' + env.name,
            subtitle: env.url,
            badge: BADGE.environment,
            tags,
            favorite: project.favorite,
            updatedAt: project.updatedAt,
            hidden: false,
            copyLabel: env.name + ' URL',
            copyValue: env.url,
            fields: [
              { t: project.name, w: 3 },
              { t: env.name, w: 4 },
              { t: env.url, w: 3 },
              { t: project.tags.join(' '), w: 1.6 },
            ],
          });
        }
        for (const v of env.vars) {
          docs.push({
            kind: 'envvar',
            id: v.id,
            projectId: project.id,
            projectName: project.name,
            title: v.key,
            subtitle: project.name + ' · ' + env.name,
            badge: BADGE.envvar,
            tags,
            favorite: project.favorite,
            updatedAt: project.updatedAt,
            hidden: v.hidden,
            copyLabel: v.hidden ? v.key + ' (secret)' : v.key,
            copyValue: v.value,
            fields: [
              { t: v.key, w: 5.4 },
              { t: project.name + ' ' + project.aliases.join(' '), w: 2.6 },
              { t: env.name, w: 2.2 },
              { t: v.value, w: v.hidden ? 1.1 : 1.8 },
              { t: project.tags.join(' '), w: 1.4 },
              { t: project.stack.join(' '), w: 1.2 },
            ],
          });
        }
      }

      for (const account of project.accounts) {
        const identity = [account.label, account.email, account.username].filter(Boolean);
        docs.push({
          kind: 'account',
          id: account.id,
          projectId: project.id,
          projectName: project.name,
          title: account.label || account.email || account.username || 'Account',
          subtitle: [account.email, account.username, account.service, account.env]
            .filter(Boolean)
            .join(' · '),
          badge: BADGE.account,
          tags,
          favorite: project.favorite,
          updatedAt: project.updatedAt,
          hidden: false,
          copyLabel: account.email ? 'email' : account.username ? 'username' : 'label',
          copyValue: account.email || account.username || account.label,
          fields: [
            { t: account.label, w: 4.4 },
            { t: account.email, w: 4.4 },
            { t: account.username, w: 3.6 },
            { t: account.service, w: 2.6 },
            { t: account.env, w: 2.2 },
            { t: account.notes, w: 1.3 },
            { t: account.tags.join(' '), w: 1.6 },
            { t: account.fields.map((f) => f.label + ' ' + f.value).join(' '), w: 1.2 },
            { t: project.name + ' ' + project.aliases.join(' '), w: 2.4 },
            { t: project.tags.join(' '), w: 1.2 },
          ],
        });
        for (const field of account.fields) {
          docs.push({
            kind: 'accountfield',
            id: field.id,
            projectId: project.id,
            projectName: project.name,
            title: field.label,
            subtitle: [account.label || account.email, project.name].filter(Boolean).join(' · '),
            badge: BADGE.accountfield,
            tags,
            favorite: project.favorite,
            updatedAt: project.updatedAt,
            hidden: field.hidden,
            copyLabel: field.hidden ? field.label + ' (secret)' : field.label,
            copyValue: field.value,
            fields: [
              { t: field.label, w: 4.6 },
              { t: account.label, w: 4 },
              { t: account.email, w: 3.4 },
              { t: account.username, w: 2.8 },
              { t: project.name + ' ' + project.aliases.join(' '), w: 2.6 },
              { t: project.tags.join(' '), w: 1.4 },
            ],
          });
        }
      }

      for (const entry of project.entries) {
        docs.push({
          kind: 'entry',
          id: entry.id,
          projectId: project.id,
          projectName: project.name,
          title: entry.title,
          subtitle: [entry.type, entry.language, project.name].filter(Boolean).join(' · '),
          badge: BADGE.entry,
          tags,
          favorite: project.favorite,
          updatedAt: entry.updatedAt || project.updatedAt,
          hidden: entry.type === 'secret',
          copyLabel: entry.type === 'snippet' ? 'snippet' : entry.type,
          copyValue: entry.body,
          fields: [
            { t: entry.title, w: 5 },
            { t: entry.body, w: 1.8 },
            { t: entry.tags.join(' '), w: 2 },
            { t: project.name + ' ' + project.aliases.join(' '), w: 2 },
            { t: entry.type, w: 1.8 },
          ],
        });
      }
    }
    return docs;
  }

  // ------------------------------------------------------------------ query

  function parseQuery(raw) {
    const filters = { tags: [], kinds: [], project: '', favoriteOnly: false };
    const tokens = [];
    for (const piece of text(raw).trim().split(/\s+/)) {
      if (!piece) continue;
      if (piece.startsWith('#') && piece.length > 1) {
        filters.tags.push(norm(piece.slice(1)));
        continue;
      }
      if (/^(type|kind):/i.test(piece)) {
        const value = norm(piece.split(':')[1]);
        const kind = KIND_ALIASES[value];
        if (kind) filters.kinds.push(kind);
        continue;
      }
      if (/^project:/i.test(piece)) {
        filters.project = norm(piece.slice(8));
        continue;
      }
      if (/^is:(fav|favorite|starred)$/i.test(piece)) {
        filters.favoriteOnly = true;
        continue;
      }
      tokens.push(norm(piece));
    }
    return { tokens, filters };
  }

  function isBoundary(ch) {
    return !/[a-z0-9]/.test(ch);
  }

  function subsequenceScore(hay, needle) {
    let hi = 0;
    let first = -1;
    let last = -1;
    let boundaryHits = 0;
    for (let i = 0; i < hay.length && hi < needle.length; i += 1) {
      if (hay[i] !== needle[hi]) continue;
      if (first < 0) first = i;
      last = i;
      if (i === 0 || isBoundary(hay[i - 1])) boundaryHits += 1;
      hi += 1;
    }
    if (hi < needle.length) return 0;
    const span = last - first + 1;
    const density = needle.length / Math.max(1, span);
    return 0.42 + 0.24 * density + Math.min(0.12, boundaryHits * 0.03);
  }

  function fieldScore(haystack, needle) {
    const hay = norm(haystack);
    if (!hay || !needle) return 0;
    const idx = hay.indexOf(needle);
    if (idx === 0) return 1;
    if (idx > 0) return isBoundary(hay[idx - 1]) ? 0.93 : 0.8;
    return subsequenceScore(hay, needle);
  }

  function docScore(doc, tokens) {
    if (!tokens.length) return 0;
    let total = 0;
    let titleHits = 0;
    for (const token of tokens) {
      let best = 0;
      for (const field of doc.fields) {
        if (!field.t) continue;
        const s = fieldScore(field.t, token) * field.w;
        if (s > best) best = s;
      }
      if (best <= 0) return 0;
      total += best;
      if (fieldScore(doc.title, token) >= 0.8) titleHits += 1;
    }
    const avg = total / tokens.length;
    const titleBonus = 1 + (titleHits / tokens.length) * 0.18;
    const ageDays = Math.max(0, (Date.now() - Date.parse(doc.updatedAt || 0)) / 86400000);
    const recency = Number.isFinite(ageDays) ? Math.max(0, 0.12 - ageDays / 250) : 0;
    const exact = tokens.length === 1 && norm(doc.title) === tokens[0] ? 1.2 : 0;
    return avg * titleBonus + recency + exact;
  }

  function search(index, rawQuery, options) {
    const opts = options || {};
    const { tokens, filters } = parseQuery(rawQuery);
    const limit = opts.limit || 40;
    let pool = index;
    if (filters.kinds.length) pool = pool.filter((d) => filters.kinds.includes(d.kind));
    if (filters.tags.length) {
      pool = pool.filter((d) =>
        filters.tags.every((t) => (d.tags || []).some((tag) => norm(tag).includes(t)))
      );
    }
    if (filters.project) {
      pool = pool.filter(
        (d) => norm(d.projectName).includes(filters.project) || d.projectId === filters.project
      );
    }
    if (filters.favoriteOnly) pool = pool.filter((d) => d.favorite);

    if (!tokens.length) {
      const sorted = pool
        .slice()
        .sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)));
      return { results: sorted.slice(0, limit), tokens, filters, filtered: sorted.length };
    }

    const scored = [];
    for (const doc of pool) {
      const score = docScore(doc, tokens);
      if (score > 0) scored.push({ doc, score });
    }
    scored.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 0.001) return b.score - a.score;
      const rank = (KIND_RANK[a.doc.kind] || 9) - (KIND_RANK[b.doc.kind] || 9);
      if (rank) return rank;
      return text(b.doc.updatedAt).localeCompare(text(a.doc.updatedAt));
    });
    return {
      results: scored.slice(0, limit).map((s) => ({ ...s.doc, score: Math.round(s.score * 100) / 100 })),
      tokens,
      filters,
      filtered: scored.length,
    };
  }

  /** Find the search-result doc that best represents one entity (for quick copy). */
  function docFor(index, kind, id) {
    return index.find((d) => d.kind === kind && d.id === id) || null;
  }

  return {
    buildIndex,
    parseQuery,
    search,
    docScore,
    fieldScore,
    docFor,
    BADGE,
    KIND_RANK,
  };
});
