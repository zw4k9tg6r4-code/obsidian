import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decideEvidence } from '../src/evidence.js';
import { resolveRuntimeConfig } from '../src/config.js';
import { recordCandidateAudit } from '../src/audit.js';

test('two current authoritative sources with 80 and 120 for the same fact are conflict', () => {
  const evidence = [
    {
      path: '02-项目/示例项目/01-输入/费率来源甲.md',
      title: '标准仓储服务费',
      projectId: 'project-example',
      sourceOpened: true,
      authorityScore: 90,
      state: 'current',
      snippet: '标准仓储服务费为每托盘 80 元。',
    },
    {
      path: '02-项目/示例项目/01-输入/费率来源乙.md',
      title: '标准仓储服务费',
      projectId: 'project-example',
      sourceOpened: true,
      authorityScore: 90,
      state: 'current',
      snippet: '标准仓储服务费为每托盘 120 元。',
    },
  ];
  const assessment = decideEvidence({
    query: '当前标准仓储服务费是多少',
    evidence,
    scope: { kind: 'project', project: { id: 'project-example', name: '示例项目' } },
    indexFresh: true,
  });
  assert.equal(assessment.decision, 'conflict');
  assert.deepEqual(assessment.conflictEvidencePaths, evidence.map((item) => item.path));
});

test('data directory inside the vault is rejected before any directory is created', () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-config-review-'));
  const vault = join(root, 'vault');
  mkdirSync(vault);
  writeFileSync(join(vault, 'AGENTS.md'), '# Synthetic vault\n', 'utf8');
  const forbiddenDataDir = join(vault, 'derived-data');
  assert.equal(existsSync(forbiddenDataDir), false);
  assert.throws(
    () => resolveRuntimeConfig({ vault, dataDir: forbiddenDataDir }),
    /must not contain one another/i,
  );
  assert.equal(existsSync(forbiddenDataDir), false);
});

test('data directory reached through a directory link is rejected before creation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-config-link-review-'));
  const vault = join(root, 'vault');
  const link = join(root, 'data-link');
  mkdirSync(vault);
  writeFileSync(join(vault, 'AGENTS.md'), '# Synthetic vault\n', 'utf8');
  try {
    symlinkSync(vault, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`directory links are unavailable in this environment: ${error.code || error.message}`);
    return;
  }
  const forbiddenDataDir = join(link, 'derived-data');
  assert.throws(
    () => resolveRuntimeConfig({ vault, dataDir: forbiddenDataDir }),
    /must not contain one another/i,
  );
  assert.equal(existsSync(join(vault, 'derived-data')), false);
});

test('data directory lexically inside the vault stays rejected when its link points outside', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-config-outward-link-review-'));
  const vault = join(root, 'vault');
  const external = join(root, 'external-data');
  const link = join(vault, 'derived-link');
  mkdirSync(vault);
  mkdirSync(external);
  writeFileSync(join(vault, 'AGENTS.md'), '# Synthetic vault\n', 'utf8');
  try {
    symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`directory links are unavailable in this environment: ${error.code || error.message}`);
    return;
  }
  assert.throws(
    () => resolveRuntimeConfig({ vault, dataDir: join(link, 'nested') }),
    /must not contain one another/i,
  );
  assert.equal(existsSync(join(external, 'nested')), false);
});

test('pre-existing derived-state junction cannot redirect audit writes into the vault', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-config-nested-link-review-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  mkdirSync(vault);
  mkdirSync(dataDir);
  writeFileSync(join(vault, 'AGENTS.md'), '# Synthetic vault\n', 'utf8');
  try {
    symlinkSync(vault, join(dataDir, 'audit'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`directory links are unavailable in this environment: ${error.code || error.message}`);
    return;
  }
  assert.throws(
    () => resolveRuntimeConfig({ vault, dataDir }),
    /symbolic links|junctions|escapes/i,
  );
  assert.equal(existsSync(join(vault, `${new Date().toISOString().slice(0, 10)}.jsonl`)), false);
});

test('audit source references are stored only as hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-audit-review-'));
  const auditDir = join(root, 'audit');
  const sensitiveReference = ['02-项目', '客户甲', '01-输入', `client-${'secret'}-fixture.md`].join('/');
  recordCandidateAudit({ auditDir }, {
    candidateId: randomUUID(),
    from: 'candidate',
    to: 'confirmed',
    confirmationType: 'authoritative-source',
    sourceRefs: [sensitiveReference, sensitiveReference],
  });

  const date = new Date().toISOString().slice(0, 10);
  const raw = readFileSync(join(auditDir, `${date}.jsonl`), 'utf8');
  assert.doesNotMatch(raw, /客户甲|client-secret-fixture/i);
  const record = JSON.parse(raw.trim());
  assert.equal(record.sourceRefs.length, 1);
  assert.match(record.sourceRefs[0], /^sha256:[0-9a-f]{64}$/);
});
