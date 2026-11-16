'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../app/model.js');
const search = require('../app/search.js');

function seed() {
  let vault = model.createVault();
  const act = (type, payload) => {
    const res = model.applyAction(vault, { type, payload });
    assert.equal(res.ok, true, res.error);
    vault = res.state;
    return res.result;
  };
  const lu = act('project.create', {
    name: 'lu app',
    tags: ['dev', 'client'],
    stack: ['Next.js', 'Supabase'],
    description: 'Client portal for Lu',
  }).project;
  act('link.upsert', {
    projectId: lu.id,
    link: { label: 'Repo', url: 'https://github.com/acme/lu', kind: 'repo' },
  });
  act('link.upsert', {
    projectId: lu.id,
    link: { label: 'Live', url: 'https://lu.app', kind: 'live' },
  });
  act('service.upsert', {
    projectId: lu.id,
    service: { provider: 'Resend', role: 'email', url: 'https://resend.com/api-keys' },
  });
  act('service.upsert', {
    projectId: lu.id,
    service: { provider: 'Vercel', role: 'hosting', url: 'https://vercel.com/acme/lu' },
  });
  act('account.upsert', {
    projectId: lu.id,
    account: {
      label: 'test-1',
      email: 'one@lu.app',
      env: 'dev',
      fields: [{ label: 'Password', value: 'p1', hidden: true }],
    },
  });
  act('account.upsert', {
    projectId: lu.id,
    account: { label: 'owner', email: 'me@lu.app', env: 'prod' },
  });
  const envResult = act('env.upsert', {
    projectId: lu.id,
    env: { name: 'dev', url: 'https://dev.lu.app', vars: [] },
  });
  act('env.vars.add', {
    projectId: lu.id,
    envId: envResult.env.id,
    vars: [
      { key: 'RESEND_API_KEY', value: 're_123' },
      { key: 'SUPABASE_URL', value: 'https://xyz.supabase.co' },
    ],
  });
  act('entry.upsert', {
    projectId: lu.id,
    entry: { type: 'snippet', title: 'Supabase auth helper', body: 'createClient(URL, KEY)' },
  });

  const pay = act('project.create', { name: 'payments', tags: ['infra'] }).project;
  act('link.upsert', {
    projectId: pay.id,
    link: { label: 'Repo', url: 'https://bitbucket.org/acme/payments', kind: 'repo' },
  });
  act('service.upsert', { projectId: pay.id, service: { provider: 'Railway', role: 'hosting' } });
  return { vault, lu, pay };
}

test('builds an index covering every entity', () => {
  const { vault } = seed();
  const index = search.buildIndex(vault);
  const kinds = new Set(index.map((d) => d.kind));
  assert.deepEqual(
    [...kinds].sort(),
    ['account', 'accountfield', 'entry', 'environment', 'envvar', 'link', 'project', 'service'].sort()
  );
  assert.ok(index.filter((d) => d.kind === 'account').length >= 2);
  assert.ok(index.some((d) => d.kind === 'envvar' && d.copyLabel === 'RESEND_API_KEY (secret)'));
});

test('project search finds by name and ranks the project first', () => {
  const { vault } = seed();
  const index = search.buildIndex(vault);
  const res = search.search(index, 'lu');
  assert.equal(res.results[0].kind, 'project');
  assert.equal(res.results[0].id, vault.projects.find((p) => p.name === 'lu app').id);
});

test('service and env values are searchable across projects', () => {
  const { vault } = seed();
  const index = search.buildIndex(vault);
  const resend = search.search(index, 'resend');
  assert.ok(resend.results.some((r) => r.kind === 'service' && r.title === 'Resend'));
  assert.ok(resend.results.some((r) => r.kind === 'envvar' && r.copyValue === 're_123'));

  const vercel = search.search(index, 'vercel');
  assert.ok(vercel.results.some((r) => r.kind === 'service' && r.title === 'Vercel'));

  const railway = search.search(index, 'railway');
  assert.ok(railway.results.some((r) => r.kind === 'service' && r.title === 'Railway'));
});

test('env var search exposes the copyable secret value', () => {
  const { vault } = seed();
  const index = search.buildIndex(vault);
  const res = search.search(index, 'RESEND_API_KEY');
  const hit = res.results.find((r) => r.kind === 'envvar');
  assert.equal(hit.copyValue, 're_123');
  assert.equal(hit.hidden, true);
  assert.equal(hit.copyLabel, 'RESEND_API_KEY (secret)');
});

test('account fields are indexed and copyable from the palette', () => {
  const { vault } = seed();
  const index = search.buildIndex(vault);
  const res = search.search(index, 'password test-1');
  const hit = res.results.find((r) => r.kind === 'accountfield');
  assert.ok(hit);
  assert.equal(hit.copyValue, 'p1');
  assert.equal(hit.hidden, true);
  assert.equal(hit.title, 'Password');
  assert.equal(hit.subtitle, 'test-1 · lu app');
});

test('supports type:, tag, project and favorite filters', () => {
  const { vault } = seed();
  const index = search.buildIndex(vault);

  const accounts = search.search(index, 'type:account lu');
  assert.ok(accounts.results.length >= 1);
  assert.ok(accounts.results.every((r) => r.kind === 'account'));

  const links = search.search(index, 'type:link lu');
  assert.ok(links.results.every((r) => r.kind === 'link'));

  const creds = search.search(index, 'type:cred');
  assert.ok(creds.results.length >= 1);
  assert.ok(creds.results.every((r) => r.kind === 'accountfield'));

  const infra = search.search(index, '#infra');
  assert.ok(infra.results.length >= 1);
  assert.ok(infra.results.every((r) => r.projectName === 'payments'));

  const scoped = search.search(index, 'project:payments repo');
  assert.ok(scoped.results.length >= 1);
  assert.ok(scoped.results.every((r) => r.projectName === 'payments'));

  const favs = search.search(index, 'is:fav');
  assert.equal(favs.results.length, 0);
});

test('subsequence matching finds sloppy queries', () => {
  const { vault } = seed();
  const index = search.buildIndex(vault);
  const res = search.search(index, 'lua');
  assert.ok(res.results.some((r) => r.kind === 'project'));
  const typo = search.search(index, 'verc');
  assert.ok(typo.results.some((r) => r.title === 'Vercel'));
});

test('empty query returns newest docs and respects filters', () => {
  const { vault } = seed();
  const index = search.buildIndex(vault);
  const all = search.search(index, '');
  assert.ok(all.results.length > 0);
  const onlyAccounts = search.search(index, 'type:account');
  assert.ok(onlyAccounts.results.every((r) => r.kind === 'account'));
  assert.ok(onlyAccounts.results.length >= 2);
});

test('nonsense queries return nothing', () => {
  const { vault } = seed();
  const index = search.buildIndex(vault);
  assert.equal(search.search(index, 'zzzzqqqqxxxx').results.length, 0);
});

test('fieldScore prefers prefixes over interior matches', () => {
  assert.equal(search.fieldScore('lu app', 'lu'), 1);
  assert.ok(search.fieldScore('the lu app', 'lu') > 0.8);
  assert.ok(search.fieldScore('value', 'zzz') < 0.8);
});
