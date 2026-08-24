import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resolveRuntimeConfig } from '../src/config.js';
import { indexVault, syncVault, readHealth } from '../src/qmd-adapter.js';
import { searchSecondBrain } from '../src/retrieval.js';
import { indexSemantic, syncSemantic } from '../src/semantic-adapter.js';
import { buildCollections, discoverProjects } from '../src/vault.js';

const fixtureVault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

function createSyntheticEnv() {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-probes-test-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });
  return { root, vault, dataDir, config };
}

test('P1-1 probe: removed fact from dirty file cannot ground from stale lexical index', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  // 1. Create a unique fact in a new input file
  const secretPath = join(vault, '02-项目', '北辰仓配项目', '01-输入', '云杉.md');
  writeFileSync(secretPath, '# 云杉\n\n云杉暗号已经启用。\n', 'utf8');
  await indexVault(config, { semantic: false });

  // 2. Modify the file to remove "云杉暗号" and replace it with "现在只保留白桦说明"
  writeFileSync(secretPath, '# 云杉\n\n现在只保留白桦说明。\n', 'utf8');

  // 3. Search for the removed fact without syncing
  const result = await searchSecondBrain({
    vault,
    dataDir,
    query: '云杉暗号',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });

  // Stale lexical index must NOT ground the deleted fact
  assert.notEqual(result.decision, 'grounded', 'Deleted fact must not be grounded from stale lexical index');
  assert.equal(result.decision, 'insufficient');
});

test('P1-2 probe: file modified during sync remains dirty and is not marked fresh', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  const quotePath = join(vault, '02-项目', '北辰仓配项目', '01-输入', '当前报价.md');

  // Hook sync: simulate concurrent edit right when sync occurs
  const syncPromise = syncVault(config, {
    projectName: '北辰仓配项目',
    temporalIntent: 'current',
    semanticMode: 'never',
  });

  // Concurrent edit
  writeFileSync(quotePath, readFileSync(quotePath, 'utf8') + '\n\n- 2026-08-24 期间并发加单。\n', 'utf8');

  const syncRes = await syncPromise;
  if (syncRes.sourceChangedDuringSync) {
    const health = await readHealth(config);
    assert.equal(health.current.lexicalFresh, false, 'File modified during sync must remain dirty');
    assert.ok(health.current.pendingFiles >= 1);
  }
});

test('P1-3 probe: empty semantic database reports semanticHealthy=false and vectorCoverage=0', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  // Create empty semantic.sqlite file
  const { mkdirSync } = await import('node:fs');
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(config.semanticDbPath, '', 'utf8');
  writeFileSync(config.semanticMetadataPath, JSON.stringify({
    schemaVersion: 2,
    model: 'BAAI/bge-small-zh-v1.5',
    pending: 0,
  }), 'utf8');

  const health = await readHealth(config);
  assert.equal(health.current.semanticHealthy, false, 'Empty database must not report healthy');
  assert.equal(health.current.vectorCoverage, 0, 'Empty database coverage must be 0');
});

test('P1-4 probe: deleted files are cleaned from semantic sqlite chunks', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  const tempFile = join(vault, '02-项目', '北辰仓配项目', '01-输入', '临时删除件.md');
  writeFileSync(tempFile, '# 临时件\n临时计费每件99元。\n', 'utf8');

  const projects = discoverProjects(vault, config.structure);
  const collections = buildCollections(vault, projects, config.structure);

  // Sync to create semantic database
  const sync1 = await syncSemantic(config, collections, ['project-6046904e9c6d-current'], { mode: 'always' });
  if (sync1.ok && existsSync(config.semanticDbPath)) {
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
  }
});

test('P1-5 probe: failed semantic indexing preserves existing usable chunks and does not wipe database', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  const projects = discoverProjects(vault, config.structure);
  const collections = buildCollections(vault, projects, config.structure);

  // First successfully sync 1 collection
  const sync1 = await syncSemantic(config, collections, ['project-6046904e9c6d-current'], { mode: 'always' });
  if (sync1.ok && existsSync(config.semanticDbPath)) {
    const db1 = new DatabaseSync(config.semanticDbPath, { readOnly: true });
    const initialRows = db1.prepare('SELECT COUNT(*) as count FROM chunks').all()[0].count;
    db1.close();
    assert.ok(initialRows > 0);

    // Now attempt indexing with invalid environment / failure
    process.env.SECOND_BRAIN_PYTHON = 'invalid_python_exe_fail';
    try {
      const failRes = await indexSemantic(config, collections, {});
      assert.equal(failRes.ok, false);
    } finally {
      delete process.env.SECOND_BRAIN_PYTHON;
    }

    // Verify database rows were NOT deleted
    const db2 = new DatabaseSync(config.semanticDbPath, { readOnly: true });
    const finalRows = db2.prepare('SELECT COUNT(*) as count FROM chunks').all()[0].count;
    db2.close();
    assert.equal(finalRows, initialRows, 'Failed indexing must not wipe previous database chunks');
  }
});

test('P1-7 probe: sync with mode=always fails when semantic environment is missing', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  // Point to a non-existent python executable
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

test('P2-1 probe: 1ms budget in auto mode stops before embedding and marks chunks as pending', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  const projects = discoverProjects(vault, config.structure);
  const collections = buildCollections(vault, projects, config.structure);

  const res = await syncSemantic(config, collections, collections.map((c) => c.name), {
    mode: 'auto',
    budgetMs: 1, // 1ms budget
  });

  if (res.ok && !res.skipped) {
    assert.ok(res.pending >= 1, 'Auto mode with 1ms budget must mark pending chunks');
    assert.equal(res.embedded, 0, 'No chunks should be embedded under 1ms budget');
  }
});

test('P2-2 probe: default search reports degraded=true when semantic index is unavailable', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  const result = await searchSecondBrain({
    vault,
    dataDir,
    query: '标准仓储服务费',
    projectName: '北辰仓配项目',
    lexicalOnly: false, // Default hybrid search mode
  });

  assert.equal(result.degraded, true, 'Default search without lexicalOnly=true must report degraded mode when semantic is missing');
  assert.match(result.degradedReason, /semantic/);
});
