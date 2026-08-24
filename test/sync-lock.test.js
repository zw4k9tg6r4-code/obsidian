import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeConfig } from '../src/config.js';
import { indexVault, syncVault, readHealth } from '../src/qmd-adapter.js';
import { searchSecondBrain } from '../src/retrieval.js';
import { acquireSyncLock, lockPath, readSyncLock } from '../src/lock.js';

const fixtureVault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

function createSyntheticEnv() {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-lock-test-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });
  return { root, vault, dataDir, config };
}

test('search does not block on active sync lock and uses read-only overlay', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  // Add dirty file
  const newFilePath = join(vault, '02-项目', '北辰仓配项目', '01-输入', '加急件.md');
  writeFileSync(newFilePath, '# 加急件\n\n加急件特殊处理费每件33元。\n', 'utf8');

  // Acquire sync lock manually
  const lock = await acquireSyncLock(config, { timeoutMs: 1000 });
  assert.ok(lock);

  // Search must succeed immediately without acquiring lock or erroring
  const searchResult = await searchSecondBrain({
    vault,
    dataDir,
    query: '加急件 特殊处理费 33元',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });

  assert.equal(searchResult.decision, 'grounded');
  assert.ok(searchResult.evidence.some((item) => item.path.includes('加急件.md')));

  lock.release();
});

test('stale sync lock from a dead PID is automatically reclaimed', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  const path = lockPath(config);
  // Write fake dead lock
  writeFileSync(path, JSON.stringify({
    token: 'dead-token',
    pid: 9999999, // Highly improbable PID
    generationId: 'gen-dead',
    startedAt: Date.now() - 60000,
    heartbeatAt: Date.now() - 60000,
  }), 'utf8');

  // Next syncVault must succeed by reclaiming the dead lock
  const syncRes = await syncVault(config, {
    projectName: '北辰仓配项目',
    temporalIntent: 'current',
    semanticMode: 'never',
  });
  assert.equal(syncRes.ok, true);
});
