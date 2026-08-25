import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const buildScript = join(repository, 'scripts', 'build-release.ps1');
const installScript = join(repository, 'scripts', 'install.ps1');
const semanticSetupScript = join(repository, 'scripts', 'setup-semantic.ps1');
const powershell = process.platform === 'win32'
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;
const windowsOnly = { skip: process.platform !== 'win32' };
const fullReleaseRootOnly = {
  skip: process.platform !== 'win32'
    ? 'requires Windows PowerShell'
    : !existsSync(join(repository, 'AGENTS.md'))
      ? 'requires the full release source root'
      : false,
};

function runScript(script, args, timeout = 30_000) {
  return spawnSync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File', script,
    ...args,
  ], { encoding: 'utf8', timeout });
}

function combinedOutput(run) {
  return `${run.stdout || ''}\n${run.stderr || ''}`;
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function syntheticReleaseSource(root) {
  const source = join(root, 'source');
  mkdirSync(source, { recursive: true });
  writeText(join(source, 'README.md'), '# Synthetic release source\n');
  writeText(join(source, 'AGENTS.md'), '# Synthetic installer instructions\n');
  writeText(join(source, 'START-HERE.md'), '# Synthetic start page\n');
  writeText(join(source, 'INSTALL.cmd'), '@echo off\r\nexit /b 0\r\n');
  writeText(join(source, 'LICENSE'), 'Synthetic test fixture only.\n');
  writeText(join(source, 'SECURITY.md'), '# Security\n');
  writeText(join(source, 'PRIVACY.md'), '# Privacy\n');
  writeText(join(source, 'THIRD_PARTY_NOTICES.md'), '# Notices\n');
  writeText(join(source, 'package.json'), `${JSON.stringify({
    name: 'synthetic-release',
    version: '0.0.0',
    private: true,
  }, null, 2)}\n`);
  writeText(join(source, 'package-lock.json'), `${JSON.stringify({
    name: 'synthetic-release',
    version: '0.0.0',
    lockfileVersion: 3,
    packages: {},
  }, null, 2)}\n`);
  writeText(join(source, 'requirements-semantic.txt'), '# none\n');
  writeText(join(source, 'src', 'index.js'), 'export const synthetic = true;\n');
  writeText(join(source, 'docs', 'architecture.md'), '# Synthetic architecture\n');
  writeText(join(source, 'test', 'smoke.test.js'), 'export {};\n');
  mkdirSync(join(source, 'scripts'), { recursive: true });
  writeText(join(source, 'scripts', 'install-wizard.ps1'), "Write-Output 'synthetic'\n");
  mkdirSync(join(source, 'schemas'), { recursive: true });
  cpSync(join(repository, 'scripts', 'scan-release.ps1'), join(source, 'scripts', 'scan-release.ps1'));
  for (const schema of [
    'config.schema.json',
    'evidence.schema.json',
    'candidate-store.schema.json',
    'audit-event.schema.json',
  ]) {
    cpSync(join(repository, 'schemas', schema), join(source, 'schemas', schema));
  }
  return source;
}

function assertRejectedForReparse(run) {
  assert.notEqual(run.status, 0, combinedOutput(run));
  assert.match(combinedOutput(run), /reparse|junction/i);
}

test('normal non-reparse release output remains supported', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-reparse-positive-'));
  try {
    const source = syntheticReleaseSource(root);
    const output = join(root, 'output');
    const run = runScript(buildScript, ['-SourceRoot', source, '-OutputRoot', output], 60_000);
    assert.equal(run.status, 0, combinedOutput(run));
    assert.ok(readdirSync(output).some((name) => name.endsWith('.zip')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('build-release resolves its repository source root when SourceRoot is omitted', fullReleaseRootOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-release-default-source-'));
  try {
    const output = join(root, 'output');
    const run = runScript(buildScript, ['-OutputRoot', output], 60_000);
    assert.equal(run.status, 0, combinedOutput(run));
    assert.ok(readdirSync(output).some((name) => name.endsWith('.zip')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('allowlisted top-level directory rejects a junction before traversal', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-reparse-directory-'));
  try {
    const source = syntheticReleaseSource(root);
    rmSync(join(source, 'docs'), { recursive: true, force: true });
    const externalDocs = join(root, 'external-docs');
    writeText(join(externalDocs, 'architecture.md'), '# Outside source boundary\n');
    symlinkSync(externalDocs, join(source, 'docs'), 'junction');
    assert.equal(lstatSync(join(source, 'docs')).isSymbolicLink(), true);

    const output = join(root, 'output');
    const run = runScript(buildScript, ['-SourceRoot', source, '-OutputRoot', output]);
    assertRejectedForReparse(run);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('allowlisted root-file entry rejects a reparse before type resolution', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-reparse-root-file-'));
  try {
    const source = syntheticReleaseSource(root);
    const readme = join(source, 'README.md');
    rmSync(readme, { force: true });
    const targetFile = join(root, 'external-readme.md');
    writeText(targetFile, '# Outside source boundary\n');
    try {
      symlinkSync(targetFile, readme, 'file');
    } catch {
      const targetDirectory = join(root, 'external-readme-directory');
      writeText(join(targetDirectory, 'content.md'), '# Junction fallback\n');
      symlinkSync(targetDirectory, readme, 'junction');
    }
    assert.equal(lstatSync(readme).isSymbolicLink(), true);

    const output = join(root, 'output');
    const run = runScript(buildScript, ['-SourceRoot', source, '-OutputRoot', output]);
    assertRejectedForReparse(run);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing OutputRoot junction into a synthetic Vault is rejected without writing', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-reparse-output-'));
  try {
    const source = syntheticReleaseSource(root);
    const syntheticVault = join(root, 'synthetic-vault');
    writeText(join(syntheticVault, 'AGENTS.md'), '# Synthetic Vault\n');
    mkdirSync(join(syntheticVault, '.obsidian'));
    const output = join(root, 'output-link');
    symlinkSync(syntheticVault, output, 'junction');

    const before = readdirSync(syntheticVault).sort();
    const run = runScript(buildScript, ['-SourceRoot', source, '-OutputRoot', output]);
    assertRejectedForReparse(run);
    assert.deepEqual(readdirSync(syntheticVault).sort(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing InstallRoot junction outside its lexical boundary is rejected before network or writes', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-reparse-install-'));
  try {
    const syntheticVault = join(root, 'synthetic-vault');
    writeText(join(syntheticVault, 'AGENTS.md'), '# Synthetic Vault\n');
    const outsideBoundary = join(root, 'outside-boundary');
    mkdirSync(outsideBoundary);
    const installRoot = join(root, 'install-link');
    symlinkSync(outsideBoundary, installRoot, 'junction');
    const skillRoot = join(root, 'skill-root');

    const run = runScript(installScript, [
      '-VaultPath', syntheticVault,
      '-InstallRoot', installRoot,
      '-Target', 'codex',
      '-CodexSkillRoot', skillRoot,
    ]);
    assertRejectedForReparse(run);
    assert.deepEqual(readdirSync(outsideBoundary), []);
    assert.equal(existsSync(skillRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('semantic setup rejects a reparse data directory before installing anything', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-reparse-semantic-'));
  try {
    const outsideBoundary = join(root, 'outside-boundary');
    mkdirSync(outsideBoundary);
    const dataDir = join(root, 'data-link');
    symlinkSync(outsideBoundary, dataDir, 'junction');
    const run = runScript(semanticSetupScript, ['-DataDir', dataDir, '-AcceptNetwork']);
    assertRejectedForReparse(run);
    assert.deepEqual(readdirSync(outsideBoundary), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
