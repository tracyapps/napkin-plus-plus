/*
 * napkin++ — feedback and bug reports.
 *
 * The app has no server and no telemetry, so a report is something the person
 * writes and then sends themselves: a GitHub issue, an email, or the clipboard.
 * Diagnostics are deliberately boring — version, platform, counts, settings,
 * recent renderer errors — and never include project names, links, or values.
 *
 * Pure so it can be tested in Node and used by the renderer.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NapkinFeedback = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KINDS = ['bug', 'idea', 'other'];

  function firstLine(value, max) {
    const line = String(value || '')
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find(Boolean);
    const text = line || '';
    return text.length > (max || 70) ? text.slice(0, (max || 70) - 1) + '…' : text;
  }

  function redactPath(value, home) {
    const text = String(value || '');
    if (!home) return text;
    return text.split(String(home)).join('~');
  }

  function onOff(value) {
    return value === false ? 'off' : 'on';
  }

  /**
   * A plain-text block safe to paste in public. No names, no URLs from the
   * vault, no values. `input.errors` is a short ring buffer from the renderer.
   */
  function diagnostics(input) {
    const data = input || {};
    const meta = data.meta || {};
    const vault = data.vault || {};
    const settings = data.settings || {};
    const versions = meta.versions || {};
    const lines = [];

    lines.push('napkin++ ' + (meta.version || 'unknown') + ' · ' + (data.arch || meta.arch || 'unknown arch'));
    lines.push(
      'Build: ' +
        (meta.packaged ? 'packaged app' : 'development') +
        (meta.archived ? ' · ' + meta.archived : '')
    );
    lines.push(
      'System: ' +
        (meta.platform || data.platform || 'unknown') +
        (data.osRelease ? ' ' + data.osRelease : '') +
        (versions.electron ? ' · Electron ' + versions.electron : '') +
        (versions.chrome ? ' · Chrome ' + versions.chrome : '')
    );
    if (meta.shortcut) lines.push('Summon shortcut: ' + meta.shortcut);
    lines.push(
      'Vault: ' +
        (Number(vault.projects) || 0) +
        ' projects · ' +
        Math.max(0, Math.round((Number(vault.bytes) || 0) / 1024)) +
        ' KB'
    );
    lines.push(
      'Settings: theme ' +
        (settings.theme || 'system') +
        ' · palette ' +
        (settings.palette || 'paper') +
        ' · accent ' +
        (settings.accent || 'ember') +
        ' · previews ' +
        onOff(settings.previews) +
        ' · detection ' +
        onOff(settings.detectOnAdd) +
        ' · update checks ' +
        onOff(settings.checkUpdates)
    );
    if (data.kind) {
      lines.push('Report: ' + data.kind);
    }
    const errors = Array.isArray(data.errors) ? data.errors.slice(-3) : [];
    if (errors.length) {
      lines.push('Recent renderer errors:');
      for (const error of errors) {
        const message = String(error && error.message ? error.message : error || '')
          .replace(/\s+/g, ' ')
          .slice(0, 240);
        lines.push('  · ' + message);
      }
    }
    lines.push('When: ' + new Date().toISOString());
    lines.push('(No project names, URLs or secret values are included.)');
    return lines.join('\n');
  }

  function envelope(kind, message, report, includeDiagnostics) {
    const body = String(message || '').trim();
    if (!includeDiagnostics) return body;
    return (
      body +
      '\n\n<details><summary>Diagnostics</summary>\n\n```\n' +
      report +
      '\n```\n\n</details>\n'
    );
  }

  function titleFor(kind, message) {
    const label = kind === 'bug' ? 'Bug' : kind === 'idea' ? 'Idea' : 'Feedback';
    const line = firstLine(message, 72);
    return '[' + label + '] ' + (line || 'napkin++');
  }

  function cap(text, max) {
    const value = String(text || '');
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  }

  /** A prefilled GitHub issue URL, capped so it survives a browser. */
  function issueUrl(input) {
    const data = input || {};
    const repo = String(data.repo || '').replace(/^\/+|\/+$/g, '');
    const kind = KINDS.includes(data.kind) ? data.kind : 'other';
    const body = cap(envelope(kind, data.message, data.report, data.includeDiagnostics !== false), 5800);
    const params = new URLSearchParams();
    params.set('title', titleFor(kind, data.message));
    params.set('body', body);
    if (kind === 'bug') params.set('labels', 'bug');
    else if (kind === 'idea') params.set('labels', 'enhancement');
    return 'https://github.com/' + repo + '/issues/new?' + params.toString();
  }

  function mailtoUrl(input) {
    const data = input || {};
    const kind = KINDS.includes(data.kind) ? data.kind : 'other';
    const body = cap(envelope(kind, data.message, data.report, data.includeDiagnostics !== false), 1600);
    const email = String(data.email || '').trim();
    return (
      'mailto:' +
      email +
      '?subject=' +
      encodeURIComponent('napkin++ ' + kind + ' — ' + firstLine(data.message, 60)) +
      '&body=' +
      encodeURIComponent(body)
    );
  }

  /** The exact text "Copy report" puts on the clipboard. */
  function clipboardReport(input) {
    const data = input || {};
    const kind = KINDS.includes(data.kind) ? data.kind : 'other';
    return (
      'napkin++ ' +
      kind +
      '\n\n' +
      String(data.message || '').trim() +
      '\n\n' +
      (data.includeDiagnostics === false ? '' : data.report || '')
    ).trim();
  }

  return {
    KINDS,
    diagnostics,
    titleFor,
    issueUrl,
    mailtoUrl,
    clipboardReport,
    firstLine,
    redactPath,
  };
});
