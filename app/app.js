/* napkin++ — renderer controller. */
(function () {
  'use strict';

  const D = window.NapkinDOM;
  const M = window.NapkinModel;
  const Q = window.NapkinSearch;
  const P = window.NapkinParse;
  const F = window.NapkinFold;
  const FB = window.NapkinFeedback;
  const U = window.NapkinUpdates;
  const api = window.napkin;

  const TAB_KINDS = {
    project: 'overview',
    account: 'accounts',
    accountfield: 'accounts',
    envvar: 'env',
    environment: 'env',
    entry: 'notes',
    link: 'links',
    service: 'links',
  };

  // Paper stocks offered in Settings, with a light and a dark swatch each:
  // [id, label, [light bg, light panel, light ink], [dark bg, dark panel, dark ink]]
  const PALETTE_META = [
    ['paper', 'Paper', ['#f4efe7', '#fffdfa', '#1f1c18'], ['#131211', '#1c1a18', '#f2ece3']],
    ['slate', 'Slate', ['#f1f3f6', '#ffffff', '#1b2028'], ['#0e1116', '#171b22', '#e8edf4']],
    ['nord', 'Nord', ['#eef1f4', '#fbfcfd', '#26303a'], ['#141a20', '#1d242c', '#e6edf4']],
    ['forest', 'Forest', ['#eff2ec', '#fcfdfb', '#1e2419'], ['#12160f', '#1a1f17', '#e9efe2']],
    ['ocean', 'Ocean', ['#edf3f5', '#fbfdfe', '#17252b'], ['#0d1518', '#151f23', '#e4f0f4']],
    ['rose', 'Rose', ['#f6eef0', '#fffbfc', '#2a1c22'], ['#17100f', '#1f1818', '#f4e9e8']],
    ['sand', 'Sand', ['#f6f0e2', '#fffdf6', '#241f17'], ['#171410', '#201c16', '#f2ecdf']],
    ['graphite', 'Graphite', ['#f0f0f0', '#fdfdfd', '#171717'], ['#101010', '#191919', '#f2f2f2']],
  ];

  const ACCENT_HEX = {
    ember: '#b2531f',
    moss: '#5c7a4f',
    ink: '#3f5f82',
    plum: '#7a4f72',
  };

  const S = {
    vault: null,
    meta: null,
    index: [],
    view: 'all',
    tag: null,
    folder: null,
    filter: '',
    sort: 'recent',
    selectedId: null,
    tab: 'overview',
    envId: null,
    reveal: new Set(),
    collapsed: new Set(),
    expanded: new Set(),
    copied: new Map(),
    editingVar: null,
    capture: { text: '', envName: '' },
    context: null,
    mergeDraft: null,
    folderTarget: null,
    contextReturnFocus: null,
    modal: null,
    importBlocks: null,
    importName: '',
    importSingle: false,
    importTimer: null,
    dupPairs: null,
    palette: { open: false, query: '', kind: 'all', results: [], active: 0 },
    suspend: false,
    editingTitle: false,
    detections: new Map(),
    detectBusy: false,
    updateBusy: false,
    errors: [],
  };

  // ------------------------------------------------------------------ helpers

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  /** Event targets can be the document itself (dispatched keyboard events), so
   *  never assume closest() exists. */
  function targetElement(event) {
    const node = event.target;
    return node && typeof node.closest === 'function' ? node : null;
  }

  function currentProject() {
    if (!S.vault) return null;
    return M.getProject(S.vault, S.selectedId);
  }

  function projectById(id) {
    return S.vault.projects.find((p) => p.id === id) || null;
  }

  function activeEnv(project) {
    if (!project || !project.envs.length) return null;
    return project.envs.find((e) => e.id === S.envId) || project.envs[0];
  }

  function folders() {
    return (S.vault && S.vault.folders) || [];
  }

  function folderById(id) {
    return folders().find((f) => f.id === id) || null;
  }

  function folderOf(project) {
    return project && project.folderId ? folderById(project.folderId) : null;
  }

  /** A stable colour for a project without a folder: the same paper tint. */
  function thumbTone(name) {
    const text = String(name || '');
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return M.FOLDER_COLORS[hash % M.FOLDER_COLORS.length];
  }

  /**
   * A project card image: the cached social preview when there is one, and a
   * paper letter tile when there is not. The letter never fails, so a broken
   * image simply reveals it again.
   */
  function thumbTile(project, options) {
    const opts = options || {};
    const folder = folderOf(project);
    const tone = folder ? folder.color : thumbTone(project.name);
    const className = 'thumb-tile' + (opts.size ? ' ' + opts.size : '');
    const letter =
      '<span class="thumb-letter">' + D.esc(D.initials(project.name)) + '</span>';
    const has = Boolean(project.thumb && project.thumb.url && project.thumb.at);
    if (!has) {
      return (
        '<span class="' + className + '" aria-hidden="true" style="--thumb-tone:' +
        D.esc(tone) + '">' + letter + '</span>'
      );
    }
    return (
      '<span class="' + className + ' has-image" aria-hidden="true" style="--thumb-tone:' +
      D.esc(tone) + '">' +
      letter +
      '<img data-thumb="' +
      D.esc(project.id) +
      '" src="napkin-thumb://local/' +
      encodeURIComponent(project.id) +
      '?v=' +
      encodeURIComponent(project.thumb.at) +
      '" alt="" loading="lazy" draggable="false" />' +
      '</span>'
    );
  }

  function projectMetaLine(project) {
    return [
      project.accounts.length ? project.accounts.length + ' acct' : '',
      project.envs.some((e) => e.vars.length) ? 'env' : '',
      project.services.length ? project.services.length + ' svc' : '',
      relative(project.updatedAt),
    ]
      .filter(Boolean)
      .join(' · ');
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

  function shortcutLabel(accel) {
    if (!accel) return '⌥Space';
    return accel
      .replace(/CommandOrControl|Cmd|Command/g, '⌘')
      .replace(/Control|Ctrl/g, '⌃')
      .replace(/Alt|Option/g, '⌥')
      .replace(/Shift/g, '⇧')
      .replace(/\+/g, '');
  }

  function relative(iso) {
    return D.timeAgo(iso);
  }

  function viewProjects() {
    const all = S.vault.projects;
    let list;
    if (S.view === 'archive') list = all.filter((p) => p.status === 'archived');
    else {
      const live = all.filter((p) => p.status !== 'archived');
      if (S.view === 'favorites') list = live.filter((p) => p.favorite);
      else if (S.view === 'recent') {
        const order = S.vault.ui.recent;
        list = live
          .slice()
          .sort((a, b) => {
            const ai = order.indexOf(a.id);
            const bi = order.indexOf(b.id);
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
          })
          .slice(0, 12);
      } else list = live;
    }
    if (S.tag) list = list.filter((p) => p.tags.includes(S.tag));
    if (S.folder === '__none__') list = list.filter((p) => !folderOf(p));
    else if (S.folder) list = list.filter((p) => p.folderId === S.folder);
    if (S.filter) {
      const q = S.filter.toLowerCase();
      list = list.filter((p) =>
        [
          p.name,
          p.aliases.join(' '),
          p.tags.join(' '),
          p.stack.join(' '),
          p.description,
          p.services.map((s) => s.provider + ' ' + s.role).join(' '),
          p.links.map((l) => l.label + ' ' + l.url).join(' '),
          p.accounts.map((a) => a.label + ' ' + a.email + ' ' + a.username).join(' '),
        ]
          .join(' ')
          .toLowerCase()
          .includes(q)
      );
    }
    return list.slice().sort((a, b) => {
      if (S.sort === 'name') return a.name.localeCompare(b.name);
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
  }

  async function dispatch(action) {
    const res = await api.dispatch(action);
    if (!res.ok) {
      toast(res.error || 'Could not save.');
      return res;
    }
    if (!S.suspend) applyState(res);
    return res;
  }

  async function batch(actions) {
    S.suspend = true;
    const results = [];
    let last = null;
    try {
      for (const action of actions) {
        const res = await api.dispatch(action);
        results.push(res);
        last = res;
      }
    } finally {
      S.suspend = false;
    }
    if (last && last.ok) applyState(last);
    return results;
  }

  async function copy(value, label, hidden, key) {
    if (!value) {
      toast('Nothing to copy there.');
      return false;
    }
    const res = await api.copy({ text: value, label: label || 'value', hidden: Boolean(hidden) });
    if (res && res.ok && key) markCopied(key);
    return Boolean(res && res.ok);
  }

  /** One click on a field copies it; the tick stays for the session so you can
   *  see what you already grabbed when you come back from another app. */
  function markCopied(key) {
    S.copied.set(key, Date.now());
    for (const el of $$('[data-copy-key]')) {
      if (el.dataset.copyKey !== key) continue;
      el.classList.add('copied');
      if (el.classList.contains('copy-btn')) el.innerHTML = D.icon('check');
      const row = el.closest('.var-row, .acct-row, .link-row, .field-pill, .entry-card, .env-url');
      if (row) row.classList.add('was-copied');
    }
  }

  function copyIconFor(key) {
    return D.icon(S.copied.has(key) ? 'check' : 'copy');
  }

  function copyAttrs(key, value, label, hidden) {
    return (
      ' data-action="copy" data-copy-key="' +
      D.esc(key) +
      '" data-value="' +
      D.esc(value) +
      '" data-label="' +
      D.esc(label) +
      '"' +
      (hidden ? ' data-hidden="1"' : '')
    );
  }

  function copyButton(key, value, label, hidden, title) {
    return (
      '<button class="mini-btn copy-btn ' +
      (S.copied.has(key) ? 'copied' : '') +
      '"' +
      copyAttrs(key, value, label, hidden) +
      ' title="' +
      D.esc(S.copied.has(key) ? 'Copied — click to copy again' : title || 'Copy') +
      '">' +
      copyIconFor(key) +
      '</button>'
    );
  }

  function toast(message, options) {
    const opts = options || {};
    const host = $('#toasts');
    if (!host) return;
    const node = document.createElement('div');
    node.className = 'toast';
    node.innerHTML =
      '<span>' +
      D.esc(message) +
      '</span>' +
      (opts.sub ? '<span class="toast-sub">' + D.esc(opts.sub) + '</span>' : '') +
      (opts.actionLabel
        ? '<button type="button" class="toast-action">' + D.esc(opts.actionLabel) + '</button>'
        : '');
    if (opts.actionLabel && opts.onAction) {
      node.querySelector('.toast-action').addEventListener('click', () => {
        node.remove();
        opts.onAction();
      });
    }
    while (host.children.length >= 3) host.firstElementChild.remove();
    host.appendChild(node);
    setTimeout(() => node.remove(), opts.timeout || 3600);
  }

  // ------------------------------------------------------------ context menu

  function renderContextItems(items) {
    return items
      .filter(Boolean)
      .map((item) => {
        if (item.sep) return '<div class="ctx-sep"></div>';
        const icon = item.icon ? D.icon(item.icon, 'ctx-ic') : '';
        if (item.sub && item.sub.length) {
          return (
            '<div class="ctx-item has-sub" role="menuitem" aria-haspopup="true">' +
            '<span class="ctx-ic-wrap">' +
            icon +
            '</span><span class="ctx-label">' +
            D.esc(item.label) +
            '</span><span class="ctx-arrow">' +
            D.icon('chevron-right') +
            '</span><div class="ctx-menu">' +
            renderContextItems(item.sub) +
            '</div></div>'
          );
        }
        return (
          '<button type="button" class="ctx-item ' +
          (item.danger ? 'danger ' : '') +
          (item.disabled ? 'disabled' : '') +
          '" role="menuitem" data-ctx-action="' +
          D.esc(item.action || '') +
          '" data-ctx-value="' +
          D.esc(item.value || '') +
          '"' +
          (item.disabled ? ' disabled' : '') +
          '>' +
          '<span class="ctx-ic-wrap">' +
          (item.swatch
            ? '<span class="ctx-swatch" style="--sw:' + D.esc(item.swatch) + '"></span>'
            : icon) +
          '</span><span class="ctx-label">' +
          D.esc(item.label) +
          '</span>' +
          (item.checked ? '<span class="ctx-check">' + D.icon('check') + '</span>' : '') +
          '</button>'
        );
      })
      .join('');
  }

  function openContextMenu(event, items, payload) {
    const host = $('#ctx-menu');
    if (!host) return;
    const returnFocus = document.activeElement;
    closeContextMenu(false);
    host.innerHTML = renderContextItems(items);
    host.classList.remove('hidden');
    const rect = host.getBoundingClientRect();
    const x = Math.min(event.clientX, window.innerWidth - rect.width - 10);
    const y = Math.min(event.clientY, window.innerHeight - rect.height - 10);
    host.style.left = Math.max(8, x) + 'px';
    host.style.top = Math.max(8, y) + 'px';
    host.classList.toggle('flip-sub', event.clientX > window.innerWidth - 340);
    S.context = { items, payload: payload || {} };
    S.contextReturnFocus = returnFocus;
    const first = host.querySelector('.ctx-item:not(.has-sub):not(.disabled)');
    if (first) first.focus({ preventScroll: true });
  }

  function closeContextMenu(restoreFocus) {
    S.context = null;
    const host = $('#ctx-menu');
    const back = S.contextReturnFocus;
    S.contextReturnFocus = null;
    if (host) {
      host.classList.add('hidden');
      host.innerHTML = '';
    }
    if (
      restoreFocus !== false &&
      back &&
      document.contains(back) &&
      typeof back.focus === 'function'
    ) {
      back.focus();
    }
  }

  function projectContextItems(project) {
    const sub = folders().map((f) => ({
      label: f.name,
      action: 'move-folder',
      value: f.id,
      checked: project.folderId === f.id,
      swatch: f.color,
    }));
    if (sub.length) sub.push({ sep: true });
    sub.push({ label: 'No folder', action: 'move-folder', value: '', checked: !project.folderId });
    sub.push({ label: 'New folder…', action: 'new-folder-for', value: project.id });
    return [
      { label: 'Open', icon: 'arrow-right', action: 'ctx-open' },
      { label: 'Edit details…', icon: 'edit', action: 'ctx-details' },
      { label: 'Rename…', icon: 'edit', action: 'ctx-rename' },
      { sep: true },
      { label: 'Refresh preview', icon: 'image', action: 'ctx-preview' },
      {
        label: 'Detect details…',
        icon: 'wand',
        action: 'ctx-detect',
        disabled: !(project.links || []).some((link) => /^https?:/i.test(link.url)),
      },
      { sep: true },
      {
        label: project.favorite ? 'Remove favorite' : 'Favorite',
        icon: 'star',
        action: 'ctx-favorite',
        checked: project.favorite,
      },
      { label: 'Move to folder', icon: 'folder', sub },
      { label: 'Merge with…', icon: 'merge', action: 'ctx-merge' },
      { sep: true },
      {
        label: project.status === 'archived' ? 'Restore' : 'Archive',
        icon: 'archive',
        action: 'ctx-archive',
      },
      { label: 'Delete…', icon: 'trash', action: 'ctx-delete', danger: true },
      { sep: true },
      { label: 'Copy name', icon: 'copy', action: 'ctx-copy-name' },
    ];
  }

  function varContextItems(project, env, v) {
    return [
      { label: 'Edit variable', icon: 'edit', action: 'ctx-var-edit' },
      { label: 'Copy value', icon: 'copy', action: 'ctx-var-copy' },
      { label: 'Copy KEY=value', icon: 'code', action: 'ctx-var-line' },
      {
        label: v.hidden ? 'Reveal' : 'Hide',
        icon: v.hidden ? 'eye' : 'eye-off',
        action: 'ctx-var-reveal',
      },
      { sep: true },
      { label: 'Delete variable', icon: 'trash', action: 'ctx-var-delete', danger: true },
    ];
  }

  function accountContextItems(account) {
    return [
      { label: 'Edit account', icon: 'edit', action: 'ctx-account-edit' },
      { label: 'Copy email', icon: 'copy', action: 'ctx-account-email', disabled: !account.email },
      {
        label: 'Copy username',
        icon: 'copy',
        action: 'ctx-account-user',
        disabled: !account.username,
      },
      { sep: true },
      { label: 'Delete account', icon: 'trash', action: 'ctx-account-delete', danger: true },
    ];
  }

  function folderContextItems(folder) {
    return [
      { label: 'Rename…', icon: 'edit', action: 'ctx-folder-rename' },
      {
        label: 'Colour',
        icon: 'grid',
        sub: M.FOLDER_COLORS.map((color) => ({
          label: color,
          action: 'ctx-folder-color',
          value: color,
          swatch: color,
          checked: folder.color === color,
        })),
      },
      { sep: true },
      { label: 'Delete folder', icon: 'trash', action: 'ctx-folder-delete', danger: true },
    ];
  }

  // -------------------------------------------------------------- state flow

  function applyState(payload) {
    if (!payload || !payload.state) return;
    S.vault = payload.state;
    S.meta = payload.meta || S.meta;
    if (S.meta && S.meta.update) S.update = S.meta.update;
    S.index = Q.buildIndex(S.vault);
    S.sort = S.vault.settings.sortBy;
    S.grid = S.vault.settings.projectView === 'grid';
    if (S.selectedId && !projectById(S.selectedId)) S.selectedId = null;
    if (!S.selectedId) S.selectedId = defaultProjectId();
    if (S.folder && S.folder !== '__none__' && !folderById(S.folder)) S.folder = null;
    applyTheme();
    if (!S.suspend) renderAll();
  }

  function defaultProjectId() {    if (!S.vault || !S.vault.projects.length) return null;
    const recent = S.vault.ui.recent.find((id) => {
      const p = projectById(id);
      return p && p.status !== 'archived';
    });
    if (recent) return recent;
    const live = S.vault.projects.find((p) => p.status !== 'archived');
    return (live || S.vault.projects[0]).id;
  }

  function uniqueName(base) {
    let name = String(base || '').trim();
    if (!name) name = 'Untitled project';
    let index = 2;
    while (S.vault.projects.some((p) => M.normalizeName(p.name) === M.normalizeName(name))) {
      name = base + ' (' + index + ')';
      index += 1;
    }
    return name;
  }

  async function undo() {
    const res = await api.undo();
    if (!res.ok) {
      toast(res.error || 'Nothing to undo.');
      return;
    }
    applyState(res);
    toast('Undone');
  }

  // --------------------------------------------------------------- rendering

  function renderAll() {
    if (!S.vault) return;
    renderSidebar();
    renderList();
    renderDetail();
    renderPalette();
    renderModal();
  }

  function renderSidebar() {
    const live = S.vault.projects.filter((p) => p.status !== 'archived');
    const counts = {
      all: live.length,
      recent: Math.min(live.length, 12),
      favorites: live.filter((p) => p.favorite).length,
      archive: S.vault.projects.length - live.length,
    };
    for (const key of Object.keys(counts)) {
      const el = document.querySelector('[data-count="' + key + '"]');
      if (el) el.textContent = String(counts[key]);
    }
    $$('.nav-row').forEach((row) => {
      row.classList.toggle('active', !S.folder && row.dataset.view === S.view);
    });
    const kbd = document.querySelector('[data-shortcut]');
    if (kbd) kbd.textContent = shortcutLabel(S.meta && S.meta.shortcut);

    const tagCounts = new Map();
    for (const project of live) {
      for (const tag of project.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    const tags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12);
    const host = $('#tag-list');
    host.innerHTML = tags.length
      ? tags
          .map(
            ([tag, count]) =>
              '<button class="tag-chip ' +
              (S.tag === tag ? 'active' : '') +
              '" data-action="tag" data-tag="' +
              D.esc(tag) +
              '">' +
              D.esc(tag) +
              ' <span class="dim">' +
              count +
              '</span></button>'
          )
          .join('')
      : '<span class="dim small" style="padding:0 4px">No tags yet</span>';
    renderFolders(live);
  }

  function renderFolders(liveProjects) {
    const host = $('#folder-list');
    if (!host) return;
    const list = folders();
    const live = liveProjects || S.vault.projects.filter((p) => p.status !== 'archived');
    const rows = list.map((folder) => {
      const count = live.filter((p) => p.folderId === folder.id).length;
      return (
        '<button class="folder-row ' +
        (S.folder === folder.id ? 'active' : '') +
        '" data-action="folder" data-id="' +
        folder.id +
        '" data-folder-row data-drop-folder="' +
        folder.id +
        '" style="--fc:' +
        D.esc(folder.color) +
        '" title="' +
        D.esc(folder.name) +
        '"><span class="folder-dot"></span><span class="folder-name">' +
        D.esc(folder.name) +
        '</span><span class="folder-count">' +
        count +
        '</span></button>'
      );
    });
    if (list.length) {
      const unfiled = live.filter((p) => !folderOf(p)).length;
      rows.push(
        '<button class="folder-row unfiled ' +
          (S.folder === '__none__' ? 'active' : '') +
          '" data-action="folder" data-id="__none__" data-folder-row data-drop-folder=""><span class="folder-dot"></span><span class="folder-name">No folder</span><span class="folder-count">' +
          unfiled +
          '</span></button>'
      );
    }
    host.innerHTML = rows.length
      ? rows.join('')
      : '<span class="dim small" style="padding:0 8px 6px">No folders yet — right-click a project to file it.</span>';
  }

  function projectListCard(project) {
    const folder = folderOf(project);
    return (
      '<button class="project-card ' +
      (project.id === S.selectedId ? 'selected' : '') +
      (folder ? ' has-folder' : '') +
      '" data-action="select-project" data-id="' +
      project.id +
      '" data-project-row draggable="true"' +
      (folder ? ' style="--fc:' + D.esc(folder.color) + '"' : '') +
      (folder ? ' title="' + D.esc(folder.name) + '"' : '') +
      '><span class="pc-row">' +
      thumbTile(project, { size: 'xs' }) +
      '<span class="pc-main"><span class="pc-top"><span class="pc-name">' +
      D.esc(project.name) +
      '</span>' +
      (project.favorite ? '<span class="pc-star">' + D.icon('star') + '</span>' : '') +
      '</span><span class="pc-meta">' +
      D.esc(projectMetaLine(project)) +
      '</span></span></span></button>'
    );
  }

  function projectGridCard(project) {
    const folder = folderOf(project);
    return (
      '<button class="project-card grid-card ' +
      (project.id === S.selectedId ? 'selected' : '') +
      '" data-action="select-project" data-id="' +
      project.id +
      '" data-project-row data-grid-card draggable="true"' +
      (folder ? ' style="--fc:' + D.esc(folder.color) + '"' : '') +
      (folder ? ' title="' + D.esc(folder.name) + '"' : '') +
      '>' +
      thumbTile(project, { size: 'lg' }) +
      '<span class="pc-top"><span class="pc-name">' +
      D.esc(project.name) +
      '</span>' +
      (project.favorite ? '<span class="pc-star">' + D.icon('star') + '</span>' : '') +
      '</span>' +
      (project.tags.length
        ? '<span class="pc-tags">' +
          project.tags
            .slice(0, 2)
            .map((tag) => '<span class="pc-tag">#' + D.esc(tag) + '</span>')
            .join('') +
          '</span>'
        : '') +
      '<span class="pc-meta">' + D.esc(projectMetaLine(project)) + '</span></button>'
    );
  }

  function renderList() {
    const host = $('#project-list');
    const list = viewProjects();
    const grid = S.vault.settings.projectView === 'grid';
    host.classList.toggle('grid', grid);
    if (!list.length) {
      host.innerHTML =
        '<div class="empty-list">' +
        (S.vault.projects.length ? 'No projects match this view.' : 'Your projects will live here.') +
        '</div>';
    } else {
      host.innerHTML = list
        .map((project) => (grid ? projectGridCard(project) : projectListCard(project)))
        .join('');
    }
    renderListScope();
    const foot = document.querySelector('[data-list-count]');
    if (foot) foot.textContent = list.length + (list.length === 1 ? ' project' : ' projects');
    const sort = document.querySelector('[data-sort-label]');
    if (sort) sort.textContent = S.sort === 'name' ? 'A–Z' : 'Recent';
    const toggle = document.querySelector('[data-action="toggle-grid"]');
    if (toggle) {
      toggle.setAttribute('aria-pressed', grid ? 'true' : 'false');
      toggle.title = grid ? 'List view (⌘⇧G)' : 'Grid view (⌘⇧G)';
      toggle.innerHTML = D.icon(grid ? 'list' : 'grid');
    }
  }

  function renderListScope() {
    const host = $('#list-scope');
    if (!host) return;
    const folder = S.folder && S.folder !== '__none__' ? folderById(S.folder) : null;
    if (!folder && S.folder !== '__none__') {
      host.classList.add('hidden');
      host.innerHTML = '';
      return;
    }
    host.classList.remove('hidden');
    host.innerHTML =
      '<span class="scope-chip"' +
      (folder ? ' style="--fc:' + D.esc(folder.color) + '"' : '') +
      '><span class="folder-dot"></span>' +
      D.esc(folder ? folder.name : 'No folder') +
      (folder
        ? '<button type="button" class="mini-btn" data-action="edit-folder" data-id="' +
          folder.id +
          '" title="Edit folder">' +
          D.icon('edit') +
          '</button>'
        : '') +
      '<button type="button" class="mini-btn" data-action="clear-folder" title="Show all projects">' +
      D.icon('x') +
      '</button></span>';
  }

  function renderDetail() {
    const host = $('#detail');
    if (!S.vault.projects.length) {
      host.innerHTML = emptyState();
      return;
    }
    const project = currentProject();
    if (!project) {
      host.innerHTML =
        '<div class="empty-state"><div class="empty-mark">n++</div><h2 class="empty-title">Pick a project</h2><p class="empty-sub">Select something on the left, or press ⌘K to search everything.</p></div>';
      return;
    }
    const vars = project.envs.reduce((n, env) => n + env.vars.length, 0);
    const live = project.links.find((l) => l.kind === 'live');
    const repo = project.links.find((l) => l.kind === 'repo');
    const hasEnv = project.envs.some((e) => e.vars.length);
    const folder = folderOf(project);

    const tabs = [
      ['overview', 'Overview', null],
      ['accounts', 'Accounts', project.accounts.length],
      ['env', 'Env & keys', vars],
      ['notes', 'Notes & code', project.entries.length],
      ['links', 'Links & services', project.links.length + project.services.length],
    ];

    const header =
      '<div class="detail-head">' +
      '<div class="eyebrow"><span class="dot"></span> Project <span class="dim">·</span> ' +
      D.esc(project.status) +
      (project.favorite ? ' <span class="dim">·</span> ★' : '') +
      '</div>' +
      '<div class="title-row"><h1 class="project-title" data-project-name data-action="edit-title">' +
      D.esc(project.name) +
      '</h1>' +
      '<div class="detail-actions">' +
      (hasEnv
        ? '<button class="btn sm" data-action="copy-env" title="Copy this project’s .env">' +
          D.icon('copy') +
          ' <span>.env</span></button>'
        : '') +
      (repo
        ? '<button class="btn sm" data-action="open-url" data-url="' + D.esc(repo.url) + '">' + D.icon('external') + ' Repo</button>'
        : '') +
      (live
        ? '<button class="btn sm" data-action="open-url" data-url="' + D.esc(live.url) + '">' + D.icon('external') + ' Live</button>'
        : '') +
      '<button class="icon-btn" data-action="favorite" title="Favorite">' +
      (project.favorite ? '<span class="pc-star">' + D.icon('star') + '</span>' : D.icon('star')) +
      '</button>' +
      '<button class="icon-btn" data-action="archive-project" title="Archive">' + D.icon('archive') + '</button>' +
      '<button class="icon-btn" data-action="export-project" title="Export markdown">' + D.icon('download') + '</button>' +
      '<button class="icon-btn" data-action="delete-project" title="Delete project">' + D.icon('trash') + '</button>' +
      '</div></div>' +
      '<div class="meta-row">' +
      (folder
        ? '<button class="chip clickable folder-chip" style="--fc:' +
          D.esc(folder.color) +
          '" data-action="edit-details"><span class="folder-dot"></span>' +
          D.esc(folder.name) +
          '</button>'
        : '') +
      project.stack.slice(0, 5).map((s) => '<span class="chip mono">' + D.esc(s) + '</span>').join('') +
      project.tags
        .map((t) => '<button class="chip clickable" data-action="tag" data-tag="' + D.esc(t) + '">#' + D.esc(t) + '</button>')
        .join('') +
      '<button class="chip clickable" data-action="edit-details">Edit details</button>' +
      '<span class="dim small" style="margin-left:4px">Updated ' + relative(project.updatedAt) + '</span>' +
      '</div>' +
      '<div class="tabs">' +
      tabs
        .map(
          ([id, label, count]) =>
            '<button class="tab ' +
            (S.tab === id ? 'active' : '') +
            '" data-action="tab" data-tab="' +
            id +
            '">' +
            D.esc(label) +
            (count ? '<span class="tab-count">' + count + '</span>' : '') +
            '</button>'
        )
        .join('') +
      '</div></div>';

    host.innerHTML = header + '<div class="detail-body">' + tabBody(project) + '</div>';
  }

  function renderDetailKeepScroll() {
    const host = $('#detail');
    const top = host ? host.scrollTop : 0;
    renderDetail();
    if (host) host.scrollTop = top;
  }

  // ------------------------------------------------------------ variable edit

  function findVar(project, envId, varId) {
    if (!project) return null;
    const env = project.envs.find((e) => e.id === envId);
    const item = env && env.vars.find((v) => v.id === varId);
    return env && item ? { env, item } : null;
  }

  function startVarEdit(envId, varId, field) {
    const found = findVar(currentProject(), envId, varId);
    if (!found) return;
    S.editingVar = { envId, id: varId, focus: field || 'key' };
    renderDetailKeepScroll();
    setTimeout(() => {
      const input = document.querySelector(
        field === 'value'
          ? '.var-row.editing [data-var-value-input]'
          : '.var-row.editing [data-var-key]'
      );
      if (input) {
        input.focus();
        if (input.select) input.select();
      }
    }, 30);
  }

  function cancelVarEdit() {
    if (!S.editingVar) return;
    S.editingVar = null;
    renderDetailKeepScroll();
  }

  async function commitVarEdit() {
    const state = S.editingVar;
    if (!state) return;
    const project = currentProject();
    if (!project) return;
    const keyInput = document.querySelector('.var-row.editing [data-var-key]');
    const valueInput = document.querySelector('.var-row.editing [data-var-value-input]');
    const key = keyInput ? keyInput.value.trim() : '';
    if (!key) {
      toast('A variable needs a key.');
      if (keyInput) keyInput.focus();
      return;
    }
    const value = valueInput ? valueInput.value : '';
    S.editingVar = null;
    const res = await dispatch({
      type: 'var.update',
      payload: { projectId: project.id, envId: state.envId, id: state.id, key, value },
    });
    if (res.ok) {
      renderDetailKeepScroll();
      toast('Variable updated');
    } else {
      S.editingVar = state;
      renderDetailKeepScroll();
    }
  }

  function tabBody(project) {
    if (S.tab === 'accounts') return accountsTab(project);
    if (S.tab === 'env') return envTab(project);
    if (S.tab === 'notes') return notesTab(project);
    if (S.tab === 'links') return linksTab(project);
    return overviewTab(project);
  }

  // --------------------------------------------------------------- overview

  function detectCard(project) {
    const links = (project.links || []).filter((link) => /^https?:/i.test(link.url));
    if (!links.length) return '';
    const preview = project.thumb && project.thumb.url ? D.hostOf(project.thumb.url) : '';
    const when = project.detectedAt ? 'Last applied ' + relative(project.detectedAt) : 'Nothing applied yet';
    return (
      '<div class="card pad detect-card">' +
      '<div class="detect-head">' +
      thumbTile(project, { size: 'sm' }) +
      '<div class="grow"><div class="section-title">Preview &amp; detection</div>' +
      '<div class="hint">A preview image from your live site or repo, and stack suggestions read from those links. Nothing is added until you tick it.</div></div>' +
      '<span class="dim small">' + D.esc(when) + '</span>' +
      '</div>' +
      '<div class="detect-actions">' +
      '<button class="btn sm primary" data-action="detect-details" data-id="' +
      project.id +
      '">' +
      D.icon('wand') +
      ' Detect details</button>' +
      '<button class="btn sm" data-action="refresh-preview" data-id="' +
      project.id +
      '">' +
      D.icon('refresh') +
      ' ' +
      (preview ? 'Refresh preview' : 'Capture preview') +
      '</button>' +
      (preview ? '<span class="dim small">Preview from ' + D.esc(preview) + '</span>' : '') +
      '</div></div>'
    );
  }

  function overviewTab(project) {
    const vars = project.envs.reduce((n, env) => n + env.vars.length, 0);
    const checks = [
      ['Code repo linked', project.links.some((l) => l.kind === 'repo')],
      ['Live URL recorded', project.links.some((l) => l.kind === 'live')],
      ['Env vars captured', project.envs.some((e) => e.vars.length)],
      ['At least one account', project.accounts.length > 0],
      ['Stack documented', project.stack.length > 0],
    ];
    const gaps = checks.filter((c) => !c[1]).length;

    return (
      captureCard(project) +
      detectCard(project) +
      '<div class="stat-grid">' +
      stat(project.accounts.length, 'accounts') +
      stat(vars, 'env vars') +
      stat(project.services.length, 'services') +
      stat(project.entries.length, 'notes') +
      '</div>' +
      '<div class="two-col" style="margin-top:12px">' +
      '<div class="card pad">' +
      '<div class="section-head"><span class="section-title">Setup</span><span class="spacer"></span><span class="dim small">' +
      (gaps ? gaps + ' to go' : 'complete') +
      '</span></div>' +
      '<div class="gap-list">' +
      checks
        .map(
          ([label, ok]) =>
            '<div class="gap-row ' +
            (ok ? 'done' : '') +
            '">' +
            D.icon(ok ? 'check' : 'plus') +
            '<span>' +
            D.esc(label) +
            '</span></div>'
        )
        .join('') +
      '</div>' +
      (project.description
        ? '<div class="hint" style="margin-top:10px">' + D.esc(project.description) + '</div>'
        : '<div class="hint" style="margin-top:10px">Click the project name to add a description later.</div>') +
      '</div>' +
      '<div class="card pad">' +
      '<div class="section-head"><span class="section-title">Services</span><span class="spacer"></span>' +
      '<button class="mini-btn" data-action="add-service" title="Add service">' + D.icon('plus') + '</button></div>' +
      (project.services.length
        ? '<div class="svc-mini">' +
          project.services
            .map(
              (s) =>
                '<button class="svc-pill" data-action="edit-service" data-id="' +
                s.id +
                '"><span class="svc-mark">' +
                D.esc(D.initials(s.provider)) +
                '</span>' +
                D.esc(s.provider) +
                (s.role ? '<span class="dim">· ' + D.esc(s.role) + '</span>' : '') +
                '</button>'
            )
            .join('') +
          '</div>'
        : '<div class="hint">No services recorded yet — Vercel, Railway, Neon, Resend…</div>') +
      '</div></div>' +
      '<div class="section" style="margin-top:18px">' +
      '<div class="section-head"><span class="section-title">Links</span><span class="spacer"></span>' +
      '<button class="mini-btn" data-action="add-link" title="Add link">' + D.icon('plus') + '</button></div>' +
      '<div class="card pad">' +
      (project.links.length
        ? project.links
            .map(
              (l) =>
                '<div class="link-line"><span class="link-kind">' +
                D.esc(l.kind) +
                '</span><span style="flex:1;min-width:0"><div class="link-label">' +
                D.esc(l.label) +
                '</div><div class="url copy-field ' +
                (S.copied.has('link:' + l.id) ? 'copied' : '') +
                '"' +
                copyAttrs('link:' + l.id, l.url, l.label, false) +
                ' title="Click to copy">' +
                D.esc(l.url) +
                '</div></span>' +
                copyButton('link:' + l.id, l.url, l.label, false, 'Copy link') +
                '<button class="mini-btn" data-action="open-url" data-url="' +
                D.esc(l.url) +
                '" title="Open">' +
                D.icon('external') +
                '</button></div>'
            )
            .join('')
        : '<div class="hint">No links yet. Add the repo, the live site, the dashboard.</div>') +
      '</div></div>' +
      (project.entries.length
        ? '<div class="section">' +
          '<div class="section-head"><span class="section-title">Latest notes</span><span class="spacer"></span>' +
          '<button class="btn sm ghost" data-action="tab" data-tab="notes">All notes</button></div>' +
          '<div class="card pad">' +
          project.entries
            .slice(0, 3)
            .map(
              (e) =>
                '<div class="recent-note"><div class="result-title">' +
                D.esc(e.title) +
                '</div><div class="entry-meta"><span>' +
                D.esc(e.type) +
                '</span><span>·</span><span>' +
                relative(e.updatedAt) +
                '</span></div></div>'
            )
            .join('') +
          '</div></div>'
        : '')
    );
  }

  // ------------------------------------------------------- project capture

  function captureCard(project) {
    const fallback = activeEnv(project) || { name: 'dev' };
    const envNames = [];
    for (const name of [
      ...project.envs.map((e) => e.name),
      S.capture.envName,
      fallback.name,
      'dev',
      'staging',
      'production',
    ]) {
      if (name && !envNames.includes(name)) envNames.push(name);
    }
    const envName = S.capture.envName || fallback.name;
    return (
      '<div class="capture-card">' +
      '<div class="capture-head"><span class="capture-badge">' +
      D.icon('capture') +
      ' Quick capture</span><span class="capture-target">' +
      D.icon('arrow-right') +
      ' filing into <strong>' +
      D.esc(project.name) +
      '</strong></span><span class="spacer"></span>' +
      '<label class="capture-env"><span>env</span><select data-capture-env>' +
      envNames
        .map(
          (name) =>
            '<option value="' +
            D.esc(name) +
            '"' +
            (name === envName ? ' selected' : '') +
            '>' +
            D.esc(name) +
            '</option>'
        )
        .join('') +
      '</select></label></div>' +
      '<textarea data-capture-input spellcheck="false" placeholder="Paste an .env block, a snippet, a few links, a login — it gets filed on the right shelf, in this project.">' +
      D.esc(S.capture.text) +
      '</textarea>' +
      '<div class="capture-foot"><span class="capture-plan" data-capture-plan>' +
      capturePlanHTML(S.capture.text) +
      '</span><span class="spacer"></span>' +
      '<span class="hint capture-keys">⌘↵ to file · esc to dismiss</span>' +
      '<button class="btn sm primary" data-action="file-capture"' +
      (S.capture.text.trim() ? '' : ' disabled') +
      '>File into project</button></div></div>'
    );
  }

  function capturePlanHTML(text) {
    if (!String(text || '').trim()) {
      return '<span class="dim small">Vars → Env, code → Notes, links → Links, the rest → Notes.</span>';
    }
    const plan = P.routeCapture(text);
    const chips = [];
    if (plan.env) {
      const n = plan.env.pairs.length;
      chips.push('<span class="capture-chip env">' + n + (n === 1 ? ' var' : ' vars') + ' → env</span>');
    }
    if (plan.accounts.length) {
      chips.push(
        '<span class="capture-chip account">' +
          plan.accounts.length +
          (plan.accounts.length === 1 ? ' login' : ' logins') +
          ' → accounts</span>'
      );
    }
    if (plan.links.length) {
      chips.push(
        '<span class="capture-chip link">' +
          plan.links.length +
          (plan.links.length === 1 ? ' link' : ' links') +
          ' → links</span>'
      );
    }
    if (plan.code) chips.push('<span class="capture-chip code">snippet → notes</span>');
    if (plan.note) chips.push('<span class="capture-chip note">note → notes</span>');
    return chips.length
      ? chips.join('')
      : '<span class="dim small">Nothing recognized — this will be filed as a note.</span>';
  }

  function renderCapturePlan() {
    const host = document.querySelector('[data-capture-plan]');
    if (host) host.innerHTML = capturePlanHTML(S.capture.text);
    const button = document.querySelector('[data-action="file-capture"]');
    if (button) button.disabled = !S.capture.text.trim();
  }

  async function fileCapture() {
    const project = currentProject();
    if (!project) return;
    const text = S.capture.text;
    if (!text.trim()) {
      toast('Nothing to file yet.');
      return;
    }
    const plan = P.routeCapture(text);
    const envName = S.capture.envName || (activeEnv(project) || { name: 'dev' }).name;
    const actions = [];
    const summary = [];

    if (plan.env) {
      const existing = project.envs.find(
        (e) => e.name.toLowerCase() === envName.toLowerCase()
      );
      actions.push({
        type: 'env.vars.add',
        payload: {
          projectId: project.id,
          envId: existing ? existing.id : undefined,
          envName,
          vars: plan.env.pairs,
        },
      });
      summary.push(plan.env.pairs.length + ' vars');
    }

    for (const account of plan.accounts) {
      actions.push({
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
    }
    if (plan.accounts.length) summary.push(plan.accounts.length + ' logins');

    const known = new Set(project.links.map((l) => l.url.toLowerCase()));
    for (const link of plan.links) {
      if (known.has(link.url.toLowerCase())) continue;
      known.add(link.url.toLowerCase());
      actions.push({
        type: 'link.upsert',
        payload: {
          projectId: project.id,
          link: {
            label: link.label || link.provider || D.hostOf(link.url),
            kind: link.kind,
            url: link.url,
          },
        },
      });
    }
    if (actions.some((a) => a.type === 'link.upsert')) {
      summary.push(
        actions.filter((a) => a.type === 'link.upsert').length === 1 ? '1 link' :
          actions.filter((a) => a.type === 'link.upsert').length + ' links'
      );
    }

    if (plan.code) {
      actions.push({
        type: 'entry.upsert',
        payload: {
          projectId: project.id,
          entry: {
            type: 'snippet',
            title: D.firstLine(plan.code, 80),
            body: plan.code,
            language: 'code',
          },
        },
      });
      summary.push('1 snippet');
    }
    if (plan.note) {
      actions.push({
        type: 'entry.upsert',
        payload: {
          projectId: project.id,
          entry: { type: 'note', title: D.firstLine(plan.note, 80), body: plan.note },
        },
      });
      summary.push('1 note');
    }

    if (!actions.length) {
      toast('Nothing to file yet.');
      return;
    }

    const results = await batch(actions);
    const ok = results.filter((r) => r && r.ok).length;
    if (!ok) {
      toast('Nothing could be filed.', { sub: 'Check the URLs and keys, then try again.' });
      return;
    }
    S.capture.text = '';
    renderDetailKeepScroll();
    toast(
      'Filed ' + summary.join(' · ') + ' into “' + project.name + '”',
      { sub: ok + (ok === 1 ? ' change' : ' changes') + ' saved' }
    );
  }

  function stat(num, label) {
    return '<div class="stat"><div class="stat-num">' + num + '</div><div class="stat-label">' + label + '</div></div>';
  }

  // --------------------------------------------------------------- accounts

  function accountsTab(project) {
    const rows = project.accounts.length
      ? project.accounts
          .map((account) => {
            const identity = account.label || account.email || account.username || 'Account';
            return (
              '<div class="acct-row" data-account-row data-account="' +
              account.id +
              '">' +
              '<div class="acct-label"><span class="avatar">' +
              D.esc(D.initials(identity)) +
              '</span><span style="min-width:0"><div class="acct-name">' +
              D.esc(identity) +
              '</div><div class="acct-sub">' +
              D.esc([account.service, account.env].filter(Boolean).join(' · ') || 'no service') +
              '</div></span></div>' +
              '<div class="value copy-field ' +
              (S.copied.has('acct:' + account.id + ':email') ? 'copied' : '') +
              '"' +
              (account.email
                ? copyAttrs('acct:' + account.id + ':email', account.email, 'email', false)
                : '') +
              ' title="' +
              D.esc(account.email || '') +
              '"><span>' +
              D.esc(account.email || '—') +
              '</span>' +
              (account.email
                ? copyButton('acct:' + account.id + ':email', account.email, 'email', false, 'Copy email')
                : '') +
              '</div>' +
              '<div class="value copy-field ' +
              (S.copied.has('acct:' + account.id + ':username') ? 'copied' : '') +
              '"' +
              (account.username
                ? copyAttrs('acct:' + account.id + ':username', account.username, 'username', false)
                : '') +
              ' title="' +
              D.esc(account.username || '') +
              '"><span>' +
              D.esc(account.username || '—') +
              '</span>' +
              (account.username
                ? copyButton(
                    'acct:' + account.id + ':username',
                    account.username,
                    'username',
                    false,
                    'Copy username'
                  )
                : '') +
              '</div>' +
              '<div class="fields">' +
              (account.fields.length
                ? account.fields.map((field) => fieldPill(account, field)).join('')
                : '<span class="dim small">no fields</span>') +
              '</div>' +
              '<div class="row-actions">' +
              '<button class="mini-btn" data-action="edit-account" data-id="' +
              account.id +
              '" title="Edit">' +
              D.icon('edit') +
              '</button>' +
              '<button class="mini-btn" data-action="delete-account" data-id="' +
              account.id +
              '" title="Delete">' +
              D.icon('trash') +
              '</button>' +
              '</div></div>'
            );
          })
          .join('')
      : '';

    return (
      '<div class="toolbar">' +
      '<button class="btn sm primary" data-action="add-account">' + D.icon('plus') + ' Add account</button>' +
      '<button class="btn sm" data-action="paste-accounts">' + D.icon('download') + ' Paste accounts</button>' +
      '<span class="spacer"></span>' +
      '<span class="dim small">' +
      project.accounts.length +
      (project.accounts.length === 1 ? ' account' : ' accounts') +
      ' · all visible by default</span>' +
      '</div>' +
      (project.accounts.length
        ? '<div class="acct-table"><div class="acct-head"><span>Label</span><span>Email</span><span>Username</span><span>Fields</span><span></span></div>' +
          rows +
          '</div>'
        : '<div class="card pad"><div class="hint" style="margin:0">No accounts yet. Test accounts, dev/prod logins, admin identities — keep them all here.</div></div>')
    );
  }

  function fieldPill(account, field) {
    const key = 'field:' + account.id + ':' + field.id;
    const revealed = S.reveal.has(account.id + ':' + field.id);
    const shown = field.hidden && !revealed ? '••••••••' : field.value || '—';
    return (
      '<span class="field-pill copy-field ' +
      (field.hidden && !revealed ? 'masked ' : '') +
      (S.copied.has(key) ? 'copied' : '') +
      '"' +
      copyAttrs(key, field.value, field.label, field.hidden) +
      ' title="Click to copy ' +
      D.esc(field.label) +
      '"><span class="flabel">' +
      D.esc(field.label) +
      '</span><span class="fval">' +
      D.esc(shown) +
      '</span>' +
      (field.hidden
        ? '<button class="mini-btn" data-action="toggle-field" data-account="' +
          account.id +
          '" data-field="' +
          field.id +
          '" title="Reveal">' +
          D.icon(revealed ? 'eye-off' : 'eye') +
          '</button>'
        : '') +
      copyButton(key, field.value, field.label, field.hidden, 'Copy ' + field.label) +
      '</span>'
    );
  }

  // -------------------------------------------------------------------- env

  function envTab(project) {
    const env = activeEnv(project);
    if (!project.envs.length) {
      return (
        '<div class="toolbar">' +
        '<button class="btn sm primary" data-action="add-env">' + D.icon('plus') + ' Add environment</button>' +
        '<button class="btn sm" data-action="paste-env">' + D.icon('download') + ' Paste .env</button>' +
        '</div>' +
        '<div class="card pad"><div class="hint" style="margin:0">No env vars yet. Paste a <span class="mono">.env</span> block and napkin++ will split it into key/value rows.</div></div>'
      );
    }
    const vars = env.vars;
    return (
      '<div class="toolbar">' +
      '<div class="env-chips">' +
      project.envs
        .map(
          (e) =>
            '<button class="env-chip ' +
            (e.id === env.id ? 'active' : '') +
            '" data-action="select-env" data-id="' +
            e.id +
            '">' +
            D.esc(e.name) +
            '<span class="dim"> ' +
            e.vars.length +
            '</span></button>'
        )
        .join('') +
      '<button class="env-chip" data-action="add-env" title="Add environment">+</button>' +
      '</div>' +
      '<span class="spacer"></span>' +
      '<button class="btn sm" data-action="paste-env">Paste .env</button>' +
      '<button class="btn sm" data-action="copy-env">' + D.icon('copy') + ' Copy .env</button>' +
      '</div>' +
      (env.url
        ? '<div class="env-url"><span class="copy-field ' +
          (S.copied.has('envurl:' + env.id) ? 'copied' : '') +
          '"' +
          copyAttrs('envurl:' + env.id, env.url, env.name + ' URL', false) +
          ' title="Click to copy">' +
          D.icon('link') +
          '<span>' +
          D.esc(env.url) +
          '</span></span>' +
          copyButton('envurl:' + env.id, env.url, env.name + ' URL', false, 'Copy URL') +
          '<button class="mini-btn" data-action="open-url" data-url="' +
          D.esc(env.url) +
          '">' +
          D.icon('external') +
          '</button></div>'
        : '') +
      '<div class="var-table">' +
      (vars.length
        ? vars.map((v) => varRow(project, env, v)).join('')
        : '<div class="var-row"><span class="dim small" style="grid-column:1/4">No variables in ' + D.esc(env.name) + ' yet.</span></div>') +
      '<form class="inline-add" data-form="add-var" data-project="' + project.id + '" data-env="' + env.id + '">' +
      '<input class="key mono" name="key" placeholder="KEY" spellcheck="false" autocomplete="off" />' +
      '<input class="val mono" name="value" placeholder="value" spellcheck="false" autocomplete="off" />' +
      '<button class="btn sm" type="submit">Add</button>' +
      '</form>' +
      '</div>'
    );
  }

  function varRow(project, env, v) {
    if (S.editingVar && S.editingVar.envId === env.id && S.editingVar.id === v.id) {
      return varEditRow(v);
    }
    const key = project.id + ':' + v.id;
    const revealed = S.reveal.has(key);
    const shown = v.hidden && !revealed ? '••••••••••••' : v.value || '—';
    return (
      '<div class="var-row ' +
      (S.copied.has(key) ? 'was-copied' : '') +
      '" data-var-row data-var-id="' +
      v.id +
      '">' +
      '<div class="var-key" title="' +
      D.esc(v.key) +
      '">' +
      D.esc(v.key) +
      '</div>' +
      '<div class="var-value copy-field ' +
      (v.hidden && !revealed ? 'masked ' : '') +
      (S.copied.has(key) ? 'copied' : '') +
      '" data-var-value="' +
      v.id +
      '"' +
      copyAttrs(key, v.value, v.key, v.hidden) +
      ' title="Click to copy ' +
      D.esc(v.key) +
      '"><span>' +
      D.esc(shown) +
      '</span></div>' +
      '<div class="var-actions">' +
      (v.hidden
        ? '<button class="mini-btn" data-action="toggle-var" data-id="' +
          v.id +
          '" title="Reveal">' +
          D.icon(revealed ? 'eye-off' : 'eye') +
          '</button>'
        : '') +
      copyButton(key, v.value, v.key, v.hidden, 'Copy value') +
      '<button class="mini-btn" data-action="copy-var-line" data-id="' +
      v.id +
      '" title="Copy KEY=value">' +
      D.icon('code') +
      '</button>' +
      '<button class="mini-btn" data-action="edit-var" data-id="' +
      v.id +
      '" title="Edit variable">' +
      D.icon('edit') +
      '</button>' +
      '<button class="mini-btn" data-action="delete-var" data-id="' +
      v.id +
      '" title="Delete">' +
      D.icon('trash') +
      '</button>' +
      '</div></div>'
    );
  }

  function varEditRow(v) {
    return (
      '<div class="var-row editing" data-var-row data-var-id="' +
      v.id +
      '">' +
      '<input class="var-edit-input mono" data-var-key value="' +
      D.esc(v.key) +
      '" placeholder="KEY" spellcheck="false" autocomplete="off" />' +
      '<input class="var-edit-input mono" data-var-value-input value="' +
      D.esc(v.value) +
      '" placeholder="value" spellcheck="false" autocomplete="off" />' +
      '<div class="var-actions edit-actions">' +
      '<button class="mini-btn" data-action="commit-var" title="Save (↵)">' +
      D.icon('check') +
      '</button>' +
      '<button class="mini-btn" data-action="cancel-var" title="Cancel (esc)">' +
      D.icon('x') +
      '</button>' +
      '</div></div>'
    );
  }

  // ------------------------------------------------------------------ notes

  function notesTab(project) {
    const entries = project.entries;
    return (
      '<form class="composer" data-form="add-entry" data-project="' + project.id + '">' +
      '<textarea name="body" placeholder="Paste a note, a snippet, a curl command…" spellcheck="false"></textarea>' +
      '<div class="composer-foot"><span data-compose-hint>Markdown, code or a stray URL — all fine.</span><span class="spacer"></span>' +
      '<select class="select" name="type" style="width:118px;height:26px;font-size:11px">' +
      ['note', 'snippet', 'command', 'secret', 'recovery', 'instruction']
        .map((t) => '<option value="' + t + '">' + t + '</option>')
        .join('') +
      '</select>' +
      '<button class="btn sm primary" type="submit">Save entry</button>' +
      '</div></form>' +
      (entries.length
        ? entries.map((entry) => entryCard(entry)).join('')
        : '<div class="card pad"><div class="hint" style="margin:0">Notes and code snippets land here. Line numbers and folding appear automatically for multi-line entries.</div></div>')
    );
  }

  function entryCard(entry) {
    const lines = F.splitLines(entry.body);
    const folds = F.computeFolds(entry.body);
    const expanded = S.expanded.has(entry.id) || lines.length <= 12;
    return (
      '<div class="entry-card" data-entry-card="' +
      entry.id +
      '">' +
      '<div class="entry-head"><div style="min-width:0;flex:1">' +
      '<div class="entry-title">' +
      D.esc(entry.title) +
      '</div>' +
      '<div class="entry-meta"><span>' +
      D.esc(entry.type) +
      '</span>' +
      (entry.language ? '<span>· ' + D.esc(entry.language) + '</span>' : '') +
      '<span>· ' + lines.length + ' lines</span><span>· ' + relative(entry.updatedAt) + '</span>' +
      (entry.pinned ? '<span>· pinned</span>' : '') +
      '</div></div>' +
      '<div class="row-actions">' +
      '<button class="mini-btn copy-btn ' +
      (S.copied.has('entry:' + entry.id) ? 'copied' : '') +
      '" data-action="copy-entry" data-copy-key="entry:' +
      entry.id +
      '" data-id="' +
      entry.id +
      '" title="' +
      D.esc(S.copied.has('entry:' + entry.id) ? 'Copied — click to copy again' : 'Copy') +
      '">' +
      copyIconFor('entry:' + entry.id) +
      '</button>' +
      '<button class="mini-btn" data-action="edit-entry" data-id="' +
      entry.id +
      '" title="Edit">' +
      D.icon('edit') +
      '</button>' +
      '<button class="mini-btn" data-action="delete-entry" data-id="' +
      entry.id +
      '" title="Delete">' +
      D.icon('trash') +
      '</button></div></div>' +
      '<div data-entry-body="' + entry.id + '">' + entryBody(entry, folds, expanded) + '</div>' +
      '</div>'
    );
  }

  function entryBody(entry, folds, expanded) {
    const lines = F.splitLines(entry.body);
    if (entry.type === 'secret' && !S.expanded.has('reveal:' + entry.id)) {
      return (
        '<div class="entry-preview" style="mask-image:none;color:var(--text-3);letter-spacing:.12em">••••••••••••••••••••</div>' +
        '<div class="composer-foot"><span>Secret entry — masked</span><span class="spacer"></span>' +
        '<button class="btn sm ghost" data-action="reveal-entry" data-id="' + entry.id + '">Reveal</button>' +
        '<button class="btn sm" data-action="copy-entry" data-id="' + entry.id + '">Copy secret</button></div>'
      );
    }
    return (
      '<div class="code">' +
      codeLines(entry, lines, folds, expanded) +
      '</div>' +
      (lines.length > 12
        ? '<div class="composer-foot"><span>' +
          (expanded ? lines.length + ' lines' : 'Previewing 12 of ' + lines.length) +
          '</span><span class="spacer"></span>' +
          '<button class="btn sm ghost" data-action="expand-entry" data-id="' +
          entry.id +
          '">' +
          (expanded ? 'Collapse' : 'Show all') +
          '</button></div>'
        : '')
    );
  }

  function codeLines(entry, lines, folds, expanded) {
    const foldMap = F.foldMap(folds);
    const collapsed = new Set(
      [...S.collapsed]
        .filter((key) => key.startsWith(entry.id + ':'))
        .map((key) => Number(key.split(':')[1]))
    );
    const hidden = F.hiddenRanges(folds, collapsed);
    const hiddenAt = new Set();
    for (const range of hidden) {
      for (let i = range.start; i <= range.end; i += 1) hiddenAt.add(i);
    }
    let html = '';
    const limit = expanded ? lines.length : Math.min(12, lines.length);
    for (let i = 0; i < limit; i += 1) {
      if (hiddenAt.has(i)) continue;
      const fold = foldMap.get(i);
      const isCollapsed = fold && collapsed.has(i);
      html +=
        '<div class="code-line"><button class="' +
        (fold ? 'gutter can-fold' : 'gutter') +
        '" ' +
        (fold ? 'data-action="toggle-fold" data-entry="' + entry.id + '" data-line="' + i + '"' : 'tabindex="-1"') +
        '>' +
        (fold ? D.icon(isCollapsed ? 'chevron-right' : 'chevron-down', 'fold-ic') : '') +
        '<span>' +
        (i + 1) +
        '</span></button><div class="code-text">' +
        D.esc(lines[i]) +
        (isCollapsed && fold ? '<span class="fold-chip">' + (fold.end - fold.start) + ' lines</span>' : '') +
        '</div></div>';
    }
    if (!expanded && lines.length > limit) {
      html +=
        '<div class="code-line"><span class="gutter">…</span><div class="code-text dim">' +
        (lines.length - limit) +
        ' more lines</div></div>';
    }
    return html || '<div class="code-line"><span class="gutter">1</span><div class="code-text dim">empty</div></div>';
  }

  // ------------------------------------------------------------------ links

  function linksTab(project) {
    return (
      '<div class="section">' +
      '<div class="section-head"><span class="section-title">Links</span><span class="spacer"></span>' +
      '<button class="btn sm" data-action="add-link">' + D.icon('plus') + ' Add link</button></div>' +
      '<div class="card pad">' +
      (project.links.length
        ? project.links
            .map(
              (l) =>
                '<div class="link-row"><span class="link-kind">' +
                D.esc(l.kind) +
                '</span><div class="link-main"><div class="link-label">' +
                D.esc(l.label) +
                '</div><div class="link-url copy-field ' +
                (S.copied.has('link:' + l.id) ? 'copied' : '') +
                '"' +
                copyAttrs('link:' + l.id, l.url, l.label, false) +
                ' title="Click to copy">' +
                D.esc(l.url) +
                '</div></div><div class="row-actions">' +
                copyButton('link:' + l.id, l.url, l.label, false, 'Copy link') +
                '<button class="mini-btn" data-action="open-url" data-url="' + D.esc(l.url) + '">' + D.icon('external') + '</button>' +
                '<button class="mini-btn" data-action="edit-link" data-id="' + l.id + '">' + D.icon('edit') + '</button>' +
                '<button class="mini-btn" data-action="delete-link" data-id="' + l.id + '">' + D.icon('trash') + '</button>' +
                '</div></div>'
            )
            .join('')
        : '<div class="hint">No links yet. Repo, live, staging, dashboard — one click to copy or open.</div>') +
      '</div></div>' +
      '<div class="section">' +
      '<div class="section-head"><span class="section-title">Services</span><span class="spacer"></span>' +
      '<button class="btn sm" data-action="add-service">' + D.icon('plus') + ' Add service</button></div>' +
      '<div class="card pad">' +
      (project.services.length
        ? project.services
            .map(
              (s) =>
                '<div class="svc-row"><span class="svc-mark">' +
                D.esc(D.initials(s.provider)) +
                '</span><div class="link-main"><div class="link-label">' +
                D.esc(s.provider) +
                (s.role ? ' <span class="svc-role">· ' + D.esc(s.role) + '</span>' : '') +
                '</div>' +
                (s.url ? '<div class="link-url">' + D.esc(s.url) + '</div>' : '') +
                (s.notes ? '<div class="svc-notes">' + D.esc(s.notes) + '</div>' : '') +
                '</div><div class="row-actions">' +
                (s.url
                  ? '<button class="mini-btn" data-action="open-url" data-url="' + D.esc(s.url) + '">' + D.icon('external') + '</button>'
                  : '') +
                '<button class="mini-btn" data-action="edit-service" data-id="' + s.id + '">' + D.icon('edit') + '</button>' +
                '<button class="mini-btn" data-action="delete-service" data-id="' + s.id + '">' + D.icon('trash') + '</button>' +
                '</div></div>'
            )
            .join('')
        : '<div class="hint">Vercel, Railway, Neon, Supabase, Clerk, LiveKit, Resend… add what this project runs on.</div>') +
      '</div></div>'
    );
  }

  function emptyState() {
    return (
      '<div class="empty-state"><div class="empty-mark">n++</div>' +
      '<h2 class="empty-title">Nothing on the napkin yet.</h2>' +
      '<p class="empty-sub">Every project gets one place for its keys, env vars, accounts, links, services and stray notes. Yours, on this Mac.</p>' +
      '<div class="empty-actions"><button class="btn primary" data-action="new-project">' +
      D.icon('plus') +
      ' New project</button>' +
      '<button class="btn" data-action="import">' +
      D.icon('download') +
      ' Import your old notes</button></div>' +
      '<div class="empty-hint">Press <kbd>⌘K</kbd> to search everything, <kbd>⌥Space</kbd> from anywhere.</div></div>'
    );
  }

  // ---------------------------------------------------------------- palette

  function openPalette(query) {
    S.palette.open = true;
    S.palette.query = query || '';
    S.palette.kind = 'all';
    S.palette.active = 0;
    renderPalette();
    const host = $('#palette');
    host.classList.remove('hidden');
    const input = $('#palette-input');
    input.value = S.palette.query;
    input.focus();
    input.select();
  }

  function closePalette() {
    S.palette.open = false;
    S.palette.query = '';
    const host = $('#palette');
    if (host) host.classList.add('hidden');
  }

  function paletteItems() {
    const query = S.palette.query.trim();
    if (!query) {
      const recent = (S.vault.ui.recent || [])
        .map((id) => projectById(id))
        .filter((p) => p && p.status !== 'archived')
        .slice(0, 5);
      return recent.map((p) => ({
        kind: 'project',
        id: p.id,
        projectId: p.id,
        title: p.name,
        subtitle: [p.status, p.accounts.length + ' accounts', p.stack.slice(0, 2).join(' · ')]
          .filter(Boolean)
          .join(' · '),
        badge: 'PROJ',
        copyLabel: 'project name',
        copyValue: p.name,
        hidden: false,
      }));
    }
    const scoped = S.palette.kind === 'all' ? query : query + ' type:' + S.palette.kind;
    return Q.search(S.index, scoped, { limit: 30 }).results;
  }

  function renderPalette() {
    if (!S.palette.open) return;
    const host = $('#palette-results');
    const scope = document.querySelector('[data-palette-scope]');
    const labels = {
      all: 'All',
      project: 'Projects',
      account: 'Accounts',
      accountfield: 'Credentials',
      envvar: 'Env',
      entry: 'Notes',
      link: 'Links',
      service: 'Services',
    };
    if (scope) scope.textContent = labels[S.palette.kind] || 'All';
    const items = paletteItems();
    S.palette.results = items;
    if (!items.length) {
      host.innerHTML =
        '<div class="palette-empty">Nothing matches “' +
        D.esc(S.palette.query) +
        '”.<br />Try a project name, an email, or <span class="mono">type:env</span>.</div>';
      return;
    }
    const tokens = Q.parseQuery(S.palette.query).tokens;
    const active = Math.max(0, Math.min(S.palette.active, items.length - 1));
    S.palette.active = active;
    host.innerHTML =
      '<div class="group-label">' +
      (S.palette.query ? 'Results' : 'Recent projects') +
      '</div>' +
      items
        .map(
          (item, index) =>
            '<button class="result ' +
            (index === active ? 'selected' : '') +
            '" data-action="palette-pick" data-index="' +
            index +
            '" data-result>' +
            '<span class="result-badge kind-' +
            item.kind +
            '">' +
            D.esc(item.badge) +
            '</span>' +
            '<span class="result-main"><span class="result-title">' +
            D.highlight(item.title, tokens) +
            '</span><span class="result-sub">' +
            D.esc(item.subtitle || '') +
            '</span></span>' +
            '<span class="result-hint">⌘↵ ' +
            D.esc(item.copyLabel || 'copy') +
            '</span></button>'
        )
        .join('');
  }

  function paletteKey(event) {
    const count = S.palette.results.length;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (count) {
        S.palette.active = (S.palette.active + 1) % count;
        renderPalette();
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (count) {
        S.palette.active = (S.palette.active - 1 + count) % count;
        renderPalette();
      }
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const order = ['all', 'project', 'account', 'accountfield', 'envvar', 'entry', 'link', 'service'];
      const index = order.indexOf(S.palette.kind);
      S.palette.kind = order[(index + 1) % order.length];
      S.palette.active = 0;
      renderPalette();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = S.palette.results[S.palette.active];
      if (!item) return;
      if (event.metaKey || event.ctrlKey) {
        copy(item.copyValue, item.copyLabel, item.hidden);
        closePalette();
      } else {
        activatePaletteItem(item);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    }
  }

  function activatePaletteItem(item) {
    closePalette();
    if (item.kind === 'project') {
      openProject(item.projectId || item.id, 'overview');
      return;
    }
    openProject(item.projectId, TAB_KINDS[item.kind] || 'overview');
  }

  function openProject(id, tab) {
    if (!id) return;
    S.selectedId = id;
    S.tab = tab || 'overview';
    S.envId = null;
    S.editingTitle = false;
    S.editingVar = null;
    S.capture = { text: '', envName: '' };
    renderSidebar();
    renderList();
    renderDetail();
    api.dispatch({ type: 'project.recent', payload: { id } });
  }

  // ------------------------------------------------------------------ modals

  function openModal(type, data) {
    S.modal = { type, data: data || {} };
    renderModal();
    const host = $('#modal');
    host.classList.remove('hidden');
    setTimeout(() => {
      const focus = host.querySelector('[autofocus], input:not([type="checkbox"]), textarea, select');
      if (focus) focus.focus();
      if (focus && focus.select && focus.tagName === 'INPUT') focus.select();
    }, 30);
  }

  function closeModal() {
    S.modal = null;
    S.mergeDraft = null;
    S.folderTarget = null;
    if (S.importTimer) {
      clearTimeout(S.importTimer);
      S.importTimer = null;
    }
    $('#modal').classList.add('hidden');
    $('#modal').innerHTML = '';
  }

  function sheet(title, sub, body, footer, wide) {
    return (
      '<div class="sheet ' +
      (wide ? 'wide' : '') +
      '">' +
      '<div class="sheet-head"><div><div class="sheet-title">' +
      D.esc(title) +
      '</div>' +
      (sub ? '<div class="sheet-sub">' + D.esc(sub) + '</div>' : '') +
      '</div><button class="icon-btn" data-action="close-modal">' +
      D.icon('x') +
      '</button></div>' +
      '<div class="sheet-body">' +
      body +
      '</div>' +
      (footer ? '<div class="sheet-foot">' + footer + '</div>' : '') +
      '</div>'
    );
  }

  function renderModal() {
    const host = $('#modal');
    if (!S.modal) {
      host.classList.add('hidden');
      host.innerHTML = '';
      return;
    }
    const previousBody = host.querySelector('.sheet-body');
    const scrollTop = previousBody ? previousBody.scrollTop : 0;
    const html = modalHTML(S.modal.type, S.modal.data);
    host.innerHTML = html || sheet('napkin++', 'Something went sideways.', '<div class="hint">Unknown dialog.</div>', '');
    const body = host.querySelector('.sheet-body');
    if (body) body.scrollTop = scrollTop;
  }

  function modalHTML(type, data) {
    if (type === 'new-project') return modalNewProject();
    if (type === 'project-details') return modalProjectDetails(data);
    if (type === 'rename') return modalRename(data);
    if (type === 'merge-projects') return modalMergeProjects(data);
    if (type === 'folder') return modalFolder(data);
    if (type === 'merge') return modalMerge(data);
    if (type === 'account') return modalAccount(data);
    if (type === 'entry') return modalEntry(data);
    if (type === 'link') return modalLink(data);
    if (type === 'service') return modalService(data);
    if (type === 'paste-accounts') return modalPasteAccounts();
    if (type === 'paste-env') return modalPasteEnv(data);
    if (type === 'add-env') return modalAddEnv();
    if (type === 'import') return modalImport(data);
    if (type === 'duplicates') return modalDuplicates();
    if (type === 'settings') return modalSettings();
    if (type === 'shortcuts') return modalShortcuts();
    if (type === 'detect') return modalDetect(data);
    if (type === 'feedback') return modalFeedback();
    if (type === 'about') return modalAbout();
    if (type === 'confirm-delete') return modalConfirmDelete(data);
    return '';
  }

  function modalNewProject() {
    return sheet(
      'New project',
      'A name is enough. Details can come later — that is the point of a napkin.',
      '<form data-form="new-project" id="modal-form">' +
        '<div class="form-field"><label>Name</label><input class="input" name="name" autofocus placeholder="lu app" /></div>' +
        '<div class="form-field"><label>Description</label><input class="input" name="description" placeholder="optional" /></div>' +
        '<div class="form-field"><label>Tags</label><input class="input" name="tags" placeholder="client, dev" /><div class="hint">Comma separated.</div></div>' +
        '</form>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-modal" data-form="new-project">Create project</button>'
    );
  }

  function modalProjectDetails(data) {
    const project = projectById(data.id) || currentProject();
    if (!project) return '';
    const folder = folderOf(project);
    return sheet(
      'Project details',
      'Name, folder, tags and stack. Aliases feed search and quick capture.',
      '<form data-form="project-details" id="modal-form" data-id="' +
        project.id +
        '">' +
        '<div class="form-grid">' +
        '<div class="form-field"><label>Name</label><input class="input" name="name" autofocus value="' +
        D.esc(project.name) +
        '" /></div>' +
        '<div class="form-field"><label>Folder</label><select class="select" name="folderId">' +
        '<option value="">No folder</option>' +
        folders()
          .map(
            (f) =>
              '<option value="' +
              f.id +
              '"' +
              (project.folderId === f.id ? ' selected' : '') +
              '>' +
              D.esc(f.name) +
              '</option>'
          )
          .join('') +
        '</select></div></div>' +
        '<div class="form-field"><label>Description</label><input class="input" name="description" value="' +
        D.esc(project.description) +
        '" placeholder="optional" /></div>' +
        '<div class="form-grid">' +
        '<div class="form-field"><label>Status</label><select class="select" name="status">' +
        M.STATUSES.map(
          (s) =>
            '<option value="' +
            s +
            '"' +
            (project.status === s ? ' selected' : '') +
            '>' +
            s +
            '</option>'
        ).join('') +
        '</select></div>' +
        '<div class="form-field"><label>Tags</label><input class="input" name="tags" value="' +
        D.esc(project.tags.join(', ')) +
        '" placeholder="client, dev" /></div></div>' +
        '<div class="form-field"><label>Stack</label><input class="input" name="stack" value="' +
        D.esc(project.stack.join(', ')) +
        '" placeholder="Next.js, Supabase" /></div>' +
        '<div class="form-field"><label>Aliases</label><input class="input" name="aliases" value="' +
        D.esc(project.aliases.join(', ')) +
        '" placeholder="lu, lu-app" /><div class="hint">Comma separated. Folder: ' +
        D.esc(folder ? folder.name : 'none') +
        '.</div></div>' +
        '</form>',
      '<button class="btn sm ghost" data-action="open-merge">Merge with…</button>' +
        '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-modal" data-form="project-details">Save details</button>'
    );
  }

  function modalRename(data) {
    const project = projectById(data.id);
    if (!project) return '';
    return sheet(
      'Rename project',
      'The old name stays as an alias, so search still finds it.',
      '<form data-form="rename" id="modal-form" data-id="' +
        project.id +
        '"><div class="form-field"><label>Name</label><input class="input" name="name" autofocus value="' +
        D.esc(project.name) +
        '" /></div></form>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-modal" data-form="rename">Rename</button>'
    );
  }

  function mergeDraftFor(data) {
    const seed = data.project || (data.id ? projectById(data.id) : currentProject());
    const pool = S.vault.projects;
    const keep = seed || pool[0] || null;
    const sources = (data.sourceIds || []).filter((id) => keep && id !== keep.id);
    return { keepId: keep ? keep.id : '', sourceIds: sources, name: keep ? keep.name : '' };
  }

  function mergeNameValue(draft) {
    const keep = projectById(draft.keepId);
    return draft.name || (keep ? keep.name : '');
  }

  function mergeNameChips(keepId, sourceIds) {
    const ids = [keepId, ...(sourceIds || [])].filter(Boolean);
    return ids
      .map((id) => projectById(id))
      .filter(Boolean)
      .map(
        (p) =>
          '<button type="button" class="chip clickable" data-action="merge-use-name" data-name="' +
          D.esc(p.name) +
          '">' +
          D.esc(p.name) +
          '</button>'
      )
      .join('');
  }

  function modalMergeProjects(data) {
    const draft = S.mergeDraft || mergeDraftFor(data);
    S.mergeDraft = draft;
    const rows = S.vault.projects
      .map((project) => {
        const isKeep = project.id === draft.keepId;
        const vars = project.envs.reduce((n, env) => n + env.vars.length, 0);
        return (
          '<div class="merge-pick ' +
          (isKeep ? 'keep' : '') +
          '" data-merge-row="' +
          project.id +
          '"><label class="merge-flag" title="Keep this project"><input type="radio" name="keep" value="' +
          project.id +
          '" data-merge-keep ' +
          (isKeep ? 'checked' : '') +
          ' /><span>keep</span></label>' +
          '<label class="merge-flag" title="Merge into the kept project"><input type="checkbox" name="source" value="' +
          project.id +
          '" data-merge-source ' +
          (draft.sourceIds.includes(project.id) ? 'checked' : '') +
          ' ' +
          (isKeep ? 'disabled' : '') +
          ' /><span>merge</span></label>' +
          '<span class="merge-pick-name">' +
          D.esc(project.name) +
          '</span><span class="merge-pick-meta">' +
          project.accounts.length +
          ' acct · ' +
          vars +
          ' vars · ' +
          project.entries.length +
          ' notes</span></div>'
        );
      })
      .join('');
    return sheet(
      'Merge projects',
      'Pick the one to keep, tick the ones to absorb, then choose the name. Links, vars, accounts and notes union; the kept project keeps its id.',
      '<form data-form="merge-projects" id="modal-form">' +
        '<div class="merge-grid-head"><span>Keep</span><span>Merge</span><span>Project</span><span></span></div>' +
        '<div class="merge-pick-list">' +
        rows +
        '</div>' +
        '<div class="form-field" style="margin-top:12px"><label>Name after merging</label><input class="input" name="mergeName" value="' +
        D.esc(mergeNameValue(draft)) +
        '" /><div class="merge-chips" id="merge-name-chips">' +
        mergeNameChips(draft.keepId, draft.sourceIds) +
        '</div><div class="hint">Click a name to use it. Old names become aliases. Duplicate env keys keep the surviving project’s value.</div></div>' +
        '</form>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-modal" data-form="merge-projects">Merge</button>'
    );
  }

  function syncMergeRows(updateName) {
    const form = document.getElementById('modal-form');
    if (!form) return;
    const keep = form.querySelector('[data-merge-keep]:checked');
    const keepId = keep ? keep.value : '';
    $$('[data-merge-source]', form).forEach((box) => {
      const isKeep = box.value === keepId;
      box.disabled = isKeep;
      if (isKeep) box.checked = false;
      const row = box.closest('.merge-pick');
      if (row) row.classList.toggle('keep', isKeep);
    });
    const sourceIds = $$('[data-merge-source]:checked', form).map((el) => el.value);
    if (updateName) {
      const nameInput = form.querySelector('[name="mergeName"]');
      const oldKeep = S.mergeDraft ? projectById(S.mergeDraft.keepId) : null;
      const newKeep = projectById(keepId);
      if (
        nameInput &&
        newKeep &&
        (!nameInput.value.trim() || (oldKeep && nameInput.value === oldKeep.name))
      ) {
        nameInput.value = newKeep.name;
      }
    }
    if (S.mergeDraft) {
      S.mergeDraft.keepId = keepId;
      S.mergeDraft.sourceIds = sourceIds;
    }
    const chips = $('#merge-name-chips');
    if (chips) chips.innerHTML = mergeNameChips(keepId, sourceIds);
  }

  function modalFolder(data) {
    const folder = data.folder || null;
    const color = hexOrDefault((folder && folder.color) || data.color, M.FOLDER_COLORS[0]);
    return sheet(
      folder ? 'Edit folder' : 'New folder',
      'Folders group projects; the colour is the left border in the project list.',
      '<form data-form="folder" id="modal-form" data-id="' +
        (folder ? folder.id : '') +
        '">' +
        '<div class="form-field"><label>Name</label><input class="input" name="name" autofocus value="' +
        D.esc(folder ? folder.name : '') +
        '" placeholder="Clients" /></div>' +
        '<div class="form-field"><label>Colour</label><div class="swatches folder-swatches">' +
        M.FOLDER_COLORS.map(
          (c) =>
            '<button type="button" class="swatch ' +
            (c === color ? 'active' : '') +
            '" style="--sw:' +
            c +
            '" data-action="pick-folder-color" data-color="' +
            c +
            '" aria-label="' +
            c +
            '"></button>'
        ).join('') +
        '</div><input type="hidden" name="color" value="' +
        color +
        '" /></div>' +
        (folder
          ? '<div class="hint">Deleting the folder keeps its projects — they just lose the folder.</div>'
          : '') +
        '</form>',
      (folder
        ? '<button class="btn sm danger" data-action="delete-folder" data-id="' + folder.id + '">Delete</button>'
        : '') +
        '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-modal" data-form="folder">' +
        (folder ? 'Save folder' : 'Create folder') +
        '</button>'
    );
  }

  function hexOrDefault(value, fallback) {
    return M.hexColor(value) || fallback;
  }

  function modalMerge(data) {    const pending = data.pending || {};
    const candidates = data.candidates || [];
    const list = candidates
      .map(
        (candidate) =>
          '<div class="merge-card"><div class="merge-top"><span class="avatar">' +
          D.esc(D.initials(candidate.project.name)) +
          '</span><span class="merge-name">' +
          D.esc(candidate.project.name) +
          '</span><span class="merge-score">' +
          Math.round(candidate.score * 100) +
          '%</span></div><div class="merge-reasons">' +
          candidate.reasons.map((r) => '<span class="chip">' + D.esc(r) + '</span>').join('') +
          '<span class="chip mono">' +
          candidate.project.accounts.length +
          ' acct · ' +
          candidate.project.envs.reduce((n, e) => n + e.vars.length, 0) +
          ' vars</span></div>' +
          '<div class="merge-actions">' +
          '<button class="btn sm primary" data-action="merge-into" data-id="' +
          candidate.project.id +
          '">Merge “' +
          D.esc(pending.name || '') +
          '” into this</button>' +
          '<button class="btn sm" data-action="open-existing" data-id="' +
          candidate.project.id +
          '">Open it</button></div></div>'
      )
      .join('');
    return sheet(
      'Already on the napkin?',
      '“' + (pending.name || '') + '” looks close to something you already have.',
      '<div class="merge-list">' +
        list +
        '</div><div class="hint" style="margin-top:10px">Merging adds the new name as an alias and opens the existing project — nothing is overwritten.</div>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn" data-action="create-anyway">Keep separate</button>'
    );
  }

  function fieldRow(field) {
    return (
      '<div class="field-row" data-field-row>' +
      '<input type="text" data-field-label placeholder="Label" value="' +
      D.esc(field.label || '') +
      '" />' +
      '<input type="text" data-field-value placeholder="Value" value="' +
      D.esc(field.value || '') +
      '" />' +
      '<label class="hint" style="margin:0;display:flex;gap:4px;align-items:center"><input type="checkbox" data-field-hidden ' +
      (field.hidden ? 'checked' : '') +
      ' /> mask</label>' +
      '<button type="button" class="mini-btn" data-action="remove-field">' +
      D.icon('x') +
      '</button></div>'
    );
  }

  function modalAccount(data) {
    const account = data.account || null;
    const fields =
      account && account.fields.length
        ? account.fields
        : [{ label: 'Password', value: '', hidden: true }];
    return sheet(
      account ? 'Edit account' : 'Add account',
      'One project can hold many accounts — dev/prod, test users, clients.',
      '<form data-form="account" id="modal-form" data-id="' +
        (account ? account.id : '') +
        '">' +
        '<div class="form-grid">' +
        '<div class="form-field"><label>Label</label><input class="input" name="label" autofocus value="' +
        D.esc(account ? account.label : '') +
        '" placeholder="test-1" /></div>' +
        '<div class="form-field"><label>Environment</label><input class="input" name="env" value="' +
        D.esc(account ? account.env : '') +
        '" placeholder="dev / prod / test" /></div>' +
        '</div>' +
        '<div class="form-field"><label>Email</label><input class="input" name="email" value="' +
        D.esc(account ? account.email : '') +
        '" placeholder="you@example.com" /></div>' +
        '<div class="form-grid">' +
        '<div class="form-field"><label>Username</label><input class="input" name="username" value="' +
        D.esc(account ? account.username : '') +
        '" /></div>' +
        '<div class="form-field"><label>Service</label><input class="input" name="service" value="' +
        D.esc(account ? account.service : '') +
        '" placeholder="Clerk / GitHub" /></div>' +
        '</div>' +
        '<div class="form-field"><label>Fields</label><div class="field-editor" id="field-editor">' +
        fields.map(fieldRow).join('') +
        '</div><button type="button" class="btn sm ghost" data-action="add-field">+ Add field</button>' +
        '<div class="hint">Password, PIN, API token, recovery code — anything this login needs.</div></div>' +
        '<div class="form-field"><label>Notes</label><input class="input" name="notes" value="' +
        D.esc(account ? account.notes : '') +
        '" /></div>' +
        '</form>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-modal" data-form="account">' +
        (account ? 'Save account' : 'Add account') +
        '</button>'
    );
  }

  function modalEntry(data) {
    const entry = data.entry || null;
    return sheet(
      entry ? 'Edit entry' : 'Add entry',
      'Pasted code keeps its line numbers and folding.',
      '<form data-form="entry" id="modal-form" data-id="' +
        (entry ? entry.id : '') +
        '">' +
        '<div class="form-grid">' +
        '<div class="form-field"><label>Type</label><select class="select" name="type">' +
        ['note', 'snippet', 'command', 'secret', 'recovery', 'instruction']
          .map(
            (t) =>
              '<option value="' +
              t +
              '"' +
              (entry && entry.type === t ? ' selected' : '') +
              '>' +
              t +
              '</option>'
          )
          .join('') +
        '</select></div>' +
        '<div class="form-field"><label>Language</label><input class="input" name="language" value="' +
        D.esc(entry ? entry.language : '') +
        '" placeholder="ts, sql, sh" /></div>' +
        '</div>' +
        '<div class="form-field"><label>Title</label><input class="input" name="title" value="' +
        D.esc(entry ? entry.title : '') +
        '" placeholder="optional — first line is used" /></div>' +
        '<div class="form-field"><label>Body</label><textarea class="textarea" name="body" style="min-height:170px">' +
        D.esc(entry ? entry.body : '') +
        '</textarea></div>' +
        '</form>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-modal" data-form="entry">Save</button>'
    );
  }

  function modalLink(data) {
    const link = data.link || null;
    const kinds = ['repo', 'live', 'staging', 'docs', 'dashboard', 'other'];
    return sheet(
      link ? 'Edit link' : 'Add link',
      'Repo, live site, staging, docs or a dashboard.',
      '<form data-form="link" id="modal-form" data-id="' +
        (link ? link.id : '') +
        '">' +
        '<div class="form-grid">' +
        '<div class="form-field"><label>Label</label><input class="input" name="label" autofocus value="' +
        D.esc(link ? link.label : '') +
        '" placeholder="Repo" /></div>' +
        '<div class="form-field"><label>Kind</label><select class="select" name="kind">' +
        kinds
          .map((k) => '<option value="' + k + '"' + (link && link.kind === k ? ' selected' : '') + '>' + k + '</option>')
          .join('') +
        '</select></div></div>' +
        '<div class="form-field"><label>URL</label><input class="input" name="url" value="' +
        D.esc(link ? link.url : '') +
        '" placeholder="https://github.com/acme/lu" /></div>' +
        '</form>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-modal" data-form="link">Save link</button>'
    );
  }

  function modalService(data) {
    const service = data.service || null;
    return sheet(
      service ? 'Edit service' : 'Add service',
      'The moving parts of this project.',
      '<form data-form="service" id="modal-form" data-id="' +
        (service ? service.id : '') +
        '">' +
        '<div class="form-grid">' +
        '<div class="form-field"><label>Provider</label><input class="input" name="provider" autofocus value="' +
        D.esc(service ? service.provider : '') +
        '" placeholder="Vercel" /></div>' +
        '<div class="form-field"><label>Role</label><input class="input" name="role" value="' +
        D.esc(service ? service.role : '') +
        '" placeholder="hosting / database / email" /></div></div>' +
        '<div class="form-field"><label>Dashboard URL</label><input class="input" name="url" value="' +
        D.esc(service ? service.url : '') +
        '" placeholder="https://vercel.com/acme/lu" /></div>' +
        '<div class="form-field"><label>Notes</label><input class="input" name="notes" value="' +
        D.esc(service ? service.notes : '') +
        '" placeholder="free tier, region, etc." /></div>' +
        '</form>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-modal" data-form="service">Save service</button>'
    );
  }

  function modalPasteAccounts() {
    return sheet(
      'Paste accounts',
      'One per line: label, email, password, notes. Messy is fine — it is parsed.',
      '<form data-form="paste-accounts" id="modal-form">' +
        '<div class="form-field"><textarea class="textarea" name="blob" autofocus placeholder="prod: hello@lu.app : hunter2&#10;test-2 | two@lu.app | s3cret!"></textarea>' +
        '<div class="hint" data-paste-preview>Waiting for text…</div></div>' +
        '</form>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-modal" data-form="paste-accounts">Add accounts</button>'
    );
  }

  function modalPasteEnv(data) {
    return sheet(
      'Paste .env',
      'KEY=value lines, exports and quotes are handled.',
      '<form data-form="paste-env" id="modal-form">' +
        '<div class="form-field"><label>Environment</label><input class="input" name="env" value="' +
        D.esc(data.envName || 'dev') +
        '" /></div>' +
        '<div class="form-field"><textarea class="textarea" name="blob" autofocus placeholder="APP_NAME=lu&#10;DATABASE_URL=postgres://…"></textarea>' +
        '<div class="hint" data-paste-preview>Waiting for text…</div></div>' +
        '</form>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-modal" data-form="paste-env">Add variables</button>'
    );
  }

  function modalAddEnv() {
    return sheet(
      'Add environment',
      'dev, staging, production, or something else.',
      '<form data-form="add-env" id="modal-form">' +
        '<div class="form-field"><label>Name</label><input class="input" name="name" autofocus placeholder="staging" /></div>' +
        '<div class="form-field"><label>URL</label><input class="input" name="url" placeholder="https://staging.lu.app" /></div>' +
        '</form>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-modal" data-form="add-env">Add environment</button>'
    );
  }

  function modalImport(data) {
    const blocks = S.importBlocks || [];
    const value = data.text || '';
    const preview = S.importSingle
      ? singleImportCard(singleImportName(value), value)
      : blocks.length
        ? importRows(blocks)
        : '';
    return sheet(
      'Import notes',
      'Paste the old text file (or choose it). napkin++ splits on dividers, headings and blank blocks — or keeps the whole thing as one project.',
      '<form data-form="import" id="modal-form">' +
        '<div class="form-field"><textarea class="textarea" name="blob" style="min-height:130px" placeholder="Paste a whole notes file here…">' +
        D.esc(value) +
        '</textarea>' +
        '<div class="hint"><button type="button" class="btn sm ghost" data-action="pick-file">Choose a file…</button> ' +
        '<button type="button" class="btn sm" data-action="preview-import">Preview split</button></div>' +
        '<label class="hint" style="display:flex;align-items:center;gap:6px;margin-top:8px"><input type="checkbox" name="single" id="import-single"' +
        (S.importSingle ? ' checked' : '') +
        ' /> Import the whole file as one project</label>' +
        '<div class="hint" data-import-count style="margin-top:2px">' +
        (S.importSingle ? 'one project' : blocks.length ? blocks.length + ' blocks' : '') +
        '</div></div>' +
        '<div id="import-preview">' +
        preview +
        '</div></form>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-modal" data-form="import">Import selected</button>'
    );
  }

  function singleImportName(value) {
    if (S.importName) return S.importName;
    const blocks = P.splitBlob(value || '', '');
    return (blocks[0] && blocks[0].name) || 'Imported note';
  }

  function singleImportCard(name, value) {
    const lineCount = value.trim() ? value.split(/\r?\n/).length : 0;
    return (
      '<div class="merge-card"><div class="merge-top"><span class="merge-name">One project</span>' +
      '<span class="merge-score">' +
      lineCount +
      ' lines</span></div><div class="merge-reasons"><span class="chip">whole file</span>' +
      '<span class="chip">env, links and accounts still detected</span></div>' +
      '<div class="form-field" style="margin:10px 0 0"><label>Project name</label>' +
      '<input class="input" id="import-single-name" value="' +
      D.esc(name) +
      '" /></div>' +
      '<div class="hint">Everything goes into one project as a note, with detected env vars, links and accounts alongside.</div></div>'
    );
  }

  function importRows(blocks) {
    return (
      '<div class="import-list">' +
      blocks
        .map((b, i) => {
          const hints = b.hints || {};
          return (
            '<div class="import-row" data-import-row data-index="' +
            i +
            '"><input type="checkbox" checked data-import-check />' +
            '<input type="text" value="' +
            D.esc(b.name) +
            '" data-import-name />' +
            '<span class="import-meta">' +
            (b.body ? b.body.split(/\r?\n/).length : 0) +
            ' lines · ' +
            (hints.envPairs || 0) +
            ' vars · ' +
            (hints.accounts || 0) +
            ' acct · ' +
            (hints.links || 0) +
            ' links</span></div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function modalDuplicates() {
    const pairs = S.dupPairs || [];
    return sheet(
      'Likely duplicates',
      'Projects that look like the same thing. Merging unions links, services, env vars, accounts and notes.',
      pairs.length
        ? '<div class="merge-list">' +
          pairs
            .map(
              (pair, i) =>
                '<div class="merge-card"><div class="merge-top"><span class="merge-name">' +
                D.esc(pair.a.name) +
                '</span><span class="dim">↔</span><span class="merge-name">' +
                D.esc(pair.b.name) +
                '</span><span class="merge-score">' +
                Math.round(pair.score * 100) +
                '%</span></div><div class="merge-reasons">' +
                pair.reasons.map((r) => '<span class="chip">' + D.esc(r) + '</span>').join('') +
                '</div><div class="merge-actions"><button class="btn sm primary" data-action="merge-pair-pick" data-index="' +
                i +
                '">Review merge…</button><button class="btn sm" data-action="open-existing" data-id="' +
                pair.a.id +
                '">Open first</button></div></div>'
            )
            .join('') +
          '</div>'
        : '<div class="hint">No likely duplicates. That is a good sign.</div>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Done</button>'
    );
  }

  function modalSettings() {
    const settings = S.vault.settings;
    const theme = settings.theme;
    const palette = settings.palette || 'paper';
    const accent = settings.accent || 'ember';
    const accentCustom = settings.accentCustom || '#b2531f';
    const iconStyle = settings.iconStyle || 'napkin';
    const iconTint = settings.iconTint || 'auto';
    const accentColor = accent === 'custom' ? accentCustom : ACCENT_HEX[accent] || ACCENT_HEX.ember;
    const resolvedTint =
      iconTint === 'auto'
        ? accent === 'custom'
          ? M.nearestIconTint(accentCustom)
          : M.ICON_TINTS.includes(accent)
            ? accent
            : 'paper'
        : iconTint;
    const menuBar = settings.menuBar !== false;
    const previews = settings.previews !== false;
    const detectOnAdd = settings.detectOnAdd !== false;
    const checkUpdates = settings.checkUpdates !== false;
    const githubToken = settings.githubToken || '';
    const login = (S.meta && S.meta.login) || { supported: false, openAtLogin: false };
    const accents = [
      ['ember', 'Ember', ACCENT_HEX.ember],
      ['moss', 'Moss', ACCENT_HEX.moss],
      ['ink', 'Harbor', ACCENT_HEX.ink],
      ['plum', 'Plum', ACCENT_HEX.plum],
    ];
    const icons = [
      ['napkin', 'Paper'],
      ['ink', 'Ink'],
      ['grid', 'Grid'],
      ['classic', 'Classic'],
    ];
    const tints = [
      ['auto', 'Auto'],
      ['paper', 'Paper'],
      ['ember', 'Ember'],
      ['moss', 'Moss'],
      ['ink', 'Ink'],
      ['plum', 'Plum'],
      ['graphite', 'Graphite'],
    ];
    return sheet(
      'Settings',
      'Everything stays on this Mac.',
      '<form data-form="settings" id="modal-form">' +
        '<div class="settings-row"><div class="grow"><div class="settings-label">Appearance</div><div class="settings-sub">System follows macOS. Each palette has a light and a dark version.</div></div>' +
        '<div class="seg">' +
        ['system', 'light', 'dark']
          .map(
            (t) =>
              '<button type="button" class="' +
              (theme === t ? 'active' : '') +
              '" data-action="set-theme" data-theme="' +
              t +
              '">' +
              t +
              '</button>'
          )
          .join('') +
        '</div></div>' +
        '<div class="settings-block"><div class="settings-label">Palette</div>' +
        '<div class="settings-sub">The paper stock. Light and dark are both included.</div>' +
        '<div class="palette-grid">' +
        PALETTE_META.map(
          ([id, label, light, dark]) =>
            '<button type="button" class="palette-card ' +
            (palette === id ? 'active' : '') +
            '" data-action="set-palette" data-palette="' +
            id +
            '" title="' +
            label +
            '"><span class="palette-strip"><span class="pal-half" style="background:' +
            light[0] +
            '"><i style="background:' +
            light[1] +
            '"></i><b style="background:' +
            light[2] +
            '"></b></span><span class="pal-half dark" style="background:' +
            dark[0] +
            '"><i style="background:' +
            dark[1] +
            '"></i><b style="background:' +
            dark[2] +
            '"></b></span></span><span class="palette-name">' +
            label +
            '</span></button>'
        ).join('') +
        '</div></div>' +
        '<div class="settings-block"><div class="settings-label">Accent</div>' +
        '<div class="settings-sub">Buttons, selections and highlights — preset or any colour.</div>' +
        '<div class="accent-row"><div class="swatches">' +
        accents
          .map(
            ([id, label, color]) =>
              '<button type="button" class="swatch ' +
              (accent === id ? 'active' : '') +
              '" style="--sw:' +
              color +
              '" data-action="set-accent" data-accent="' +
              id +
              '" title="' +
              label +
              '" aria-label="' +
              label +
              '"></button>'
          )
          .join('') +
        '<button type="button" class="swatch custom ' +
        (accent === 'custom' ? 'active' : '') +
        '" style="--sw:' +
        accentCustom +
        '" data-action="set-accent" data-accent="custom" title="Custom accent" aria-label="Custom accent"></button>' +
        '</div>' +
        '<label class="color-pick" title="Pick a custom accent"><input type="color" data-custom-accent value="' +
        accentCustom +
        '" /><span class="mono">' +
        accentCustom +
        '</span></label></div></div>' +
        '<div class="settings-block"><div class="settings-label">Dock icon</div>' +
        '<div class="settings-sub">The form, then the colourway. Auto follows the accent. The sheet sits at a slight angle.</div>' +
        '<div class="icon-grid">' +
        icons
          .map(
            ([id, label]) =>
              '<button type="button" class="icon-choice ' +
              (iconStyle === id ? 'active' : '') +
              '" data-action="set-icon" data-icon="' +
              id +
              '"><img src="assets/icons/' +
              id +
              '--' +
              resolvedTint +
              '@128.png" alt="" /><span>' +
              label +
              '</span></button>'
          )
          .join('') +
        '</div>' +
        '<div class="tint-row">' +
        tints
          .map(
            ([id, label]) =>
              '<button type="button" class="tint-choice ' +
              (iconTint === id ? 'active' : '') +
              '" data-action="set-icon-tint" data-tint="' +
              id +
              '"><span class="tint-dot" style="--sw:' +
              (id === 'auto' ? accentColor : M.ICON_TINT_COLORS[id] || accentColor) +
              '"></span>' +
              label +
              '</button>'
          )
          .join('') +
        '</div><div class="hint">Preview: ' +
        D.esc(resolvedTint) +
        ' colourway.</div></div>' +
        '<div class="settings-row"><div class="grow"><div class="settings-label">Menu bar icon</div><div class="settings-sub">Quick capture, search and settings without hunting for the window.</div></div>' +
        '<button type="button" class="switch ' +
        (menuBar ? 'on' : '') +
        '" data-action="toggle-menubar" role="switch" aria-checked="' +
        (menuBar ? 'true' : 'false') +
        '"><span></span></button></div>' +
        '<div class="settings-row"><div class="grow"><div class="settings-label">Open at login</div><div class="settings-sub">' +
        (login.supported
          ? 'Starts hidden in the menu bar when you log in.'
          : 'Available in the packaged app — build it with npm run package.') +
        '</div></div>' +
        '<button type="button" class="switch ' +
        (login.openAtLogin ? 'on' : '') +
        '" data-action="toggle-login" role="switch" aria-checked="' +
        (login.openAtLogin ? 'true' : 'false') +
        '"' +
        (login.supported ? '' : ' disabled') +
        '><span></span></button></div>' +
        '<div class="settings-row"><div class="grow"><div class="settings-label">Project previews</div><div class="settings-sub">Fetch the social preview image from a live site or repo. Shown in the list and the grid.</div></div>' +
        '<button type="button" class="switch ' +
        (previews ? 'on' : '') +
        '" data-action="toggle-previews" role="switch" aria-checked="' +
        (previews ? 'true' : 'false') +
        '"><span></span></button></div>' +
        '<div class="settings-row"><div class="grow"><div class="settings-label">Detect details from links</div><div class="settings-sub">Suggests stack, hosting, database and auth after you add a live or repo link. Nothing is saved until you tick it.</div></div>' +
        '<button type="button" class="switch ' +
        (detectOnAdd ? 'on' : '') +
        '" data-action="toggle-detect" role="switch" aria-checked="' +
        (detectOnAdd ? 'true' : 'false') +
        '"><span></span></button></div>' +
        '<div class="settings-row"><div class="grow"><div class="settings-label">Check for updates</div><div class="settings-sub">Once a day, against GitHub Releases. No account, no identifier.</div></div>' +
        '<button type="button" class="switch ' +
        (checkUpdates ? 'on' : '') +
        '" data-action="toggle-updates" role="switch" aria-checked="' +
        (checkUpdates ? 'true' : 'false') +
        '"><span></span></button></div>' +
        '<div class="settings-row"><div class="grow"><div class="settings-label">GitHub token</div><div class="settings-sub">Optional. Raises the API limit when reading repos for detection. Stays in the local vault.</div></div>' +
        '<input class="input" style="width:220px" type="password" name="githubToken" value="' +
        D.esc(githubToken) +
        '" placeholder="ghp_…" spellcheck="false" autocomplete="off" /></div>' +
        '<div class="settings-row"><button class="btn sm" data-action="capture-all-previews">Capture previews</button>' +
        '<button class="btn sm ghost" data-action="clear-previews">Clear cached previews</button>' +
        '<span class="spacer"></span><button class="btn sm ghost" data-action="about">About &amp; updates</button>' +
        '<button class="btn sm ghost" data-action="open-feedback">Feedback</button></div>' +
        '<div class="settings-row"><div class="grow"><div class="settings-label">Clipboard timeout</div><div class="settings-sub">Clear copied secrets after this many seconds (0 = never).</div></div>' +
        '<input class="input" style="width:76px" type="number" min="0" max="600" name="seconds" value="' +
        S.vault.settings.copyClearSeconds +
        '" /></div>' +
        '<div class="settings-row"><div class="grow"><div class="settings-label">Summon shortcut</div><div class="settings-sub">' +
        D.esc(shortcutLabel(S.meta && S.meta.shortcut)) +
        ' opens quick capture from anywhere.</div></div><span class="chip mono">' +
        D.esc(shortcutLabel(S.meta && S.meta.shortcut)) +
        '</span></div>' +
        '<div class="settings-row" style="align-items:flex-start"><div class="grow"><div class="settings-label">Vault file</div>' +
        '<div class="path-box" style="margin-top:6px">' +
        D.esc(S.meta ? S.meta.path : '') +
        '</div><div class="settings-sub" style="margin-top:5px">Plain JSON, backed up daily and before each save. ' +
        (S.meta ? Math.round(S.meta.bytes / 1024) + ' KB · ' + S.meta.projects + ' projects' : '') +
        '</div></div></div>' +
        '</form>' +
        '<div class="settings-row"><button class="btn sm" data-action="reveal-vault">Reveal in Finder</button>' +
        '<button class="btn sm" data-action="backup">Back up now</button>' +
        '<button class="btn sm" data-action="export-all">Export all markdown…</button></div>',
      '<button class="btn sm ghost" data-action="reset-settings">Reset appearance</button>' +
        '<span class="spacer"></span><button class="btn primary" data-action="save-settings">Done</button>'
    );
  }

  function modalShortcuts() {
    const rows = [
      ['⌘K', 'Search everything'],
      ['⌘N', 'New project'],
      ['⌥Space', 'Quick capture (global)'],
      ['⌘⇧N', 'Quick capture (from app)'],
      ['⌘↵', 'File the project capture'],
      ['esc', 'Cancel an edit or clear the capture box'],
      ['right-click', 'Project, folder, variable and account actions'],
      ['⌘F', 'Filter the project list'],
      ['⌘⇧G', 'Switch between list and grid'],
      ['⌘1–5', 'Switch project tab'],
      ['⌘Z', 'Undo last change'],
      ['⌘↵', 'Copy the selected palette result'],
      ['⌘/', 'This sheet'],
    ];
    return sheet(
      'Keyboard shortcuts',
      'Everything is a keystroke away.',
      '<div class="shortcut-grid">' +
        rows.map(([key, label]) => '<kbd>' + D.esc(key) + '</kbd><span>' + D.esc(label) + '</span>').join('') +
        '</div>',
      '<span class="spacer"></span><button class="btn primary" data-action="close-modal">Close</button>'
    );
  }

  // ------------------------------------------------- previews & detection

  function openDetection(projectId) {
    const project = projectById(projectId);
    if (!project) return;
    if (!(project.links || []).some((link) => /^https?:/i.test(link.url))) {
      toast('Add a live site or repo link first.');
      return;
    }
    openModal('detect', { id: projectId });
    runDetection(projectId, false);
  }

  async function runDetection(projectId, force) {
    S.detections.set(projectId, { status: 'loading' });
    if (S.modal && S.modal.type === 'detect') renderModal();
    let entry;
    try {
      const res = await api.detect(projectId, Boolean(force));
      entry = res && res.ok ? { status: 'ready', res } : { status: 'error', error: (res && res.error) || 'Detection failed.' };
    } catch (error) {
      entry = { status: 'error', error: (error && error.message) || 'Detection failed.' };
    }
    S.detections.set(projectId, entry);
    if (S.modal && S.modal.type === 'detect' && S.modal.data.id === projectId) renderModal();
  }

  function detectRow(group, index, label, meta, checked) {
    return (
      '<label class="detect-item"><input type="checkbox" data-detect-item data-group="' +
      group +
      '" data-index="' +
      index +
      '"' +
      (checked ? ' checked' : '') +
      ' /><span class="detect-item-label">' +
      D.esc(label) +
      '</span>' +
      (meta ? '<span class="detect-item-meta">' + D.esc(meta) + '</span>' : '') +
      '</label>'
    );
  }

  function detectGroup(title, hint, rows) {
    if (!rows.length) return '';
    return (
      '<div class="detect-group"><div class="detect-group-head"><span class="settings-label">' +
      D.esc(title) +
      '</span><span class="dim small">' +
      rows.length +
      '</span></div>' +
      (hint ? '<div class="settings-sub">' + D.esc(hint) + '</div>' : '') +
      '<div class="detect-items">' +
      rows.join('') +
      '</div></div>'
    );
  }

  function detectFacts(res) {
    const chips = [];
    for (const item of res.hosting || []) {
      chips.push(
        '<span class="chip mono" title="' +
        D.esc(item.evidence) +
        '">' +
        D.esc(item.label) +
        ' <span class="dim">· ' +
        D.esc(item.evidence) +
        '</span></span>'
      );
    }
    for (const label of res.dns || []) chips.push('<span class="chip mono">DNS · ' + D.esc(label) + '</span>');
    for (const label of res.email || []) chips.push('<span class="chip mono">Email · ' + D.esc(label) + '</span>');
    const page = res.page || {};
    const repo = res.repo || {};
    const lines = [];
    if (page.title) lines.push('Page: ' + page.title);
    if (repo.owner) lines.push('Repo: ' + repo.owner + '/' + repo.name + (repo.language ? ' · ' + repo.language : ''));
    return (
      (chips.length ? '<div class="detect-facts">' + chips.join('') + '</div>' : '') +
      (lines.length ? '<div class="hint">' + D.esc(lines.join(' · ')) + '</div>' : '') +
      (res.warnings && res.warnings.length
        ? '<div class="detect-warn">' + res.warnings.map((warning) => D.esc(warning)).join('<br />') + '</div>'
        : '')
    );
  }

  function modalDetect(data) {
    const project = projectById(data.id);
    if (!project) return '';
    const entry = S.detections.get(data.id);
    const busy = !entry || entry.status === 'loading';
    let body = '';
    if (busy) {
      body =
        '<div class="detect-loading"><span class="spinner"></span><div><div class="settings-label">Reading the links…</div>' +
        '<div class="hint">The page, its DNS records and the repo. This takes a couple of seconds.</div></div></div>';
    } else if (entry.status === 'error') {
      body =
        '<div class="detect-error">' +
        D.esc(entry.error) +
        '</div><div class="hint">Detection needs a reachable live site or public repo link. Check the URLs in the Links tab and try again.</div>';
    } else {
      const res = entry.res;
      const proposals = res.proposals;
      const groups = [
        detectGroup(
          'Stack',
          'Frameworks, languages and tooling found in the repo or the page.',
          proposals.stack.map((item, index) => detectRow('stack', index, item.name, item.evidence, true))
        ),
        detectGroup(
          'Services',
          'Hosting, database, auth, email. Existing entries are left alone.',
          proposals.services.map((item, index) =>
            detectRow(
              'services',
              index,
              item.provider + (item.role ? ' · ' + item.role : ''),
              item.role + (item.evidence ? ' — ' + item.evidence : ''),
              true
            )
          )
        ),
        detectGroup(
          'Links',
          'The repo\u2019s own homepage, if it has one and this project does not.',
          proposals.links.map((item, index) => detectRow('links', index, item.label, item.url, true))
        ),
        detectGroup(
          'Tags',
          'Lowercase, one word. Useful for filtering and search.',
          proposals.tags.map((tag, index) => detectRow('tags', index, '#' + tag, '', true))
        ),
      ].filter(Boolean);
      const note = proposals.note
        ? '<div class="detect-group"><label class="detect-item"><input type="checkbox" data-detect-note checked /><span class="detect-item-label">Add a note describing what was detected</span></label>' +
          '<div class="detect-note-text">' +
          D.esc(proposals.note) +
          '</div></div>'
        : '';
      body =
        detectFacts(res) +
        (groups.length || note
          ? groups.join('') + note
          : '<div class="hint">Nothing new — this project already records what the links show. ' +
            (res.offline ? 'Network access is off right now.' : 'Re-check after changing the links.') +
            '</div>') +
        (res.cached ? '<div class="hint">Used a result from the last few minutes. Re-check to look again.</div>' : '');
    }
    return sheet(
      'Detect details',
      project.name + ' · tick what belongs in the dossier',
      body,
      '<button class="btn sm ghost" data-action="detect-recheck" data-id="' +
        project.id +
        '"' +
        (busy ? ' disabled' : '') +
        '>' +
        D.icon('refresh') +
        ' Re-check</button><span class="spacer"></span>' +
        '<button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="apply-detection" data-id="' +
        project.id +
        '"' +
        (busy || entry.status === 'error' ? ' disabled' : '') +
        '>Add selected</button>',
      true
    );
  }

  async function applyDetection(projectId) {
    const entry = S.detections.get(projectId);
    if (!entry || entry.status !== 'ready') return;
    const proposals = entry.res.proposals;
    const checked = [...document.querySelectorAll('[data-detect-item]')].filter((box) => box.checked);
    const indexOf = (group) =>
      new Set(
        checked
          .filter((box) => box.dataset.group === group)
          .map((box) => Number(box.dataset.index))
      );
    const stack = [...indexOf('stack')].map((index) => proposals.stack[index] && proposals.stack[index].name).filter(Boolean);
    const tags = [...indexOf('tags')].map((index) => proposals.tags[index]).filter(Boolean);
    const services = [...indexOf('services')].map((index) => proposals.services[index]).filter(Boolean);
    const links = [...indexOf('links')].map((index) => proposals.links[index]).filter(Boolean);
    const noteBox = document.querySelector('[data-detect-note]');
    const note = noteBox && noteBox.checked ? proposals.note : '';
    if (!stack.length && !tags.length && !services.length && !links.length && !note) {
      toast('Nothing selected.');
      return;
    }
    const res = await dispatch({
      type: 'project.enrich',
      payload: { projectId, stack, tags, services, links, note },
    });
    if (!res.ok) {
      toast(res.error || 'Could not apply that.');
      return;
    }
    const counts = res.result || {};
    const bits = [
      counts.stack ? counts.stack + ' stack' : '',
      counts.tags ? counts.tags + ' tags' : '',
      counts.services ? counts.services + ' services' : '',
      counts.links ? counts.links + ' links' : '',
      counts.note ? 'a note' : '',
    ].filter(Boolean);
    closeModal();
    toast(bits.length ? 'Added ' + bits.join(' · ') : 'Those were already recorded.');
  }

  // --------------------------------------------------------------- feedback

  function feedbackReport() {
    const meta = S.meta || {};
    return FB.diagnostics({
      meta: {
        version: meta.version,
        packaged: meta.packaged,
        platform: meta.platform,
        arch: meta.arch,
        shortcut: meta.shortcut,
        versions: meta.versions,
      },
      vault: { projects: S.vault.projects.length, bytes: meta.bytes || 0 },
      settings: S.vault.settings,
      errors: S.errors,
      arch: meta.arch,
      osRelease: meta.osRelease,
    });
  }

  function feedbackInput() {
    const kindField = document.querySelector('#feedback-kind');
    const messageField = document.querySelector('#feedback-message');
    const diagField = document.querySelector('#feedback-diagnostics');
    const links = (S.meta && S.meta.links) || {};
    return {
      kind: kindField ? kindField.value : 'bug',
      message: messageField ? messageField.value : '',
      includeDiagnostics: diagField ? diagField.checked : true,
      report: feedbackReport(),
      repo: links.repoSlug || '',
      email: links.email || '',
    };
  }

  function modalFeedback() {
    const report = feedbackReport();
    const links = (S.meta && S.meta.links) || {};
    return sheet(
      'Feedback & bugs',
      'Straight to the person who made it. No account, no telemetry.',
      '<form data-form="feedback" id="modal-form">' +
        '<div class="form-field"><label>What kind?</label><select class="select" id="feedback-kind" name="kind">' +
        '<option value="bug">Something is broken</option>' +
        '<option value="idea">An idea</option>' +
        '<option value="other">Something else</option>' +
        '</select></div>' +
        '<div class="form-field"><label>What happened?</label>' +
        '<textarea class="input textarea" id="feedback-message" name="message" rows="6" autofocus placeholder="The env paste dropped the last variable. I was on the staging tab, coming from…"></textarea>' +
        '<div class="hint">Include what you did just before it happened. Steps beat screenshots.</div></div>' +
        '<div class="form-field"><label class="check-row"><input type="checkbox" id="feedback-diagnostics" checked /> Include diagnostics</label>' +
        '<div class="hint">Version, macOS, settings and the last renderer error. Never project names, URLs or secret values.</div>' +
        '<pre class="diag-box" data-diagnostics>' +
        D.esc(report) +
        '</pre></div>' +
        '<div class="hint">Sends through GitHub or your mail app — napkin++ makes no request of its own.</div>' +
        '</form>',
      '<button class="btn sm" data-action="copy-report">' +
        D.icon('copy') +
        ' Copy report</button>' +
        '<button class="btn sm" data-action="send-email">Email ' +
        D.esc(links.email || '') +
        '</button>' +
        '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="send-issue">Open GitHub issue</button>',
      true
    );
  }

  // ------------------------------------------------------------------ about

  function modalAbout() {
    const meta = S.meta || {};
    const links = meta.links || {};
    const update = S.update || meta.update || null;
    let status = '';
    if (S.updateBusy) {
      status = '<div class="hint">Checking GitHub…</div>';
    } else if (update && update.ok && update.updateAvailable) {
      status =
        '<div class="update-card"><div><div class="settings-label">Version ' +
        D.esc(update.latest) +
        ' is available</div><div class="settings-sub">You are on ' +
        D.esc(update.current || meta.version || '') +
        '. Download it, quit napkin++, and replace the app in Applications.</div>' +
        (update.assetBytes ? '<div class="hint">' + D.esc(U.formatBytes(update.assetBytes)) + ' · ' + D.esc(update.assetName || '') + '</div>' : '') +
        (update.notes
          ? '<div class="hint update-notes">' +
            D.esc(String(update.notes).split(/\r?\n/).slice(0, 6).join('\n')) +
            '</div>'
          : '') +
        '</div><div class="update-actions"><button class="btn sm primary" data-action="open-update">Download</button>' +
        '<button class="btn sm ghost" data-action="skip-update">Skip this version</button></div></div>';
    } else if (update && update.ok === false) {
      status = '<div class="hint">' + D.esc(update.error || 'Could not check right now.') + '</div>';
    } else if (update && update.ok) {
      status =
        '<div class="hint">You are on the latest version. Checked ' +
        D.esc(U.checkedAgo(update.checkedAt)) +
        '.</div>';
    } else {
      status = '<div class="hint">Not checked yet.</div>';
    }
    return sheet(
      'napkin++',
      'A local-first project dossier. ' + (meta.packaged ? 'Packaged build' : 'Development build'),
      '<div class="about-head"><div class="about-mark">n<span>++</span></div><div><div class="about-name">napkin++</div>' +
        '<div class="about-version mono">' +
        D.esc(meta.version || '') +
        ' · ' +
        D.esc(meta.arch || '') +
        '</div></div></div>' +
        '<div class="settings-block"><div class="settings-label">Updates</div>' +
        '<div class="settings-sub">Checked against GitHub Releases. A signed, notarized build can install in place; this build opens the download.</div>' +
        status +
        '<div class="about-actions"><button class="btn sm" data-action="check-updates"' +
        (S.updateBusy ? ' disabled' : '') +
        '>' +
        D.icon('refresh') +
        ' Check now</button>' +
        '<button class="btn sm ghost" data-action="send-feedback-about">Send feedback</button></div></div>' +
        '<div class="settings-block"><div class="settings-label">This build</div>' +
        '<div class="about-grid"><span>Electron</span><b class="mono">' +
        D.esc((meta.versions && meta.versions.electron) || '—') +
        '</b><span>Chrome</span><b class="mono">' +
        D.esc((meta.versions && meta.versions.chrome) || '—') +
        '</b><span>System</span><b class="mono">' +
        D.esc(meta.platform + ' ' + (meta.osRelease || '')) +
        '</b><span>Vault</span><b class="mono">' +
        (S.vault.projects.length || 0) +
        ' projects</b></div></div>' +
        '<div class="settings-block"><div class="settings-label">Elsewhere</div><div class="about-links">' +
        '<button class="btn sm" data-action="open-url" data-url="' +
        D.esc(links.site || '') +
        '">Website</button>' +
        '<button class="btn sm" data-action="open-url" data-url="' +
        D.esc(links.repo || '') +
        '">GitHub</button>' +
        '<button class="btn sm" data-action="open-url" data-url="' +
        D.esc(links.support || '') +
        '">Support the developer</button>' +
        '<button class="btn sm" data-action="open-url" data-url="' +
        D.esc((links.site || '') + '/privacy') +
        '">Privacy</button>' +
        '<button class="btn sm" data-action="open-url" data-url="' +
        D.esc(links.developer || '') +
        '">tapps.design</button></div></div>',
      '<button class="btn sm ghost" data-action="copy-diagnostics">Copy diagnostics</button>' +
        '<span class="spacer"></span><button class="btn primary" data-action="close-modal">Close</button>',
      true
    );
  }

  function modalConfirmDelete(data) {
    const project = projectById(data.id);
    return sheet(
      'Delete project?',
      'This removes the dossier from this Mac. Backups remain on disk.',
      '<div class="danger-zone"><strong>' +
        D.esc(project ? project.name : '') +
        '</strong><div class="hint">' +
        (project
          ? project.accounts.length + ' accounts · ' + project.entries.length + ' notes · ' + project.links.length + ' links'
          : '') +
        '</div></div>',
      '<span class="spacer"></span><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn danger" data-action="confirm-delete" data-id="' +
        D.esc(data.id) +
        '">Delete project</button>'
    );
  }

  // ------------------------------------------------------------- form handling

  function formValues(form) {
    const data = {};
    for (const [key, value] of new FormData(form).entries()) data[key] = String(value);
    return data;
  }

  function scheduleImportPreview(form) {
    if (S.importTimer) clearTimeout(S.importTimer);
    S.importTimer = setTimeout(() => {
      S.importTimer = null;
      const modalForm = document.getElementById('modal-form');
      if (!modalForm || modalForm !== form) return;
      renderImportPreview(form);
    }, 300);
  }

  function renderImportPreview(form) {
    const blob = form.querySelector('[name="blob"]');
    const host = $('#import-preview');
    if (!blob || !host) return;
    const value = blob.value;
    const count = form.querySelector('[data-import-count]');
    if (!value.trim()) {
      S.importBlocks = null;
      host.innerHTML = '';
      if (count) count.textContent = '';
      return;
    }
    if (S.importSingle) {
      S.importBlocks = null;
      host.innerHTML = singleImportCard(singleImportName(value), value);
      if (count) count.textContent = 'one project · ' + value.split(/\r?\n/).length + ' lines';
      return;
    }
    const blocks = P.splitBlob(value, S.importName || '');
    S.importBlocks = blocks;
    host.innerHTML = blocks.length
      ? importRows(blocks)
      : '<div class="hint">Could not split that text — it will import as one note.</div>';
    if (count) count.textContent = blocks.length ? blocks.length + ' blocks' : '';
  }

  async function submitForm(name, form) {
    const values = formValues(form);
    const project = currentProject();

    if (name === 'feedback') return;

    if (name === 'new-project') {
      const pending = {
        name: (values.name || '').trim(),
        description: values.description || '',
        tags: splitTags(values.tags),
      };
      if (!pending.name) {
        toast('Give it a name first.');
        return;
      }
      const candidates = M.findDuplicates(S.vault, { name: pending.name });
      if (candidates.length) {
        closeModal();
        openModal('merge', { pending, candidates });
        return;
      }
      const res = await dispatch({ type: 'project.create', payload: pending });
      if (res.ok) {
        closeModal();
        openProject(res.result.projectId, 'overview');
        toast('Created “' + pending.name + '”');
      }
      return;
    }

    if (name === 'project-details' && project) {
      const id = form.dataset.id || project.id;
      const res = await dispatch({
        type: 'project.update',
        payload: {
          id,
          patch: {
            name: values.name,
            description: values.description,
            status: values.status,
            folderId: values.folderId || '',
            tags: splitTags(values.tags),
            stack: splitTags(values.stack),
            aliases: splitTags(values.aliases),
          },
        },
      });
      if (res.ok) {
        closeModal();
        toast('Details saved');
      }
      return;
    }

    if (name === 'rename') {
      const id = form.dataset.id;
      const targetProject = projectById(id);
      if (!targetProject) return;
      const nextName = (values.name || '').trim();
      if (!nextName) {
        toast('A project needs a name.');
        return;
      }
      const aliases = [...targetProject.aliases];
      if (
        nextName !== targetProject.name &&
        !aliases.some((a) => M.normalizeName(a) === M.normalizeName(targetProject.name))
      ) {
        aliases.push(targetProject.name);
      }
      const res = await dispatch({
        type: 'project.update',
        payload: { id, patch: { name: nextName, aliases } },
      });
      if (res.ok) {
        closeModal();
        toast('Renamed to “' + nextName + '”');
      }
      return;
    }

    if (name === 'folder') {
      const id = form.dataset.id;
      const payload = { name: values.name, color: values.color };
      const res = id
        ? await dispatch({ type: 'folder.update', payload: { id, patch: payload } })
        : await dispatch({ type: 'folder.create', payload });
      if (res.ok) {
        const folder = res.result && res.result.folder ? res.result.folder : null;
        if (!id && folder) {
          if (S.folderTarget) {
            await dispatch({
              type: 'project.update',
              payload: { id: S.folderTarget, patch: { folderId: folder.id } },
            });
            S.folderTarget = null;
          }
        }
        closeModal();
        renderSidebar();
        renderList();
        toast(id ? 'Folder saved' : 'Folder created');
      }
      return;
    }

    if (name === 'merge-projects') {
      const keep = form.querySelector('[data-merge-keep]:checked');
      const sources = $$('[data-merge-source]:checked', form)
        .map((el) => el.value)
        .filter((id) => !keep || id !== keep.value);
      if (!keep) {
        toast('Pick the project to keep.');
        return;
      }
      if (!sources.length) {
        toast('Tick at least one project to merge in.');
        return;
      }
      const res = await dispatch({
        type: 'project.merge',
        payload: {
          targetId: keep.value,
          sourceIds: sources,
          name: (values.mergeName || '').trim(),
        },
      });
      if (res.ok) {
        S.mergeDraft = null;
        closeModal();
        openProject(res.result.targetId, 'overview');
        const conflicts = res.result.conflictCount || 0;
        const keys = (res.result.conflicts || []).slice(0, 3).join(', ');
        toast(
          'Merged ' + sources.length + (sources.length === 1 ? ' project' : ' projects'),
          {
            actionLabel: 'Undo',
            onAction: undo,
            sub: conflicts
              ? conflicts +
                ' env key' +
                (conflicts === 1 ? '' : 's') +
                " kept the surviving project's value" +
                (keys ? ' · ' + keys + (conflicts > 3 ? '…' : '') : '')
              : '',
          }
        );
      }
      return;
    }

    if (name === 'account' && project) {
      const fields = $$('#field-editor [data-field-row]', form)
        .map((row) => ({
          label: row.querySelector('[data-field-label]').value,
          value: row.querySelector('[data-field-value]').value,
          hidden: row.querySelector('[data-field-hidden]').checked,
        }))
        .filter((field) => String(field.value).trim());
      const id = form.dataset.id || null;
      const res = await dispatch({
        type: 'account.upsert',
        payload: {
          projectId: project.id,
          account: {
            id: id || undefined,
            label: values.label,
            email: values.email,
            username: values.username,
            service: values.service,
            env: values.env,
            notes: values.notes,
            fields,
          },
        },
      });
      if (res.ok) {
        closeModal();
        toast(id ? 'Account updated' : 'Account added');
      }
      return;
    }

    if (name === 'entry' && project) {
      const id = form.dataset.id || null;
      const res = await dispatch({
        type: 'entry.upsert',
        payload: {
          projectId: project.id,
          entry: {
            id: id || undefined,
            type: values.type,
            title: values.title,
            language: values.language,
            body: values.body,
          },
        },
      });
      if (res.ok) {
        closeModal();
        S.tab = 'notes';
        renderDetail();
        toast(id ? 'Entry updated' : 'Entry saved');
      }
      return;
    }

    if (name === 'link' && project) {
      const id = form.dataset.id || null;
      const res = await dispatch({
        type: 'link.upsert',
        payload: {
          projectId: project.id,
          link: { id: id || undefined, label: values.label, kind: values.kind, url: values.url },
        },
      });
      if (res.ok) {
        closeModal();
        toast('Link saved');
      }
      return;
    }

    if (name === 'service' && project) {
      const id = form.dataset.id || null;
      const res = await dispatch({
        type: 'service.upsert',
        payload: {
          projectId: project.id,
          service: {
            id: id || undefined,
            provider: values.provider,
            role: values.role,
            url: values.url,
            notes: values.notes,
          },
        },
      });
      if (res.ok) {
        closeModal();
        toast('Service saved');
      }
      return;
    }

    if (name === 'paste-accounts' && project) {
      const parsed = P.parseAccountLines(values.blob || '');
      if (!parsed.length) {
        toast('No email addresses found in that text.');
        return;
      }
      const actions = parsed.map((account) => ({
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
      }));
      const results = await batch(actions);
      const ok = results.filter((r) => r && r.ok).length;
      closeModal();
      toast('Added ' + ok + (ok === 1 ? ' account' : ' accounts'));
      return;
    }

    if (name === 'paste-env' && project) {
      const parsed = P.parseEnvBlock(values.blob || '');
      if (!parsed.pairs.length) {
        toast('No KEY=value lines found.');
        return;
      }
      const envName = values.env || 'dev';
      const existing = project.envs.find((e) => e.name.toLowerCase() === envName.toLowerCase());
      const res = await dispatch({
        type: 'env.vars.add',
        payload: {
          projectId: project.id,
          envId: existing ? existing.id : undefined,
          envName,
          vars: parsed.pairs,
        },
      });
      if (res.ok) {
        S.tab = 'env';
        S.envId = res.result.envId;
        closeModal();
        renderDetail();
        toast('Added ' + res.result.added + ' vars to ' + envName);
      }
      return;
    }

    if (name === 'add-env' && project) {
      const res = await dispatch({
        type: 'env.upsert',
        payload: { projectId: project.id, env: { name: values.name, url: values.url, vars: [] } },
      });
      if (res.ok) {
        S.envId = res.result.env.id;
        S.tab = 'env';
        closeModal();
        renderDetail();
      }
      return;
    }

    if (name === 'add-var' && project) {
      const envId = form.dataset.env;
      const key = (values.key || '').trim();
      if (!key) return;
      const res = await dispatch({
        type: 'env.vars.add',
        payload: { projectId: project.id, envId, vars: [{ key, value: values.value || '' }] },
      });
      if (res.ok) {
        form.reset();
        const input = form.querySelector('input[name="key"]');
        if (input) input.focus();
      }
      return;
    }

    if (name === 'add-entry' && project) {
      const body = (values.body || '').trim();
      if (!body) return;
      const detected = P.detectTextKind(body);
      let type = values.type || 'note';
      if (type === 'note' && detected.kind === 'code') type = 'snippet';
      const res = await dispatch({
        type: 'entry.upsert',
        payload: {
          projectId: project.id,
          entry: {
            type,
            body,
            title: D.firstLine(body, 80),
            language: type === 'snippet' ? 'code' : '',
          },
        },
      });
      if (res.ok) {
        form.reset();
        renderDetail();
        toast('Saved to notes');
      }
      return;
    }

    if (name === 'import') {
      const blobField = form.querySelector('[name="blob"]');
      const raw = blobField ? blobField.value : '';
      if (!raw.trim()) {
        toast('Paste a note or choose a file first.');
        return;
      }

      if (S.importSingle || values.single === 'on') {
        const nameField = form.querySelector('#import-single-name');
        let name = (nameField ? nameField.value.trim() : '') || singleImportName(raw);
        if (S.vault.projects.some((p) => M.normalizeName(p.name) === M.normalizeName(name))) {
          name = name + ' (imported)';
        }
        const draft = P.projectDraft({ name, body: raw });
        draft.entries = [{ type: 'note', title: name + ' — imported note', body: raw, language: '' }];
        const res = await dispatch({ type: 'project.create', payload: draft });
        if (res.ok) {
          S.importBlocks = null;
          S.importSingle = false;
          closeModal();
          openProject(res.result.projectId, 'overview');
          toast('Imported “' + name + '”');
        }
        return;
      }

      let rows = $$('[data-import-row]', form);
      if (!rows.length) {
        // Importing without preview should still work: split on submit.
        const blocks = P.splitBlob(raw, S.importName || '');
        if (!blocks.length) {
          toast('That text could not be split into a project.');
          return;
        }
        S.importBlocks = blocks;
        const host = $('#import-preview');
        if (host) host.innerHTML = importRows(blocks);
        rows = $$('[data-import-row]', form);
      }

      const blocks = S.importBlocks || P.splitBlob(raw, S.importName || '');
      const actions = [];
      const names = [];
      for (const row of rows) {
        const check = row.querySelector('[data-import-check]');
        if (!check || !check.checked) continue;
        const index = Number(row.dataset.index);
        const block = blocks[index];
        if (!block) continue;
        let name = row.querySelector('[data-import-name]').value.trim() || block.name;
        if (S.vault.projects.some((p) => M.normalizeName(p.name) === M.normalizeName(name))) {
          name = name + ' (imported)';
        }
        names.push(name);
        const draft = P.projectDraft(block);
        draft.name = name;
        actions.push({ type: 'project.create', payload: draft });
      }
      if (!actions.length) {
        toast('Nothing selected to import.');
        return;
      }
      const results = await batch(actions);
      const ok = results.filter((r) => r && r.ok).length;
      S.importBlocks = null;
      closeModal();
      toast('Imported ' + ok + (ok === 1 ? ' project' : ' projects'), {
        sub: names.slice(0, 3).join(' · '),
      });
      if (ok) {
        const last = results.filter((r) => r && r.ok).pop();
        if (last) openProject(last.result.projectId, 'overview');
      }
      return;
    }

    if (name === 'settings') {
      await dispatch({
        type: 'settings.update',
        payload: {
          patch: {
            copyClearSeconds: Number(values.seconds),
            githubToken: values.githubToken || '',
          },
        },
      });
      closeModal();
      toast('Settings saved');
    }
  }

  function splitTags(value) {
    return String(value || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  function previewPaste(form) {
    const blob = form.querySelector('[name="blob"]');
    const hint = form.querySelector('[data-paste-preview]');
    if (!blob || !hint) return;
    const text = blob.value;
    if (form.dataset.form === 'paste-accounts') {
      const accounts = P.parseAccountLines(text);
      hint.textContent = accounts.length
        ? accounts.length +
          ' account(s) found: ' +
          accounts.slice(0, 4).map((a) => a.email).join(' · ')
        : 'No email addresses yet.';
    } else {
      const env = P.parseEnvBlock(text);
      hint.textContent = env.pairs.length
        ? env.pairs.length + ' variable(s): ' + env.pairs.slice(0, 5).map((p) => p.key).join(' · ')
        : 'No KEY=value lines yet.';
    }
  }

  // -------------------------------------------------------------- interactions

  async function handleAction(action, target) {
    const project = currentProject();
    const handled = await projectActions(action, target, project);
    if (!handled) await detailActions(action, target, project);
  }

  async function projectActions(action, target, project) {
    switch (action) {
      case 'new-project':
        openModal('new-project');
        return true;

      case 'capture':
        api.showCapture();
        return true;

      case 'view':
        S.view = target.dataset.view;
        S.tag = null;
        S.folder = null;
        renderSidebar();
        renderList();
        return true;

      case 'folder':
        S.folder = S.folder === target.dataset.id ? null : target.dataset.id;
        S.tag = null;
        if (S.folder) S.view = 'all';
        renderSidebar();
        renderList();
        return true;

      case 'clear-folder':
        S.folder = null;
        renderSidebar();
        renderList();
        return true;

      case 'new-folder':
        openModal('folder');
        return true;

      case 'edit-folder': {
        const folder = folderById(target.dataset.id);
        if (folder) openModal('folder', { folder });
        return true;
      }

      case 'edit-details':
        if (project) openModal('project-details', { id: project.id });
        return true;

      case 'file-capture':
        fileCapture();
        return true;

      case 'tag':
        S.tag = S.tag === target.dataset.tag ? null : target.dataset.tag;
        S.folder = null;
        renderSidebar();
        renderList();
        return true;

      case 'select-project':
        openProject(target.dataset.id, 'overview');
        return true;

      case 'tab':
        S.tab = target.dataset.tab;
        renderDetail();
        return true;

      case 'toggle-sort': {
        const next = S.sort === 'name' ? 'recent' : 'name';
        S.sort = next;
        renderList();
        dispatch({ type: 'settings.update', payload: { patch: { sortBy: next } } });
        return true;
      }

      case 'toggle-grid': {
        const next = S.vault.settings.projectView === 'grid' ? 'list' : 'grid';
        S.vault.settings.projectView = next;
        renderList();
        dispatch({ type: 'settings.update', payload: { patch: { projectView: next } } });
        return true;
      }

      case 'refresh-preview':
        if (project) {
          toast('Looking for a preview…');
          const res = await api.capturePreview(project.id);
          toast(res.ok ? 'Preview updated' : res.error || 'Could not capture a preview.');
        }
        return true;

      case 'detect-details':
        if (project) openDetection(project.id);
        return true;

      case 'detect-recheck':
        if (project) runDetection(project.id, true);
        return true;

      case 'apply-detection':
        await applyDetection(target.dataset.id);
        return true;

      case 'open-feedback':
        openModal('feedback');
        return true;

      case 'send-feedback-about':
        closeModal();
        openModal('feedback');
        return true;

      case 'about':
        openModal('about');
        return true;

      case 'check-updates': {
        S.updateBusy = true;
        if (S.modal) renderModal();
        const res = await api.checkUpdates(true);
        S.updateBusy = false;
        S.update = res;
        if (S.modal) renderModal();
        if (res.ok) {
          toast(res.updateAvailable ? 'Version ' + res.latest + ' is available' : 'You are on the latest version');
        } else {
          toast(res.error || 'Could not check for updates.');
        }
        return true;
      }

      case 'open-update': {
        const current = S.update || (S.meta && S.meta.update) || {};
        const url = current.assetUrl || current.url;
        if (url) api.openExternal(url);
        return true;
      }

      case 'skip-update': {
        const current = S.update;
        if (current && current.latest) {
          await dispatch({
            type: 'settings.update',
            payload: { patch: { updateSkipped: current.latest } },
          });
          toast('Skipping ' + current.latest);
          closeModal();
        }
        return true;
      }

      case 'copy-report': {
        const input = feedbackInput();
        if (!input.message.trim()) {
          toast('Write a sentence first.');
          return true;
        }
        copy(FB.clipboardReport(input), 'report', false, null);
        return true;
      }

      case 'send-issue': {
        const input = feedbackInput();
        if (!input.message.trim()) {
          toast('Write a sentence first.');
          return true;
        }
        if (!input.repo) {
          toast('No GitHub repo configured.');
          return true;
        }
        api.openExternal(FB.issueUrl(input));
        toast('Opening GitHub — review it there before submitting.');
        return true;
      }

      case 'send-email': {
        const input = feedbackInput();
        if (!input.message.trim()) {
          toast('Write a sentence first.');
          return true;
        }
        api.openExternal(FB.mailtoUrl(input));
        return true;
      }

      case 'copy-diagnostics':
        copy(feedbackReport(), 'diagnostics', false, null);
        return true;

      case 'capture-all-previews': {
        const res = await api.captureAllPreviews();
        if (!res.ok) toast(res.error || 'Could not capture previews.');
        return true;
      }

      case 'toggle-previews': {
        const next = !(S.vault.settings.previews !== false);
        await dispatch({ type: 'settings.update', payload: { patch: { previews: next } } });
        toast(next ? 'Previews on' : 'Previews off');
        if (S.modal && S.modal.type === 'settings') renderModal();
        return true;
      }

      case 'toggle-detect': {
        const next = !(S.vault.settings.detectOnAdd !== false);
        await dispatch({ type: 'settings.update', payload: { patch: { detectOnAdd: next } } });
        toast(next ? 'Detection on' : 'Detection off');
        if (S.modal && S.modal.type === 'settings') renderModal();
        return true;
      }

      case 'toggle-updates': {
        const next = !(S.vault.settings.checkUpdates !== false);
        await dispatch({ type: 'settings.update', payload: { patch: { checkUpdates: next } } });
        toast(next ? 'Update checks on' : 'Update checks off');
        if (S.modal && S.modal.type === 'settings') renderModal();
        return true;
      }

      case 'clear-previews': {
        const res = await api.clearPreviews();
        toast('Cleared ' + (res.removed || 0) + ' cached previews');
        return true;
      }

      case 'copy':
        copy(
          target.dataset.value,
          target.dataset.label,
          target.dataset.hidden === '1',
          target.dataset.copyKey
        );
        return true;

      case 'open-url':
        api.openExternal(target.dataset.url).then((res) => {
          if (res && !res.ok) toast(res.error || 'Could not open that link.');
        });
        return true;

      case 'copy-env':
        if (project) {
          const env = activeEnv(project);
          if (env) copy(M.serializeEnv(env.vars), env.name + ' .env', true);
        }
        return true;

      case 'favorite':
        if (project) {
          dispatch({
            type: 'project.update',
            payload: { id: project.id, patch: { favorite: !project.favorite } },
          });
        }
        return true;

      case 'archive-project':
        if (project) {
          const archiving = project.status !== 'archived';
          dispatch({
            type: 'project.update',
            payload: { id: project.id, patch: { status: archiving ? 'archived' : 'active' } },
          });
          toast(archiving ? 'Archived' : 'Restored', {
            actionLabel: 'Undo',
            onAction: () =>
              dispatch({
                type: 'project.update',
                payload: { id: project.id, patch: { status: archiving ? 'active' : 'archived' } },
              }),
          });
        }
        return true;

      case 'delete-project':
        if (project) openModal('confirm-delete', { id: project.id });
        return true;

      case 'confirm-delete': {
        const id = target.dataset.id;
        const res = await dispatch({ type: 'project.delete', payload: { id } });
        if (res.ok) {
          S.selectedId = defaultProjectId();
          closeModal();
          renderAll();
          toast('Project deleted', { actionLabel: 'Undo', onAction: undo });
        }
        return true;
      }

      case 'export-project':
        if (project) {
          const res = await api.exportMarkdown({ projectId: project.id, redact: true });
          if (res.ok) toast('Exported markdown', { sub: res.path });
          else if (!res.canceled) toast(res.error || 'Export failed.');
        }
        return true;

      case 'export-all': {
        const res = await api.exportMarkdown({ redact: true });
        if (res.ok) toast('Exported the vault', { sub: res.path });
        else if (!res.canceled) toast(res.error || 'Export failed.');
        return true;
      }

      case 'add-account':
        openModal('account');
        return true;

      case 'edit-account':
        if (project) {
          const account = project.accounts.find((a) => a.id === target.dataset.id);
          if (account) openModal('account', { account });
        }
        return true;

      case 'delete-account':
        if (project) {
          await dispatch({
            type: 'account.delete',
            payload: { projectId: project.id, id: target.dataset.id },
          });
          toast('Account removed', { actionLabel: 'Undo', onAction: undo });
        }
        return true;

      case 'toggle-field': {
        if (!project) return true;
        const key = target.dataset.account + ':' + target.dataset.field;
        if (S.reveal.has(key)) S.reveal.delete(key);
        else S.reveal.add(key);
        const account = project.accounts.find((a) => a.id === target.dataset.account);
        const field = account && account.fields.find((f) => f.id === target.dataset.field);
        if (!account || !field) return true;
        const pill = target.closest('.field-pill');
        const valueEl = pill && pill.querySelector('.fval');
        const masked = field.hidden && !S.reveal.has(key);
        if (valueEl) valueEl.textContent = masked ? '••••••••' : field.value || '—';
        if (pill) pill.classList.toggle('masked', masked);
        target.innerHTML = D.icon(S.reveal.has(key) ? 'eye-off' : 'eye');
        return true;
      }

      case 'copy-field': {
        if (!project) return true;
        const account = project.accounts.find((a) => a.id === target.dataset.account);
        const field = account && account.fields.find((f) => f.id === target.dataset.field);
        if (field) copy(field.value, field.label, field.hidden);
        return true;
      }

      case 'paste-accounts':
        openModal('paste-accounts');
        return true;

      case 'edit-title':
        startTitleEdit(target);
        return true;

      default:
        return false;
    }
  }

  function refreshEntryBody(entry, expanded) {
    const host = document.querySelector('[data-entry-body="' + entry.id + '"]');
    if (!host) return;
    const lines = F.splitLines(entry.body);
    host.innerHTML = entryBody(entry, F.computeFolds(entry.body), expanded || lines.length <= 12);
  }

  async function detailActions(action, target, project) {
    switch (action) {
      case 'select-env':
        S.envId = target.dataset.id;
        renderDetail();
        return;

      case 'add-env':
        openModal('add-env');
        return;

      case 'paste-env':
        if (project) openModal('paste-env', { envName: (activeEnv(project) || { name: 'dev' }).name });
        return;

      case 'toggle-var': {
        if (!project) return;
        const env = activeEnv(project);
        if (!env) return;
        const v = env.vars.find((x) => x.id === target.dataset.id);
        if (!v) return;
        const key = project.id + ':' + v.id;
        if (S.reveal.has(key)) S.reveal.delete(key);
        else S.reveal.add(key);
        const masked = v.hidden && !S.reveal.has(key);
        const valueEl = document.querySelector('[data-var-value="' + v.id + '"]');
        if (valueEl) {
          valueEl.textContent = masked ? '••••••••••••' : v.value || '—';
          valueEl.classList.toggle('masked', masked);
        }
        target.innerHTML = D.icon(S.reveal.has(key) ? 'eye-off' : 'eye');
        return;
      }

      case 'copy-var': {
        if (!project) return;
        const env = activeEnv(project);
        const v = env && env.vars.find((x) => x.id === target.dataset.id);
        if (v) copy(v.value, v.key, v.hidden);
        return;
      }

      case 'copy-var-line': {
        if (!project) return;
        const env = activeEnv(project);
        const v = env && env.vars.find((x) => x.id === target.dataset.id);
        if (v) copy(M.envLine(v.key, v.value), v.key + '=…', v.hidden);
        return;
      }

      case 'delete-var': {
        if (!project) return;
        const env = activeEnv(project);
        if (!env) return;
        await dispatch({
          type: 'var.delete',
          payload: { projectId: project.id, envId: env.id, id: target.dataset.id },
        });
        toast('Variable removed', { actionLabel: 'Undo', onAction: undo });
        return;
      }

      case 'add-link':
        openModal('link');
        return;

      case 'edit-link':
        if (project) {
          const link = project.links.find((l) => l.id === target.dataset.id);
          if (link) openModal('link', { link });
        }
        return;

      case 'delete-link':
        if (project) {
          await dispatch({ type: 'link.delete', payload: { projectId: project.id, id: target.dataset.id } });
          toast('Link removed', { actionLabel: 'Undo', onAction: undo });
        }
        return;

      case 'add-service':
        openModal('service');
        return;

      case 'edit-service':
        if (project) {
          const service = project.services.find((s) => s.id === target.dataset.id);
          if (service) openModal('service', { service });
        }
        return;

      case 'delete-service':
        if (project) {
          await dispatch({
            type: 'service.delete',
            payload: { projectId: project.id, id: target.dataset.id },
          });
          toast('Service removed', { actionLabel: 'Undo', onAction: undo });
        }
        return;

      case 'edit-entry':
        if (project) {
          const entry = project.entries.find((e) => e.id === target.dataset.id);
          if (entry) openModal('entry', { entry });
        }
        return;

      case 'delete-entry':
        if (project) {
          await dispatch({
            type: 'entry.delete',
            payload: { projectId: project.id, id: target.dataset.id },
          });
          toast('Entry deleted', { actionLabel: 'Undo', onAction: undo });
        }
        return;

      case 'copy-entry': {
        if (!project) return;
        const entry = project.entries.find((e) => e.id === target.dataset.id);
        if (entry) copy(entry.body, entry.title, entry.type === 'secret', 'entry:' + entry.id);
        return;
      }

      case 'reveal-entry': {
        if (!project) return;
        const entry = project.entries.find((e) => e.id === target.dataset.id);
        if (!entry) return;
        S.expanded.add('reveal:' + entry.id);
        refreshEntryBody(entry, true);
        return;
      }

      case 'expand-entry': {
        if (!project) return;
        const id = target.dataset.id;
        if (S.expanded.has(id)) S.expanded.delete(id);
        else S.expanded.add(id);
        const entry = project.entries.find((e) => e.id === id);
        if (entry) refreshEntryBody(entry, S.expanded.has(id));
        return;
      }

      case 'toggle-fold': {
        if (!project) return;
        const id = target.dataset.entry;
        const line = target.dataset.line;
        const key = id + ':' + line;
        if (S.collapsed.has(key)) S.collapsed.delete(key);
        else S.collapsed.add(key);
        const entry = project.entries.find((e) => e.id === id);
        if (entry) refreshEntryBody(entry, S.expanded.has(id));
        return;
      }

      case 'add-field': {
        const editor = $('#field-editor');
        if (editor) {
          editor.insertAdjacentHTML('beforeend', fieldRow({ label: '', value: '', hidden: false }));
          const inputs = editor.querySelectorAll('[data-field-label]');
          if (inputs.length) inputs[inputs.length - 1].focus();
        }
        return;
      }

      case 'remove-field': {
        const row = target.closest('[data-field-row]');
        if (row) row.remove();
        return;
      }

      case 'submit-modal': {
        const form = document.getElementById('modal-form');
        if (!form) return;
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { cancelable: true }));
        return;
      }

      case 'close-modal':
        closeModal();
        return;

      case 'create-anyway': {
        const pending = S.modal && S.modal.data.pending;
        if (!pending) return;
        const payload = Object.assign({}, pending, { name: uniqueName(pending.name) });
        const res = await dispatch({ type: 'project.create', payload });
        if (res.ok) {
          closeModal();
          openProject(res.result.projectId, 'overview');
          toast('Created “' + payload.name + '”');
        }
        return;
      }

      case 'merge-into': {
        const pending = S.modal && S.modal.data.pending;
        if (!pending) return;
        const existing = projectById(target.dataset.id);
        if (!existing) return;
        const aliases = [...existing.aliases];
        if (!aliases.some((a) => M.normalizeName(a) === M.normalizeName(pending.name))) {
          aliases.push(pending.name);
        }
        const res = await dispatch({
          type: 'project.update',
          payload: { id: existing.id, patch: { aliases } },
        });
        if (res.ok) {
          closeModal();
          openProject(existing.id, 'overview');
          toast('Merged into “' + existing.name + '”', { actionLabel: 'Undo', onAction: undo });
        }
        return;
      }

      case 'open-existing':
        closeModal();
        openProject(target.dataset.id, 'overview');
        return;

      case 'merge-pair-pick': {
        const pair = (S.dupPairs || [])[Number(target.dataset.index)];
        if (!pair) return;
        const weight = (p) => p.accounts.length + p.entries.length + p.links.length;
        const keep = weight(pair.a) >= weight(pair.b) ? pair.a : pair.b;
        const source = keep.id === pair.a.id ? pair.b : pair.a;
        closeModal();
        openMergePicker(keep.id, [source.id]);
        return;
      }

      case 'open-merge': {
        const id =
          (S.modal && S.modal.data && S.modal.data.id) ||
          (currentProject() && currentProject().id);
        closeModal();
        if (id) openMergePicker(id, []);
        return;
      }

      case 'preview-import': {
        const form = document.getElementById('modal-form');
        if (form) renderImportPreview(form);
        return;
      }

      case 'pick-file': {
        const res = await api.importFile();
        if (!res.ok) {
          if (!res.canceled) toast(res.error || 'Could not read that file.');
          return;
        }
        S.importName = res.name.replace(/\.[^.]+$/, '');
        S.importBlocks = P.splitBlob(res.text, S.importName);
        openModal('import', { text: res.text });
        toast('Loaded ' + res.name);
        return;
      }

      case 'set-theme':
        dispatch({ type: 'settings.update', payload: { patch: { theme: target.dataset.theme } } });
        return;

      case 'set-accent':
        dispatch({ type: 'settings.update', payload: { patch: { accent: target.dataset.accent } } });
        return;

      case 'set-icon':
        dispatch({ type: 'settings.update', payload: { patch: { iconStyle: target.dataset.icon } } });
        return;

      case 'toggle-menubar':
        dispatch({
          type: 'settings.update',
          payload: { patch: { menuBar: !(S.vault.settings.menuBar !== false) } },
        });
        return;

      case 'toggle-login': {
        const current = (S.meta && S.meta.login) || { openAtLogin: false, supported: false };
        if (!current.supported) {
          toast('Open at login is available in the packaged app.');
          return;
        }
        const res = await api.setLogin(!current.openAtLogin);
        if (!res.ok) {
          toast(res.error || 'Could not change the login item.');
          return;
        }
        S.meta.login = res.state;
        if (res.state.openAtLogin && S.vault.settings.menuBar === false) {
          await dispatch({ type: 'settings.update', payload: { patch: { menuBar: true } } });
        }
        renderModal();
        toast(res.state.openAtLogin ? 'Opens at login' : 'Login item removed');
        return;
      }

      case 'reset-settings':
        dispatch({
          type: 'settings.update',
          payload: {
            patch: {
              theme: 'system',
              palette: 'paper',
              accent: 'ember',
              accentCustom: '#b2531f',
              iconStyle: 'napkin',
              iconTint: 'auto',
              menuBar: true,
              copyClearSeconds: 45,
            },
          },
        });
        toast('Appearance reset');
        return;

      case 'save-settings': {
        const form = document.getElementById('modal-form');
        if (form) {
          await dispatch({
            type: 'settings.update',
            payload: { patch: { copyClearSeconds: Number(formValues(form).seconds) } },
          });
        }
        closeModal();
        toast('Settings saved');
        return;
      }

      case 'reveal-vault':
        api.revealVault();
        return;

      case 'backup':
        api.backup().then((res) => {
          if (res.ok) toast('Backed up', { sub: res.meta.lastSavedAt });
          else toast('Backup failed.');
        });
        return;

      case 'import':
        S.importBlocks = null;
        S.importSingle = false;
        S.importName = '';
        openModal('import');
        return;

      case 'duplicates':
        S.dupPairs = findDuplicatePairs();
        openModal('duplicates');
        return;

      case 'settings':
        openModal('settings');
        return;

      case 'shortcuts':
        openModal('shortcuts');
        return;

      case 'edit-var': {
        if (!project) return;
        const env = activeEnv(project);
        if (env) startVarEdit(env.id, target.dataset.id, 'key');
        return;
      }

      case 'commit-var':
        commitVarEdit();
        return;

      case 'cancel-var':
        cancelVarEdit();
        return;

      case 'set-palette':
        dispatch({
          type: 'settings.update',
          payload: { patch: { palette: target.dataset.palette } },
        });
        return;

      case 'set-icon-tint':
        dispatch({
          type: 'settings.update',
          payload: { patch: { iconTint: target.dataset.tint } },
        });
        return;

      case 'pick-folder-color': {
        const input = document.querySelector('#modal-form [name="color"]');
        if (input) input.value = target.dataset.color;
        $$('#modal-form .folder-swatches .swatch').forEach((swatch) =>
          swatch.classList.toggle('active', swatch === target)
        );
        return;
      }

      case 'delete-folder': {
        const id = target.dataset.id;
        const folder = folderById(id);
        if (!folder) return;
        const res = await dispatch({ type: 'folder.delete', payload: { id } });
        if (res.ok) {
          if (S.folder === id) S.folder = null;
          closeModal();
          renderSidebar();
          renderList();
          toast('Folder deleted — projects kept', { actionLabel: 'Undo', onAction: undo });
        }
        return;
      }

      case 'merge-use-name': {
        const input = document.querySelector('#modal-form [name="mergeName"]');
        if (input) {
          input.value = target.dataset.name;
          input.focus();
        }
        return;
      }

      case 'palette-pick': {
        const item = S.palette.results[Number(target.dataset.index)];
        if (item) activatePaletteItem(item);
        return;
      }

      default:
        return;
    }
  }

  // ------------------------------------------------------ context menu actions

  function openMergePicker(keepId, sourceIds) {
    const keep = projectById(keepId) || currentProject();
    if (!keep) {
      toast('Add a project first.');
      return;
    }
    S.mergeDraft = {
      keepId: keep.id,
      sourceIds: (sourceIds || []).filter((id) => id !== keep.id),
      name: keep.name,
    };
    openModal('merge-projects');
  }

  async function handleContextAction(action, value) {
    const payload = (S.context && S.context.payload) || {};
    closeContextMenu();
    const project = payload.projectId ? projectById(payload.projectId) : null;

    if (action === 'ctx-open') {
      openProject(payload.projectId, 'overview');
      return;
    }
    if (action === 'ctx-details') {
      openModal('project-details', { id: payload.projectId });
      return;
    }
    if (action === 'ctx-rename') {
      openModal('rename', { id: payload.projectId });
      return;
    }
    if (action === 'ctx-favorite' && project) {
      const next = !project.favorite;
      await dispatch({
        type: 'project.update',
        payload: { id: project.id, patch: { favorite: next } },
      });
      toast(next ? 'Favorited “' + project.name + '”' : 'Removed from favorites');
      return;
    }
    if (action === 'move-folder' && project) {
      const folderId = value || '';
      const res = await dispatch({
        type: 'project.update',
        payload: { id: project.id, patch: { folderId } },
      });
      if (res.ok) {
        const folder = folderId ? folderById(folderId) : null;
        toast(
          folder ? 'Filed in “' + folder.name + '”' : 'Removed from folder',
          { actionLabel: 'Undo', onAction: undo }
        );
      }
      return;
    }
    if (action === 'new-folder-for') {
      S.folderTarget = payload.projectId;
      openModal('folder', {
        color: M.FOLDER_COLORS[folders().length % M.FOLDER_COLORS.length],
      });
      return;
    }
    if (action === 'ctx-merge' && project) {
      openMergePicker(project.id, []);
      return;
    }
    if (action === 'ctx-archive' && project) {
      const archiving = project.status !== 'archived';
      await dispatch({
        type: 'project.update',
        payload: { id: project.id, patch: { status: archiving ? 'archived' : 'active' } },
      });
      toast(archiving ? 'Archived' : 'Restored', { actionLabel: 'Undo', onAction: undo });
      return;
    }
    if (action === 'ctx-delete' && project) {
      openModal('confirm-delete', { id: project.id });
      return;
    }
    if (action === 'ctx-copy-name' && project) {
      copy(project.name, 'project name', false, null);
      return;
    }
    if (action === 'ctx-preview' && project) {
      api.capturePreview(project.id).then((res) => {
        if (!res.ok) toast(res.error || 'Could not capture a preview.');
      });
      return;
    }
    if (action === 'ctx-detect' && project) {
      openDetection(project.id);
      return;
    }

    const found =
      payload.varId && payload.envId ? findVar(project, payload.envId, payload.varId) : null;
    if (action === 'ctx-var-edit' && found) {
      if (payload.projectId !== S.selectedId) openProject(payload.projectId, 'env');
      S.tab = 'env';
      S.envId = payload.envId;
      startVarEdit(payload.envId, payload.varId, 'value');
      return;
    }
    if (action === 'ctx-var-copy' && found) {
      copy(found.item.value, found.item.key, found.item.hidden, project.id + ':' + found.item.id);
      return;
    }
    if (action === 'ctx-var-line' && found) {
      copy(
        M.envLine(found.item.key, found.item.value),
        found.item.key + '=…',
        found.item.hidden,
        project.id + ':' + found.item.id
      );
      return;
    }
    if (action === 'ctx-var-reveal' && found) {
      const key = project.id + ':' + found.item.id;
      if (S.reveal.has(key)) S.reveal.delete(key);
      else S.reveal.add(key);
      renderDetailKeepScroll();
      return;
    }
    if (action === 'ctx-var-delete' && found) {
      await dispatch({
        type: 'var.delete',
        payload: { projectId: project.id, envId: payload.envId, id: payload.varId },
      });
      toast('Variable removed', { actionLabel: 'Undo', onAction: undo });
      return;
    }

    const account =
      payload.accountId && project
        ? project.accounts.find((a) => a.id === payload.accountId)
        : null;
    if (action === 'ctx-account-edit' && account) {
      openModal('account', { account });
      return;
    }
    if (action === 'ctx-account-email' && account) {
      copy(
        account.email,
        'email',
        false,
        'acct:' + account.id + ':email'
      );
      return;
    }
    if (action === 'ctx-account-user' && account) {
      copy(
        account.username,
        'username',
        false,
        'acct:' + account.id + ':username'
      );
      return;
    }
    if (action === 'ctx-account-delete' && account) {
      await dispatch({
        type: 'account.delete',
        payload: { projectId: project.id, id: account.id },
      });
      toast('Account removed', { actionLabel: 'Undo', onAction: undo });
      return;
    }

    const folder = payload.folderId ? folderById(payload.folderId) : null;
    if (action === 'ctx-folder-rename' && folder) {
      openModal('folder', { folder });
      return;
    }
    if (action === 'ctx-folder-color' && folder) {
      const res = await dispatch({
        type: 'folder.update',
        payload: { id: folder.id, patch: { color: value } },
      });
      if (res.ok) toast('Folder colour updated');
      return;
    }
    if (action === 'ctx-folder-delete' && folder) {
      const res = await dispatch({ type: 'folder.delete', payload: { id: folder.id } });
      if (res.ok) {
        if (S.folder === folder.id) S.folder = null;
        toast('Folder deleted — projects kept', { actionLabel: 'Undo', onAction: undo });
      }
    }
  }

  function findDuplicatePairs() {
    const pairs = [];
    const seen = new Set();
    for (const project of S.vault.projects) {
      if (project.status === 'archived') continue;
      const candidates = M.findDuplicates(S.vault, {
        name: project.name,
        excludeId: project.id,
        repoUrl: (project.links.find((l) => l.kind === 'repo') || {}).url,
        emails: project.accounts.map((a) => a.email),
      });
      for (const candidate of candidates) {
        const key = [project.id, candidate.project.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({
          a: project,
          b: candidate.project,
          score: candidate.score,
          reasons: candidate.reasons,
        });
      }
    }
    pairs.sort((x, y) => y.score - x.score);
    return pairs.slice(0, 12);
  }

  function startTitleEdit(target) {
    if (S.editingTitle) return;
    const project = currentProject();
    if (!project) return;
    S.editingTitle = true;
    const input = document.createElement('input');
    input.className = 'title-input';
    input.value = project.name;
    target.replaceWith(input);
    input.focus();
    input.select();
    const finish = async (commit) => {
      if (!S.editingTitle) return;
      S.editingTitle = false;
      const name = input.value.trim();
      if (commit && name && name !== project.name) {
        const aliases = [...project.aliases];
        if (!aliases.some((a) => M.normalizeName(a) === M.normalizeName(project.name))) {
          aliases.push(project.name);
        }
        const res = await dispatch({
          type: 'project.update',
          payload: { id: project.id, patch: { name, aliases } },
        });
        if (res.ok) toast('Renamed');
      } else {
        renderDetail();
      }
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        S.editingTitle = false;
        renderDetail();
      }
    });
  }

  // ------------------------------------------------------------------- events

  function bindEvents() {
    document.addEventListener('click', (event) => {
      const node = targetElement(event);
      if (!node) return;
      const ctxItem = node.closest('[data-ctx-action]');
      if (ctxItem) {
        event.preventDefault();
        handleContextAction(ctxItem.dataset.ctxAction, ctxItem.dataset.ctxValue);
        return;
      }
      if (!node.closest('#ctx-menu')) closeContextMenu();
      if (node.id === 'palette') {
        closePalette();
        return;
      }
      if (node.id === 'modal') {
        closeModal();
        return;
      }
      const target = node.closest('[data-action]');
      if (!target) return;
      // Let people select text without copying the whole field by accident.
      // Explicit copy buttons always work, even with a selection on screen.
      if (
        target.dataset.action === 'copy' &&
        !target.classList.contains('copy-btn') &&
        String(window.getSelection()).trim()
      ) {
        return;
      }
      event.preventDefault();
      handleAction(target.dataset.action, target);
    });

    document.addEventListener('contextmenu', (event) => {
      const node = targetElement(event);
      if (!node) return;
      if (node.closest('input, textarea, select')) return;
      const projectRow = node.closest('[data-project-row]');
      if (projectRow) {
        const project = projectById(projectRow.dataset.id);
        if (project) {
          event.preventDefault();
          openContextMenu(event, projectContextItems(project), { projectId: project.id });
        }
        return;
      }
      const folderRow = node.closest('[data-folder-row]');
      if (folderRow) {
        const folder = folderById(folderRow.dataset.id);
        if (folder) {
          event.preventDefault();
          openContextMenu(event, folderContextItems(folder), { folderId: folder.id });
        } else {
          closeContextMenu();
        }
        return;
      }
      const varRow = node.closest('[data-var-row]');
      if (varRow) {
        const project = currentProject();
        const env = activeEnv(project);
        const item = env && env.vars.find((v) => v.id === varRow.dataset.varId);
        if (project && env && item) {
          event.preventDefault();
          openContextMenu(event, varContextItems(project, env, item), {
            projectId: project.id,
            envId: env.id,
            varId: item.id,
          });
        }
        return;
      }
      const accountRow = node.closest('[data-account-row]');
      if (accountRow) {
        const project = currentProject();
        const account =
          project && project.accounts.find((a) => a.id === accountRow.dataset.account);
        if (account) {
          event.preventDefault();
          openContextMenu(event, accountContextItems(account), {
            projectId: project.id,
            accountId: account.id,
          });
        }
        return;
      }
      closeContextMenu();
    });

    document.addEventListener('dblclick', (event) => {
      const node = targetElement(event);
      if (!node) return;
      const row = node.closest('.var-row');
      if (!row || node.closest('button, input')) return;
      const project = currentProject();
      const env = activeEnv(project);
      if (!project || !env) return;
      startVarEdit(env.id, row.dataset.varId, node.closest('.var-value') ? 'value' : 'key');
    });

    // Drag a project onto a folder in the sidebar.
    document.addEventListener('dragstart', (event) => {
      const node = targetElement(event);
      const card = node && node.closest('[data-project-row]');
      if (!card) return;
      event.dataTransfer.setData('text/plain', card.dataset.id);
      event.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });

    document.addEventListener('dragend', (event) => {
      const node = targetElement(event);
      const card = node && node.closest('[data-project-row]');
      if (card) card.classList.remove('dragging');
      $$('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });

    document.addEventListener('dragover', (event) => {
      const node = targetElement(event);
      const target = node && node.closest('[data-drop-folder]');
      if (!target) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      $$('.drop-target').forEach((el) => {
        if (el !== target) el.classList.remove('drop-target');
      });
      target.classList.add('drop-target');
    });

    document.addEventListener('dragleave', (event) => {
      const node = targetElement(event);
      const target = node && node.closest('[data-drop-folder]');
      if (target) target.classList.remove('drop-target');
    });

    document.addEventListener('drop', async (event) => {
      const node = targetElement(event);
      const target = node && node.closest('[data-drop-folder]');
      if (!target) return;
      event.preventDefault();
      $$('.drop-target').forEach((node) => node.classList.remove('drop-target'));
      const id = event.dataTransfer.getData('text/plain');
      const project = id ? projectById(id) : null;
      if (!project || project.folderId === target.dataset.dropFolder) return;
      const folderId = target.dataset.dropFolder || '';
      const res = await dispatch({
        type: 'project.update',
        payload: { id: project.id, patch: { folderId } },
      });
      if (res.ok) {
        const folder = folderId ? folderById(folderId) : null;
        toast(
          folder ? 'Filed “' + project.name + '” in “' + folder.name + '”' : 'Removed from folder',
          { actionLabel: 'Undo', onAction: undo }
        );
      }
    });

    document.addEventListener('submit', (event) => {
      const node = targetElement(event);
      if (!node) return;
      const form = node.closest('form[data-form]');
      if (!form) return;
      event.preventDefault();
      submitForm(form.dataset.form, form);
    });

    document.addEventListener('change', (event) => {
      const field = targetElement(event);
      if (!field) return;
      if (field.matches('[data-merge-keep]')) {
        syncMergeRows(true);
        return;
      }
      if (field.matches('[data-merge-source]')) {
        syncMergeRows(false);
        return;
      }
      if (field.matches('[data-custom-accent]')) {
        dispatch({
          type: 'settings.update',
          payload: {
            patch: { accent: 'custom', accentCustom: field.value },
          },
        });
        return;
      }
      if (field.matches('[data-capture-env]')) {
        S.capture.envName = field.value;
        renderCapturePlan();
        return;
      }
      if (field.id === 'import-single') {
        S.importSingle = field.checked;
        const form = field.closest('form[data-form="import"]');
        if (form) renderImportPreview(form);
      }
    });

    document.addEventListener('input', (event) => {
      const field = targetElement(event);
      if (!field) return;
      if (field.matches('[data-capture-input]')) {
        S.capture.text = field.value;
        renderCapturePlan();
        return;
      }
      if (field.id === 'filter') {
        S.filter = field.value;
        renderList();
        return;
      }
      if (field.id === 'palette-input') {
        S.palette.query = field.value;
        S.palette.active = 0;
        renderPalette();
        return;
      }
      const importForm = field.closest('form[data-form="import"]');
      if (importForm && field.getAttribute('name') === 'blob') {
        scheduleImportPreview(importForm);
        return;
      }
      const form = field.closest('form[data-form]');
      if (form && (form.dataset.form === 'paste-env' || form.dataset.form === 'paste-accounts')) {
        previewPaste(form);
      }
      if (form && form.dataset.form === 'add-entry') {
        const hint = form.querySelector('[data-compose-hint]');
        const select = form.querySelector('[name="type"]');
        const detected = P.detectTextKind(field.value || '');
        if (hint) {
          hint.textContent =
            detected.kind === 'code'
              ? 'Looks like code — will save as a snippet.'
              : detected.kind === 'env'
                ? 'Looks like env vars — use the Env tab to add them as keys.'
                : detected.kind === 'accounts'
                  ? 'Looks like logins — Paste accounts on the Accounts tab.'
                  : 'Markdown, code or a stray URL — all fine.';
        }
        if (select && detected.kind === 'code' && select.value === 'note') select.value = 'snippet';
      }
    });

    document.addEventListener('keydown', (event) => {
      if (S.palette.open) {
        paletteKey(event);
        return;
      }
      const active = document.activeElement;
      const inField = active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
      if (S.modal) {
        if (event.key === 'Escape' && !S.editingTitle) {
          event.preventDefault();
          closeModal();
        }
        return;
      }
      if (S.context) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeContextMenu();
        }
        return;
      }
      const captureBox = targetElement(event)
        ? targetElement(event).closest('[data-capture-input]')
        : null;
      if (captureBox) {
        if (event.key === 'Escape') {
          event.preventDefault();
          captureBox.blur();
          return;
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          fileCapture();
          return;
        }
      }
      if (S.editingVar) {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitVarEdit();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelVarEdit();
          return;
        }
      }
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openPalette();
        return;
      }
      if (meta && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        if (event.shiftKey) api.showCapture();
        else openModal('new-project');
        return;
      }
      if (meta && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        const filter = $('#filter');
        filter.focus();
        filter.select();
        return;
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === 'g' && !inField) {
        // The menu owns ⌘⇧G; this only catches the case where the menu was not
        // built (a smoke run), so the toggle still has a keyboard path.
        if (S.menuBuilt) return;
        event.preventDefault();
        const next = S.vault.settings.projectView === 'grid' ? 'list' : 'grid';
        S.vault.settings.projectView = next;
        renderList();
        dispatch({ type: 'settings.update', payload: { patch: { projectView: next } } });
        return;
      }
      if (meta && event.key === ',') {
        event.preventDefault();
        openModal('settings');
        return;
      }
      if (meta && event.key === '/') {
        event.preventDefault();
        openModal('shortcuts');
        return;
      }
      if (meta && event.key.toLowerCase() === 'z' && !inField) {
        event.preventDefault();
        undo();
        return;
      }
      if (meta && /^[1-5]$/.test(event.key)) {
        event.preventDefault();
        const tabs = ['overview', 'accounts', 'env', 'notes', 'links'];
        S.tab = tabs[Number(event.key) - 1];
        renderDetail();
        return;
      }
      if (event.key === 'Escape') {
        if (S.filter) {
          S.filter = '';
          $('#filter').value = '';
          renderList();
        }
        return;
      }
      if (event.key === '?' && !inField) {
        event.preventDefault();
        openModal('shortcuts');
      }
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

    api.onState(applyState);
    api.onNotice((notice) => {
      if (!notice) return;
      const sub = notice.clearInSeconds ? 'clipboard clears in ' + notice.clearInSeconds + 's' : '';
      toast(notice.message || 'Copied', { sub });
    });
    api.onDetect((event) => {
      if (!event || !event.proposals) return;
      S.detections.set(event.projectId, {
        status: 'ready',
        res: {
          ok: true,
          proposals: event.proposals,
          page: event.page || null,
          repo: event.repo || null,
          hosting: event.hosting || [],
          dns: event.dns || [],
          email: event.email || [],
          warnings: event.warnings || [],
          cached: false,
        },
      });
      toast(
        'Found ' + event.count + ' details' + (event.headline ? ' · ' + event.headline : ''),
        {
          actionLabel: 'Review',
          onAction: () => {
            openProject(event.projectId, 'overview');
            setTimeout(() => {
              if (S.detections.get(event.projectId)) openModal('detect', { id: event.projectId });
            }, 140);
          },
        }
      );
    });
    api.onUpdate((update) => {
      if (!update || !update.updateAvailable) return;
      S.update = update;
      toast('napkin++ ' + update.latest + ' is available', {
        actionLabel: 'What’s new',
        onAction: () => openModal('about'),
      });
    });
    api.onNavigate((event) => {
      if (event && event.projectId) openProject(event.projectId, 'overview');
    });
    api.onMenu((event) => {
      if (!event) return;
      if (event.action === 'palette') openPalette();
      else if (event.action === 'new-project') openModal('new-project');
      else if (event.action === 'settings') openModal('settings');
      else if (event.action === 'shortcuts') openModal('shortcuts');
      else if (event.action === 'import') {
        S.importBlocks = null;
        S.importSingle = false;
        S.importName = '';
        openModal('import');
      } else if (event.action === 'duplicates') {
        S.dupPairs = findDuplicatePairs();
        openModal('duplicates');
      } else if (event.action === 'view') {
        S.view = event.view || 'all';
        S.tag = null;
        S.folder = null;
        renderSidebar();
        renderList();
      } else if (event.action === 'backup') {
        api.backup().then((res) => {
          if (res.ok) toast('Backed up');
        });
      } else if (event.action === 'feedback') {
        openModal('feedback');
      } else if (event.action === 'about') {
        openModal('about');
      } else if (event.action === 'updates') {
        openModal('about');
        setTimeout(() => handleAction('check-updates', document.body), 80);
      } else if (event.action === 'grid') {
        const next = S.vault.settings.projectView === 'grid' ? 'list' : 'grid';
        S.vault.settings.projectView = next;
        renderList();
        dispatch({ type: 'settings.update', payload: { patch: { projectView: next } } });
      } else if (event.action === 'export') {
        api.exportMarkdown({ redact: true }).then((res) => {
          if (res.ok) toast('Exported the vault', { sub: res.path });
        });
      }
    });
  }

  async function boot() {
    const payload = await api.getState();
    S.vault = payload.state;
    S.meta = payload.meta;
    S.sort = payload.state.settings.sortBy;
    S.grid = payload.state.settings.projectView === 'grid';
    S.update = payload.meta.update || null;
    S.menuBuilt = Boolean(payload.meta.menu);
    S.index = Q.buildIndex(S.vault);
    S.selectedId = defaultProjectId();
    applyTheme();
    pushErrorHook();
    bindEvents();
    renderAll();
  }

  function pushError(message) {
    const text = String(message || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    S.errors.push({ message: text.slice(0, 240), at: new Date().toISOString() });
    if (S.errors.length > 5) S.errors.shift();
  }

  function pushErrorHook() {
    window.addEventListener('error', (event) => {
      pushError((event && event.message) || 'Unknown renderer error');
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event && event.reason;
      pushError((reason && reason.message) || String(reason || 'Unhandled rejection'));
    });
    document.addEventListener(
      'error',
      (event) => {
        const img = event.target;
        if (img && img.matches && img.matches('img[data-thumb]')) {
          img.classList.add('broken');
          const tile = img.closest('.thumb-tile');
          if (tile) tile.classList.add('img-failed');
        }
      },
      true
    );
  }

  boot().catch((error) => {
    document.getElementById('detail').innerHTML =
      '<div class="empty-state"><div class="empty-mark">!</div><h2 class="empty-title">Could not start</h2><p class="empty-sub">' +
      D.esc(error && error.message ? error.message : String(error)) +
      '</p></div>';
  });
})();
