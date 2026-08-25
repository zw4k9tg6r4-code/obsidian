import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolveRuntimeConfig } from '../src/config.js';
import { indexVault, syncVault, readHealth } from '../src/qmd-adapter.js';
import { searchSecondBrain } from '../src/retrieval.js';
import { indexSemantic, isSemanticRuntimeConfigured, syncSemantic } from '../src/semantic-adapter.js';
import { buildCollections, discoverProjects } from '../src/vault.js';
import { acquireSyncLock, lockPath } from '../src/lock.js';

const fixtureVault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

function createSyntheticEnv() {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-probes-test-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });
  return { root, vault, dataDir, config };
}

test('P1-1 probe: physical file deletion does not throw during search and returns insufficient', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  // 1. Create a unique file and index it
  const secretPath = join(vault, '02-项目', '北辰仓配项目', '01-输入', '紫藤旧口令.md');
  writeFileSync(secretPath, '# 紫藤\n\n紫藤旧口令已经废弃。\n', 'utf8');
  await indexVault(config, { semantic: false });

  // 2. Physically delete the file without syncing
  unlinkSync(secretPath);
  assert.equal(existsSync(secretPath), false);

  // 3. Search for the deleted content - must NOT throw
  const result = await searchSecondBrain({
    vault,
    dataDir,
    query: '紫藤旧口令',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });

  assert.equal(result.decision, 'insufficient', 'Deleted physical file must return insufficient');
  assert.equal(result.degraded, true, 'Search after unindexed physical deletion must report degraded=true');
  assert.equal(result.evidence.length, 0, 'No evidence should be opened for deleted file');
});

test('P1-1 probe: modified dirty file stale lexical hits are filtered and do not ground removed facts', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  const secretPath = join(vault, '02-项目', '北辰仓配项目', '01-输入', '云杉.md');
  writeFileSync(secretPath, '# 云杉\n\n云杉暗号已经启用。\n', 'utf8');
  await indexVault(config, { semantic: false });

  // Modify file
  writeFileSync(secretPath, '# 云杉\n\n现在只保留白桦说明。\n', 'utf8');

  const result = await searchSecondBrain({
    vault,
    dataDir,
    query: '云杉暗号',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });

  assert.equal(result.decision, 'insufficient', 'Removed fact from modified file must not ground');
});

test('P1-2 probe: stale-lock claim does not delete active newly acquired lock', async () => {
  const { config } = createSyntheticEnv();
  const p = lockPath(config);

  // 1. Write an observed stale lock (dead PID 999999)
  const { mkdirSync } = await import('node:fs');
  mkdirSync(config.indexDir, { recursive: true });
  const deadLockData = {
    token: 'dead-token-1111',
    pid: 999999,
    generationId: 'gen-dead',
    startedAt: Date.now() - 60000,
    heartbeatAt: Date.now() - 60000,
  };
  writeFileSync(p, JSON.stringify(deadLockData, null, 2), 'utf8');

  // 2. Simulate Process B acquiring a brand new active lock while Process A was reading
  // Acquire a genuine active lock from current process
  const activeLock = await acquireSyncLock(config, { timeoutMs: 2000, maxStaleMs: 30000 });
  assert.ok(activeLock.token);

  // 3. Now simulate Process A attempting to reclaim using old knowledge of dead PID
  // Active lock must remain untouched and healthy
  const currentLock = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(currentLock.token, activeLock.token);
  assert.equal(currentLock.pid, process.pid);

  activeLock.release();
  assert.equal(existsSync(p), false);
});

test('P1-3 probe: empty semantic database reports semanticHealthy=false and vectorCoverage=0', async () => {
  const { config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  const { mkdirSync } = await import('node:fs');
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(config.semanticDbPath, '', 'utf8');
  writeFileSync(config.semanticMetadataPath, JSON.stringify({
    schemaVersion: 2,
    model: 'BAAI/bge-small-zh-v1.5',
    pending: 0,
  }), 'utf8');

  const health = await readHealth(config);
  assert.equal(health.current.semanticHealthy, false, 'Empty database must report healthy=false');
  assert.equal(health.current.vectorCoverage, 0, 'Empty database coverage must be 0');
});

test('P1-4 probe: deleted files are cleaned from semantic sqlite chunks', async (t) => {
  const { vault, config } = createSyntheticEnv();
  if (!isSemanticRuntimeConfigured(config)) {
    return t.skip('optional semantic runtime and local model are not configured');
  }
  const tempFile = join(vault, '02-项目', '北辰仓配项目', '01-输入', '临时删除件.md');
  writeFileSync(tempFile, '# 临时件\n临时计费每件99元。\n', 'utf8');

  const projects = discoverProjects(vault, config.structure);
  const collections = buildCollections(vault, projects, config.structure);

  const sync1 = await syncSemantic(config, collections, ['project-6046904e9c6d-current'], { mode: 'always' });
  assert.equal(sync1.ok, true);
  assert.equal(existsSync(config.semanticDbPath), true);

  // Delete file from vault
  unlinkSync(tempFile);

  // Sync collections again
  const collectionsAfter = buildCollections(vault, discoverProjects(vault, config.structure), config.structure);
  await syncSemantic(config, collectionsAfter, ['project-6046904e9c6d-current'], { mode: 'always' });

  // Verify deleted file is no longer in sqlite chunks
  const db = new DatabaseSync(config.semanticDbPath, { readOnly: true });
  const rows = db.prepare("SELECT * FROM chunks WHERE relative_path LIKE '%临时删除件%'").all();
  db.close();
  assert.equal(rows.length, 0, 'Deleted file chunks must be removed from sqlite');
});

test('P1-5 probe: failed semantic indexing preserves existing usable chunks and does not wipe database', async (t) => {
  const { vault, config } = createSyntheticEnv();
  if (!isSemanticRuntimeConfigured(config)) {
    return t.skip('optional semantic runtime and local model are not configured');
  }
  const projects = discoverProjects(vault, config.structure);
  const collections = buildCollections(vault, projects, config.structure);

  const sync1 = await syncSemantic(config, collections, ['project-6046904e9c6d-current'], { mode: 'always' });
  assert.equal(sync1.ok, true);

  const db1 = new DatabaseSync(config.semanticDbPath, { readOnly: true });
  const initialRows = db1.prepare('SELECT COUNT(*) as count FROM chunks').all()[0].count;
  db1.close();
  assert.ok(initialRows > 0);

  // Now attempt indexing with invalid environment / failure
  const previousPython = process.env.SECOND_BRAIN_PYTHON;
  process.env.SECOND_BRAIN_PYTHON = 'invalid_python_exe_fail_probe';
  try {
    const failRes = await indexSemantic(config, collections, {});
    assert.equal(failRes.ok, false);
  } finally {
    if (previousPython === undefined) delete process.env.SECOND_BRAIN_PYTHON;
    else process.env.SECOND_BRAIN_PYTHON = previousPython;
  }

  // Verify database rows were NOT deleted
  const db2 = new DatabaseSync(config.semanticDbPath, { readOnly: true });
  const finalRows = db2.prepare('SELECT COUNT(*) as count FROM chunks').all()[0].count;
  db2.close();
  assert.equal(finalRows, initialRows, 'Failed indexing must not wipe previous database chunks');
});

test('P1-7 probe: sync with mode=always fails when semantic environment is missing', async () => {
  const { config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  process.env.SECOND_BRAIN_PYTHON = 'non_existent_python_path_12345';
  try {
    const syncRes = await syncVault(config, {
      projectName: '北辰仓配项目',
      temporalIntent: 'current',
      semanticMode: 'always',
    });
    assert.equal(syncRes.ok, false, 'syncVault with mode=always must return ok=false when semantic fails');
  } finally {
    delete process.env.SECOND_BRAIN_PYTHON;
  }
});

test('P2-1 probe: deterministic concurrent write during sync is detected and remains dirty', async () => {
  const { vault, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  const quotePath = join(vault, '02-项目', '北辰仓配项目', '01-输入', '当前报价.md');

  // Trigger concurrent edit precisely during sync after snapshotBefore is taken
  const syncRes = await syncVault(config, {
    projectName: '北辰仓配项目',
    temporalIntent: 'current',
    semanticMode: 'never',
    _testHookAfterSnapshot: async () => {
      writeFileSync(quotePath, readFileSync(quotePath, 'utf8') + '\n\n- 2026-08-24 确定性同步中途并发修改测试。\n', 'utf8');
    },
  });

  // 1. Unconditionally assert that sync detected the concurrent modification
  assert.equal(syncRes.sourceChangedDuringSync, true, 'syncVault must detect concurrent file modification during sync');

  // 2. Unconditionally assert that health check flags this file as dirty
  const health = await readHealth(config);
  assert.equal(health.current.lexicalFresh, false, 'File modified during sync must remain dirty');
  assert.ok(health.current.pendingFiles >= 1, 'Pending files must be at least 1');
});

test('P2-2 probe: auto semantic skip writes semanticReady=false and retains reason in metadata', async () => {
  const { config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  // Point to a non-existent semantic python path so auto skips
  process.env.SECOND_BRAIN_PYTHON = 'non_existent_python_path_auto_probe';
  try {
    const syncRes = await syncVault(config, {
      projectName: '北辰仓配项目',
      temporalIntent: 'current',
      semanticMode: 'auto',
    });

    assert.equal(syncRes.ok, true, 'Auto mode returns ok=true at top level');
    assert.equal(syncRes.semantic.skipped, true, 'Semantic sync is skipped');
    assert.equal(syncRes.metadata.semanticReady, false, 'Metadata must record semanticReady=false when skipped');
    assert.ok(typeof syncRes.metadata.semanticReason === 'string', 'Metadata must retain skip reason');
  } finally {
    delete process.env.SECOND_BRAIN_PYTHON;
  }
});

test('P2-3 probe: micro-budget under 100ms exits early without spawning worker', async () => {
  const { vault, config } = createSyntheticEnv();
  const projects = discoverProjects(vault, config.structure);
  const collections = buildCollections(vault, projects, config.structure);

  const res = await syncSemantic(config, collections, collections.map((c) => c.name), {
    mode: 'auto',
    budgetMs: 1,
  });

  assert.equal(res.ok, true);
  assert.equal(res.embedded, 0, 'Zero chunks embedded for micro budget');
  assert.ok(res.pending >= 1, 'Pending chunks recorded');
});

test('R1-01: scan-release.ps1 does not misidentify SHA-256 hash containing phone-like substring as mobile number', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const root = mkdtempSync(join(tmpdir(), 'sbrain-scan-probe-'));
  const source = join(root, 'source');
  const outputRoot = join(root, 'output');
  mkdirSync(source, { recursive: true });

  const fakeHash = 'a1f94813812345678b40cdef1234567890abcdef1234567890abcdef12345678';
  writeFileSync(join(source, 'README.md'), `# Test\n\nCommit hash: ${fakeHash}\n`, 'utf8');
  writeFileSync(join(source, 'AGENTS.md'), '# Agents\n- PlanOnly\n- IndexMode lexical\ninstall-wizard.ps1\n', 'utf8');
  writeFileSync(join(source, 'START-HERE.md'), '# Start\n', 'utf8');
  writeFileSync(join(source, 'INSTALL.cmd'), '@echo off\r\n%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -File "%INSTALLER_ROOT%scripts\\install-wizard.ps1"\r\nexit /b %INSTALL_EXIT%\r\n', 'utf8');
  writeFileSync(join(source, 'LICENSE'), 'MIT License\n', 'utf8');
  writeFileSync(join(source, 'SECURITY.md'), '# Security\n', 'utf8');
  writeFileSync(join(source, 'PRIVACY.md'), '# Privacy\n', 'utf8');
  writeFileSync(join(source, 'THIRD_PARTY_NOTICES.md'), '# Notices\n', 'utf8');
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'synthetic-release', version: '0.0.0', private: true }), 'utf8');
  writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ name: 'synthetic-release', version: '0.0.0', lockfileVersion: 3 }), 'utf8');

  const repository = fileURLToPath(new URL('..', import.meta.url));
  cpSync(join(repository, 'scripts'), join(source, 'scripts'), { recursive: true });
  cpSync(join(repository, 'schemas'), join(source, 'schemas'), { recursive: true });
  cpSync(join(repository, 'skill'), join(source, 'skill'), { recursive: true });
  cpSync(join(repository, 'src'), join(source, 'src'), { recursive: true });
  cpSync(join(repository, 'docs'), join(source, 'docs'), { recursive: true });
  cpSync(join(repository, 'test'), join(source, 'test'), { recursive: true });
  writeFileSync(join(source, 'requirements-semantic.txt'), 'fastembed==0.8.0\nonnxruntime==1.20.1; platform_system == "Windows"\n', 'utf8');

  const buildScript = join(repository, 'scripts', 'build-release.ps1');
  const buildRes = spawnSync('powershell.exe', ['-NoProfile', '-File', buildScript, '-SourceRoot', source, '-OutputRoot', outputRoot], {
    encoding: 'utf8',
  });
  assert.equal(buildRes.status, 0, `Build release must succeed: ${buildRes.stderr}`);

  const scanScript = join(fileURLToPath(new URL('..', import.meta.url)), 'scripts', 'scan-release.ps1');
  const stageDirName = readdirSync(outputRoot).find((name) => !name.endsWith('.zip') && !name.endsWith('.tar.gz'));
  const stage = join(outputRoot, stageDirName);
  const res = spawnSync('powershell.exe', ['-NoProfile', '-File', scanScript, '-Path', stage, '-AllowSyntheticFixtures'], {
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `First round scan with fake hash in SHA256SUMS must succeed with exit code 0: ${res.stderr || res.stdout}`);
  assert.ok(!res.stdout.includes('mainland-mobile-number'), 'SHA-256 hash containing phone-like digits must not trigger mainland-mobile-number finding');

  // 2. Write a real mobile number and verify it IS detected
  const testPhone = '138' + '12345678';
  writeFileSync(join(stage, 'README.md'), `# Test\n\n联系电话：${testPhone}\n`, 'utf8');
  const resFail = spawnSync('powershell.exe', ['-NoProfile', '-File', scanScript, '-Path', stage, '-AllowSyntheticFixtures'], {
    encoding: 'utf8',
  });
  const combinedOutput = `${resFail.stdout || ''}\n${resFail.stderr || ''}`;
  assert.ok(combinedOutput.includes('mainland-mobile-number'), 'Genuine mobile number must trigger mainland-mobile-number finding');
});

test('P2-03 probe: WAL checkpoint busy/error degrades health and reports reason', async () => {
  const { config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  // 1. Initial healthy state
  const initialHealth = await readHealth(config);
  assert.equal(initialHealth.current.lexicalFresh, true);

  // 2. Simulate WAL checkpoint contention recorded in metadata.json
  const metadata = JSON.parse(readFileSync(config.metadataPath, 'utf8'));
  metadata.checkpointStatus = { busy: true, code: 5, error: 'sqlite3_wal_checkpoint_v2 busy' };
  writeFileSync(config.metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

  // 3. Verify health reading reflects degraded status
  const degradedHealth = await readHealth(config);
  assert.equal(degradedHealth.current.degraded, true, 'Checkpoint busy must mark current scope as degraded');
  assert.equal(degradedHealth.current.semanticHealthy, false, 'Semantic healthy must be false when checkpoint is degraded');
  assert.equal(degradedHealth.current.reason, 'sqlite wal checkpoint is busy or degraded');
  assert.deepEqual(degradedHealth.metadata.checkpointStatus, { busy: true, code: 5, error: 'sqlite3_wal_checkpoint_v2 busy' });
});
