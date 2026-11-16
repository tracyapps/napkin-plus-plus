'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../app/model.js');

function harness() {
  let vault = model.createVault();
  return {
    get vault() {
      return vault;
    },
    act(type, payload) {
      const res = model.applyAction(vault, { type, payload });
      assert.equal(res.ok, true, res.error);
      vault = res.state;
      return res.result;
    },
    tryAct(type, payload) {
      const res = model.applyAction(vault, { type, payload });
      if (res.ok) vault = res.state;
      return res;
    },
  };
}

function credential(value) {
  return [{ label: 'Password', value, hidden: true }];
}

test('creates a project with defaults and records it as recent', () => {
  const h = harness();
  const { project } = h.act('project.create', { name: '  lu app  ' });
  assert.equal(project.name, 'lu app');
  assert.equal(project.status, 'active');
  assert.deepEqual(project.accounts, []);
  assert.deepEqual(h.vault.ui.recent, [project.id]);
});

test('rejects empty, duplicate and colliding project names', () => {
  const h = harness();
  h.act('project.create', { name: 'lu app' });
  assert.equal(h.tryAct('project.create', { name: 'lu-app' }).ok, false);
  assert.equal(h.tryAct('project.create', { name: '   ' }).ok, false);

  const second = h.act('project.create', { name: 'payments' }).project;
  const clash = h.tryAct('project.update', { id: second.id, patch: { name: 'LU APP' } });
  assert.equal(clash.ok, false);
});

test('trims, de-duplicates and validates tags/aliases', () => {
  const h = harness();
  const { project } = h.act('project.create', { name: 'lu app' });
  h.act('project.update', {
    id: project.id,
    patch: { tags: [' dev ', 'dev', '', 'infra'], aliases: ['Lu', 'LU APP'] },
  });
  const updated = model.getProject(h.vault, project.id);
  assert.deepEqual(updated.tags, ['dev', 'infra']);
  assert.deepEqual(updated.aliases, ['Lu']);
});

test('many accounts per project: create, edit in place, delete', () => {
  const h = harness();
  const { project } = h.act('project.create', { name: 'lu app' });
  const a = h.act('account.upsert', {
    projectId: project.id,
    account: { label: 'test-1', email: 'one@lu.app', env: 'dev', fields: credential('p1') },
  }).account;
  h.act('account.upsert', {
    projectId: project.id,
    account: { label: 'test-2', email: 'two@lu.app', env: 'test', fields: credential('p2') },
  });
  let live = model.getProject(h.vault, project.id);
  assert.equal(live.accounts.length, 2);
  assert.equal(live.accounts[0].fields[0].hidden, true);

  h.act('account.upsert', {
    projectId: project.id,
    account: { ...a, label: 'test-1-renamed' },
  });
  live = model.getProject(h.vault, project.id);
  assert.equal(live.accounts.length, 2);
  assert.equal(live.accounts.find((x) => x.id === a.id).label, 'test-1-renamed');
  assert.equal(live.accounts.find((x) => x.id === a.id).fields.length, 1);

  h.act('account.delete', { projectId: project.id, id: a.id });
  assert.equal(model.getProject(h.vault, project.id).accounts.length, 1);
});

test('account fields are typed and masking is inferred from the label', () => {
  const h = harness();
  const { project } = h.act('project.create', { name: 'lu app' });
  const { account } = h.act('account.upsert', {
    projectId: project.id,
    account: {
      label: 'owner',
      email: 'me@lu.app',
      fields: [{ label: 'PIN', value: '1234' }, { label: 'Member ID', value: 'M-9' }],
    },
  });
  assert.equal(account.fields.length, 2);
  assert.equal(account.fields[0].hidden, true);
  assert.equal(account.fields[1].hidden, false);
});

test('env vars: bulk add, masking, replace and delete', () => {
  const h = harness();
  const { project } = h.act('project.create', { name: 'lu app' });
  const added = h.act('env.vars.add', {
    projectId: project.id,
    envName: 'dev',
    vars: [
      { key: 'RESEND_API_KEY', value: 're_1' },
      { key: 'NODE_ENV', value: 'development' },
    ],
  });
  assert.equal(added.added, 2);
  let live = model.getProject(h.vault, project.id);
  assert.equal(live.envs.length, 1);
  assert.equal(live.envs[0].name, 'dev');
  assert.equal(live.envs[0].vars[0].hidden, true);
  assert.equal(live.envs[0].vars[1].hidden, false);

  h.act('env.vars.add', {
    projectId: project.id,
    envId: live.envs[0].id,
    vars: [{ key: 'RESEND_API_KEY', value: 're_2' }],
  });
  live = model.getProject(h.vault, project.id);
  assert.equal(live.envs[0].vars.length, 2);
  assert.equal(live.envs[0].vars[0].value, 're_2');

  h.act('env.upsert', {
    projectId: project.id,
    env: { id: live.envs[0].id, name: 'prod', url: 'https://lu.app', vars: live.envs[0].vars },
  });
  live = model.getProject(h.vault, project.id);
  assert.equal(live.envs[0].name, 'prod');
  assert.equal(live.envs[0].url, 'https://lu.app');

  h.act('var.delete', { projectId: project.id, envId: live.envs[0].id, id: live.envs[0].vars[0].id });
  assert.equal(model.getProject(h.vault, project.id).envs[0].vars.length, 1);
});

test('rejects a second environment with the same name but allows more envs', () => {
  const h = harness();
  const { project } = h.act('project.create', { name: 'lu app' });
  h.act('env.upsert', { projectId: project.id, env: { name: 'dev', vars: [] } });
  assert.equal(h.tryAct('env.upsert', { projectId: project.id, env: { name: 'DEV', vars: [] } }).ok, false);
  h.act('env.upsert', { projectId: project.id, env: { name: 'production', vars: [] } });
  assert.equal(model.getProject(h.vault, project.id).envs.length, 2);
});

test('links and services require sane values', () => {
  const h = harness();
  const { project } = h.act('project.create', { name: 'lu app' });
  assert.equal(h.tryAct('link.upsert', { projectId: project.id, link: { label: 'x', url: 'javascript:alert(1)' } }).ok, false);
  assert.equal(h.tryAct('service.upsert', { projectId: project.id, service: { provider: '  ' } }).ok, false);
  h.act('service.upsert', { projectId: project.id, service: { provider: 'Vercel', role: 'hosting' } });
  assert.equal(model.getProject(h.vault, project.id).services[0].provider, 'Vercel');
});

test('entries default their title from the first line', () => {
  const h = harness();
  const { project } = h.act('project.create', { name: 'lu app' });
  const { entry } = h.act('entry.upsert', {
    projectId: project.id,
    entry: { type: 'snippet', body: '\n\nSELECT * FROM users;\n' },
  });
  assert.equal(entry.title, 'SELECT * FROM users;');
  assert.equal(entry.type, 'snippet');
});

test('name similarity handles punctuation, spacing and aliases', () => {
  assert.equal(model.nameSimilarity('lu app', 'lu-app'), 1);
  assert.equal(model.nameSimilarity('lu app', 'luapp'), 1);
  assert.ok(model.nameSimilarity('lu app', 'lu app v2') > 0.6);
  assert.ok(model.nameSimilarity('lu app', 'payments') < 0.4);
  assert.equal(model.nameSimilarity('Café', 'cafe'), 1);
});

test('finds duplicates by name, repo and shared account email', () => {
  const h = harness();
  const { project } = h.act('project.create', { name: 'lu app' });
  h.act('link.upsert', {
    projectId: project.id,
    link: { label: 'Repo', url: 'https://github.com/acme/lu', kind: 'repo' },
  });
  h.act('account.upsert', {
    projectId: project.id,
    account: { label: 'owner', email: 'me@lu.app' },
  });

  const byName = model.findDuplicates(h.vault, { name: 'LU-APP' });
  assert.equal(byName[0].project.id, project.id);
  assert.ok(byName[0].score >= 0.9);

  const byRepo = model.findDuplicates(h.vault, {
    name: 'something else',
    repoUrl: 'https://github.com/acme/lu',
  });
  assert.equal(byRepo[0].project.id, project.id);
  assert.ok(byRepo[0].reasons.includes('same repo'));

  const byEmail = model.findDuplicates(h.vault, { name: 'zzz', emails: ['me@lu.app'] });
  assert.equal(byEmail[0].project.id, project.id);

  const none = model.findDuplicates(h.vault, { name: 'totally unrelated zzz' });
  assert.equal(none.length, 0);
});

test('merging unions everything and keeps distinct accounts', () => {
  const h = harness();
  const target = h.act('project.create', { name: 'lu app', tags: ['dev'], stack: ['Next.js'] }).project;
  h.act('link.upsert', {
    projectId: target.id,
    link: { label: 'Repo', url: 'https://github.com/acme/lu', kind: 'repo' },
  });
  h.act('account.upsert', {
    projectId: target.id,
    account: { label: 'test-1', email: 'one@lu.app', fields: credential('p1') },
  });
  h.act('env.upsert', {
    projectId: target.id,
    env: { name: 'dev', vars: [{ key: 'RESEND_API_KEY', value: 're_1' }] },
  });

  const source = h.act('project.create', { name: 'lu-app-legacy', tags: ['infra'] }).project;
  h.act('link.upsert', {
    projectId: source.id,
    link: { label: 'GitHub', url: 'https://github.com/acme/lu', kind: 'repo' },
  });
  h.act('account.upsert', {
    projectId: source.id,
    account: { label: 'test-1', email: 'one@lu.app', fields: credential('p1') },
  });
  h.act('account.upsert', {
    projectId: source.id,
    account: { label: 'test-2', email: 'two@lu.app', fields: credential('p2') },
  });
  h.act('entry.upsert', {
    projectId: source.id,
    entry: { type: 'note', title: 'legacy note', body: 'hello' },
  });
  h.act('env.upsert', {
    projectId: source.id,
    env: {
      name: 'dev',
      vars: [
        { key: 'RESEND_API_KEY', value: 're_2' },
        { key: 'NEW_FLAG', value: '1' },
      ],
    },
  });

  const result = h.act('project.merge', { targetId: target.id, sourceIds: [source.id] });
  assert.equal(h.vault.projects.length, 1);
  const merged = model.getProject(h.vault, target.id);
  assert.deepEqual(merged.aliases, ['lu-app-legacy']);
  assert.deepEqual(merged.tags.sort(), ['dev', 'infra']);
  assert.equal(merged.links.length, 1);
  assert.equal(merged.accounts.length, 2);
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.envs.length, 1);
  assert.equal(merged.envs[0].vars.length, 2);
  assert.equal(merged.envs[0].vars.find((v) => v.key === 'RESEND_API_KEY').value, 're_1');
  assert.equal(result.after.accounts, 2);
  assert.equal(result.after.fields, 2);
  assert.equal(result.sourceIds.length, 1);
});

test('explicit source preference wins conflicting env values', () => {
  const h = harness();
  const a = h.act('project.create', { name: 'lu' }).project;
  h.act('env.vars.add', { projectId: a.id, envName: 'dev', vars: [{ key: 'TOKEN', value: 'old' }] });
  const b = h.act('project.create', { name: 'lu legacy' }).project;
  h.act('env.vars.add', { projectId: b.id, envName: 'dev', vars: [{ key: 'TOKEN', value: 'new' }] });

  const target = model.clone(model.getProject(h.vault, a.id));
  const source = model.clone(model.getProject(h.vault, b.id));
  model.mergeProjects(target, source, { prefer: 'source' });
  assert.equal(target.envs[0].vars[0].value, 'new');
});

test('stats and gaps describe what the dossier is missing', () => {
  const h = harness();
  const { project } = h.act('project.create', { name: 'lu app' });
  const gaps = model.projectGaps(project);
  assert.ok(gaps.includes('No code repo link'));
  assert.ok(gaps.includes('No accounts'));
  h.act('link.upsert', {
    projectId: project.id,
    link: { label: 'Live', url: 'https://lu.app', kind: 'live' },
  });
  const live = model.getProject(h.vault, project.id);
  const stats = model.projectStats(live);
  assert.equal(stats.links, 1);
  assert.ok(!model.projectGaps(live).includes('No live URL'));
});

test('serializes .env values with quoting only when needed', () => {
  assert.equal(model.envLine('A', 'simple'), 'A=simple');
  assert.equal(model.envLine('B', 'hello world'), 'B="hello world"');
  assert.equal(model.envLine('C', 'a"b'), 'C="a\\"b"');
  assert.equal(model.envLine('D', ''), 'D=""');
  assert.equal(
    model.serializeEnv([
      { key: 'ONE', value: '1' },
      { key: 'TWO', value: 'two words' },
    ]),
    'ONE=1\nTWO="two words"'
  );
});

test('markdown export redacts hidden values by default', () => {
  const h = harness();
  const { project } = h.act('project.create', { name: 'lu app' });
  h.act('account.upsert', {
    projectId: project.id,
    account: { label: 'owner', email: 'me@lu.app', fields: credential('hunter2') },
  });
  h.act('env.vars.add', {
    projectId: project.id,
    envName: 'prod',
    vars: [{ key: 'STRIPE_SECRET_KEY', value: 'sk_live_123' }],
  });
  h.act('entry.upsert', {
    projectId: project.id,
    entry: { type: 'secret', title: 'recovery codes', body: 'aaa-bbb' },
  });
  const live = model.getProject(h.vault, project.id);
  const redacted = model.exportProjectMarkdown(live);
  assert.ok(redacted.includes('••••••'));
  assert.ok(!redacted.includes('hunter2'));
  assert.ok(!redacted.includes('sk_live_123'));
  assert.ok(!redacted.includes('aaa-bbb'));
  assert.ok(model.exportProjectMarkdown(live, { redact: false }).includes('hunter2'));
});

test('validates appearance settings', () => {
  const h = harness();
  h.act('settings.update', {
    patch: { theme: 'dark', accent: 'moss', iconStyle: 'grid', menuBar: false },
  });
  assert.equal(h.vault.settings.accent, 'moss');
  assert.equal(h.vault.settings.iconStyle, 'grid');
  assert.equal(h.vault.settings.menuBar, false);
  assert.equal(h.tryAct('settings.update', { patch: { accent: 'neon' } }).ok, false);
  assert.equal(h.tryAct('settings.update', { patch: { iconStyle: 'emoji' } }).ok, false);

  const repaired = model.normalizeVault({
    settings: { accent: 'neon', iconStyle: 'bad', menuBar: false },
  });
  assert.equal(repaired.settings.accent, 'ember');
  assert.equal(repaired.settings.iconStyle, 'napkin');
  assert.equal(repaired.settings.menuBar, false);
});

test('normalizeVault repairs partial or damaged documents', () => {
  const repaired = model.normalizeVault({
    projects: [
      {
        id: 'prj_1',
        name: 'lu app',
        accounts: [{ email: 'a@b.co', fields: [{ label: 'Password', value: 'x' }] }],
        envs: [{ name: 'dev', vars: [{ key: 'A', value: '1' }] }],
      },
      { name: 'no id — dropped' },
    ],
    settings: { theme: 'neon', copyClearSeconds: 9999 },
    ui: { recent: ['prj_1', 'missing'] },
  });
  assert.equal(repaired.projects.length, 1);
  assert.equal(repaired.settings.theme, 'system');
  assert.equal(repaired.settings.copyClearSeconds, 600);
  assert.deepEqual(repaired.ui.recent, ['prj_1']);
  assert.equal(repaired.projects[0].envs[0].vars[0].hidden, false);
  assert.equal(repaired.projects[0].accounts[0].fields[0].hidden, true);
});

test('creates folders, files projects and clears them on delete', () => {
  const h = harness();
  const a = h.act('folder.create', { name: 'Clients', color: '#5c7a4f' }).folder;
  const b = h.act('folder.create', { name: 'Archive 2025' }).folder;
  assert.equal(a.color, '#5c7a4f');
  assert.notEqual(b.color, a.color);
  assert.equal(h.tryAct('folder.create', { name: 'clients' }).ok, false);

  const { project } = h.act('project.create', { name: 'lu app' });
  h.act('project.update', { id: project.id, patch: { folderId: a.id } });
  assert.equal(model.getProject(h.vault, project.id).folderId, a.id);
  assert.equal(
    h.tryAct('project.update', { id: project.id, patch: { folderId: 'fdr_missing' } }).ok,
    false
  );

  h.act('folder.update', { id: a.id, patch: { name: 'Client work', color: '#3f5f82' } });
  assert.equal(h.vault.folders.find((f) => f.id === a.id).name, 'Client work');
  assert.equal(h.tryAct('folder.update', { id: a.id, patch: { color: 'blue' } }).ok, false);

  h.act('folder.delete', { id: a.id });
  assert.equal(h.vault.folders.length, 1);
  assert.equal(model.getProject(h.vault, project.id).folderId, '');
});

test('drops folder references that do not resolve when loading', () => {
  const repaired = model.normalizeVault({
    folders: [{ id: 'fdr_1', name: 'Clients', color: '#b2531f' }, { id: 'fdr_2', name: 'clients' }],
    projects: [{ id: 'prj_1', name: 'lu app', folderId: 'fdr_9' }],
  });
  assert.equal(repaired.folders.length, 1);
  assert.equal(repaired.projects[0].folderId, '');
});

test('edits a variable in place and refuses duplicate keys', () => {
  const h = harness();
  const { project } = h.act('project.create', { name: 'lu app' });
  h.act('env.vars.add', {
    projectId: project.id,
    envName: 'dev',
    vars: [
      { key: 'PORT', value: '3000' },
      { key: 'DEBUG', value: 'true' },
    ],
  });
  const env = model.getProject(h.vault, project.id).envs[0];
  const port = env.vars.find((v) => v.key === 'PORT');
  h.act('var.update', {
    projectId: project.id,
    envId: env.id,
    id: port.id,
    key: 'APP_PORT',
    value: '4100',
  });
  const updated = model.getProject(h.vault, project.id).envs[0];
  assert.equal(updated.vars.find((v) => v.id === port.id).key, 'APP_PORT');
  assert.equal(updated.vars.find((v) => v.id === port.id).value, '4100');
  assert.equal(
    h.tryAct('var.update', {
      projectId: project.id,
      envId: env.id,
      id: port.id,
      key: 'DEBUG',
    }).ok,
    false
  );
  assert.equal(
    h.tryAct('var.update', { projectId: project.id, envId: env.id, id: port.id, key: ' ' }).ok,
    false
  );
});

test('merging chooses which name survives and aliases the old one', () => {
  const h = harness();
  const keep = h.act('project.create', { name: 'lu-app' }).project;
  const other = h.act('project.create', { name: 'Lou App' }).project;
  h.act('env.vars.add', {
    projectId: other.id,
    envName: 'dev',
    vars: [{ key: 'PORT', value: '4100' }],
  });
  const res = h.act('project.merge', {
    targetId: keep.id,
    sourceIds: [other.id],
    name: 'lu app',
  });
  assert.equal(res.name, 'lu app');
  const merged = model.getProject(h.vault, keep.id);
  assert.equal(merged.name, 'lu app');
  assert.ok(merged.aliases.includes('lu-app'));
  assert.equal(h.vault.projects.length, 1);
  assert.equal(merged.envs[0].vars[0].value, '4100');
});

test('validates palettes, custom accents and icon tints', () => {
  const h = harness();
  h.act('settings.update', {
    patch: { palette: 'nord', accent: 'custom', accentCustom: '#336699', iconTint: 'plum' },
  });
  assert.equal(h.vault.settings.palette, 'nord');
  assert.equal(h.vault.settings.accent, 'custom');
  assert.equal(h.vault.settings.accentCustom, '#336699');
  assert.equal(h.vault.settings.iconTint, 'plum');
  assert.equal(h.tryAct('settings.update', { patch: { palette: 'candy' } }).ok, false);
  assert.equal(h.tryAct('settings.update', { patch: { accentCustom: 'red' } }).ok, false);
  assert.equal(h.tryAct('settings.update', { patch: { iconTint: 'glow' } }).ok, false);

  const repaired = model.normalizeVault({
    settings: { palette: 'candy', accent: 'custom', accentCustom: 'nope', iconTint: 'glow' },
  });
  assert.equal(repaired.settings.palette, 'paper');
  assert.equal(repaired.settings.accentCustom, '#b2531f');
  assert.equal(repaired.settings.iconTint, 'auto');
});

test('merging keeps links and services that share a label but not a URL', () => {
  const h = harness();
  const a = h.act('project.create', { name: 'lu app' }).project;
  const b = h.act('project.create', { name: 'lu site' }).project;
  h.act('link.upsert', {
    projectId: a.id,
    link: { label: 'Repo', url: 'https://github.com/acme/lu', kind: 'repo' },
  });
  h.act('link.upsert', {
    projectId: b.id,
    link: { label: 'Repo', url: 'https://github.com/acme/lu-site', kind: 'repo' },
  });
  h.act('service.upsert', {
    projectId: a.id,
    service: { provider: 'Vercel', role: 'hosting', url: 'https://vercel.com/acme/lu' },
  });
  h.act('service.upsert', {
    projectId: b.id,
    service: { provider: 'Vercel', role: 'hosting', url: 'https://vercel.com/acme/lu-site' },
  });
  h.act('project.merge', { targetId: a.id, sourceIds: [b.id] });
  const merged = model.getProject(h.vault, a.id);
  assert.equal(merged.links.length, 2);
  assert.deepEqual(
    merged.links.map((l) => l.url).sort(),
    ['https://github.com/acme/lu', 'https://github.com/acme/lu-site']
  );
  assert.equal(merged.services.length, 2);
});

test('merging reports env key conflicts instead of hiding them', () => {
  const h = harness();
  const a = h.act('project.create', { name: 'lu app' }).project;
  const b = h.act('project.create', { name: 'lu site' }).project;
  h.act('env.vars.add', {
    projectId: a.id,
    envName: 'dev',
    vars: [{ key: 'PORT', value: '3000' }],
  });
  h.act('env.vars.add', {
    projectId: b.id,
    envName: 'dev',
    vars: [{ key: 'PORT', value: '4000' }],
  });
  const result = h.act('project.merge', { targetId: a.id, sourceIds: [b.id] });
  assert.equal(result.conflictCount, 1);
  assert.deepEqual(result.conflicts, ['dev · PORT']);
  const merged = model.getProject(h.vault, a.id);
  assert.equal(merged.envs[0].vars.find((v) => v.key === 'PORT').value, '3000');
});

test('renaming a variable to a sensitive key starts masking it', () => {
  const h = harness();
  const { project } = h.act('project.create', { name: 'lu app' });
  h.act('env.vars.add', {
    projectId: project.id,
    envName: 'dev',
    vars: [
      { key: 'PORT', value: '3000' },
      { key: 'DEBUG', value: 'true' },
    ],
  });
  const env = model.getProject(h.vault, project.id).envs[0];
  const port = env.vars.find((v) => v.key === 'PORT');
  const debug = env.vars.find((v) => v.key === 'DEBUG');
  assert.equal(port.hidden, false);
  h.act('var.update', {
    projectId: project.id,
    envId: env.id,
    id: port.id,
    key: 'DB_PASSWORD',
  });
  h.act('var.update', {
    projectId: project.id,
    envId: env.id,
    id: debug.id,
    key: 'APP_TITLE',
  });
  const updated = model.getProject(h.vault, project.id).envs[0];
  assert.equal(updated.vars.find((v) => v.id === port.id).hidden, true);
  assert.equal(updated.vars.find((v) => v.id === debug.id).hidden, false);
});

test('merging fills a missing service URL instead of duplicating it', () => {
  const h = harness();
  const a = h.act('project.create', { name: 'lu app' }).project;
  const b = h.act('project.create', { name: 'lu site' }).project;
  h.act('service.upsert', {
    projectId: a.id,
    service: { provider: 'Vercel', role: 'hosting', url: '' },
  });
  h.act('service.upsert', {
    projectId: b.id,
    service: { provider: 'Vercel', role: 'hosting', url: 'https://vercel.com/acme/lu' },
  });
  h.act('project.merge', { targetId: a.id, sourceIds: [b.id] });
  const merged = model.getProject(h.vault, a.id);
  assert.equal(merged.services.length, 1);
  assert.equal(merged.services[0].url, 'https://vercel.com/acme/lu');
});

// ------------------------------------------------------------------ 1.0

test('a new project starts with an empty preview and no detection date', () => {
  const h = harness();
  const project = h.act('project.create', { name: 'lu app' }).project;
  assert.deepEqual(project.thumb, { url: '', source: '', at: '' });
  assert.equal(project.detectedAt, '');
  assert.equal(h.vault.settings.previews, true);
  assert.equal(h.vault.settings.detectOnAdd, true);
  assert.equal(h.vault.settings.checkUpdates, true);
  assert.equal(h.vault.settings.projectView, 'list');
  assert.equal(h.vault.schemaVersion, 4);
});

test('a preview record needs an http(s) URL and can be cleared', () => {
  const h = harness();
  const project = h.act('project.create', { name: 'lu app' }).project;
  h.act('project.thumb', {
    projectId: project.id,
    url: 'https://lu.app',
    source: 'live',
  });
  let stored = model.getProject(h.vault, project.id);
  assert.equal(stored.thumb.url, 'https://lu.app');
  assert.equal(stored.thumb.source, 'live');
  assert.ok(stored.thumb.at);

  const bad = h.tryAct('project.thumb', {
    projectId: project.id,
    url: 'javascript:alert(1)',
  });
  assert.equal(bad.ok, false);
  assert.equal(model.getProject(h.vault, project.id).thumb.url, 'https://lu.app');

  h.act('project.thumb', { projectId: project.id, url: '' });
  stored = model.getProject(h.vault, project.id);
  assert.deepEqual(stored.thumb, { url: '', source: '', at: '' });
});

test('enrich adds stack, tags, services, links and one note', () => {
  const h = harness();
  const project = h.act('project.create', { name: 'lu app', stack: ['Next.js'] }).project;
  const counts = h.act('project.enrich', {
    projectId: project.id,
    stack: ['next.js', 'TypeScript', 'Vercel'],
    tags: ['nextjs', 'client'],
    services: [
      { provider: 'Vercel', role: 'hosting', url: 'https://vercel.com/acme/lu', notes: 'x-vercel-id' },
      { provider: 'Neon', role: 'database', url: 'https://console.neon.tech', notes: '' },
    ],
    links: [{ label: 'Live', kind: 'live', url: 'https://lu.app' }],
    note: 'Auto-detected from lu.app.',
  });
  assert.deepEqual(counts, { stack: 2, tags: 2, services: 2, links: 1, note: true });
  const stored = model.getProject(h.vault, project.id);
  assert.deepEqual(stored.stack, ['Next.js', 'TypeScript', 'Vercel']);
  assert.deepEqual(stored.tags.sort(), ['client', 'nextjs']);
  assert.equal(stored.services.length, 2);
  assert.equal(stored.links.length, 1);
  assert.equal(stored.entries.length, 1);
  assert.equal(stored.entries[0].type, 'note');
  assert.equal(stored.entries[0].title, 'Detected setup');
  assert.ok(stored.detectedAt);

  const again = h.act('project.enrich', {
    projectId: project.id,
    stack: ['Next.js'],
    tags: ['nextjs'],
    services: [{ provider: 'Vercel', role: 'hosting', url: 'https://elsewhere.example' }],
    links: [{ label: 'Live again', kind: 'live', url: 'https://lu.app' }],
    note: 'Auto-detected from lu.app.',
  });
  assert.deepEqual(again, { stack: 0, tags: 0, services: 0, links: 0, note: false });
  const unchanged = model.getProject(h.vault, project.id);
  assert.equal(unchanged.stack.length, 3);
  assert.equal(unchanged.services.length, 2);
  assert.equal(unchanged.services[0].url, 'https://vercel.com/acme/lu');
  assert.equal(unchanged.links.length, 1);
  assert.equal(unchanged.entries.length, 1);
});

test('enrich fills a blank service URL without replacing a real one', () => {
  const h = harness();
  const project = h.act('project.create', { name: 'lu app' }).project;
  h.act('service.upsert', {
    projectId: project.id,
    service: { provider: 'Vercel', role: 'hosting', url: '' },
  });
  h.act('project.enrich', {
    projectId: project.id,
    services: [{ provider: 'Vercel', role: 'hosting', url: 'https://vercel.com/acme/lu' }],
  });
  assert.equal(model.getProject(h.vault, project.id).services[0].url, 'https://vercel.com/acme/lu');

  h.act('project.enrich', {
    projectId: project.id,
    services: [{ provider: 'Vercel', role: 'hosting', url: 'https://evil.example' }],
  });
  assert.equal(model.getProject(h.vault, project.id).services[0].url, 'https://vercel.com/acme/lu');
});

test('release settings are validated and normalised', () => {
  const h = harness();
  h.act('settings.update', {
    patch: {
      projectView: 'grid',
      previews: false,
      detectOnAdd: false,
      checkUpdates: false,
      githubToken: '  ghp_abc  ',
      updateSkipped: ' 1.0.1 ',
    },
  });
  assert.equal(h.vault.settings.projectView, 'grid');
  assert.equal(h.vault.settings.previews, false);
  assert.equal(h.vault.settings.detectOnAdd, false);
  assert.equal(h.vault.settings.checkUpdates, false);
  assert.equal(h.vault.settings.githubToken, 'ghp_abc');
  assert.equal(h.vault.settings.updateSkipped, '1.0.1');

  const bad = h.tryAct('settings.update', { patch: { projectView: 'masonry' } });
  assert.equal(bad.ok, false);
  assert.equal(h.vault.settings.projectView, 'grid');
});

test('normalizeVault keeps good previews and drops bad ones', () => {
  const vault = model.normalizeVault({
    projects: [
      {
        id: 'prj_one',
        name: 'lu app',
        thumb: { url: 'https://lu.app', source: 'live', at: '2026-11-01T00:00:00.000Z' },
        detectedAt: '2026-11-01T00:00:00.000Z',
      },
      {
        id: 'prj_two',
        name: 'other',
        thumb: { url: 'file:///etc/passwd', source: 'manual', at: 'x' },
      },
    ],
  });
  assert.equal(vault.projects[0].thumb.url, 'https://lu.app');
  assert.equal(vault.projects[0].thumb.source, 'live');
  assert.equal(vault.projects[0].detectedAt, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(vault.projects[1].thumb, { url: '', source: '', at: '' });
  assert.equal(vault.settings.projectView, 'list');
});
