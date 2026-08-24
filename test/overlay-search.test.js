import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeConfig } from '../src/config.js';
import { indexVault, syncVault, readHealth } from '../src/qmd-adapter.js';
import { searchSecondBrain } from '../src/retrieval.js';

const fixtureVault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

function createSyntheticEnv() {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-overlay-test-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });
  return { root, vault, dataDir, config };
}

test('unindexed dirty files in scope can be recalled via read-only in-memory overlay', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  // Add a new file in Project A current input directory
  const newFilePath = join(vault, '02-项目', '北辰仓配项目', '01-输入', '紧急通知.md');
  writeFileSync(newFilePath, '# 紧急通知\n\n北辰仓配新增特殊装卸费每托盘55元。\n', 'utf8');

  // Search without syncing - overlay must recall the new file in memory
  const result = await searchSecondBrain({
    vault,
    dataDir,
    query: '特殊装卸费 55元',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });

  assert.equal(result.decision, 'grounded');
  assert.ok(result.evidence.length > 0);
  assert.ok(result.evidence.some((item) => item.path.includes('紧急通知.md')));

  // Search must NOT modify database or write files
  // Now test sync: sync the project
  const syncRes = await syncVault(config, {
    projectName: '北辰仓配项目',
    temporalIntent: 'current',
    semanticMode: 'never',
  });
  assert.equal(syncRes.ok, true);

  const health = await readHealth(config);
  assert.equal(health.current.lexicalFresh, true);
});

test('overlay does not cross project boundaries or time scopes', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  // Add a new dirty file in Project A
  const newProjA = join(vault, '02-项目', '北辰仓配项目', '01-输入', '专属暗号.md');
  writeFileSync(newProjA, '# 暗号\n\n专属暗号为九九归一99。\n', 'utf8');

  // Add a new dirty file in history log
  const logPath = join(vault, '04-对话纪要', '2026-08.md');
  writeFileSync(logPath, readFileSync(logPath, 'utf8') + '\n\n- 历史暗号为九九归一99。\n', 'utf8');

  // Search Project B for the keyword -> must NOT recall Project A or history log
  const resultB = await searchSecondBrain({
    vault,
    dataDir,
    query: '专属暗号 九九归一99',
    projectName: '西岭运输项目',
    lexicalOnly: true,
  });
  assert.equal(resultB.decision, 'insufficient');
  assert.deepEqual(resultB.evidence, []);
});
