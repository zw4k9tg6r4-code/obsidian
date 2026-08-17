import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const wizard = join(repository, 'scripts', 'install-wizard.ps1');
const powershell = process.platform === 'win32'
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;
const windowsOnly = { skip: process.platform !== 'win32' };

function runWizard(args, timeout = 30_000) {
  return spawnSync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', wizard,
    ...args,
  ], { encoding: 'utf8', timeout });
}

function outputOf(run) {
  return `${run.stdout || ''}\n${run.stderr || ''}`;
}

function makeVault(root) {
  const vault = join(root, 'synthetic-vault');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'AGENTS.md'), '# Synthetic Vault\n', 'utf8');
  return vault;
}

test('self-guided entrypoints are present and route only to the fixed wizard', () => {
  const agents = readFileSync(join(repository, 'AGENTS.md'), 'utf8');
  const start = readFileSync(join(repository, 'START-HERE.md'), 'utf8');
  const launcher = readFileSync(join(repository, 'INSTALL.cmd'), 'utf8');
  const initialize = readFileSync(join(repository, 'scripts', 'initialize-index.ps1'), 'utf8');
  const install = readFileSync(join(repository, 'scripts', 'install.ps1'), 'utf8');
  const wizardSource = readFileSync(wizard, 'utf8');

  assert.match(agents, /install-wizard\.ps1/);
  assert.match(agents, /-PlanOnly/);
  assert.match(agents, /-IndexMode lexical/);
  assert.match(start, /安装这个/);
  assert.match(launcher, /INSTALLER_ROOT=%~dp0/i);
  assert.match(launcher, /%INSTALLER_ROOT%scripts\\install-wizard\.ps1/i);
  assert.match(launcher, /exit \/b %INSTALL_EXIT%/i);
  assert.doesNotMatch(launcher, /%\*/);
  assert.doesNotMatch(launcher, /Invoke-Expression|iex/i);
  assert.match(initialize, /Join-Path \$projectRoot 'src\\cli\.js'/);
  assert.match(install, /Assert-NoContainment \$projectRoot \$installRootFull/);
  assert.match(wizardSource, /installer package and InstallRoot must not contain one another/);
});

test('PowerShell installer entrypoints parse cleanly', windowsOnly, () => {
  const command = [
    "$errors = @()",
    `foreach ($file in @('${wizard.replaceAll("'", "''")}', '${join(repository, 'scripts', 'install.ps1').replaceAll("'", "''")}')) {`,
    '  $tokens = $null; $parseErrors = $null',
    '  [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$parseErrors) | Out-Null',
    '  $errors += $parseErrors',
    '}',
    'if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }',
  ].join('; ');
  const run = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, outputOf(run));
});

test('PlanOnly validates a synthetic Vault and performs zero writes', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-wizard-plan-'));
  try {
    const vault = makeVault(root);
    const installRoot = join(root, 'local-data');
    const before = readdirSync(vault).sort();
    const run = runWizard([
      '-VaultPath', vault,
      '-InstallRoot', installRoot,
      '-Target', 'codex',
      '-IndexMode', 'lexical',
      '-NonInteractive',
      '-PlanOnly',
    ]);
    assert.equal(run.status, 0, outputOf(run));
    const result = JSON.parse(run.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.planOnly, true);
    assert.equal(result.indexMode, 'lexical');
    assert.equal(result.vaultWrites, false);
    assert.equal(existsSync(installRoot), false);
    assert.deepEqual(readdirSync(vault).sort(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-interactive mode without VaultPath fails before writes', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-wizard-missing-vault-'));
  try {
    const installRoot = join(root, 'local-data');
    const run = runWizard(['-InstallRoot', installRoot, '-NonInteractive']);
    assert.notEqual(run.status, 0, outputOf(run));
    assert.match(outputOf(run), /VaultPath is required/i);
    assert.equal(existsSync(installRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-interactive installation without network consent fails before writes', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-wizard-network-consent-'));
  try {
    const vault = makeVault(root);
    const installRoot = join(root, 'local-data');
    const run = runWizard([
      '-VaultPath', vault,
      '-InstallRoot', installRoot,
      '-IndexMode', 'lexical',
      '-NonInteractive',
    ]);
    assert.notEqual(run.status, 0, outputOf(run));
    assert.match(outputOf(run), /AcceptNetwork/i);
    assert.equal(existsSync(installRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('semantic mode without model consent fails before writes', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-wizard-semantic-consent-'));
  try {
    const vault = makeVault(root);
    const installRoot = join(root, 'local-data');
    const run = runWizard([
      '-VaultPath', vault,
      '-InstallRoot', installRoot,
      '-IndexMode', 'semantic',
      '-NonInteractive',
      '-AcceptNetwork',
    ]);
    assert.notEqual(run.status, 0, outputOf(run));
    assert.match(outputOf(run), /AcceptModelDownload/i);
    assert.equal(existsSync(installRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the extracted package cannot be selected as its own Vault', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-wizard-self-vault-'));
  try {
    const installRoot = join(root, 'local-data');
    const run = runWizard([
      '-VaultPath', repository,
      '-InstallRoot', installRoot,
      '-NonInteractive',
      '-PlanOnly',
    ]);
    assert.notEqual(run.status, 0, outputOf(run));
    assert.match(outputOf(run), /must not contain one another/i);
    assert.equal(existsSync(installRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PlanOnly rejects InstallRoot inside or around the extracted package without writes', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-wizard-package-install-boundary-'));
  const installInsidePackage = join(repository, '.installer-containment-test');
  try {
    const vault = makeVault(root);
    const insideRun = runWizard([
      '-VaultPath', vault,
      '-InstallRoot', installInsidePackage,
      '-NonInteractive',
      '-PlanOnly',
    ]);
    assert.notEqual(insideRun.status, 0, outputOf(insideRun));
    assert.match(outputOf(insideRun), /package and InstallRoot must not contain one another/i);
    assert.equal(existsSync(installInsidePackage), false);

    const aroundRun = runWizard([
      '-VaultPath', vault,
      '-InstallRoot', dirname(repository),
      '-NonInteractive',
      '-PlanOnly',
    ]);
    assert.notEqual(aroundRun.status, 0, outputOf(aroundRun));
    assert.match(outputOf(aroundRun), /package and InstallRoot must not contain one another/i);
    assert.equal(existsSync(installInsidePackage), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('base installer rejects InstallRoot inside the package before creating it', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-base-package-install-boundary-'));
  const installInsidePackage = join(repository, '.installer-containment-test');
  try {
    const vault = makeVault(root);
    const installScript = join(repository, 'scripts', 'install.ps1');
    const run = spawnSync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', installScript,
      '-VaultPath', vault,
      '-InstallRoot', installInsidePackage,
      '-Target', 'codex',
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.notEqual(run.status, 0, outputOf(run));
    assert.match(outputOf(run), /project root and install root must not contain one another/i);
    assert.equal(existsSync(installInsidePackage), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a junction Vault is rejected during PlanOnly without writes', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-wizard-vault-junction-'));
  try {
    const realVault = makeVault(root);
    const vaultLink = join(root, 'vault-link');
    symlinkSync(realVault, vaultLink, 'junction');
    const installRoot = join(root, 'local-data');
    const run = runWizard([
      '-VaultPath', vaultLink,
      '-InstallRoot', installRoot,
      '-NonInteractive',
      '-PlanOnly',
    ]);
    assert.notEqual(run.status, 0, outputOf(run));
    assert.match(outputOf(run), /reparse|junction/i);
    assert.equal(existsSync(installRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('INSTALL.cmd works from a path with spaces and preserves failure exit code', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain launcher with spaces '));
  try {
    const scripts = join(root, 'scripts');
    mkdirSync(scripts, { recursive: true });
    copyFileSync(join(repository, 'INSTALL.cmd'), join(root, 'INSTALL.cmd'));
    writeFileSync(join(scripts, 'install-wizard.ps1'), "Write-Error 'synthetic failure'; exit 7\n", 'utf8');
    const run = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'INSTALL.cmd'], {
      cwd: root,
      encoding: 'utf8',
      input: '\n',
    });
    assert.equal(run.status, 7, outputOf(run));
    assert.match(outputOf(run), /failed with exit code 7/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
