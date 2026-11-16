'use strict';

/*
 * napkin++ — vault store.
 *
 * The vault is a single readable JSON file, written atomically (tmp + fsync +
 * rename) with one rolling backup per day. If the file is ever corrupted we
 * keep the evidence, restore the newest backup, and tell the UI — never fail
 * into an empty vault silently.
 *
 * Undo is session-scoped: the last 30 states are kept in memory, not on disk.
 */

const fs = require('node:fs');
const path = require('node:path');
const model = require('./model.js');

const MAX_UNDO = 30;
const MAX_BACKUPS = 14;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

class VaultStore {
  constructor(options) {
    const opts = options || {};
    this.dir = opts.dir;
    this.file = path.join(this.dir, 'vault.json');
    this.backupDir = path.join(this.dir, 'backups');
    this.vault = model.createVault();
    this.undoStack = [];
    this.recovery = null;
    this.lastSavedAt = null;
    this.writes = 0;
  }

  ensureDirs() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  load() {
    this.ensureDirs();
    if (!fs.existsSync(this.file)) {
      this.save();
      return { recovered: false, fresh: true };
    }

    let raw = null;
    let mtime = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
      mtime = fs.statSync(this.file).mtime.toISOString();
    } catch (err) {
      this.recovery = { reason: 'unreadable', message: err.message };
    }

    if (raw !== null) {
      try {
        this.vault = model.normalizeVault(JSON.parse(raw));
        this.lastSavedAt = mtime;
        return { recovered: false, fresh: false };
      } catch (err) {
        const corruptPath = path.join(this.dir, 'vault.corrupt-' + stamp() + '.json');
        try {
          fs.copyFileSync(this.file, corruptPath);
        } catch {
          /* best effort only */
        }
        const backup = this.latestBackup();
        if (backup) {
          try {
            const restored = model.normalizeVault(JSON.parse(fs.readFileSync(backup, 'utf8')));
            this.vault = restored;
            this.recovery = {
              reason: 'corrupt',
              message: err.message,
              corruptPath,
              restoredFrom: backup,
            };
            this.save();
            return { recovered: true, fresh: false, from: backup };
          } catch {
            /* fall through to empty vault */
          }
        }
        this.recovery = { reason: 'corrupt', message: err.message, corruptPath };
        this.vault = model.createVault();
        this.save();
        return { recovered: true, fresh: true, corruptPath };
      }
    }

    this.vault = model.createVault();
    this.save();
    return { recovered: true, fresh: true };
  }

  latestBackup() {
    try {
      const files = fs
        .readdirSync(this.backupDir)
        .filter(
          (f) => f === 'vault-prev.json' || /^vault-\d{4}-\d{2}-\d{2}\.json$/.test(f)
        );
      if (!files.length) return null;
      let newest = null;
      for (const file of files) {
        const full = path.join(this.backupDir, file);
        const mtime = fs.statSync(full).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { full, mtime };
      }
      return newest ? newest.full : null;
    } catch {
      return null;
    }
  }

  pruneBackups() {
    try {
      const files = fs
        .readdirSync(this.backupDir)
        .filter((f) => /^vault-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort();
      while (files.length > MAX_BACKUPS) {
        const oldest = files.shift();
        try {
          fs.unlinkSync(path.join(this.backupDir, oldest));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  save() {
    this.ensureDirs();
    const today = new Date().toISOString().slice(0, 10);
    const backupPath = path.join(this.backupDir, 'vault-' + today + '.json');
    const prevPath = path.join(this.backupDir, 'vault-prev.json');
    if (fs.existsSync(this.file)) {
      try {
        // Always keep the immediately previous save: a corrupt write should
        // cost at most one edit, not the whole day.
        fs.copyFileSync(this.file, prevPath);
      } catch {
        /* best effort */
      }
      if (!fs.existsSync(backupPath)) {
        try {
          fs.copyFileSync(this.file, backupPath);
        } catch {
          /* a failed backup must not block the save */
        }
      }
    }
    const tmp = this.file + '.tmp';
    const json = JSON.stringify(this.vault, null, 2);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, json, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    this.lastSavedAt = new Date().toISOString();
    this.writes += 1;
    this.pruneBackups();
  }

  dispatch(action) {
    const result = model.applyAction(this.vault, action);
    if (!result.ok) return result;
    if (!result.quiet) {
      this.undoStack.push(this.vault);
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    }
    this.vault = result.state;
    this.save();
    return { ok: true, state: this.vault, result: result.result };
  }

  undo() {
    if (!this.undoStack.length) return { ok: false, error: 'Nothing to undo.' };
    this.vault = this.undoStack.pop();
    this.save();
    return { ok: true, state: this.vault, result: { remaining: this.undoStack.length } };
  }

  exportMarkdown(projectId, options) {
    const opts = options || {};
    if (projectId) {
      const project = model.getProject(this.vault, projectId);
      if (!project) return null;
      return model.exportProjectMarkdown(project, opts);
    }
    const parts = this.vault.projects.map((p) => model.exportProjectMarkdown(p, opts));
    return '# napkin++ vault\n\n' + parts.join('\n---\n\n');
  }

  meta() {
    return {
      path: this.file,
      dir: this.dir,
      backupDir: this.backupDir,
      lastSavedAt: this.lastSavedAt,
      projects: this.vault.projects.length,
      recovery: this.recovery,
      undoDepth: this.undoStack.length,
      bytes: fs.existsSync(this.file) ? fs.statSync(this.file).size : 0,
    };
  }
}

module.exports = { VaultStore, MAX_UNDO, MAX_BACKUPS };
