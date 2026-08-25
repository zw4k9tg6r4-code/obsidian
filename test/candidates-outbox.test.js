import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { resolveRuntimeConfig } from '../src/config.js';
import { addCandidate, confirmCandidate, activateCandidate, listCandidates } from '../src/candidates.js';

const fixtureVault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

test('P1-02 & P2-05: Transactional outbox persists pending audits, cleans disk outbox, and deduplicates records', () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-outbox-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });

  // 1. Add candidate and verify audit outbox flushed
  const added = addCandidate(config, {
    content: '北辰项目冷链仓储基准费 150元/吨',
    scope: '北辰仓配项目',
    createdBy: 'ai',
  });
  assert.equal(added.created, true);

  // 2. Confirm candidate
  const confirmed = confirmCandidate(config, {
    id: added.record.id,
    userConfirmed: true,
  });
  assert.equal(confirmed.status, 'confirmed');

  // 3. Test timestamp-based deduplication with opposite array order
  const storePath = join(dataDir, 'candidates', 'records.json');
  const storeData = JSON.parse(readFileSync(storePath, 'utf8'));

  const olderRecord = {
    ...storeData.records[0],
    content: '北辰项目冷链仓储基准费 140元/吨 (旧版本)',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const newerRecord = {
    ...storeData.records[0],
    content: '北辰项目冷链仓储基准费 150元/吨 (最新版本)',
    updatedAt: '2026-08-25T10:00:00.000Z',
  };

  // Place older record at the end of the array to test that array order does NOT win
  storeData.records = [newerRecord, olderRecord];
  writeFileSync(storePath, JSON.stringify(storeData, null, 2), 'utf8');

  // List candidates should trigger deduplication and pick newerRecord
  const listed = listCandidates(config);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].content, '北辰项目冷链仓储基准费 150元/吨 (最新版本)');

  // Verify disk file is self-healed and rewritten
  const diskStore = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(diskStore.records.length, 1);
  assert.equal(diskStore.records[0].content, '北辰项目冷链仓储基准费 150元/吨 (最新版本)');
});

test('P1-02: Pending audits replay idempotently, clear disk pendingAudits, and prevent duplicate writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-pending-audit-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });

  const added = addCandidate(config, {
    content: '北辰项目测试事实',
    scope: '北辰仓配项目',
    createdBy: 'ai',
  });

  const storePath = join(dataDir, 'candidates', 'records.json');
  const storeData = JSON.parse(readFileSync(storePath, 'utf8'));

  const eventId = randomUUID();
  const traceId = randomUUID();

  // Inject an uncommitted pending audit event with unique eventId
  const pendingEvent = {
    eventId,
    traceId,
    candidateId: added.record.id,
    from: 'candidate',
    to: 'confirmed',
    occurredAt: '2026-08-25T12:00:00.000Z',
    confirmationType: 'explicit-user',
    sourceRefs: [],
  };
  storeData.pendingAudits = [pendingEvent];
  writeFileSync(storePath, JSON.stringify(storeData, null, 2), 'utf8');

  // 1. First load: should replay and write to audit log, AND clear disk pendingAudits
  listCandidates(config);

  const today = '2026-08-25';
  const auditPath = join(dataDir, 'audit', `${today}.jsonl`);
  assert.equal(existsSync(auditPath), true);

  const diskStoreAfterFirst = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(diskStoreAfterFirst.pendingAudits.length, 0, 'Disk pendingAudits must be cleared after replay');

  // 2. Second load: calling listCandidates again should NOT append duplicate audit entries
  listCandidates(config);

  const auditLines = readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  const matchingEntries = auditLines.filter((entry) => entry.eventId === eventId);
  assert.equal(matchingEntries.length, 1, 'Audit log must contain exactly one entry for eventId (idempotent replay)');
});

test('P2-05: Field repairs rewrite disk records.json even when record count is unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-repair-disk-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });

  const added = addCandidate(config, {
    content: '自愈测试事实',
    scope: '北辰仓配项目',
    createdBy: 'ai',
  });

  const storePath = join(dataDir, 'candidates', 'records.json');
  const storeData = JSON.parse(readFileSync(storePath, 'utf8'));

  // Corrupt contentHash and createdAt on the single record
  storeData.records[0].contentHash = 'corrupted-invalid-hash';
  storeData.records[0].createdAt = 'invalid-date-string';
  writeFileSync(storePath, JSON.stringify(storeData, null, 2), 'utf8');

  // Load via listCandidates
  const listed = listCandidates(config);
  assert.equal(listed.length, 1);

  // Read disk file directly to verify disk was rewritten
  const diskStore = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.match(diskStore.records[0].contentHash, /^[0-9a-f]{64}$/, 'Disk contentHash must be repaired');
  assert.ok(Number.isFinite(Date.parse(diskStore.records[0].createdAt)), 'Disk createdAt must be a valid ISO date');
});

test('P1-02: Supersede transition emits distinct eventIds sharing traceId', () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-supersede-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });

  // 1. Create first candidate, confirm, activate to current
  const cand1 = addCandidate(config, {
    content: '第一版计费规则',
    scope: '北辰仓配项目',
    createdBy: 'user',
  });
  confirmCandidate(config, { id: cand1.record.id, userConfirmed: true });

  const targetFile = join(vault, '02-项目', '北辰仓配项目', '01-输入', '计费规则.md');
  writeFileSync(targetFile, '# 计费\n第一版计费规则\n', 'utf8');
  const text1 = readFileSync(targetFile, 'utf8');
  const hash1 = createHash('sha256').update(text1).digest('hex');
  const current1 = activateCandidate(config, {
    id: cand1.record.id,
    targetPath: targetFile,
    expectedHash: hash1,
  });

  // 2. Create second candidate, confirm, and supersede first
  const cand2 = addCandidate(config, {
    content: '第二版计费规则',
    scope: '北辰仓配项目',
    createdBy: 'user',
  });
  confirmCandidate(config, { id: cand2.record.id, userConfirmed: true });

  writeFileSync(targetFile, '# 计费\n第二版计费规则\n', 'utf8');
  const text2 = readFileSync(targetFile, 'utf8');
  const hash2 = createHash('sha256').update(text2).digest('hex');
  const sharedTraceId = randomUUID();
  const current2 = activateCandidate(config, {
    id: cand2.record.id,
    targetPath: targetFile,
    expectedHash: hash2,
    supersedes: cand1.record.id,
    traceId: sharedTraceId,
  });

  // Read audit events
  const today = new Date().toISOString().slice(0, 10);
  const auditPath = join(dataDir, 'audit', `${today}.jsonl`);
  const auditLines = readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);

  const supersedeAudit = auditLines.find((e) => e.candidateId === cand1.record.id && e.to === 'superseded');
  const activateAudit = auditLines.find((e) => e.candidateId === cand2.record.id && e.to === 'current');

  assert.ok(supersedeAudit);
  assert.ok(activateAudit);
  assert.equal(supersedeAudit.traceId, sharedTraceId);
  assert.equal(activateAudit.traceId, sharedTraceId);
  assert.notEqual(supersedeAudit.eventId, activateAudit.eventId, 'Supersede and activate events must have distinct eventIds');
});
