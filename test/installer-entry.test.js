import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
const initializeIndex = join(repository, 'scripts', 'initialize-index.ps1');
const setupSemantic = join(repository, 'scripts', 'setup-semantic.ps1');
const downloadSemanticModel = join(repository, 'scripts', 'download-semantic-model.ps1');
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

function findPythonExecutable() {
  const probes = process.platform === 'win32'
    ? [
        ['py.exe', ['-3.12']],
        ['py.exe', ['-3']],
        ['python.exe', []],
      ]
    : [
        ['python3', []],
        ['python', []],
      ];
  for (const [command, prefix] of probes) {
    const run = spawnSync(command, [...prefix, '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    if (run.status === 0 && run.stdout.trim()) return run.stdout.trim();
  }
  return null;
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
  const initialize = readFileSync(initializeIndex, 'utf8');
  const semanticSetup = readFileSync(setupSemantic, 'utf8');
  const semanticDownload = readFileSync(downloadSemanticModel, 'utf8');
  const semanticDownloader = readFileSync(join(repository, 'src', 'download_semantic_model.py'), 'utf8');
  const semanticWorker = readFileSync(join(repository, 'src', 'fastembed_worker.py'), 'utf8');
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
  assert.match(initialize, /download-semantic-model\.ps1/);
  assert.match(initialize, /\$installedCli/);
  assert.match(initialize, /Get-Command node/);
  assert.match(initialize, /& \$node\.Source @arguments/);
  assert.match(semanticSetup, /@\('--version'\)/);
  assert.doesNotMatch(semanticSetup, /probeScript|sys\.version_info/);
  assert.match(semanticDownload, /if \(-not \$AcceptModelDownload\)/);
  assert.match(semanticDownloader, /local_files_only=False/);
  assert.match(semanticDownloader, /local_files_only=True/);
  assert.match(semanticWorker, /local_files_only=True/);
  assert.match(install, /Assert-NoContainment \$projectRoot \$installRootFull/);
  assert.match(wizardSource, /installer package and InstallRoot must not contain one another/);
});

test('PowerShell installer entrypoints parse cleanly', windowsOnly, () => {
  const entrypoints = [
    wizard,
    join(repository, 'scripts', 'install.ps1'),
    initializeIndex,
    setupSemantic,
    downloadSemanticModel,
  ];
  const quotedEntrypoints = entrypoints.map((file) => `'${file.replaceAll("'", "''")}'`).join(', ');
  const command = [
    "$errors = @()",
    `foreach ($file in @(${quotedEntrypoints})) {`,
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

test('semantic model downloader requires explicit consent before writes', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-model-consent-'));
  try {
    const dataDir = join(root, 'local-data');
    const run = spawnSync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', downloadSemanticModel,
      '-DataDir', dataDir,
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.notEqual(run.status, 0, outputOf(run));
    assert.match(outputOf(run), /AcceptModelDownload/i);
    assert.equal(existsSync(dataDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows PowerShell 5.1 probes a standard Python without writing semantic state', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-python-probe-'));
  try {
    const dataDir = join(root, 'local-data');
    const run = spawnSync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', setupSemantic,
      '-DataDir', dataDir,
      '-ProbeOnly',
    ], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        Path: [process.env.SystemRoot, join(process.env.SystemRoot, 'System32')].join(';'),
      },
    });
    assert.equal(run.status, 0, outputOf(run));
    const result = JSON.parse(run.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.engine, 'python');
    assert.equal(existsSync(dataDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authorized downloader goes online once and then verifies the same model offline', windowsOnly, (t) => {
  const python = findPythonExecutable();
  if (!python) return t.skip('standard Python is not available');
  const root = mkdtempSync(join(tmpdir(), 'sbrain-model-download-behavior-'));
  try {
    const fakeRoot = join(root, 'fake-python');
    const fakePackage = join(fakeRoot, 'fastembed');
    const dataDir = join(root, 'local-data');
    const marker = join(root, 'fastembed-calls.jsonl');
    mkdirSync(fakePackage, { recursive: true });
    writeFileSync(join(fakePackage, '__init__.py'), [
      'import json',
      'import os',
      '',
      'class TextEmbedding:',
      '    def __init__(self, **kwargs):',
      '        record = {',
      '            "localFilesOnly": kwargs.get("local_files_only"),',
      '            "hfOffline": os.environ.get("HF_HUB_OFFLINE"),',
      '            "transformersOffline": os.environ.get("TRANSFORMERS_OFFLINE"),',
      '        }',
      '        with open(os.environ["FAKE_FASTEMBED_MARKER"], "a", encoding="utf-8") as handle:',
      '            handle.write(json.dumps(record) + "\\n")',
      '    def embed(self, texts, batch_size=1):',
      '        yield [0.0] * 512',
    ].join('\n'), 'utf8');

    const run = spawnSync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', downloadSemanticModel,
      '-DataDir', dataDir,
      '-AcceptModelDownload',
    ], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        SECOND_BRAIN_PYTHON: python,
        PYTHONPATH: fakeRoot,
        FAKE_FASTEMBED_MARKER: marker,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
      },
    });

    assert.equal(run.status, 0, outputOf(run));
    const calls = readFileSync(marker, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(calls, [
      { localFilesOnly: false, hfOffline: null, transformersOffline: null },
      { localFilesOnly: true, hfOffline: null, transformersOffline: null },
    ]);
    const result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.ok, true);
    assert.equal(result.dimensions, 512);
    assert.equal(result.offlineVerified, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('semantic initialization validates a runnable CLI before model download', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-semantic-preflight-'));
  try {
    const packageRoot = join(root, 'package');
    const scripts = join(packageRoot, 'scripts');
    const vault = makeVault(root);
    const dataDir = join(root, 'local-data');
    const marker = join(root, 'download-called.txt');
    mkdirSync(scripts, { recursive: true });
    copyFileSync(initializeIndex, join(scripts, 'initialize-index.ps1'));
    writeFileSync(join(scripts, 'download-semantic-model.ps1'), [
      'param([string]$DataDir, [switch]$AcceptModelDownload)',
      `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value 'unexpected'`,
    ].join('\n'), 'utf8');

    const run = spawnSync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(scripts, 'initialize-index.ps1'),
      '-VaultPath', vault,
      '-DataDir', dataDir,
      '-Semantic',
      '-AcceptModelDownload',
    ], { encoding: 'utf8', timeout: 30_000 });

    assert.notEqual(run.status, 0, outputOf(run));
    assert.match(outputOf(run), /No runnable Second Brain CLI/i);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(dataDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('semantic initialization forwards consent and falls back to the installed CLI', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-semantic-installed-cli-'));
  try {
    const packageRoot = join(root, 'package');
    const scripts = join(packageRoot, 'scripts');
    const vault = makeVault(root);
    const dataDir = join(root, 'local-data');
    const installedApp = join(dataDir, 'app');
    const marker = join(root, 'download-called.txt');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(join(installedApp, 'src'), { recursive: true });
    mkdirSync(join(installedApp, 'node_modules', 'yaml'), { recursive: true });
    mkdirSync(join(installedApp, 'node_modules', '@tobilu', 'qmd'), { recursive: true });
    copyFileSync(initializeIndex, join(scripts, 'initialize-index.ps1'));
    writeFileSync(join(scripts, 'download-semantic-model.ps1'), [
      'param([string]$DataDir, [switch]$AcceptModelDownload)',
      "if (-not $AcceptModelDownload) { throw 'consent missing' }",
      `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value 'accepted'`,
    ].join('\n'), 'utf8');
    writeFileSync(join(installedApp, 'src', 'cli.js'), "console.log(JSON.stringify({ source: 'installed', argv: process.argv.slice(2) }));\n", 'utf8');
    writeFileSync(join(installedApp, 'node_modules', 'yaml', 'package.json'), '{}\n', 'utf8');
    writeFileSync(join(installedApp, 'node_modules', '@tobilu', 'qmd', 'package.json'), '{}\n', 'utf8');

    const run = spawnSync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(scripts, 'initialize-index.ps1'),
      '-VaultPath', vault,
      '-DataDir', dataDir,
      '-Semantic',
      '-AcceptModelDownload',
    ], { encoding: 'utf8', timeout: 30_000 });

    assert.equal(run.status, 0, outputOf(run));
    assert.equal(readFileSync(marker, 'utf8').trim(), 'accepted');
    const result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.source, 'installed');
    assert.ok(result.argv.includes('--semantic'));
    const dataDirIndex = result.argv.indexOf('--data-dir');
    assert.notEqual(dataDirIndex, -1);
    assert.equal(
      realpathSync.native(result.argv[dataDirIndex + 1]).toLowerCase(),
      realpathSync.native(dataDir).toLowerCase(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
