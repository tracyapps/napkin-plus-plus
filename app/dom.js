/* napkin++ — tiny DOM helpers shared by the main and quick windows. */
(function (global) {
  'use strict';

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function icon(name, cls) {
    return (
      '<svg class="i ' + (cls || '') + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>'
    );
  }

  function timeAgo(iso) {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return '';
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.round(hours / 24);
    if (days < 7) return days + 'd ago';
    if (days < 35) return Math.round(days / 7) + 'w ago';
    const date = new Date(then);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: sameYear ? undefined : 'numeric',
    });
  }

  function initials(name) {
    const parts = String(name || '')
      .replace(/\([^)]*\)/g, ' ')
      .trim()
      .split(/[\s._-]+/)
      .map((part) => part.replace(/[^A-Za-z0-9]/g, ''))
      .filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function hostOf(url) {
    try {
      return new URL(String(url)).hostname.replace(/^www\./, '');
    } catch {
      return String(url || '');
    }
  }

  function truncate(value, max) {
    const s = String(value || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function countLines(value) {
    const s = String(value || '');
    if (!s) return 0;
    return s.split(/\r?\n/).length;
  }

  /** Escape + wrap every occurrence of the query tokens in <mark>. */
  function highlight(value, tokens) {
    const raw = String(value === null || value === undefined ? '' : value);
    if (!raw || !tokens || !tokens.length) return esc(raw);
    const lower = raw.toLowerCase();
    const mask = new Array(raw.length).fill(false);
    for (const token of tokens) {
      if (!token) continue;
      let index = lower.indexOf(token);
      while (index !== -1) {
        for (let i = index; i < index + token.length && i < raw.length; i += 1) mask[i] = true;
        index = lower.indexOf(token, index + 1);
      }
    }
    let out = '';
    let i = 0;
    while (i < raw.length) {
      const marked = mask[i];
      let j = i;
      while (j < raw.length && mask[j] === marked) j += 1;
      const chunk = esc(raw.slice(i, j));
      out += marked ? '<mark class="mark">' + chunk + '</mark>' : chunk;
      i = j;
    }
    return out;
  }

  function firstLine(value, max) {
    const line = String(value || '')
      .split(/\r?\n/)
      .find((l) => l.trim());
    return truncate(line || '', max || 60);
  }

  global.NapkinDOM = {
    esc,
    icon,
    timeAgo,
    initials,
    hostOf,
    truncate,
    countLines,
    highlight,
    firstLine,
  };
})(typeof window !== 'undefined' ? window : globalThis);
