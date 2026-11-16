/* napkin++ — quick capture window. */
(function () {
  'use strict';

  const D = window.NapkinDOM;
  const M = window.NapkinModel;
  const P = window.NapkinParse;
  const api = window.napkin;

  const MODES = ['project', 'note', 'credential', 'env'];
  const S = {
    vault: null,
    meta: null,
    mode: 'project',
    targetId: null,
    text: '',
    active: 0,
    rows: [],
  };

  const $ = (selector) => document.querySelector(selector);
  const input = () => $('#quick-input');

  function projectById(id) {
    if (!S.vault) return null;
    return S.vault.projects.find((p) => p.id === id) || null;
  }

  function liveProjects() {
    return (S.vault ? S.vault.projects : []).filter((p) => p.status !== 'archived');
  }

  function ensureTarget() {
    if (S.targetId && projectById(S.targetId)) return;
    const recent = (S.vault.ui.recent || [])
      .map((id) => projectById(id))
      .filter((p) => p && p.status !== 'archived');
    const fallback = liveProjects()[0];
    S.targetId = recent.length ? recent[0].id : fallback ? fallback.id : null;
  }

  function target() {
    return projectById(S.targetId);
  }

  /** The env a paste lands in: dev if it exists, else the project's first env. */
  function envFor(project) {
    if (!project || !project.envs.length) return null;
    return project.envs.find((e) => e.name.toLowerCase() === 'dev') || project.envs[0];
  }

  function envNameFor(project) {
    const env = envFor(project);
    return env ? env.name : 'dev';
  }

  function applyTheme() {
    const settings = (S.vault && S.vault.settings) || {};
    const pref = settings.theme || 'system';
    const dark =
      pref === 'dark' ||
      (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.palette = settings.palette || 'paper';
    const accent = settings.accent || 'ember';
    root.dataset.accent = accent;
    if (accent === 'custom') {
      root.style.setProperty('--accent-base', settings.accentCustom || '#b2531f');
    } else {
      root.style.removeProperty('--accent-base');
    }
  }

  function clip(value, max) {
    const s = String(value || '').trim().replace(/\s+/g, ' ');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function findDuplicate(text) {
    const normalized = M.normalizeName(text);
    for (const project of liveProjects()) {
      if (M.normalizeName(project.name) === normalized) return project;
    }
    let best = null;
    for (const project of liveProjects()) {
      const score = M.nameSimilarity(project.name, text);
      if (score >= 0.9 && (!best || score > best.score)) best = { project, score };
    }
    return best ? best.project : null;
  }

  // ------------------------------------------------------------------- rows

  function buildRows() {
    const text = S.text.trim();
    const project = target();
    const rows = [];

    if (!text) {
      for (const recent of liveProjects().slice(0, 6)) {
        const vars = recent.envs.reduce((n, e) => n + e.vars.length, 0);
        rows.push({
          kind: 'open',
          id: recent.id,
          icon: 'folder',
          title: recent.name,
          sub: [recent.accounts.length + ' accounts', vars + ' vars', recent.stack[0]].filter(Boolean).join(' · '),
          hint: '↵ open',
        });
      }
      return rows;
    }

    if (S.mode === 'project') {
      const detected = P.detectTextKind(text);
      if (detected.kind === 'env' && detected.env.pairs.length) {
        if (!project) {
          rows.push({
            kind: 'none',
            icon: 'terminal',
            title: 'No project to add these vars to',
            sub: 'Create a project first, then paste the .env block',
            disabled: true,
          });
          return rows;
        }
        const count = detected.env.pairs.length;
        rows.push({
          kind: 'env',
          icon: 'terminal',
          title: 'Add ' + count + (count === 1 ? ' env var' : ' env vars'),
          sub: '→ ' + project.name + ' · ' + envNameFor(project),
          hint: '↵ add',
        });
        return rows;
      }
      if (detected.kind === 'accounts' && detected.accounts.length) {
        if (!project) {
          rows.push({
            kind: 'none',
            icon: 'key',
            title: 'No project to add these logins to',
            sub: 'Create a project first, then paste the accounts',
            disabled: true,
          });
          return rows;
        }
        rows.push({
          kind: 'accounts',
          icon: 'key',
          title: 'Add ' + detected.accounts.length + ' account(s)',
          sub: '→ ' + project.name,
          hint: '↵ add',
          accounts: detected.accounts,
        });
        return rows;
      }
      if (text.includes('\n')) {
        if (project) {
          rows.push({
            kind: 'note',
            icon: 'note',
            title: 'Save as note',
            sub: '→ ' + project.name,
            hint: '↵ save',
          });
        }
        rows.push({
          kind: 'create',
          icon: 'plus',
          title: 'Create project “' + clip(text.split('\n')[0], 40) + '”',
          sub: 'uses the first line as the name',
          hint: '↵ create',
          name: text.split('\n')[0],
        });
        return rows;
      }

      const dupe = findDuplicate(text);
      if (dupe) {
        rows.push({
          kind: 'open',
          id: dupe.id,
          icon: 'folder',
          title: dupe.name,
          sub: 'already exists · ' + dupe.accounts.length + ' accounts',
          hint: '↵ open',
        });
        rows.push({
          kind: 'create',
          icon: 'plus',
          title: 'Create separate “' + clip(text, 40) + '”',
          sub: 'keeps both projects',
          hint: '⌘↵ create',
          name: text,
          force: true,
        });
        return rows;
      }

      rows.push({
        kind: 'create',
        icon: 'plus',
        title: 'Create project “' + clip(text, 46) + '”',
        sub: 'a name is enough',
        hint: '↵ create',
        name: text,
      });
      const matches = liveProjects()
        .map((p) => ({ project: p, score: M.nameSimilarity(p.name, text) }))
        .filter((m) => m.score > 0.45)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      for (const match of matches) {
        rows.push({
          kind: 'open',
          id: match.project.id,
          icon: 'folder',
          title: match.project.name,
          sub: 'similar · ' + match.project.accounts.length + ' accounts',
          hint: '↵ open',
        });
      }
      return rows;
    }

    if (!project) {
      rows.push({
        kind: 'none',
        icon: 'folder',
        title: 'No project to save into',
        sub: 'Switch to Project mode and create one',
        disabled: true,
      });
      return rows;
    }

    if (S.mode === 'note') {
      rows.push({
        kind: 'note',
        icon: 'note',
        title: 'Save note',
        sub: '→ ' + project.name,
        hint: '↵ save',
      });
    } else if (S.mode === 'credential') {
      rows.push({
        kind: 'cred',
        icon: 'key',
        title: 'Save secret',
        sub: '→ ' + project.name + ' · masked, copy-safe',
        hint: '↵ save',
      });
    } else if (S.mode === 'env') {
      const env = P.parseEnvBlock(text);
      if (env.pairs.length) {
        rows.push({
          kind: 'env',
          icon: 'terminal',
          title: 'Add ' + env.pairs.length + ' env var(s)',
          sub: '→ ' + project.name + ' · ' + envNameFor(project),
          hint: '↵ add',
        });
      } else {
        rows.push({
          kind: 'none',
          icon: 'terminal',
          title: 'No KEY=value lines found',
          sub: 'Paste an .env block, one per line',
          disabled: true,
        });
      }
    }
    return rows;
  }

  function detectionLine() {
    const text = S.text.trim();
    if (!text) {
      return S.meta && S.meta.shortcut
        ? 'Summoned with ' + S.meta.shortcut + ' · everything stays local'
        : 'Everything stays local';
    }
    if (S.mode === 'project') {
      const detected = P.detectTextKind(text);
      if (detected.kind === 'env') return 'Looks like env vars — Enter adds them to the target project';
      if (detected.kind === 'accounts') return 'Looks like logins — Enter adds them to the target project';
      if (detected.kind === 'code') return 'Looks like code — save it as a note, or create a project';
      return 'A name is enough. Details come later.';
    }
    if (S.mode === 'note') return 'Saved with line numbers and folding';
    if (S.mode === 'credential') return 'Masked in the list; copied values clear from the clipboard';
    return 'KEY=value, exports and quotes are handled';
  }

  function render() {
    ensureTarget();
    S.rows = buildRows();
    if (S.active >= S.rows.length) S.active = Math.max(0, S.rows.length - 1);
    if (S.active < 0) S.active = 0;

    document.querySelectorAll('.mode').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === S.mode);
    });

    const select = $('#target');
    const projects = liveProjects();
    select.innerHTML = projects
      .map((p) => '<option value="' + p.id + '">' + D.esc(p.name) + '</option>')
      .join('');
    select.value = S.targetId || '';
    select.style.display = !projects.length ? 'none' : '';
    const wrap = select.parentElement;
    if (wrap) wrap.style.display = !projects.length ? 'none' : '';

    const detect = $('#detect');
    detect.innerHTML = '<span class="dot"></span><span>' + D.esc(detectionLine()) + '</span>';

    const host = $('#quick-rows');
    if (!S.rows.length) {
      host.innerHTML =
        '<div class="empty">No projects yet.<br />Type a name and press ↵ to make the first one.</div>';
    } else {
      host.innerHTML = S.rows
        .map(
          (row, index) =>
            '<button class="row ' +
            (index === S.active ? 'active' : '') +
            (row.disabled ? ' disabled' : '') +
            '" data-index="' +
            index +
            '"><span class="row-ic">' +
            D.icon(row.icon) +
            '</span><span class="row-main"><span class="row-title">' +
            D.esc(row.title) +
            '</span><span class="row-sub">' +
            D.esc(row.sub || '') +
            '</span></span><span class="row-hint">' +
            D.esc(row.hint || '') +
            '</span></button>'
        )
        .join('');
    }

    const primary = S.rows[S.active];
    const foot = $('#foot-primary');
    if (foot) {
      foot.textContent = primary
        ? primary.kind === 'open'
          ? 'open'
          : primary.kind === 'create'
            ? 'create'
            : primary.kind === 'env'
              ? 'add vars'
              : primary.kind === 'accounts'
                ? 'add accounts'
                : 'save'
        : 'create';
    }
    autosize();
  }

  function autosize() {
    const el = input();
    el.style.height = 'auto';
    el.style.height = Math.min(132, Math.max(32, el.scrollHeight)) + 'px';
  }

  // ---------------------------------------------------------------- actions

  async function afterSuccess(message) {
    api.notify({ message });
    api.hideCapture();
  }

  function entryTypeFor(kind) {
    // Model order: note, snippet, command, secret, recovery, instruction.
    return kind === 'cred' ? M.ENTRY_TYPES[3] : M.ENTRY_TYPES[0];
  }

  async function execute(index, options) {
    const opts = options || {};
    let row = S.rows[index];
    if (!row || row.disabled) return;
    if (opts.separate) {
      const createRow = S.rows.find((candidate) => candidate.kind === 'create');
      if (createRow) row = createRow;
    }
    const project = target();

    if (row.kind === 'open') {
      api.openProject(row.id);
      api.hideCapture();
      return;
    }

    if (row.kind === 'create') {
      const name = (row.name || S.text).trim();
      if (!name) return;
      const res = await api.dispatch({ type: 'project.create', payload: { name } });
      if (!res.ok) {
        $('#detect').innerHTML = '<span class="dot"></span><span>' + D.esc(res.error) + '</span>';
        return;
      }
      await afterSuccess('Created “' + name + '”');
      return;
    }

    if (!project) return;

    if (row.kind === 'note' || row.kind === 'cred') {
      const res = await api.dispatch({
        type: 'entry.upsert',
        payload: {
          projectId: project.id,
          entry: {
            type: entryTypeFor(row.kind),
            title: D.firstLine(S.text, 80),
            body: S.text,
          },
        },
      });
      if (!res.ok) return;
      await afterSuccess(row.kind === 'cred' ? 'Secret saved to ' + project.name : 'Note saved to ' + project.name);
      return;
    }

    if (row.kind === 'env') {
      const parsed = P.parseEnvBlock(S.text);
      if (!parsed.pairs.length) return;
      const env = envFor(project);
      const res = await api.dispatch({
        type: 'env.vars.add',
        payload: {
          projectId: project.id,
          envId: env ? env.id : undefined,
          envName: env ? env.name : 'dev',
          vars: parsed.pairs,
        },
      });
      if (!res.ok) return;
      await afterSuccess(
        'Added ' + res.result.added + ' vars to ' + project.name + ' · ' + (env ? env.name : 'dev')
      );
      return;
    }

    if (row.kind === 'accounts') {
      const parsed = row.accounts || P.parseAccountLines(S.text);
      let added = 0;
      for (const account of parsed) {
        const res = await api.dispatch({
          type: 'account.upsert',
          payload: {
            projectId: project.id,
            account: {
              label: account.label || account.env || 'account',
              email: account.email,
              username: account.username,
              service: account.service,
              env: account.env,
              notes: account.notes,
              fields: account.fields,
            },
          },
        });
        if (res.ok) added += 1;
      }
      await afterSuccess('Added ' + added + ' account(s) to ' + project.name);
    }
  }

  function move(delta) {
    if (!S.rows.length) return;
    S.active = (S.active + delta + S.rows.length) % S.rows.length;
    render();
  }

  function setMode(mode) {
    if (!MODES.includes(mode)) return;
    S.mode = mode;
    S.active = 0;
    const el = input();
    el.placeholder =
      mode === 'project'
        ? 'lu app — or paste anything'
        : mode === 'note'
          ? 'Paste a note or snippet…'
          : mode === 'credential'
            ? 'Paste a secret, token or recovery code…'
            : 'APP_NAME=lu\nPORT=3000';
    render();
    el.focus();
  }

  function reset() {
    S.text = '';
    S.active = 0;
    S.mode = 'project';
    const el = input();
    el.value = '';
    el.placeholder = 'lu app — or paste anything';
    ensureTarget();
    applyTheme();
    render();
    el.focus();
  }

  // ------------------------------------------------------------------ events

  function bind() {
    const el = input();

    el.addEventListener('input', () => {
      S.text = el.value;
      S.active = 0;
      render();
    });

    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        execute(S.active, { separate: event.metaKey || event.ctrlKey });
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const index = MODES.indexOf(S.mode);
        setMode(MODES[(index + (event.shiftKey ? -1 : 1) + MODES.length) % MODES.length]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        api.hideCapture();
      }
    });

    document.addEventListener('click', (event) => {
      const mode = event.target.closest('.mode');
      if (mode) {
        setMode(mode.dataset.mode);
        return;
      }
      const row = event.target.closest('.row');
      if (row) {
        const index = Number(row.dataset.index);
        if (Number.isFinite(index)) execute(index);
      }
    });

    const select = $('#target');
    select.addEventListener('change', () => {
      S.targetId = select.value;
      render();
    });

    window.addEventListener('keydown', (event) => {
      if (event.metaKey && /^[1-4]$/.test(event.key)) {
        event.preventDefault();
        setMode(MODES[Number(event.key) - 1]);
      }
    });

    api.onState((payload) => {
      if (!payload || !payload.state) return;
      S.vault = payload.state;
      S.meta = payload.meta || S.meta;
      ensureTarget();
      applyTheme();
      render();
    });

    api.onCaptureReset(reset);
  }

  async function boot() {
    const payload = await api.getState();
    S.vault = payload.state;
    S.meta = payload.meta;
    ensureTarget();
    applyTheme();
    bind();
    reset();
  }

  boot().catch((error) => {
    const detect = $('#detect');
    if (detect) detect.textContent = String(error && error.message ? error.message : error);
  });
})();
