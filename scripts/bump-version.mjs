#!/usr/bin/env node
/**
 * bump-version.mjs - bump napkin++ and seed the changelog entry for it.
 *
 *   node scripts/bump-version.mjs 1.0.0
 *   node scripts/bump-version.mjs 1.0.0 --dry-run
 *   node scripts/bump-version.mjs 1.1.0 --force        # ignore a dirty work tree
 *   node scripts/bump-version.mjs 1.0.0 --root /tmp/x  # run against another checkout
 *
 * It edits exactly two files: package.json and CHANGELOG.md. It does NOT touch
 * package-lock.json (that file belongs to npm), so it prints the command that
 * syncs the lockfile's version fields afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function usage(exitCode = 0) {
  const text = `Usage: node scripts/bump-version.mjs <version> [options]

  <version>        Semver to set, e.g. 1.0.0 or 1.1.0-beta.1

Options:
  --force          Proceed even when the git work tree has uncommitted changes
  --dry-run        Print what would change without writing anything
  --root <dir>     Repository root to operate on (default: this script's parent)
  -h, --help       Show this message

What it does:
  1. Sets "version" in package.json
  2. Prepends a "## [<version>] - <today>" stub to CHANGELOG.md
  3. Prints the remaining release steps
`;
  (exitCode === 0 ? process.stdout : process.stderr).write(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    version: '',
    root: path.resolve(SCRIPT_DIR, '..'),
    force: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      usage(0);
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) fail('--root needs a directory');
      options.root = path.resolve(value);
      i += 1;
    } else if (arg.startsWith('-')) {
      fail(`unknown option: ${arg} (try --help)`);
    } else if (!options.version) {
      options.version = arg.replace(/^v/, '');
    } else {
      fail(`unexpected argument: ${arg}`);
    }
  }

  if (!options.version) usage(2);
  if (!SEMVER.test(options.version)) {
    fail(`"${options.version}" is not a semver version (want MAJOR.MINOR.PATCH[-prerelease])`);
  }
  return options;
}

function today() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function gitStatus(root) {
  try {
    const stdout = execFileSync('git', ['-C', root, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { available: true, dirty: stdout.trim() !== '', listing: stdout.trim() };
  } catch {
    return { available: false, dirty: false, listing: '' };
  }
}

function changelogEntry(version) {
  return [
    `## [${version}] - ${today()}`,
    '',
    '### Added',
    '<!-- New capabilities. Delete this section if it is empty. -->',
    '',
    '### Changed',
    '<!-- Behaviour that changed. Delete this section if it is empty. -->',
    '',
    '### Fixed',
    '<!-- Bugs fixed. Delete this section if it is empty. -->',
  ].join('\n');
}

const CHANGELOG_HEADER = [
  '# Changelog',
  '',
  'All notable changes to napkin++ are documented in this file. The format follows',
  '[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses',
  '[Semantic Versioning](https://semver.org/spec/v2.0.0.html).',
  '',
  '',
].join('\n');

function prependChangelog(existing, entry) {
  const index = existing.search(/^## /m);
  if (index === -1) {
    const head = existing.trimEnd();
    return head ? `${head}\n\n${entry}\n` : `${entry}\n`;
  }
  const head = existing.slice(0, index).replace(/\s+$/, '');
  const rest = existing.slice(index);
  return head ? `${head}\n\n${entry}\n\n${rest}` : `${entry}\n\n${rest}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const pkgPath = path.join(options.root, 'package.json');
  const changelogPath = path.join(options.root, 'CHANGELOG.md');

  if (!fs.existsSync(pkgPath)) {
    fail(`no package.json in ${options.root} (pass --root <repo>)`);
  }

  const pkgText = fs.readFileSync(pkgPath, 'utf8');
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch (error) {
    fail(`package.json is not valid JSON: ${error.message}`);
  }

  const current = String(pkg.version || '0.0.0');
  out(`root: ${options.root}`);
  if (current === options.version) {
    fail(`package.json is already at ${options.version}; nothing to do`);
  }

  const status = gitStatus(options.root);
  if (!status.available) {
    out(`! ${options.root} is not a git work tree - skipping the dirty-tree check`);
  } else if (status.dirty && !options.force) {
    const lines = status.listing.split('\n');
    const listing = lines.slice(0, 20).map((line) => `  ${line}`).join('\n');
    const truncated = lines.length > 20 ? '\n  ...' : '';
    process.stderr.write(
      `error: the work tree has uncommitted changes.\n\n${listing}${truncated}\n\n` +
        'Commit or stash them first, or re-run with --force if you know what you are doing.\n',
    );
    process.exit(1);
  }

  const nextPkg = { ...pkg, version: options.version };
  const pkgOut = `${JSON.stringify(nextPkg, null, 2)}\n`;

  const changelogExists = fs.existsSync(changelogPath);
  const changelogOld = changelogExists ? fs.readFileSync(changelogPath, 'utf8') : CHANGELOG_HEADER;
  const hasEntryForVersion = changelogOld.includes(`## [${options.version}]`);

  let changelogOut;
  if (hasEntryForVersion) {
    changelogOut = changelogOld;
    out(`! CHANGELOG.md already has a section for ${options.version} - leaving it alone`);
  } else {
    changelogOut = prependChangelog(changelogOld, changelogEntry(options.version));
  }

  out(`${options.dryRun ? 'would set' : 'setting'} version ${current} -> ${options.version}`);
  out(`  ${pkgPath}`);
  if (!hasEntryForVersion) out(`  ${changelogPath}${changelogExists ? '' : ' (new file)'}`);

  if (options.dryRun) {
    out('');
    out('dry run: nothing written');
    return;
  }

  fs.writeFileSync(pkgPath, pkgOut);
  fs.writeFileSync(changelogPath, changelogOut);

  const lockPath = path.join(options.root, 'package-lock.json');
  let lockNote = '';
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const lockVersion = lock.version;
      const nestedVersion = lock.packages && lock.packages[''] ? lock.packages[''].version : undefined;
      if (lockVersion !== options.version || nestedVersion !== options.version) {
        lockNote = `package-lock.json still says ${lockVersion ?? 'nothing'} - sync it with:\n   npm install --package-lock-only`;
      }
    } catch {
      lockNote = 'package-lock.json could not be parsed - run npm install --package-lock-only to refresh it';
    }
  }

  out('');
  out('Next:');
  out(`  1. Write the CHANGELOG entry under "## [${options.version}]".`);
  if (lockNote) out(`  2. ${lockNote}`);
  out(`  ${lockNote ? '3' : '2'}. Review the diff: git diff package.json CHANGELOG.md`);
  out(`  ${lockNote ? '4' : '3'}. Commit and tag:`);
  out(`       git add package.json CHANGELOG.md${lockNote ? ' package-lock.json' : ''}`);
  out(`       git commit -m "release: ${pkg.name || 'napkin++'} ${options.version}"`);
  out(`       git tag -a v${options.version} -m "${pkg.productName || 'napkin++'} ${options.version}"`);
  out(`       git push origin HEAD && git push origin v${options.version}`);
  out(`  ${lockNote ? '5' : '4'}. Watch the Release workflow, then follow docs/RELEASING.md.`);
}

main();
