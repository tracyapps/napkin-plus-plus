'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const feedback = require('../app/feedback.js');

const base = {
  kind: 'bug',
  message: 'Pasting a .env block dropped the last key.\nIt happened on staging.',
  report: 'napkin++ 1.0.0 · arm64\nVault: 3 projects · 12 KB\n(No project names, URLs or secret values are included.)',
  includeDiagnostics: true,
  repo: 'tracyapps/napkin-plus-plus',
  email: 'hello@napkinplusplus.app',
};

test('diagnostics stay boring and never mention vault content', () => {
  const report = feedback.diagnostics({
    meta: {
      version: '1.0.0',
      packaged: true,
      platform: 'darwin',
      arch: 'arm64',
      shortcut: 'Alt+Space',
      versions: { electron: '45.2.1', chrome: '140.0.0' },
    },
    vault: { projects: 3, bytes: 12288 },
    settings: {
      theme: 'system',
      palette: 'paper',
      accent: 'ember',
      previews: true,
      detectOnAdd: false,
      checkUpdates: true,
    },
    errors: [{ message: 'TypeError: x is undefined' }],
    arch: 'arm64',
    osRelease: '24.1.0',
  });
  assert.match(report, /napkin\+\+ 1\.0\.0/);
  assert.match(report, /Vault: 3 projects/);
  assert.match(report, /detection off/);
  assert.match(report, /TypeError: x is undefined/);
  assert.match(report, /No project names/);
  assert.ok(!report.includes('lu app'));
});

test('a home directory is redacted from paths', () => {
  assert.equal(
    feedback.redactPath('/Users/tracy/Library/Application Support/napkin++', '/Users/tracy'),
    '~/Library/Application Support/napkin++'
  );
  assert.equal(feedback.redactPath('relative/path', '/Users/tracy'), 'relative/path');
});

test('the issue URL is prefilled, labelled and capped', () => {
  const url = feedback.issueUrl(base);
  assert.ok(url.startsWith('https://github.com/tracyapps/napkin-plus-plus/issues/new?'));
  const params = new URL(url).searchParams;
  assert.equal(params.get('title'), '[Bug] Pasting a .env block dropped the last key.');
  assert.equal(params.get('labels'), 'bug');
  assert.match(params.get('body'), /dropped the last key/);
  assert.match(params.get('body'), /<details><summary>Diagnostics<\/summary>/);

  const huge = feedback.issueUrl(Object.assign({}, base, { message: 'x'.repeat(9000) }));
  assert.ok(huge.length < 9000, 'URL should be capped, was ' + huge.length);
});

test('the mailto URL leaves diagnostics out when unticked', () => {
  const url = feedback.mailtoUrl(Object.assign({}, base, { includeDiagnostics: false }));
  assert.ok(url.startsWith('mailto:hello@napkinplusplus.app?'));
  const body = decodeURIComponent(url.split('&body=')[1]);
  assert.match(body, /dropped the last key/);
  assert.ok(!body.includes('Vault: 3 projects'));
});

test('the clipboard report is the message plus diagnostics', () => {
  const text = feedback.clipboardReport(base);
  assert.match(text, /^napkin\+\+ bug/);
  assert.match(text, /dropped the last key/);
  assert.match(text, /Vault: 3 projects/);
  const without = feedback.clipboardReport(Object.assign({}, base, { includeDiagnostics: false }));
  assert.ok(!without.includes('Vault: 3 projects'));
});

test('titleFor adds the right label and collapses whitespace', () => {
  assert.equal(feedback.titleFor('idea', '  Add a grid\nplease '), '[Idea] Add a grid');
  assert.equal(feedback.titleFor('other', ''), '[Feedback] napkin++');
});
