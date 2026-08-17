import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const rollbackScript = join(repository, 'scripts', 'rollback.ps1');
const powershell = process.platform === 'win32'
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;
const windowsOnly = { skip: process.platform !== 'win32' };

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function inventory(path, kind) {
  if (kind === 'absent') return { kind, directories: [], files: [] };
  if (kind === 'file') {
    return {
      kind,
      directories: [],
      files: [{ path: basename(path), length: statSync(path).size, sha256: sha256(path) }],
    };
  }
  const directories = [];
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const rel = relative(path, full).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        directories.push(rel);
        walk(full);
      } else {
        files.push({ path: rel, length: statSync(full).size, sha256: sha256(full) });
      }
    }
  }
  walk(path);
  directories.sort();
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { kind: 'directory', directories, files };
}

function makeFixture(schemaVersion = 2) {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-rollback-'));
  const installRoot = join(root, 'install');
  const installId = '0123456789abcdef0123456789abcdef';
  const batchRoot = join(installRoot, 'backups', `20260817-120000-${installId}`);
  const appTarget = join(installRoot, 'app');
  const appBackup = join(batchRoot, 'app');
  const configPath = join(installRoot, 'config', 'config.json');
  const configBackup = join(batchRoot, 'config.json');
  const codexRoot = join(root, 'codex-skills');
  const antigravityRoot = join(root, 'antigravity-skills');
  const skillTarget = join(codexRoot, 'obsidian-second-brain');
  const skillBackup = join(batchRoot, 'skill-codex');
  writeText(join(appTarget, 'state.txt'), 'new-app');
  writeText(join(appBackup, 'state.txt'), 'old-app');
  writeText(configPath, 'new-config');
  writeText(configBackup, 'old-config');
  writeText(join(skillTarget, 'state.txt'), 'new-skill');
  writeText(join(skillBackup, 'state.txt'), 'old-skill');
  mkdirSync(antigravityRoot, { recursive: true });
  const skill = {
    name: 'codex', target: skillTarget, backup: skillBackup, hadPrevious: true,
  };
  const manifest = {
    schemaVersion,
    installId,
    installedAt: '2026-08-17T04:00:00.000Z',
    installRoot,
    appTarget,
    appBackup,
    appWasPresent: true,
    configPath,
    configBackup,
    configWasPresent: true,
    skills: [skill],
  };
  if (schemaVersion === 2) {
    manifest.backupRoot = batchRoot;
    manifest.appBackupInventory = inventory(appBackup, 'directory');
    manifest.configBackupInventory = inventory(configBackup, 'file');
    skill.backupInventory = inventory(skillBackup, 'directory');
  }
  const manifestPath = join(batchRoot, 'install-manifest.json');
  writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, installRoot, batchRoot, manifestPath, appTarget, appBackup, configPath, configBackup, codexRoot, antigravityRoot, skillTarget, skillBackup };
}

function runRollback(fixture) {
  return spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', rollbackScript,
    '-InstallRoot', fixture.installRoot,
    '-ManifestPath', fixture.manifestPath,
    '-CodexSkillRoot', fixture.codexRoot,
    '-AntigravitySkillRoot', fixture.antigravityRoot,
  ], { encoding: 'utf8', timeout: 30_000 });
}

function output(run) {
  return `${run.stdout || ''}\n${run.stderr || ''}`;
}

test('schema v2 rollback verifies backup inventories and restores all prior targets', windowsOnly, () => {
  const fixture = makeFixture(2);
  try {
    const run = runRollback(fixture);
    assert.equal(run.status, 0, output(run));
    assert.equal(readFileSync(join(fixture.appTarget, 'state.txt'), 'utf8'), 'old-app');
    assert.equal(readFileSync(fixture.configPath, 'utf8'), 'old-config');
    assert.equal(readFileSync(join(fixture.skillTarget, 'state.txt'), 'utf8'), 'old-skill');
    assert.match(run.stdout, /"backupIntegrityVerified"\s*:\s*true/i);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('tampered v2 backup is rejected before any target is moved', windowsOnly, () => {
  const fixture = makeFixture(2);
  try {
    writeText(join(fixture.appBackup, 'state.txt'), 'tampered-old-app');
    const run = runRollback(fixture);
    assert.notEqual(run.status, 0, output(run));
    assert.match(output(run), /SHA256|file list|manifest/i);
    assert.equal(readFileSync(join(fixture.appTarget, 'state.txt'), 'utf8'), 'new-app');
    assert.equal(readFileSync(fixture.configPath, 'utf8'), 'new-config');
    assert.equal(readFileSync(join(fixture.skillTarget, 'state.txt'), 'utf8'), 'new-skill');
    assert.equal(readdirSync(join(fixture.installRoot, 'backups')).some((name) => name.startsWith('rollback-')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('legacy schema v1 install backups remain restorable with strict batch binding', windowsOnly, () => {
  const fixture = makeFixture(1);
  try {
    const run = runRollback(fixture);
    assert.equal(run.status, 0, output(run));
    assert.equal(readFileSync(join(fixture.appTarget, 'state.txt'), 'utf8'), 'old-app');
    assert.match(run.stdout, /"backupIntegrityVerified"\s*:\s*false/i);
    assert.equal(existsSync(fixture.appBackup), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
