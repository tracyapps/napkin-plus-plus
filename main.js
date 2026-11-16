'use strict';

/*
 * napkin++ — Electron main process.
 *
 * The main process owns the vault document (so two windows can never clobber
 * each other), the global summon shortcut, the clipboard timeout, and the
 * smoke harness used to verify a real boot.
 */

const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, clipboard, dialog, Menu, Tray, nativeImage, protocol } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const model = require('./app/model.js');
const { VaultStore } = require('./app/store.js');
const config = require('./app/config.js');
const detect = require('./app/detect.js');
const inspect = require('./app/inspect.js');
const net = require('./app/net.js');
const updates = require('./app/updates.js');
const { PreviewStore, previewSource } = require('./app/previews.js');

const SMOKE = process.env.NAPKIN_SMOKE === '1';
const DATA_DIR =
  process.env.NAPKIN_DATA_DIR ||
  (SMOKE
    ? path.join(os.tmpdir(), 'napkin-smoke-' + process.pid)
    : app.getPath('userData'));

// A smoke run must never share the real app's lock, cache, or vault.
if (SMOKE || process.env.NAPKIN_DATA_DIR) {
  app.setPath('userData', DATA_DIR);
}
const PRELOAD = path.join(__dirname, 'preload.js');
const PREVIEWS = new PreviewStore({ dir: path.join(DATA_DIR, 'previews') });
const UPDATE_FILE = path.join(DATA_DIR, 'update-check.json');

// The renderer shows cached previews through this scheme; nothing else is
// reachable and the handler only ever serves a file it wrote itself.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'napkin-thumb',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

let store = null;
let mainWindow = null;
let quickWindow = null;
let tray = null;
let summonShortcut = '';
let clipTimer = null;
let appliedIconStyle = null;
let appliedIconTint = null;
let dockMenuInstalled = false;
let startHidden = false;
let updateState = null;
let updateNoticeShown = '';
const pendingPreview = new Map();
const pendingDetect = new Map();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------- vault state

function payload() {
  return {
    ok: true,
    state: store.vault,
    meta: Object.assign({}, store.meta(), {
      shortcut: summonShortcut,
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      login: loginState(),
      dockIcon: appliedIconStyle,
      dockTint: appliedIconTint,
      dockMenu: dockMenuInstalled,
      tray: Boolean(tray),
      arch: process.arch,
      osRelease: os.release(),
      versions: {
        electron: process.versions.electron || '',
        chrome: process.versions.chrome || '',
        node: process.versions.node || '',
      },
      links: {
        site: config.SITE_URL,
        repo: config.REPO_URL,
        support: config.SUPPORT_URL,
        download: config.DOWNLOAD_URL,
        developer: config.DEVELOPER_URL,
        email: config.FEEDBACK_EMAIL,
        repoSlug: config.REPO,
      },
      update: readUpdateState().result || null,
      menu: !SMOKE && process.platform === 'darwin',
      network: { offline: net.offline(), previews: store.vault.settings.previews !== false },
    }),
  };
}

function broadcast() {
  const data = payload();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('vault:state', data);
  }
}

function notify(target, message, kind) {
  const win = target && !target.isDestroyed() ? target : mainWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send('app:notice', { message, kind: kind || 'info' });
  }
}

// ------------------------------------------------- previews, detection, updates

function projectById(id) {
  return store ? model.getProject(store.vault, id) : null;
}

function readUpdateState() {
  if (updateState) return updateState;
  try {
    updateState = JSON.parse(fs.readFileSync(UPDATE_FILE, 'utf8'));
  } catch {
    updateState = {};
  }
  return updateState || {};
}

function writeUpdateState(patch) {
  updateState = Object.assign({}, readUpdateState(), patch);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(UPDATE_FILE, JSON.stringify(updateState, null, 2), 'utf8');
  } catch {
    /* a failed cache write must not break the check */
  }
}

/**
 * Capture (or reuse) the social preview for one project. Writes the file, then
 * records which link it came from so a changed link refreshes the card.
 */
async function capturePreview(projectId, options) {
  const opts = options || {};
  if (!store) return { ok: false, error: 'The vault is not open.' };
  if (!store.vault.settings.previews && !opts.force) {
    return { ok: false, error: 'Previews are off in Settings.' };
  }
  const project = projectById(projectId);
  if (!project) return { ok: false, error: 'Project not found.' };
  const source = previewSource(project);
  if (!source) return { ok: false, error: 'Add a live or repo link first.' };
  if (!opts.force && project.thumb.url === source.url && PREVIEWS.has(project.id)) {
    return { ok: true, cached: true, url: source.url, source: source.source };
  }
  const result = await PREVIEWS.capture({ projectId: project.id, pageUrl: source.url });
  if (!result.ok) return { ok: false, error: result.error || 'Could not capture a preview.', url: source.url };
  store.dispatch({
    type: 'project.thumb',
    payload: {
      projectId: project.id,
      url: source.url,
      source: source.source,
      at: new Date().toISOString(),
    },
  });
  broadcast();
  return {
    ok: true,
    url: source.url,
    source: source.source,
    bytes: result.bytes,
    width: result.width,
    height: result.height,
  };
}

function schedulePreview(projectId) {
  if (!store || !store.vault.settings.previews) return;
  const existing = pendingPreview.get(projectId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingPreview.delete(projectId);
    capturePreview(projectId)
      .then((res) => {
        if (res.ok && !res.cached) notify(mainWindow, 'Preview captured', 'preview');
        else if (!res.ok && res.error) notify(mainWindow, res.error, 'warn');
      })
      .catch(() => {});
  }, 900);
  pendingPreview.set(projectId, timer);
}

async function detectionFor(projectId, force) {
  const project = projectById(projectId);
  if (!project) return { ok: false, error: 'Project not found.' };
  const links = (project.links || []).filter((link) => /^https?:/i.test(link.url));
  if (!links.length) return { ok: false, error: 'Add a live site or repo link first.' };
  if (force) inspect.forget(projectId);
  // The smoke run uses a fixture so it never depends on the network. The hook
  // is only read when NAPKIN_SMOKE=1, and never outside a test run.
  if (SMOKE && process.env.NAPKIN_DETECT_FIXTURE) {
    try {
      return JSON.parse(
        fs.readFileSync(path.resolve(__dirname, process.env.NAPKIN_DETECT_FIXTURE), 'utf8')
      );
    } catch {
      /* fall through to the real path */
    }
  }
  const findings = await inspect.inspectProject(project, store.vault.settings);
  const proposals = detect.proposals(findings, project);
  return {
    ok: true,
    proposals,
    headline: detect.headline(findings),
    page: findings.page || null,
    repo: findings.repo || null,
    hosting: (findings.hosting || []).map((item) => ({ label: item.label, evidence: item.evidence })),
    dns: (findings.dns || []).map((item) => item.label),
    email: (findings.email || []).map((item) => item.label),
    warnings: findings.warnings || [],
    offline: Boolean(findings.offline),
    cached: Boolean(findings.cached),
    fetchedAt: findings.fetchedAt || '',
  };
}

function scheduleDetection(projectId) {
  if (!store || !store.vault.settings.detectOnAdd) return;
  const existing = pendingDetect.get(projectId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingDetect.delete(projectId);
    detectionFor(projectId)
      .then((res) => {
        if (!res.ok || !res.proposals.hasAnything) return;
        const count =
          res.proposals.stack.length +
          res.proposals.tags.length +
          res.proposals.services.length +
          res.proposals.links.length;
        if (!count) return;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app:detect', {
            projectId,
            count,
            headline: res.headline,
            proposals: res.proposals,
            page: res.page,
            repo: res.repo,
            hosting: res.hosting,
            dns: res.dns,
            email: res.email,
            warnings: res.warnings,
          });
        }
      })
      .catch(() => {});
  }, 1200);
  pendingDetect.set(projectId, timer);
}

/** Side effects of a successful dispatch, kept out of the IPC handler body. */
function afterDispatch(action) {
  if (!action || !action.payload) return;
  if (action.type === 'link.upsert') {
    const projectId = action.payload.projectId;
    const kind = action.payload.link && action.payload.link.kind;
    if (kind === 'repo' || kind === 'live' || kind === 'staging') {
      inspect.forget(projectId);
      schedulePreview(projectId);
      scheduleDetection(projectId);
    }
  }
  if (action.type === 'link.delete') {
    inspect.forget(action.payload.projectId);
  }
  if (action.type === 'project.delete') {
    PREVIEWS.clear(action.payload.id);
    inspect.forget(action.payload.id);
  }
}

/**
 * Check GitHub Releases. The app cannot self-replace while it is ad-hoc signed,
 * so a positive result means "show the download", not "install silently".
 */
async function checkUpdates(force) {
  const settings = store ? store.vault.settings : {};
  if (!force && settings.checkUpdates === false) {
    return { ok: false, error: 'Update checks are off in Settings.', current: app.getVersion() };
  }
  const state = readUpdateState();
  if (
    !force &&
    state.checkedAt &&
    Date.now() - Date.parse(state.checkedAt) < 6 * 60 * 60 * 1000 &&
    state.result
  ) {
    return Object.assign({ cached: true }, state.result);
  }
  const headers = { accept: 'application/vnd.github+json' };
  if (settings.githubToken) headers.authorization = 'Bearer ' + settings.githubToken;
  const res = await net.fetchJson(config.RELEASES_API, { headers, maxBytes: 1024 * 1024 });
  let result;
  if (!res.ok) {
    result = {
      ok: false,
      current: app.getVersion(),
      error: res.error || 'Could not reach GitHub.',
      checkedAt: new Date().toISOString(),
    };
  } else {
    result = updates.fromRelease(res.json, app.getVersion(), process.arch);
    result.checkedAt = new Date().toISOString();
  }
  writeUpdateState({ checkedAt: result.checkedAt, result });
  return result;
}

function maybeCheckUpdates() {
  if (!app.isPackaged || !store || store.vault.settings.checkUpdates === false) return;
  const state = readUpdateState();
  if (state.checkedAt && Date.now() - Date.parse(state.checkedAt) < 24 * 60 * 60 * 1000) {
    maybeAnnounceUpdate(state.result);
    return;
  }
  checkUpdates(false)
    .then((result) => maybeAnnounceUpdate(result))
    .catch(() => {});
}

function maybeAnnounceUpdate(result) {
  if (!result || !result.ok || !result.updateAvailable) return;
  if (!store || store.vault.settings.updateSkipped === result.latest) return;
  if (updateNoticeShown === result.latest) return;
  updateNoticeShown = result.latest;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:update', result);
  }
}

// ------------------------------------------------------------ chrome & login

function loginState() {
  let state = {};
  try {
    state = app.getLoginItemSettings();
  } catch {
    /* not available on this platform */
  }
  return {
    supported: app.isPackaged,
    openAtLogin: Boolean(state.openAtLogin),
    wasOpenedAtLogin: Boolean(state.wasOpenedAtLogin),
    status: state.status || 'unknown',
  };
}

function setLoginItem(enabled) {
  if (!app.isPackaged) {
    return { ok: false, supported: false, error: 'Open at login is available in the packaged app.' };
  }
  try {
    // Electron 45 dropped openAsHidden; launching at login is detected through
    // wasOpenedAtLogin and we keep the window hidden in that case.
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    syncTray();
    broadcast();
    return { ok: true, state: loginState() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function applyDockIcon() {
  if (process.platform !== 'darwin' || !app.dock || !store) return;
  const settings = store.vault.settings;
  const style = settings.iconStyle || 'napkin';
  const tint = resolveIconTint();
  if (style === appliedIconStyle && tint === appliedIconTint) return;
  const file = (name) => path.join(__dirname, 'assets', 'icons', name + '.png');
  const candidates = [
    file(style + '--' + tint),
    file(style),
    path.join(__dirname, 'assets', 'icon.png'),
  ].filter((candidate) => fs.existsSync(candidate));
  if (!candidates.length) return;
  try {
    app.dock.setIcon(candidates[0]);
    appliedIconStyle = style;
    appliedIconTint = tint;
  } catch {
    /* the bundle icon remains */
  }
}

function resolveIconTint() {
  if (!store) return 'paper';
  const settings = store.vault.settings;
  const tint = settings.iconTint || 'auto';
  if (tint !== 'auto') return tint;
  if (settings.accent === 'custom') return model.nearestIconTint(settings.accentCustom);
  return model.ICON_TINTS.includes(settings.accent) ? settings.accent : 'paper';
}

function trayTemplate() {
  const file = path.join(__dirname, 'assets', 'trayTemplate.png');
  if (!fs.existsSync(file)) return null;
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return null;
  image.setTemplateImage(true);
  return image;
}

function trayMenu() {
  const login = loginState();
  return Menu.buildFromTemplate([
    { label: 'Show napkin++', click: showMain },
    { label: 'Quick Capture', click: showCapture },
    { label: 'Search Everything…', click: () => sendMenu('palette') },
    { type: 'separator' },
    { label: 'Settings…', click: () => sendMenu('settings') },
    {
      label: 'Open at Login',
      type: 'checkbox',
      checked: login.openAtLogin,
      enabled: login.supported,
      click: (item) => setLoginItem(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit napkin++', click: () => app.quit() },
  ]);
}

function syncTray() {
  if (!store) return;
  const enabled = store.vault.settings.menuBar !== false;
  if (!enabled) {
    if (tray) {
      tray.destroy();
      tray = null;
    }
    return;
  }
  if (!tray) {
    const image = trayTemplate();
    if (!image) return;
    tray = new Tray(image);
    tray.setToolTip('napkin++');
  }
  tray.setContextMenu(trayMenu());
}

function applySettingsSideEffects() {
  applyDockIcon();
  syncDockMenu();
  syncTray();
}

/** Right-click on the Dock icon: capture, search and new project without
 *  hunting for the window. Installed once; the menu items resolve live. */
function syncDockMenu() {
  if (process.platform !== 'darwin' || !app.dock || !store || dockMenuInstalled) return;
  try {
    app.dock.setMenu(
      Menu.buildFromTemplate([
        { label: 'Quick Capture', click: showCapture },
        { label: 'Search Everything…', click: () => sendMenu('palette') },
        { label: 'New Project', click: () => sendMenu('new-project') },
        { type: 'separator' },
        { label: 'Settings…', click: () => sendMenu('settings') },
      ])
    );
    dockMenuInstalled = true;
  } catch {
    /* older macOS or a dev run without a Dock icon */
  }
}

// -------------------------------------------------------------------- windows

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1340,
    height: 880,
    minWidth: 1040,
    minHeight: 620,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 19 },
    backgroundColor: '#f6f2ec',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!SMOKE && !startHidden) mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createQuickWindow() {
  quickWindow = new BrowserWindow({
    width: 660,
    height: 372,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    vibrancy: 'popover',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  quickWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickWindow.loadFile(path.join(__dirname, 'quick.html'));
  quickWindow.on('blur', () => {
    if (SMOKE) return;
    if (quickWindow && !quickWindow.isDestroyed() && !quickWindow.webContents.isDevToolsOpened()) {
      quickWindow.hide();
    }
  });
  quickWindow.on('closed', () => {
    quickWindow = null;
  });
}

function showMain() {
  startHidden = false;
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openProjectInMain(projectId) {
  showMain();
  if (projectId) {
    store.dispatch({ type: 'project.recent', payload: { id: projectId } });
    mainWindow.webContents.send('nav:project', { projectId });
    broadcast();
  }
}

function showCapture() {
  if (!quickWindow || quickWindow.isDestroyed()) createQuickWindow();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  const [width, height] = quickWindow.getSize();
  quickWindow.setPosition(
    Math.round(area.x + (area.width - width) / 2),
    Math.round(area.y + area.height * 0.16)
  );
  quickWindow.show();
  try {
    app.focus({ steal: true });
  } catch {
    /* best effort — show() still brings the panel forward */
  }
  quickWindow.focus();
  quickWindow.webContents.send('capture:reset');
}

function toggleCapture() {
  if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()) {
    quickWindow.hide();
    return;
  }
  showCapture();
}

// ----------------------------------------------------------------------- menu

function sendMenu(action, extra) {
  showMain();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:action', Object.assign({ action }, extra || {}));
  }
}

function buildMenu() {
  const template = [
    {
      label: 'napkin++',
      submenu: [
        { label: 'About napkin++', click: () => sendMenu('about') },
        { label: 'Check for Updates…', click: () => sendMenu('updates') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => sendMenu('settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CommandOrControl+N', click: () => sendMenu('new-project') },
        { label: 'Quick Capture', accelerator: 'CommandOrControl+Shift+N', click: () => showCapture() },
        { type: 'separator' },
        { label: 'Import Notes…', accelerator: 'CommandOrControl+I', click: () => sendMenu('import') },
        { label: 'Back Up Now', click: () => sendMenu('backup') },
        { label: 'Export Markdown…', click: () => sendMenu('export') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Search Everything', accelerator: 'CommandOrControl+K', click: () => sendMenu('palette') },
        { type: 'separator' },
        { label: 'All Projects', accelerator: 'CommandOrControl+1', click: () => sendMenu('view', { view: 'all' }) },
        { label: 'Recent', click: () => sendMenu('view', { view: 'recent' }) },
        { label: 'Favorites', click: () => sendMenu('view', { view: 'favorites' }) },
        { label: 'Archive', click: () => sendMenu('view', { view: 'archive' }) },
        { type: 'separator' },
        { label: 'Grid View', accelerator: 'CommandOrControl+Shift+G', click: () => sendMenu('grid') },
        { type: 'separator' },
        { label: 'Find Duplicates', click: () => sendMenu('duplicates') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CommandOrControl+/', click: () => sendMenu('shortcuts') },
        { type: 'separator' },
        { label: 'Send Feedback…', click: () => sendMenu('feedback') },
        { label: 'napkin++ Website', click: () => shell.openExternal(config.SITE_URL) },
        { label: 'Support the Developer', click: () => shell.openExternal(config.SUPPORT_URL) },
      ],
    },
  ];
  if (process.platform === 'darwin') {
    template[0].submenu.splice(1, 0, {
      label: 'Reveal Vault in Finder',
      click: () => shell.showItemInFolder(store.file),
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle('vault:get', () => payload());

  ipcMain.handle('vault:dispatch', (event, action) => {
    const res = store.dispatch(action);
    if (!res.ok) return { ok: false, error: res.error, state: store.vault };
    applySettingsSideEffects();
    broadcast();
    afterDispatch(action);
    return Object.assign(payload(), { result: res.result });
  });

  ipcMain.handle('vault:undo', () => {
    const res = store.undo();
    if (!res.ok) return { ok: false, error: res.error };
    applySettingsSideEffects();
    broadcast();
    return payload();
  });

  ipcMain.handle('app:login-state', () => ({ ok: true, state: loginState() }));

  ipcMain.handle('app:set-login', (event, enabled) => setLoginItem(enabled));

  ipcMain.handle('vault:backup', () => {
    store.save();
    return { ok: true, meta: store.meta() };
  });

  ipcMain.handle('vault:reveal', () => {
    shell.showItemInFolder(store.file);
    return { ok: true };
  });

  ipcMain.handle('vault:export', async (event, opts) => {
    const options = opts || {};
    const markdown = store.exportMarkdown(options.projectId, { redact: options.redact !== false });
    if (!markdown) return { ok: false, error: 'Project not found.' };
    const project = options.projectId ? model.getProject(store.vault, options.projectId) : null;
    const name = (project ? project.name : 'napkin-vault').replace(/[^a-z0-9._-]+/gi, '-').toLowerCase();
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export markdown',
      defaultPath: path.join(app.getPath('desktop'), name + '.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, markdown, 'utf8');
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle('vault:importFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a notes file',
      properties: ['openFile'],
      filters: [
        { name: 'Text notes', extensions: ['txt', 'md', 'env', 'text', 'json', 'csv'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const file = result.filePaths[0];
    const stat = fs.statSync(file);
    if (stat.size > 4 * 1024 * 1024) return { ok: false, error: 'That file is larger than 4 MB.' };
    return { ok: true, name: path.basename(file), text: fs.readFileSync(file, 'utf8') };
  });

  ipcMain.handle('app:openExternal', async (event, url) => {
    if (!/^(https?:\/\/|mailto:)/i.test(String(url || ''))) {
      return { ok: false, error: 'Only http(s) and mailto links can be opened.' };
    }
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('app:copy', (event, opts) => {
    const options = opts || {};
    const text = String(options.text || '');
    if (!text) return { ok: false, error: 'Nothing to copy.' };
    clipboard.writeText(text);
    const seconds = options.hidden ? store.vault.settings.copyClearSeconds : 0;
    if (clipTimer) clearTimeout(clipTimer);
    if (seconds > 0) {
      clipTimer = setTimeout(async () => {
        // Electron's clipboard read is async; only clear if the secret is still
        // the thing on the pasteboard.
        const current = await clipboard.readText();
        if (current === text) clipboard.clear();
      }, seconds * 1000);
    }
    event.sender.send('app:notice', {
      message: options.label ? 'Copied ' + options.label : 'Copied',
      kind: 'copy',
      clearInSeconds: seconds,
    });
    return { ok: true, clearInSeconds: seconds };
  });

  ipcMain.handle('app:notify', (event, opts) => {
    const options = opts || {};
    notify(mainWindow, options.message || '', options.kind);
    return { ok: true };
  });

  ipcMain.handle('capture:show', () => {
    showCapture();
    return { ok: true };
  });

  ipcMain.handle('capture:hide', () => {
    if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide();
    return { ok: true };
  });

  ipcMain.handle('window:openProject', (event, id) => {
    openProjectInMain(id);
    return { ok: true };
  });

  // --------------------------------------------------------- 1.0 link helpers

  ipcMain.handle('preview:capture', async (event, projectId) => {
    const res = await capturePreview(projectId, { force: true });
    if (res.ok) notify(mainWindow, 'Preview refreshed', 'preview');
    return res;
  });

  ipcMain.handle('preview:captureAll', async () => {
    let ok = 0;
    const failed = [];
    for (const project of store.vault.projects) {
      if (!previewSource(project)) continue;
      const res = await capturePreview(project.id, { force: false });
      if (res.ok) ok += 1;
      else failed.push({ name: project.name, error: res.error || '' });
    }
    notify(
      mainWindow,
      ok + (ok === 1 ? ' preview captured' : ' previews captured') +
        (failed.length ? ' · ' + failed.length + ' skipped' : ''),
      failed.length ? 'warn' : 'preview'
    );
    return { ok: true, captured: ok, failed };
  });

  ipcMain.handle('preview:clearAll', () => {
    const removed = PREVIEWS.clearAll();
    for (const project of store.vault.projects) {
      if (!project.thumb.url && !project.thumb.at) continue;
      store.dispatch({ type: 'project.thumb', payload: { projectId: project.id, url: '' } });
    }
    broadcast();
    return { ok: true, removed };
  });

  ipcMain.handle('detect:project', async (event, projectId, force) => detectionFor(projectId, Boolean(force)));

  ipcMain.handle('updates:check', async (event, force) => checkUpdates(Boolean(force)));

  ipcMain.handle('updates:state', () => ({
    ok: true,
    result: readUpdateState().result || null,
    checkedAt: readUpdateState().checkedAt || '',
    current: app.getVersion(),
  }));
}

// ---------------------------------------------------------------------- smoke

async function runSmoke() {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });
  const SHOT_DIR = process.env.NAPKIN_SHOT_DIR || path.join(__dirname, 'docs');
  const shot = (name) => path.join(SHOT_DIR, name);
  const clearToasts = async () => {
    await mainWindow.webContents.executeJavaScript(
      "document.querySelectorAll('#toasts .toast').forEach((n) => n.remove())",
      true
    );
    await delay(160);
  };
  const exec = async (code) => {
    try {
      return await mainWindow.webContents.executeJavaScript(code, true);
    } catch (err) {
      process.stdout.write(
        JSON.stringify(
          { ok: false, error: err.message, code: code.replace(/\s+/g, ' ').slice(0, 200), checks },
          null,
          2
        ) + '\n'
      );
      throw new Error('EXEC FAILED [' + code.replace(/\s+/g, ' ').slice(0, 160) + ']: ' + err.message);
    }
  };

  mainWindow.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      process.stderr.write(
        'renderer: ' + event.message + ' (' + (event.sourceId || '') + ':' + event.lineNumber + ')\n'
      );
    }
  });

  await new Promise((resolve) => {
    if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', resolve);
    else resolve();
  });
  mainWindow.showInactive();
  await delay(500);

  check('chrome.tray', Boolean(tray), tray ? 'created' : 'missing trayTemplate.png');
  check(
    'chrome.dock-icon',
    appliedIconStyle === (store.vault.settings.iconStyle || 'napkin'),
    String(appliedIconStyle)
  );

  const firstRun = await exec(`(() => ({
    empty: Boolean(document.querySelector('#detail .empty-state')),
    rows: document.querySelectorAll('[data-project-row]').length,
    title: document.title,
    projects: [...document.querySelectorAll('[data-count]')].map((n) => n.textContent)
  }))()`);
  check(
    'ui.first-run',
    firstRun.empty && firstRun.rows === 0 && firstRun.title === 'napkin++' && firstRun.projects.every((n) => n === '0'),
    JSON.stringify(firstRun)
  );

  const created = store.dispatch({
    type: 'project.create',
    payload: { name: 'lu app', description: 'Client portal for Lu', tags: ['client', 'dev'], stack: ['Next.js', 'Supabase'] },
  });
  check('vault.create', created.ok);
  const projectId = created.ok ? created.result.projectId : null;

  if (projectId) {
    store.dispatch({
      type: 'link.upsert',
      payload: { projectId, link: { label: 'Repo', url: 'https://github.com/acme/lu', kind: 'repo' } },
    });
    store.dispatch({
      type: 'link.upsert',
      payload: { projectId, link: { label: 'Live', url: 'https://lu.app', kind: 'live' } },
    });
    store.dispatch({
      type: 'service.upsert',
      payload: { projectId, service: { provider: 'Vercel', role: 'hosting', url: 'https://vercel.com/acme/lu' } },
    });
    store.dispatch({
      type: 'service.upsert',
      payload: { projectId, service: { provider: 'Resend', role: 'email', url: 'https://resend.com/api-keys' } },
    });
    store.dispatch({
      type: 'account.upsert',
      payload: {
        projectId,
        account: {
          label: 'test-1',
          email: 'one@lu.app',
          env: 'dev',
          fields: [{ label: 'Password', value: 'smoke-pass', hidden: true }],
        },
      },
    });
    store.dispatch({
      type: 'env.vars.add',
      payload: {
        projectId,
        envName: 'dev',
        vars: [
          { key: 'APP_NAME', value: 'lu' },
          { key: 'SUPABASE_URL', value: 'https://xyz.supabase.co' },
        ],
      },
    });
    store.dispatch({
      type: 'entry.upsert',
      payload: {
        projectId,
        entry: {
          type: 'snippet',
          title: 'supabase client',
          language: 'ts',
          body: 'import { createClient } from "@supabase/supabase-js";\n\nconst client = createClient(\n  process.env.SUPABASE_URL,\n  process.env.SUPABASE_ANON_KEY\n);\n\nexport default client;',
        },
      },
    });
    broadcast();
    await delay(400);
  }

  const dom = await exec(`(() => ({
    title: document.title,
    rows: document.querySelectorAll('[data-project-row]').length,
    detailName: (document.querySelector('#detail [data-project-name]') || {}).textContent || '',
    tabs: document.querySelectorAll('[data-tab]').length,
    theme: document.documentElement.dataset.theme
  }))()`);
  check('ui.render', dom.rows >= 1 && dom.tabs >= 5, JSON.stringify(dom));

  await exec(`(() => {
    const el = document.querySelector('[data-project-row]');
    if (el) el.click();
  })()`);
  await delay(250);

  await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`);
  await delay(150);
  const paletteOpen = await exec(`!document.querySelector('#palette').classList.contains('hidden')`);
  check('ui.palette-opens', paletteOpen);

  const paletteRows = await exec(`(() => {
    const input = document.querySelector('#palette-input');
    input.value = 'resend';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelectorAll('#palette-results [data-result]').length;
  })()`);
  check('ui.palette-search', paletteRows >= 1, String(paletteRows));
  await delay(200);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(shot('preview-palette.png'), (await mainWindow.webContents.capturePage()).toPNG());

  await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await delay(200);

  const accountTab = await exec(`(() => {
    const tab = document.querySelector('[data-tab="accounts"]');
    if (tab) tab.click();
    return true;
  })()`);
  check('ui.account-tab', accountTab);
  await delay(250);
  const accountRows = await exec(`document.querySelectorAll('[data-account-row]').length`);
  check('ui.accounts-visible', accountRows >= 1, String(accountRows));

  await exec(`document.querySelector('[data-action="add-account"]').click()`);
  await delay(250);
  const filled = await exec(`(() => {
    const f = document.querySelector('#modal-form');
    if (!f) return 'no-form';
    f.querySelector('[name="label"]').value = 'test-2';
    f.querySelector('[name="email"]').value = 'two@lu.app';
    f.querySelector('[name="env"]').value = 'staging';
    const rows = f.querySelectorAll('[data-field-row]');
    if (rows[0]) rows[0].querySelector('[data-field-value]').value = 'smoke-pass';
    f.requestSubmit();
    return 'ok';
  })()`);
  await delay(500);
  const acctCount = await exec(`document.querySelectorAll('[data-account-row]').length`);
  check('ui.add-account-modal', acctCount >= 2, filled + ':' + acctCount);
  await clearToasts();
  fs.writeFileSync(shot('preview-accounts.png'), (await mainWindow.webContents.capturePage()).toPNG());

  await exec(`document.querySelector('[data-tab="env"]').click()`);
  await delay(200);
  await exec(`document.querySelector('[data-action="paste-env"]').click()`);
  await delay(250);
  await exec(`(() => {
    const f = document.querySelector('#modal-form');
    f.querySelector('[name="blob"]').value = 'APP_NAME=smoke' + String.fromCharCode(10) + 'PORT=4100';
    f.querySelector('[name="env"]').value = 'staging';
    f.requestSubmit();
  })()`);
  await delay(600);
  const varCount = await exec(`document.querySelectorAll('[data-var-row]').length`);
  check('ui.paste-env', varCount >= 2, String(varCount));
  await clearToasts();
  fs.writeFileSync(shot('preview-env.png'), (await mainWindow.webContents.capturePage()).toPNG());

  await exec(`document.querySelector('[data-tab="notes"]').click()`);
  await delay(200);
  await exec(`(() => {
    const f = document.querySelector('form[data-form="add-entry"]');
    const body = f.querySelector('textarea[name="body"]');
    body.value = 'const a = {' + String.fromCharCode(10) + '  b: 1' + String.fromCharCode(10) + '};';
    body.dispatchEvent(new Event('input', { bubbles: true }));
    f.requestSubmit();
  })()`);
  await delay(500);
  const entryCount = await exec(`document.querySelectorAll('[data-entry-card]').length`);
  check('ui.add-entry', entryCount >= 2, String(entryCount));

  await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }))`);
  await delay(250);
  await exec(`(() => {
    const f = document.querySelector('#modal-form');
    f.querySelector('[name="name"]').value = 'lu-app';
    f.requestSubmit();
  })()`);
  await delay(400);
  const mergeCards = await exec(`document.querySelectorAll('#modal .merge-card').length`);
  check('ui.duplicate-sheet', mergeCards >= 1, String(mergeCards));
  await exec(`document.querySelector('#modal [data-action="create-anyway"]').click()`);
  await delay(600);
  const projectCount = await exec(`document.querySelectorAll('[data-project-row]').length`);
  check('ui.keep-separate', projectCount === 2, String(projectCount));

  await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`);
  await delay(200);
  const copyHit = await exec(`(() => {
    const input = document.querySelector('#palette-input');
    input.value = 'PORT';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const first = document.querySelector('#palette-results [data-result]');
    return first ? first.textContent.replace(/\s+/g, ' ') : '';
  })()`);
  await exec(`document.querySelector('#palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))`);
  await delay(450);
  const copied = await clipboard.readText();
  check('ui.palette-copy', copied === '4100', 'clip=' + copied + ' hit=' + copyHit);

  await exec(`(() => {
    const rows = [...document.querySelectorAll('[data-project-row]')];
    const row = rows.find((r) => (r.querySelector('.pc-name') || {}).textContent.trim() === 'lu app');
    if (row) row.click();
  })()`);
  await delay(300);
  await exec(`(() => {
    const tab = document.querySelector('[data-tab="overview"]');
    if (tab) tab.click();
  })()`);
  await delay(250);
  await clearToasts();
  fs.writeFileSync(shot('preview.png'), (await mainWindow.webContents.capturePage()).toPNG());

  const light = store.dispatch({ type: 'settings.update', payload: { patch: { theme: 'light' } } });
  check('theme.light', light.ok);
  broadcast();
  await delay(350);
  await exec(`(() => { const tab = document.querySelector('[data-tab="notes"]'); if (tab) tab.click(); })()`);
  await delay(300);
  fs.writeFileSync(shot('preview-light.png'), (await mainWindow.webContents.capturePage()).toPNG());
  store.dispatch({ type: 'settings.update', payload: { patch: { theme: 'system' } } });
  broadcast();
  await delay(200);

  showCapture();
  await delay(500);
  check('quick.opens', quickWindow && quickWindow.isVisible());
  if (quickWindow) {
    fs.writeFileSync(shot('preview-quick.png'), (await quickWindow.webContents.capturePage()).toPNG());
    const quickRows = await quickWindow.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('#quick-input');
        input.value = 'STRIPE_KEY=sk_test_123';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return [...document.querySelectorAll('#quick-rows .row')].map((row) =>
          row.textContent.replace(/\\s+/g, ' ').trim()
        );
      })()`,
      true
    );
    check(
      'quick.env-single-var',
      quickRows.length >= 1 &&
        quickRows[0].includes('Add 1 env var') &&
        !quickRows.join(' ').includes('Create project'),
      JSON.stringify(quickRows)
    );

    const alt = store.vault.projects.find((p) => p.name.startsWith('lu-app'));
    store.dispatch({
      type: 'env.vars.add',
      payload: {
        projectId: alt.id,
        envName: 'production',
        vars: [{ key: 'EXISTING', value: '1' }],
      },
    });
    store.dispatch({ type: 'project.recent', payload: { id: alt.id } });
    broadcast();
    await delay(400);
    const quickProduction = await quickWindow.webContents.executeJavaScript(
      `(() => {
        const select = document.querySelector('#target');
        select.value = ${JSON.stringify(alt.id)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const input = document.querySelector('#quick-input');
        input.value = 'FOO_BAR=2';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return {
          visible: select.offsetParent !== null,
          rows: [...document.querySelectorAll('#quick-rows .row')].map((row) =>
            row.textContent.replace(/\\s+/g, ' ').trim()
          )
        };
      })()`,
      true
    );
    await quickWindow.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('#quick-input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`,
      true
    );
    await delay(800);
    const altProject = store.vault.projects.find((p) => p.id === alt.id);
    const production = altProject.envs.find((e) => e.name === 'production');
    check(
      'quick.env-target',
      quickProduction.visible &&
        quickProduction.rows.some((row) => row.includes('production')) &&
        production &&
        production.vars.some((v) => v.key === 'FOO_BAR') &&
        !altProject.envs.some((e) => e.name === 'dev'),
      JSON.stringify(quickProduction)
    );
    quickWindow.hide();
  }

  await exec(`document.querySelector('[data-action="import"]').click()`);
  await delay(300);
  await exec(`(() => {
    const f = document.querySelector('#modal-form');
    const ta = f.querySelector('[name="blob"]');
    ta.value = 'digital ocean ta.org new' + String.fromCharCode(10, 10) + 'database pw';
  })()`);
  await exec(`document.querySelector('#modal [data-action="submit-modal"]').click()`);
  await delay(800);
  const importedCount = await exec(`document.querySelectorAll('[data-project-row]').length`);
  const importedName = await exec(`(() => {
    const rows = [...document.querySelectorAll('[data-project-row]')];
    return rows.some((r) => r.textContent.includes('digital ocean ta.org new'));
  })()`);
  check('ui.import-without-preview', importedCount === 3 && importedName, importedCount + ':' + importedName);

  await exec(`document.querySelector('[data-action="import"]').click()`);
  await delay(300);
  await exec(`(() => {
    const f = document.querySelector('#modal-form');
    const ta = f.querySelector('[name="blob"]');
    ta.value = 'alpha plugin' + String.fromCharCode(10, 10) + 'beta plugin';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(700);
  const autoRows = await exec(`document.querySelectorAll('[data-import-row]').length`);
  check('ui.import-auto-preview', autoRows === 1, String(autoRows));

  await exec(`(() => {
    const cb = document.querySelector('#import-single');
    if (cb) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
  await delay(300);
  const singleName = await exec(`(() => {
    const field = document.querySelector('#import-single-name');
    return field ? field.value : '';
  })()`);
  check('ui.import-single-mode', singleName === 'alpha plugin', singleName);
  await exec(`document.querySelector('#modal [data-action="submit-modal"]').click()`);
  await delay(800);
  const singleCount = await exec(`document.querySelectorAll('[data-project-row]').length`);
  check('ui.import-single-project', singleCount === 4, String(singleCount));
  await exec(`document.querySelector('#modal [data-action="close-modal"]')?.click()`);

  // ---------------------------------------------------------- v0.2 features

  await exec(`(() => {
    const rows = [...document.querySelectorAll('[data-project-row]')];
    const row = rows.find((r) => (r.querySelector('.pc-name') || {}).textContent.trim() === 'lu app');
    if (row) row.click();
  })()`);
  await delay(300);

  const folder = store.dispatch({
    type: 'folder.create',
    payload: { name: 'Clients', color: '#5c7a4f' },
  });
  store.dispatch({
    type: 'project.update',
    payload: { id: projectId, patch: { folderId: folder.result.folder.id } },
  });
  broadcast();
  await delay(350);
  const folderUi = await exec(`(() => ({
    rows: document.querySelectorAll('[data-folder-row]').length,
    border: getComputedStyle(document.querySelector('[data-project-row][data-id="${projectId}"]')).borderLeftColor
  }))()`);
  check('ui.folders', folderUi.rows >= 1 && folderUi.border.includes('92, 122, 79'), JSON.stringify(folderUi));

  await exec(`document.querySelector('[data-action="new-folder"]').click()`);
  await delay(300);
  const folderModal = await exec(`(() => {
    const form = document.querySelector('#modal-form');
    return {
      name: Boolean(form && form.querySelector('[name="name"]')),
      swatches: document.querySelectorAll('#modal-form .folder-swatches .swatch').length,
      color: form ? form.querySelector('[name="color"]').value : ''
    };
  })()`);
  check(
    'ui.folder-modal',
    folderModal.name && folderModal.swatches === 8 && /^#[0-9a-f]{6}$/i.test(folderModal.color),
    JSON.stringify(folderModal)
  );
  await exec(`document.querySelector('#modal [data-action="close-modal"]').click()`);
  await delay(200);

  await exec(`document.querySelector('[data-folder-row]').click()`);
  await delay(350);
  await exec(`document.querySelector('[data-action="edit-folder"]').click()`);
  await delay(300);
  const editFolder = await exec(`(() => ({
    name: (document.querySelector('#modal-form [name="name"]') || {}).value || '',
    color: (document.querySelector('#modal-form [name="color"]') || {}).value || ''
  }))()`);
  check(
    'ui.folder-edit',
    editFolder.name === 'Clients' && /^#[0-9a-f]{6}$/i.test(editFolder.color),
    JSON.stringify(editFolder)
  );
  await exec(`document.querySelector('#modal [data-action="close-modal"]').click()`);
  await delay(200);
  await exec(`document.querySelector('[data-action="clear-folder"]').click()`);
  await delay(250);

  await exec(`document.querySelector('[data-action="edit-details"]').click()`);
  await delay(300);
  const detailsModal = await exec(`(() => ({
    fields: document.querySelectorAll('#modal-form .input').length,
    folder: [...document.querySelectorAll('#modal-form [name="folderId"] option')].some((o) => o.textContent.includes('Clients')),
    status: Boolean(document.querySelector('#modal-form [name="status"]')),
    mergeButton: Boolean(document.querySelector('#modal [data-action="open-merge"]'))
  }))()`);
  await exec(`document.querySelector('#modal [data-action="open-merge"]').click()`);
  await delay(350);
  const mergeFromDetails = await exec(`(() => ({
    picker: document.querySelectorAll('.merge-pick').length,
    kept: (document.querySelector('.merge-pick.keep .merge-pick-name') || { textContent: '' }).textContent.trim(),
    name: Boolean(document.querySelector('#modal-form [name="mergeName"]'))
  }))()`);
  check(
    'ui.project-details',
    detailsModal.fields >= 4 &&
      detailsModal.folder &&
      detailsModal.status &&
      detailsModal.mergeButton &&
      mergeFromDetails.picker >= 2 &&
      mergeFromDetails.kept === 'lu app' &&
      mergeFromDetails.name,
    JSON.stringify(detailsModal) + ' merge=' + JSON.stringify(mergeFromDetails)
  );
  await exec(`document.querySelector('#modal [data-action="close-modal"]').click()`);
  await delay(200);

  await exec(`document.querySelector('[data-folder-row]').click()`);
  await delay(400);
  const folderFilter = await exec(`(() => ({
    rows: document.querySelectorAll('[data-project-row]').length,
    scope: (document.querySelector('#list-scope') || { textContent: '' }).textContent.trim()
  }))()`);
  check(
    'ui.folder-filter',
    folderFilter.rows === 1 && folderFilter.scope.includes('Clients'),
    JSON.stringify(folderFilter)
  );
  await clearToasts();
  fs.writeFileSync(shot('preview-folders.png'), (await mainWindow.webContents.capturePage()).toPNG());
  await exec(`document.querySelector('[data-action="clear-folder"]').click()`);
  await delay(300);

  const dragData = await exec(`(() => {
    const card = [...document.querySelectorAll('[data-project-row]')].find((row) => (row.querySelector('.pc-name') || {}).textContent.trim() === 'alpha plugin');
    const folder = document.querySelector('[data-folder-row]');
    if (!card || !folder) return 'missing';
    const data = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
    folder.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    folder.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    return data.getData('text/plain');
  })()`);
  await delay(700);
  const dragged = store.vault.projects.find((p) => p.name === 'alpha plugin');
  check(
    'ui.folder-drag-drop',
    dragData !== 'missing' && dragged && dragged.folderId === folder.result.folder.id,
    dragData + ':' + (dragged ? dragged.folderId : 'none')
  );

  await exec(`document.querySelector('[data-tab="env"]').click()`);
  await delay(250);
  await exec(`document.querySelector('[data-var-row] [data-action="edit-var"]').click()`);
  await delay(250);
  const editStart = await exec(`(() => {
    const key = document.querySelector('.var-row.editing [data-var-key]');
    const value = document.querySelector('.var-row.editing [data-var-value-input]');
    if (!key || !value) {
      return {
        result: 'no-inputs',
        rows: document.querySelectorAll('.var-row').length,
        editing: document.querySelectorAll('.var-row.editing').length
      };
    }
    key.value = 'APP_TITLE';
    value.value = 'lu-app';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { result: 'ok' };
  })()`);
  await delay(700);
  const editedVar = store.vault.projects
    .find((p) => p.id === projectId)
    .envs.some((e) => e.vars.some((v) => v.key === 'APP_TITLE' && v.value === 'lu-app'));
  check('ui.var-inline-edit', editStart.result === 'ok' && editedVar, JSON.stringify(editStart) + ':' + editedVar);

  await exec(`document.querySelector('[data-var-row] [data-action="edit-var"]').click()`);
  await delay(250);
  const cancelled = await exec(`(() => {
    const key = document.querySelector('.var-row.editing [data-var-key]');
    if (!key) return 'no-inputs';
    key.value = 'SHOULD_NOT_SAVE';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return document.querySelectorAll('.var-row.editing').length;
  })()`);
  await delay(350);
  const nothingSaved = !store.vault.projects
    .find((p) => p.id === projectId)
    .envs.some((e) => e.vars.some((v) => v.key === 'SHOULD_NOT_SAVE'));
  check('ui.var-edit-escape', cancelled === 0 && nothingSaved, String(cancelled));

  const copyBefore = await exec(`(() => {
    const cell = document.querySelector('.var-value.copy-field');
    return {
      found: Boolean(cell),
      selection: String(window.getSelection()),
      action: cell ? cell.dataset.action : '',
      key: cell ? cell.dataset.copyKey : '',
      value: cell ? cell.dataset.value : '',
      count: document.querySelectorAll('.var-row').length
    };
  })()`);
  await exec(`document.querySelector('.var-value.copy-field').click()`);
  await delay(600);
  const copyUi = await exec(`(() => ({
    cell: document.querySelector('.var-value.copy-field').classList.contains('copied'),
    button: document.querySelector('.copy-btn.copied') !== null
  }))()`);
  const copiedText = await clipboard.readText();
  check(
    'ui.copy-checkmark',
    copyUi.cell && copyUi.button && copiedText.length > 0,
    JSON.stringify(copyUi) + ' before=' + JSON.stringify(copyBefore) + ' clip=' + copiedText
  );
  await exec(`(() => {
    const rows = [...document.querySelectorAll('[data-project-row]')];
    const other = rows.find((r) => (r.querySelector('.pc-name') || {}).textContent.trim() !== 'lu app');
    if (other) other.click();
  })()`);
  await delay(350);
  await exec(`document.querySelector('[data-project-row][data-id="${projectId}"]').click()`);
  await delay(400);
  await exec(`document.querySelector('[data-tab="env"]').click()`);
  await delay(300);
  const copyPersisted = await exec(`document.querySelectorAll('.copy-btn.copied').length > 0`);
  check('ui.copy-checkmark-persists', copyPersisted, String(copyPersisted));

  // The smoke window starts inactive. Give keyboard focus to the renderer
  // before testing the context menu’s focus transfer.
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.focus();
  await delay(100);
  const ctxState = await exec(`(async () => {
    const row = document.querySelector('[data-project-row][data-id="${projectId}"]');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 300 }));
    const menu = document.querySelector('#ctx-menu');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const state = {
      open: !menu.classList.contains('hidden'),
      items: menu.querySelectorAll('[data-ctx-action]').length,
      focused: menu.contains(document.activeElement),
      activeElement: document.activeElement?.tagName,
      windowFocused: document.hasFocus(),
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return state;
  })()`);
  check('ui.project-context-menu', ctxState.open && ctxState.items >= 8 && ctxState.focused, JSON.stringify(ctxState));

  await exec(`(() => {
    const row = document.querySelector('[data-project-row][data-id="${projectId}"]');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
  })()`);
  await delay(250);
  await clearToasts();
  fs.writeFileSync(shot('preview-context.png'), (await mainWindow.webContents.capturePage()).toPNG());
  await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await delay(200);

  const mergeUi = await exec(`(() => {
    const row = document.querySelector('[data-project-row][data-id="${projectId}"]');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 300 }));
    document.querySelector('[data-ctx-action="ctx-merge"]').click();
    return {
      picks: document.querySelectorAll('.merge-pick').length,
      name: Boolean(document.querySelector('#modal-form [name="mergeName"]')),
      chips: document.querySelectorAll('#merge-name-chips .chip').length
    };
  })()`);
  check('ui.merge-picker', mergeUi.picks >= 2 && mergeUi.name && mergeUi.chips >= 1, JSON.stringify(mergeUi));
  await exec(`document.querySelector('#modal [data-action="close-modal"]').click()`);
  await delay(250);

  await exec(`document.querySelector('[data-tab="overview"]').click()`);
  await delay(250);
  const captureChips = await exec(`(() => {
    const box = document.querySelector('[data-capture-input]');
    if (!box) return 'no-box';
    box.value = ['CAPTURE_ONE=hello', 'Repo: https://github.com/acme/extra', 'remember the milk'].join(String.fromCharCode(10));
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelectorAll('[data-capture-plan] .capture-chip').length;
  })()`);
  await exec(`document.querySelector('[data-action="file-capture"]').click()`);
  await delay(900);
  const captured = store.vault.projects.find((p) => p.id === projectId);
  const captureOk =
    captured.envs.some((e) => e.vars.some((v) => v.key === 'CAPTURE_ONE')) &&
    captured.links.some((l) => l.url.includes('acme/extra')) &&
    captured.entries.some((e) => e.body.includes('remember the milk'));
  const captureBtn = await exec(`(() => {
    const button = document.querySelector('[data-action="file-capture"]');
    return button ? { disabled: button.disabled, opacity: getComputedStyle(button).opacity } : null;
  })()`);
  check(
    'ui.project-capture',
    captureChips >= 3 && captureOk,
    captureChips + ':' + captureOk + ' button=' + JSON.stringify(captureBtn)
  );

  // ------------------------------------------------------------ v1.0 checks

  // Seed one real preview file so the list, the grid and the napkin-thumb://
  // protocol are exercised without the network. Everything else keeps its
  // letter tile.
  const seedSource = path.join(__dirname, 'docs', 'preview-light.png');
  const previewSeed = path.join(DATA_DIR, 'previews', projectId + '.png');
  fs.mkdirSync(path.dirname(previewSeed), { recursive: true });
  const seedImage = nativeImage
    .createFromPath(fs.existsSync(seedSource) ? seedSource : path.join(__dirname, 'assets', 'icon.png'))
    .resize({ width: 640, quality: 'good' });
  fs.writeFileSync(previewSeed, seedImage.toPNG());
  store.dispatch({
    type: 'project.thumb',
    payload: { projectId, url: 'https://lu.app', source: 'live' },
  });
  broadcast();
  await delay(450);
  const previewUi = await exec(`(async () => {
    const img = document.querySelector('[data-project-row][data-id="${projectId}"] img[data-thumb]');
    if (!img) return { found: false };
    if (!img.complete || !img.naturalWidth) {
      await new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 1500);
      });
    }
    return { found: true, width: img.naturalWidth, src: img.getAttribute('src') };
  })()`);
  check(
    'ui.preview-image',
    previewUi.found && previewUi.width > 0 && String(previewUi.src).startsWith('napkin-thumb://'),
    JSON.stringify(previewUi)
  );

  await clearToasts();
  await exec(`document.querySelector('[data-action="toggle-grid"]').click()`);
  await delay(500);
  const gridState = await exec(`(() => ({
    on: document.querySelector('#project-list').classList.contains('grid'),
    cards: document.querySelectorAll('[data-grid-card]').length,
    rows: document.querySelectorAll('[data-project-row]').length,
    tiles: document.querySelectorAll('.thumb-tile.lg').length,
    letters: document.querySelectorAll('.thumb-tile .thumb-letter').length,
    pressed: document.querySelector('[data-action="toggle-grid"]').getAttribute('aria-pressed')
  }))()`);
  check(
    'ui.grid-view',
    gridState.on &&
      gridState.rows >= 4 &&
      gridState.cards === gridState.rows &&
      gridState.tiles === gridState.rows &&
      gridState.letters >= 1 &&
      gridState.pressed === 'true',
    JSON.stringify(gridState)
  );
  check('ui.grid-persisted', store.vault.settings.projectView === 'grid', store.vault.settings.projectView);
  await clearToasts();
  fs.writeFileSync(shot('preview-grid.png'), (await mainWindow.webContents.capturePage()).toPNG());
  await exec(`document.querySelector('[data-action="toggle-grid"]').click()`);
  await delay(450);
  const listState = await exec(`(() => ({
    on: !document.querySelector('#project-list').classList.contains('grid'),
    cards: document.querySelectorAll('[data-grid-card]').length
  }))()`);
  check('ui.list-view', listState.on && listState.cards === 0, JSON.stringify(listState));

  await exec(`document.querySelector('[data-tab="overview"]').click()`);
  await delay(250);
  await exec(`document.querySelector('[data-action="detect-details"]').click()`);
  await delay(900);
  const detectUi = await exec(`(() => ({
    open: !document.querySelector('#modal').classList.contains('hidden'),
    title: (document.querySelector('.sheet-title') || {}).textContent || '',
    groups: document.querySelectorAll('.detect-group').length,
    items: document.querySelectorAll('[data-detect-item]').length,
    checked: document.querySelectorAll('[data-detect-item]:checked').length,
    apply: Boolean(document.querySelector('[data-action="apply-detection"]') && !document.querySelector('[data-action="apply-detection"]').disabled),
    hosting: [...document.querySelectorAll('.detect-facts .chip')].map((c) => c.textContent.trim())
  }))()`);
  check(
    'ui.detect-sheet',
    detectUi.open &&
      detectUi.title === 'Detect details' &&
      detectUi.groups >= 3 &&
      detectUi.items >= 4 &&
      detectUi.checked === detectUi.items &&
      detectUi.apply &&
      detectUi.hosting.some((text) => text.includes('Vercel')),
    JSON.stringify(detectUi)
  );
  await clearToasts();
  fs.writeFileSync(shot('preview-detect.png'), (await mainWindow.webContents.capturePage()).toPNG());
  await exec(`document.querySelector('[data-action="apply-detection"]').click()`);
  await delay(900);
  const enriched = store.vault.projects.find((p) => p.id === projectId);
  check(
    'ui.detect-apply',
    enriched.stack.includes('Next.js') &&
      enriched.tags.includes('nextjs') &&
      enriched.services.some((s) => s.provider === 'Neon') &&
      enriched.entries.some((e) => e.title === 'Detected setup'),
    JSON.stringify({
      stack: enriched.stack,
      tags: enriched.tags,
      services: enriched.services.map((s) => s.provider),
      entries: enriched.entries.map((e) => e.title),
    })
  );
  await clearToasts();

  await exec(`document.querySelector('[data-action="open-feedback"]').click()`);
  await delay(400);
  const feedbackUi = await exec(`(() => {
    const box = document.querySelector('#feedback-message');
    if (box) {
      box.value = 'The grid view did not remember my choice.';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return {
      open: !document.querySelector('#modal').classList.contains('hidden'),
      kind: Boolean(document.querySelector('#feedback-kind')),
      diagnostics: (document.querySelector('[data-diagnostics]') || {}).textContent || '',
      chars: box ? box.value.length : 0
    };
  })()`);
  check(
    'ui.feedback-sheet',
    feedbackUi.open &&
      feedbackUi.kind &&
      feedbackUi.chars > 10 &&
      feedbackUi.diagnostics.includes('napkin++') &&
      feedbackUi.diagnostics.includes('Vault:'),
    JSON.stringify({ open: feedbackUi.open, kind: feedbackUi.kind, chars: feedbackUi.chars })
  );
  clipboard.writeText('');
  await exec(`document.querySelector('[data-action="copy-report"]').click()`);
  await delay(500);
  const reportClip = await clipboard.readText();
  check(
    'ui.feedback-copy',
    reportClip.includes('napkin++') && reportClip.includes('grid view did not remember'),
    reportClip.slice(0, 90)
  );
  await exec(`document.querySelector('#modal [data-action="close-modal"]').click()`);
  await delay(250);

  await exec(`document.querySelector('[data-action="settings"]').click()`);
  await delay(400);
  const releaseSettings = await exec(`(() => ({
    previews: Boolean(document.querySelector('#modal [data-action="toggle-previews"]')),
    detect: Boolean(document.querySelector('#modal [data-action="toggle-detect"]')),
    updates: Boolean(document.querySelector('#modal [data-action="toggle-updates"]')),
    token: Boolean(document.querySelector('#modal [name="githubToken"]')),
    about: Boolean(document.querySelector('#modal [data-action="about"]'))
  }))()`);
  check(
    'ui.settings-release',
    releaseSettings.previews && releaseSettings.detect && releaseSettings.updates && releaseSettings.token && releaseSettings.about,
    JSON.stringify(releaseSettings)
  );
  await exec(`document.querySelector('#modal [data-action="toggle-previews"]').click()`);
  await delay(500);
  const previewsOff = store.vault.settings.previews === false;
  await exec(`document.querySelector('#modal [data-action="toggle-previews"]').click()`);
  await delay(500);
  check(
    'ui.previews-switch',
    previewsOff && store.vault.settings.previews === true,
    previewsOff + ':' + store.vault.settings.previews
  );
  await exec(`document.querySelector('#modal [data-action="about"]').click()`);
  await delay(500);
  const aboutUi = await exec(`(() => ({
    title: (document.querySelector('.sheet-title') || {}).textContent || '',
    version: (document.querySelector('.about-version') || {}).textContent || '',
    check: Boolean(document.querySelector('[data-action="check-updates"]')),
    diagnostics: Boolean(document.querySelector('[data-action="copy-diagnostics"]'))
  }))()`);
  check(
    'ui.about-sheet',
    aboutUi.title === 'napkin++' &&
      aboutUi.version.includes(app.getVersion()) &&
      aboutUi.check &&
      aboutUi.diagnostics,
    JSON.stringify(aboutUi)
  );
  await clearToasts();
  fs.writeFileSync(shot('preview-about.png'), (await mainWindow.webContents.capturePage()).toPNG());

  // Offline, the update check must fail with a sentence rather than a stack.
  await exec(`document.querySelector('#modal [data-action="check-updates"]').click()`);
  await delay(900);
  const updateUi = await exec(`(() => ({
    disabled: Boolean(document.querySelector('#modal [data-action="check-updates"]')?.disabled),
    hint: (document.querySelector('#modal .hint') || {}).textContent || '',
    toast: [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).join(' ')
  }))()`);
  check(
    'ui.update-check-offline',
    !updateUi.disabled && /off|reach|latest|version/i.test(updateUi.hint + ' ' + updateUi.toast),
    JSON.stringify(updateUi)
  );
  await exec(`document.querySelector('#modal [data-action="close-modal"]').click()`);
  await delay(250);

  await exec(`document.querySelector('[data-action="settings"]').click()`);
  await delay(350);
  const customAccent = store.dispatch({
    type: 'settings.update',
    payload: { patch: { accent: 'custom', accentCustom: '#336699', palette: 'slate' } },
  });
  broadcast();
  await delay(400);
  const customUi = await exec(`(() => ({
    accent: document.documentElement.dataset.accent,
    palette: document.documentElement.dataset.palette,
    base: getComputedStyle(document.documentElement).getPropertyValue('--accent-base').trim()
  }))()`);
  check(
    'ui.custom-accent',
    customAccent.ok && customUi.accent === 'custom' && customUi.palette === 'slate' && customUi.base === '#336699',
    JSON.stringify(customUi)
  );
  await exec(`document.querySelector('[data-action="set-palette"][data-palette="nord"]').click()`);
  await delay(350);
  const palette = await exec(`document.documentElement.dataset.palette`);
  check('ui.palette-switch', palette === 'nord', palette);
  await exec(`document.querySelector('[data-action="set-icon-tint"][data-tint="plum"]').click()`);
  await delay(350);
  const tintMeta = await exec(`window.napkin.getState().then((res) => res.meta)`);
  check('ui.dock-tint', tintMeta.dockTint === 'plum', String(tintMeta.dockTint));
  check('ui.dock-menu', tintMeta.dockMenu === true, String(tintMeta.dockMenu));
  await exec(`document.querySelector('#modal [data-action="close-modal"]').click()`);
  await delay(250);

  await exec(`document.querySelector('[data-action="settings"]').click()`);
  await delay(400);
  const settings = await exec(`(() => ({
    icons: document.querySelectorAll('#modal .icon-choice').length,
    loaded: [...document.querySelectorAll('#modal .icon-choice img')].every((img) => img.complete && img.naturalWidth > 0),
    loginDisabled: document.querySelector('#modal [data-action="toggle-login"]').disabled
  }))()`);
  check('ui.settings-icons', settings.icons === 4 && settings.loaded, JSON.stringify(settings));
  check('ui.login-switch', settings.loginDisabled === !app.isPackaged, String(settings.loginDisabled));

  await exec(`document.querySelector('#modal [data-action="set-accent"][data-accent="moss"]').click()`);
  await delay(350);
  const accent = await exec(`document.documentElement.dataset.accent`);
  check('ui.accent-switch', accent === 'moss', accent);

  await exec(`document.querySelector('#modal [data-action="set-icon"][data-icon="ink"]').click()`);
  await delay(350);
  const iconActive = await exec(`(() => {
    const el = document.querySelector('#modal .icon-choice.active');
    return el ? el.textContent.trim() : '';
  })()`);
  check('ui.dock-icon-switch', iconActive === 'Ink', iconActive);
  const appliedIcon = await exec(`window.napkin.getState().then((res) => res.meta.dockIcon)`);
  check('ui.dock-icon-applied', appliedIcon === 'ink', String(appliedIcon));
  await clearToasts();
  fs.writeFileSync(shot('preview-settings.png'), (await mainWindow.webContents.capturePage()).toPNG());
  await exec(`document.querySelector('#modal [data-action="save-settings"]').click()`);
  await delay(400);

  await exec(`document.querySelector('[data-action="settings"]').click()`);
  await delay(300);
  await exec(`document.querySelector('#modal [data-action="toggle-menubar"]').click()`);
  await delay(400);
  const trayOff = await exec(`window.napkin.getState().then((res) => res.meta.tray)`);
  check('ui.tray-off', trayOff === false, String(trayOff));
  await exec(`document.querySelector('#modal [data-action="toggle-menubar"]').click()`);
  await delay(400);
  const trayOn = await exec(`window.napkin.getState().then((res) => res.meta.tray)`);
  check('ui.tray-on', trayOn === true, String(trayOn));
  await exec(`document.querySelector('#modal [data-action="close-modal"]').click()`);
  await delay(200);

  clipboard.writeText('smoke-clip');
  const clipRead = await clipboard.readText();
  check('clipboard', clipRead === 'smoke-clip', 'read=' + clipRead);

  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(
    JSON.stringify({ ok: failed.length === 0, checks, vault: store.meta() }, null, 2) + '\n'
  );
  await delay(120);
  app.exit(failed.length === 0 ? 0 : 1);
}

// ----------------------------------------------------------------------- boot

const gotLock = SMOKE || app.requestSingleInstanceLock();
if (!gotLock) {
  dialog.showErrorBox(
    'napkin++ is already running',
    'Quit the other copy (including a terminal npm start) and open this app again.'
  );
  app.quit();
} else {
  app.on('second-instance', showMain);

  app.whenReady().then(() => {
    if (process.platform === 'darwin') {
      const iconPath = path.join(__dirname, 'assets', 'icon.png');
      if (fs.existsSync(iconPath)) app.dock.setIcon(iconPath);
    }
    protocol.handle('napkin-thumb', (request) => {
      let id = '';
      try {
        const url = new URL(request.url);
        id = url.pathname.replace(/^\/+/, '') || url.hostname;
      } catch {
        id = '';
      }
      const file = PREVIEWS.file(id);
      if (!file || !fs.existsSync(file)) return new Response('', { status: 404 });
      return new Response(fs.readFileSync(file), {
        status: 200,
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
      });
    });
    store = new VaultStore({ dir: DATA_DIR });
    store.load();
    startHidden = app.isPackaged && loginState().wasOpenedAtLogin;
    applySettingsSideEffects();
    registerIpc();
    createMainWindow();
    createQuickWindow();
    if (!SMOKE) {
      buildMenu();
      const candidates = ['Alt+Space', 'Alt+Shift+Space', 'Control+Alt+Space', 'Alt+Cmd+N'];
      for (const accel of candidates) {
        if (globalShortcut.register(accel, toggleCapture)) {
          summonShortcut = accel;
          break;
        }
      }
      if (!summonShortcut) process.stderr.write('napkin: no global summon shortcut available\n');
    }
    app.on('activate', () => {
      startHidden = false;
      if (!mainWindow) createMainWindow();
      else mainWindow.show();
    });
    if (SMOKE) {
      runSmoke().catch((err) => {
        process.stderr.write('SMOKE FAILED: ' + (err && err.stack) + '\n');
        app.exit(1);
      });
    } else {
      setTimeout(maybeCheckUpdates, 6000);
    }
  });

  app.on('will-quit', () => {
    if (clipTimer) clearTimeout(clipTimer);
    if (tray) {
      tray.destroy();
      tray = null;
    }
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
