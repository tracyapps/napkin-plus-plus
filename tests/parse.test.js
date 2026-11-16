'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parse = require('../app/parse.js');

const ENV_BLOCK = [
  '# lu app — local',
  'export SUPABASE_URL=https://xyz.supabase.co',
  'GREETING="hello world"',
  'DATABASE_URL=postgres://u:p@host:5432/db',
  'PORT=3000 # local dev',
  'EMPTY=',
].join('\n');

const ACCOUNT_BLOCK = [
  'prod: hello@lu.app : hunter2',
  'Test 2 | second@lu.app | s3cret!',
  'billing: acct@lu.app : Pa$$w0rd note=stripe test',
].join('\n');

test('parses .env blocks with exports, quotes, comments and empties', () => {
  const res = parse.parseEnvBlock(ENV_BLOCK);
  assert.equal(res.pairs.length, 5);
  assert.equal(res.confidence, 1);
  const byKey = Object.fromEntries(res.pairs.map((p) => [p.key, p]));
  assert.equal(byKey.SUPABASE_URL.value, 'https://xyz.supabase.co');
  assert.equal(byKey.GREETING.value, 'hello world');
  assert.equal(byKey.DATABASE_URL.value, 'postgres://u:p@host:5432/db');
  assert.equal(byKey.PORT.value, '3000');
  assert.equal(byKey.EMPTY.value, '');
});

test('parses JSON objects as env pairs', () => {
  const res = parse.parseEnvBlock('{"API_URL":"https://x.dev","COUNT":3}');
  assert.equal(res.source, 'json');
  assert.equal(res.pairs.length, 2);
  assert.equal(res.pairs.find((p) => p.key === 'COUNT').value, '3');
});

test('does not mistake a labelled link for an env var', () => {
  const res = parse.parseEnvBlock('Repo: https://github.com/acme/lu');
  assert.equal(res.pairs.length, 0);
  assert.equal(parse.detectTextKind('Repo: https://github.com/acme/lu').kind, 'links');
});

test('parses account lines with labels, usernames and notes', () => {
  const accounts = parse.parseAccountLines(ACCOUNT_BLOCK);
  assert.equal(accounts.length, 3);
  assert.equal(accounts[0].label, 'prod');
  assert.equal(accounts[0].email, 'hello@lu.app');
  assert.equal(accounts[0].fields[0].value, 'hunter2');
  assert.equal(accounts[0].fields[0].hidden, true);
  assert.equal(accounts[1].label, 'Test 2');
  assert.equal(accounts[1].fields[0].value, 's3cret!');
  assert.equal(accounts[2].label, 'billing');
  assert.equal(accounts[2].fields[0].value, 'Pa$$w0rd');
  assert.ok(accounts[2].notes.includes('stripe test'));
});

test('finds usernames inside labelled lines without inventing credentials', () => {
  const [account] = parse.parseAccountLines('dashboard — email: me@lu.app username: lu-admin');
  assert.equal(account.email, 'me@lu.app');
  assert.equal(account.username, 'lu-admin');
  assert.equal(account.fields.length, 0);
});

test('parses links, labels and guesses kinds/providers', () => {
  const links = parse.parseLinks(
    [
      'Repo — https://github.com/acme/lu',
      'Live: https://lu.app',
      'Docs: https://docs.lu.app',
      'Dashboard https://vercel.com/acme/lu',
      'https://bitbucket.org/acme/payments',
    ].join('\n')
  );
  assert.equal(links.length, 5);
  assert.equal(links[0].kind, 'repo');
  assert.equal(links[0].label, 'Repo');
  assert.equal(links[1].kind, 'live');
  assert.equal(links[2].kind, 'docs');
  assert.equal(links[3].kind, 'dashboard');
  assert.equal(links[3].provider, 'Vercel');
  assert.equal(links[4].provider, 'Bitbucket');
  assert.equal(links[4].kind, 'repo');
});

test('recognizes common providers, including the b-word', () => {
  assert.equal(parse.guessProvider('https://resend.com/api-keys'), 'Resend');
  assert.equal(parse.guessProvider('https://app.brevo.com/'), 'Brevo');
  assert.equal(parse.guessProvider('https://console.neon.tech/app'), 'Neon');
  assert.equal(parse.guessProvider('https://supabase.com/dashboard'), 'Supabase');
  assert.equal(parse.guessProvider('https://railway.com/project/x'), 'Railway');
  assert.equal(parse.guessProvider('https://livekit.io/'), 'LiveKit');
  assert.equal(parse.guessProvider('https://clerk.com/'), 'Clerk');
  assert.equal(parse.guessProvider('https://example.com'), '');
});

test('detects what a pasted blob is', () => {
  assert.equal(parse.detectTextKind(ENV_BLOCK).kind, 'env');
  assert.equal(parse.detectTextKind(ACCOUNT_BLOCK).kind, 'accounts');
  assert.equal(parse.detectTextKind('Repo: https://github.com/a/b').kind, 'links');
  assert.equal(parse.detectTextKind('const x = {\n  a: 1,\n};').kind, 'code');
  assert.equal(parse.detectTextKind('remember to rotate the key on Friday').kind, 'note');
  assert.equal(parse.detectTextKind('   ').kind, 'empty');
});

test('detects stack keywords in order without duplicates', () => {
  const stack = parse.detectStack('Next.js 15 on Vercel with TypeScript, Supabase and Tailwind.');
  assert.deepEqual(stack, ['Next.js', 'Vercel', 'TypeScript', 'Supabase', 'Tailwind']);
});

test('splits an old notes file on headings', () => {
  const blob = [
    'LU APP',
    'Repo: https://github.com/acme/lu',
    'Live: https://lu.app',
    '',
    'PAYMENTS',
    'Repo: https://bitbucket.org/acme/payments',
    'APP_NAME=payments',
  ].join('\n');
  const blocks = parse.splitBlob(blob, 'notes');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].name, 'Lu App');
  assert.ok(blocks[0].hints.links >= 2);
  assert.equal(blocks[1].name, 'Payments');
  assert.equal(blocks[1].hints.envPairs, 1);
});

test('falls back to blank-line chunks when there are no headings', () => {
  const blob = ['lu app', 'notes here', '', '', 'payments', 'more notes'].join('\n');
  const blocks = parse.splitBlob(blob, 'notes');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].name, 'lu app');
  assert.equal(blocks[1].name, 'payments');
});

test('keeps a single unheaded file as one block', () => {
  const blocks = parse.splitBlob('APP_NAME=lu\nPORT=3000', 'my napkin');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].name, 'my napkin');
  assert.equal(blocks[0].hints.envPairs, 2);
});

test('names an unheaded import after its first real line', () => {
  const blocks = parse.splitBlob('digital ocean ta.org new\n\ndatabase pw', 'imported');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].name, 'digital ocean ta.org new');
  assert.equal(blocks[0].body, 'digital ocean ta.org new\n\ndatabase pw');
});

test('does not name a block after credential shorthand', () => {
  const blocks = parse.splitBlob('user: wcfjip\n\n\nWP ADMIN:\nu: \nwcfjip admin\n\np:\n', 'imported');
  assert.equal(blocks.length, 2);
  assert.notEqual(blocks[0].name, 'user: wcfjip');
  assert.equal(blocks[1].name, 'Wp Admin');
  assert.equal(parse.headingOf('WP ADMIN:'), 'Wp Admin');
});

test('splits on dashed dividers and ignores shouting section labels', () => {
  const text = [
    'digital ocean ta.org new',
    'database pw',
    '',
    '----',
    '',
    'WP ADMIN:',
    'u: wcfjip',
    'p: 1234',
    '',
    'SUPABASE',
    'url: https://x.supabase.co',
  ].join('\n');
  const blocks = parse.splitBlob(text, '');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].name, 'digital ocean ta.org new');
  assert.equal(blocks[1].name, 'WP ADMIN');
  assert.ok(blocks[1].body.includes('SUPABASE'));
});

test('does not name a block after an access key or DSN', () => {
  const blocks = parse.splitBlob(
    'aws\nzaobank\naccess key\nAKIATVMN53WPS3ID3EOT\n----\npostgresql://owner:pw@host/db\nmail box',
    ''
  );
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].name, 'aws');
  assert.notEqual(blocks[1].name, 'AKIATVMN53WPS3ID3EOT');
  assert.ok(!/^postgresql:/.test(blocks[1].name));
});

test('turns a parsed block into a project draft', () => {
  const blocks = parse.splitBlob(ENV_BLOCK, 'lu app');
  const draft = parse.projectDraft(blocks[0]);
  assert.equal(draft.envs.length, 1);
  assert.equal(draft.envs[0].vars.length, 5);
  assert.equal(draft.envs[0].vars[2].key, 'DATABASE_URL');
});

test('capture routing spreads one paste across env, links, code and note', () => {
  const text = [
    'APP_NAME=lu',
    'DATABASE_URL=postgres://u:p@host:5432/db',
    'Repo: https://github.com/acme/lu',
    'const client = createClient(process.env.DATABASE_URL);',
    'Remember to rotate the staging key on Friday.',
  ].join('\n');
  const plan = parse.routeCapture(text);
  assert.equal(plan.env.pairs.length, 2);
  assert.equal(plan.links.length, 1);
  assert.equal(plan.links[0].kind, 'repo');
  assert.ok(plan.code.includes('createClient'));
  assert.ok(plan.note.includes('rotate the staging key'));
  assert.deepEqual(plan.kinds, ['env', 'links', 'code', 'note']);
});

test('capture routing treats a single uppercase assignment as env', () => {
  const plan = parse.routeCapture('SITE_URL=https://lu.app');
  assert.equal(plan.env.pairs.length, 1);
  assert.equal(plan.env.pairs[0].key, 'SITE_URL');
  assert.equal(plan.note, '');
});

test('capture routing keeps context lines that merely contain a URL', () => {
  const plan = parse.routeCapture('deploy notes https://vercel.com/acme/lu — free tier');
  assert.equal(plan.links.length, 1);
  assert.ok(plan.note.includes('deploy notes'));
});

test('capture routing files logins as accounts', () => {
  const plan = parse.routeCapture('prod: hello@lu.app : hunter2\nTest 2 | second@lu.app | s3cret!');
  assert.equal(plan.accounts.length, 2);
  assert.equal(plan.accounts[0].fields[0].value, 'hunter2');
  assert.equal(plan.kinds[0], 'accounts');
});

test('capture routing sends a plain sentence to notes', () => {
  const plan = parse.routeCapture('ask Lu about the staging database');
  assert.equal(plan.note, 'ask Lu about the staging database');
  assert.deepEqual(plan.kinds, ['note']);
});

test('capture routing keeps env comments rather than swallowing them', () => {
  const plan = parse.routeCapture('# lu app — local\nAPP_NAME=lu\nPORT=3000');
  assert.equal(plan.env.pairs.length, 2);
  assert.ok(plan.note.includes('# lu app — local'));
});

test('capture routing does not mistake prose for control flow', () => {
  const plan = parse.routeCapture(
    'const port = 3000;\nIf you need the staging key, ask Lu.\nfor the client, use their login.'
  );
  assert.ok(plan.code.includes('const port'));
  assert.ok(plan.note.includes('If you need the staging key'));
  assert.ok(plan.note.includes('for the client'));
});
