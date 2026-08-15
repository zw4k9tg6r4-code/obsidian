import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeConfig } from '../src/config.js';
import { indexVault, readHealth } from '../src/qmd-adapter.js';
import { searchSecondBrain } from '../src/retrieval.js';

const vault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

async function indexedSandbox() {
  const dataDir = mkdtempSync(join(tmpdir(), 'sbrain-index-'));
  const config = resolveRuntimeConfig({ vault, dataDir });
  await indexVault(config, { semantic: false });
  return config;
}

test('lexical index stays outside vault and reports degraded semantic mode', async () => {
  const config = await indexedSandbox();
  const health = await readHealth(config);
  assert.equal(health.indexed, true);
  assert.equal(health.indexFresh, true);
  assert.equal(health.semanticHealthy, false);
  assert.equal(health.degraded, true);
});

test('current project search never returns another project or old process notes', async () => {
  const config = await indexedSandbox();
  const result = await searchSecondBrain({
    vault,
    dataDir: config.dataDir,
    query: '标准仓储服务费 每托盘 120 元',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });
  assert.equal(result.decision, 'grounded');
  assert.ok(result.evidence.length > 0);
  assert.ok(result.evidence.every((item) => !item.path.includes('西岭运输项目')));
  assert.ok(result.evidence.every((item) => !item.path.includes('/02-过程/')));
  assert.ok(result.evidence.length <= 4);
  assert.ok(result.relatedEvidence.length <= 2);
  const audit = readFileSync(join(config.auditDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
  assert.ok(!audit.includes('120 元'));
  assert.match(audit, /queryHash/);
});

test('project-scoped search excludes project facts stored in global long-term memory', async () => {
  const config = await indexedSandbox();
  const result = await searchSecondBrain({
    vault,
    dataDir: config.dataDir,
    query: '雪岭结算码 7788',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });
  assert.equal(result.decision, 'insufficient');
  assert.ok(result.evidence.every((item) => !item.path.startsWith('01-长期记忆/项目专属事实.md')));
});

test('project-scoped search still includes explicit global governance rules', async () => {
  const config = await indexedSandbox();
  const result = await searchSecondBrain({
    vault,
    dataDir: config.dataDir,
    query: '事实回答必须附上来源',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });
  assert.equal(result.decision, 'grounded');
  assert.ok(result.evidence.some((item) => item.path === '01-长期记忆/合作规则.md'));
});

test('history search may retrieve superseded process notes', async () => {
  const config = await indexedSandbox();
  const result = await searchSecondBrain({
    vault,
    dataDir: config.dataDir,
    query: '早期草案 每托盘 80 元',
    projectName: '北辰仓配项目',
    temporalIntent: 'history',
    lexicalOnly: true,
  });
  assert.ok(result.evidence.some((item) => item.path.includes('/02-过程/旧方案.md')));
});

test('ambiguous project identity abstains before search', async () => {
  const config = await indexedSandbox();
  const result = await searchSecondBrain({
    vault,
    dataDir: config.dataDir,
    query: '比较北辰仓配和西岭运输的价格',
    lexicalOnly: true,
  });
  assert.equal(result.decision, 'insufficient');
  assert.equal(result.scope.kind, 'ambiguous');
  assert.deepEqual(result.evidence, []);
});

test('explicit disputed evidence produces conflict', async () => {
  const config = await indexedSandbox();
  const result = await searchSecondBrain({
    vault,
    dataDir: config.dataDir,
    query: '发车日期存在什么冲突',
    projectName: '西岭运输项目',
    lexicalOnly: true,
  });
  assert.equal(result.decision, 'conflict');
  assert.ok(result.conflicts.length > 0);
});

test('maxEvidence cannot hide a conflict found in the broader candidate set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-conflict-limit-'));
  const conflictVault = join(root, 'vault');
  cpSync(vault, conflictVault, { recursive: true });
  writeFileSync(
    join(conflictVault, '02-项目', '北辰仓配项目', '01-输入', '冲突报价.md'),
    '---\nupdated: 2026-08-15\nfact_status: current\n---\n\n# 标准仓储服务费\n\n标准仓储服务费为每托盘 80 元。\n',
    'utf8',
  );
  const config = resolveRuntimeConfig({ vault: conflictVault, dataDir: join(root, 'data') });
  await indexVault(config, { semantic: false });
  const result = await searchSecondBrain({
    vault: conflictVault,
    dataDir: config.dataDir,
    query: '当前标准仓储服务费是多少',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
    maxEvidence: 1,
  });
  assert.equal(result.decision, 'conflict');
  assert.ok(result.evidence.length <= 1);
  assert.ok(result.conflicts.length >= 2);
  assert.ok(result.conflicts.some((item) => item.path.endsWith('/冲突报价.md')));
  assert.ok(result.conflicts.some((item) => item.snippet.includes('120 元')));
});

test('requested semantic initialization fails closed when the worker fails', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sbrain-semantic-failure-'));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = spawnSync(process.execPath, [
    cli,
    'index',
    '--vault', vault,
    '--data-dir', dataDir,
    '--semantic',
    '--json',
  ], {
    encoding: 'utf8',
    env: { ...process.env, SECOND_BRAIN_PYTHON: process.execPath },
    timeout: 30_000,
  });
  assert.equal(run.status, 2, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.metadata.semanticReady, false);
  assert.equal(result.semantic.ok, false);
});

test('archived projects require explicit history intent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-archived-'));
  const archivedVault = join(root, 'vault');
  cpSync(vault, archivedVault, { recursive: true });
  const home = join(archivedVault, '02-项目', '北辰仓配项目', '项目主页.md');
  writeFileSync(home, readFileSync(home, 'utf8').replace('status: active', 'status: archived'), 'utf8');
  const config = resolveRuntimeConfig({ vault: archivedVault, dataDir: join(root, 'data') });
  await indexVault(config, { semantic: false });

  const current = await searchSecondBrain({
    vault: archivedVault,
    dataDir: config.dataDir,
    query: '北辰仓配当前价格',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });
  assert.equal(current.decision, 'insufficient');
  assert.deepEqual(current.evidence, []);

  const history = await searchSecondBrain({
    vault: archivedVault,
    dataDir: config.dataDir,
    query: '北辰仓配历史价格120元',
    projectName: '北辰仓配项目',
    temporalIntent: 'history',
    lexicalOnly: true,
  });
  assert.equal(history.decision, 'grounded');
});
