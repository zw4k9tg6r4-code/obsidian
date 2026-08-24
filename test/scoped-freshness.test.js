import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeConfig } from '../src/config.js';
import { indexVault, readHealth } from '../src/qmd-adapter.js';
import { searchSecondBrain } from '../src/retrieval.js';

const fixtureVault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

function createSyntheticEnv() {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-scoped-test-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });
  return { root, vault, dataDir, config };
}

test('modifying monthly conversation log does not degrade current project search', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  // Baseline: fresh
  let health = await readHealth(config);
  assert.equal(health.current.lexicalFresh, true);
  assert.equal(health.overall.allFresh, true);

  // Modify monthly conversation log in 04-对话纪要/2026-08.md
  const logPath = join(vault, '04-对话纪要', '2026-08.md');
  const originalLog = readFileSync(logPath, 'utf8');
  writeFileSync(logPath, originalLog + '\n\n- 2026-08-24 新增日常对话记录。\n', 'utf8');

  // Check health: current must remain fresh; history is pending
  health = await readHealth(config);
  assert.equal(health.current.lexicalFresh, true, 'current project scope must stay fresh when only history changed');
  assert.equal(health.history.lexicalFresh, false, 'history scope must detect dirty log');
  assert.equal(health.history.pendingFiles, 1);
  assert.equal(health.overall.allFresh, false);

  // Current project search must retain indexFresh=true
  const result = await searchSecondBrain({
    vault,
    dataDir,
    query: '标准仓储服务费 每托盘 120 元',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });
  assert.equal(result.decision, 'grounded');
  assert.equal(result.indexFresh, true);
});

test('modifying Project A does not mark Project B search as degraded', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  // Modify Project A (西岭运输项目)
  const projAPath = join(vault, '02-项目', '西岭运输项目', '01-输入', '日期冲突.md');
  writeFileSync(projAPath, readFileSync(projAPath, 'utf8') + '\n\n补充备注文档。\n', 'utf8');

  // Search Project B (北辰仓配项目) -> must stay fresh
  const resultB = await searchSecondBrain({
    vault,
    dataDir,
    query: '标准仓储服务费 每托盘 120 元',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });
  assert.equal(resultB.decision, 'grounded');
  assert.equal(resultB.indexFresh, true);
});

test('modifying global governance file marks all project current scopes as dirty', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  // Modify AGENTS.md (global governance)
  const agentsPath = join(vault, 'AGENTS.md');
  writeFileSync(agentsPath, readFileSync(agentsPath, 'utf8') + '\n\n<!-- updated governance rule -->\n', 'utf8');

  const health = await readHealth(config);
  assert.equal(health.current.lexicalFresh, false, 'global governance change must mark current scope dirty');
  assert.equal(health.current.pendingFiles >= 1, true);
});

test('markdown files not belonging to any collection do not affect freshness', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  // Create an unmapped markdown file outside standard collections (e.g. in an ignored _temp dir)
  const unmappedDir = join(vault, '_untracked');
  const unmappedFile = join(unmappedDir, 'notes.md');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(unmappedDir, { recursive: true });
  writeFileSync(unmappedFile, '# Untracked file\nThis is not in any collection.\n', 'utf8');

  const health = await readHealth(config);
  assert.equal(health.current.lexicalFresh, true);
  assert.equal(health.overall.allFresh, true);
});
