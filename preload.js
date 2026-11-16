'use strict';

/*
 * napkin++ — preload bridge.
 *
 * Explicit methods only; the renderer never sees Node or ipcRenderer directly.
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('napkin', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('vault:get'),
  dispatch: (action) => ipcRenderer.invoke('vault:dispatch', action),
  undo: () => ipcRenderer.invoke('vault:undo'),
  backup: () => ipcRenderer.invoke('vault:backup'),
  revealVault: () => ipcRenderer.invoke('vault:reveal'),
  exportMarkdown: (options) => ipcRenderer.invoke('vault:export', options),
  importFile: () => ipcRenderer.invoke('vault:importFile'),
  copy: (options) => ipcRenderer.invoke('app:copy', options),
  notify: (options) => ipcRenderer.invoke('app:notify', options),
  getLogin: () => ipcRenderer.invoke('app:login-state'),
  setLogin: (enabled) => ipcRenderer.invoke('app:set-login', enabled),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  detect: (projectId) => ipcRenderer.invoke('detect:project', projectId),
  capturePreview: (projectId) => ipcRenderer.invoke('preview:capture', projectId),
  captureAllPreviews: () => ipcRenderer.invoke('preview:captureAll'),
  clearPreviews: () => ipcRenderer.invoke('preview:clearAll'),
  checkUpdates: (force) => ipcRenderer.invoke('updates:check', Boolean(force)),
  updateState: () => ipcRenderer.invoke('updates:state'),
  showCapture: () => ipcRenderer.invoke('capture:show'),
  hideCapture: () => ipcRenderer.invoke('capture:hide'),
  openProject: (id) => ipcRenderer.invoke('window:openProject', id),
  onState: (callback) => subscribe('vault:state', callback),
  onNotice: (callback) => subscribe('app:notice', callback),
  onMenu: (callback) => subscribe('menu:action', callback),
  onNavigate: (callback) => subscribe('nav:project', callback),
  onCaptureReset: (callback) => subscribe('capture:reset', callback),
  onDetect: (callback) => subscribe('app:detect', callback),
  onUpdate: (callback) => subscribe('app:update', callback),
});
