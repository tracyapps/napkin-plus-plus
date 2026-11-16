'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VaultStore } = require('../app/store.js');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'napkin-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('creates a fresh vault and persists a project across reloads', (t) => {
  const dir = tmp(t);
  const store = new VaultStore({ dir });
  const loaded = store.load();
  assert.equal(loaded.fresh, true);
  assert.ok(fs.existsSync(path.join(dir, 'vault.json')));

  const res = store.dispatch({ type: 'project.create', payload: { name: 'lu app' } });
  assert.equal(res.ok, true);
  assert.equal(store.vault.projects.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'vault.json.tmp')));

  const reload = new VaultStore({ dir });
  reload.load();
  assert.equal(reload.vault.projects.length, 1);
  assert.equal(reload.vault.projects[0].name, 'lu app');
  assert.ok(reload.meta().bytes > 100);
});

test('writes daily and previous-save backups before overwriting', (t) => {
  const dir = tmp(t);
  const store = new VaultStore({ dir });
  store.load();
  store.dispatch({ type: 'project.create', payload: { name: 'one' } });
  store.dispatch({ type: 'project.create', payload: { name: 'two' } });
  const backups = fs.readdirSync(path.join(dir, 'backups')).sort();
  assert.ok(backups.includes('vault-prev.json'));
  assert.ok(backups.some((f) => /^vault-\d{4}-\d{2}-\d{2}\.json$/.test(f)));
});

test('undo steps back through session history', (t) => {
  const dir = tmp(t);
  const store = new VaultStore({ dir });
  store.load();
  store.dispatch({ type: 'project.create', payload: { name: 'one' } });
  store.dispatch({ type: 'project.create', payload: { name: 'two' } });
  assert.equal(store.vault.projects.length, 2);

  const first = store.undo();
  assert.equal(first.ok, true);
  assert.equal(store.vault.projects.length, 1);
  store.undo();
  assert.equal(store.vault.projects.length, 0);
  const empty = store.undo();
  assert.equal(empty.ok, false);

  const reload = new VaultStore({ dir });
  reload.load();
  assert.equal(reload.vault.projects.length, 0);
});

test('rejects invalid actions without touching the vault', (t) => {
  const dir = tmp(t);
  const store = new VaultStore({ dir });
  store.load();
  store.dispatch({ type: 'project.create', payload: { name: 'one' } });
  const before = JSON.stringify(store.vault);
  const res = store.dispatch({ type: 'project.create', payload: { name: '' } });
  assert.equal(res.ok, false);
  assert.equal(JSON.stringify(store.vault), before);
  assert.equal(store.dispatch({ type: 'nope' }).ok, false);
});

test('recovers from a corrupted vault using the newest backup', (t) => {
  const dir = tmp(t);
  const store = new VaultStore({ dir });
  store.load();
  store.dispatch({ type: 'project.create', payload: { name: 'survivor' } });
  store.dispatch({ type: 'project.create', payload: { name: 'second' } });

  fs.writeFileSync(path.join(dir, 'vault.json'), '{ this is not json', 'utf8');
  const recovered = new VaultStore({ dir });
  const result = recovered.load();
  assert.equal(result.recovered, true);
  assert.ok(recovered.vault.projects.length >= 1);
  assert.ok(recovered.recovery.reason === 'corrupt');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('vault.corrupt-'));
  assert.equal(files.length, 1);
  assert.ok(fs.existsSync(recovered.file));
});

test('exports markdown for one project or the whole vault', (t) => {
  const dir = tmp(t);
  const store = new VaultStore({ dir });
  store.load();
  const res = store.dispatch({ type: 'project.create', payload: { name: 'lu app' } });
  store.dispatch({
    type: 'account.upsert',
    payload: {
      projectId: res.result.projectId,
      account: { label: 'owner', email: 'me@lu.app' },
    },
  });
  const one = store.exportMarkdown(res.result.projectId);
  assert.ok(one.startsWith('# lu app'));
  assert.ok(one.includes('me@lu.app'));
  const all = store.exportMarkdown();
  assert.ok(all.startsWith('# napkin++ vault'));
  assert.equal(store.exportMarkdown('missing'), null);
});

test('meta reports the vault location and recovery state', (t) => {
  const dir = tmp(t);
  const store = new VaultStore({ dir });
  store.load();
  const meta = store.meta();
  assert.equal(meta.path, path.join(dir, 'vault.json'));
  assert.equal(meta.projects, 0);
  assert.equal(meta.undoDepth, 0);
  assert.ok(meta.bytes > 0);
});
