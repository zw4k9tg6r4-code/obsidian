import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { resolveRuntimeConfig } from '../src/config.js';
import { addCandidate, listCandidates } from '../src/candidates.js';
import { getProcessIdentity, withJsonLock } from '../src/io.js';

const fixture = fileURLToPath(new URL('./fixtures/vault', import.meta.url));
const schemaRaw = readFileSync(fileURLToPath(new URL('../schemas/candidate-store.schema.json', import.meta.url)), 'utf8');
const storeSchema = JSON.parse(schemaRaw);

function deterministicUuid(input) {
  const hash = createHash('sha256').update(String(input).trim()).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-recovery-'));
  const config = resolveRuntimeConfig({ vault: fixture, dataDir: join(root, 'data') });
  return { root, config };
}

const RFC3339_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

function assertStoreValid(config) {
  const storePath = join(config.candidatesDir, 'records.json');
  assert.ok(existsSync(storePath), 'records.json must exist');
  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  ajv.addFormat('date-time', (d) => typeof d === 'string' && RFC3339_DATETIME_REGEX.test(d.trim()) && Number.isFinite(Date.parse(d)));
  const validate = ajv.compile(storeSchema);
  const valid = validate(store);
  if (!valid) {
    console.error('Candidate store schema validation errors:', validate.errors);
  }
  assert.equal(valid, true, 'Candidate store must strictly validate against candidate-store.schema.json');
}

test('corrupt candidate store is quarantined, rebuilt, and passes schema validation', () => {
  const { config } = sandbox();
  writeFileSync(join(config.candidatesDir, 'records.json'), '{not valid json', 'utf8');
  const added = addCandidate(config, { content: '损坏后新增的候选事实', scope: '北辰仓配项目' });
  assert.equal(added.created, true);
  assert.equal(listCandidates(config).length, 1);
  const quarantined = readdirSync(config.candidatesDir).filter((name) => name.startsWith('records.corrupt-'));
  assert.equal(quarantined.length, 1);
  assertStoreValid(config);
});

test('withJsonLock runs the critical section and removes the lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-lock-'));
  const lock = join(dir, 'records.lock');
  assert.equal(withJsonLock(lock, () => 'done'), 'done');
  assert.equal(existsSync(lock), false);
  assert.equal(withJsonLock(lock, (value) => value), undefined);
});

test('candidate-store lock never preempts a live matching process because of stale mtime', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-lock-live-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, 'records.lock');
  const processIdentity = getProcessIdentity(process.pid);
  if (!processIdentity) return t.skip('OS process-start identity is unavailable');
  writeFileSync(lock, JSON.stringify({
    token: 'live-owner',
    pid: process.pid,
    processIdentity,
    startedAt: Date.now() - 60_000,
  }), 'utf8');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  let entered = false;

  assert.throws(
    () => withJsonLock(lock, () => { entered = true; }, { timeoutMs: 120, maxStaleMs: 1 }),
    /Timed out waiting for store lock/,
  );
  assert.equal(entered, false, 'Contender must not enter while the recorded owner process is still alive');
});

test('candidate-store lock reclaims an orphan when the PID was reused by another process identity', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-lock-pid-reuse-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, 'records.lock');
  const processIdentity = getProcessIdentity(process.pid);
  if (!processIdentity) return t.skip('OS process-start identity is unavailable');
  writeFileSync(lock, JSON.stringify({
    token: 'orphaned-owner',
    pid: process.pid,
    processIdentity: `${processIdentity}-previous-process`,
    startedAt: Date.now(),
  }), 'utf8');

  assert.equal(
    withJsonLock(lock, () => 'reclaimed', { timeoutMs: 500, maxStaleMs: 30_000 }),
    'reclaimed',
  );
  assert.equal(existsSync(lock), false);
});

test('duplicate non-UUID IDs in records.json are deterministically healed and validate against schema', () => {
  const { config } = sandbox();
  const corruptedStore = {
    schemaVersion: 1,
    records: [
      {
        id: 'dup-1',
        scope: '北辰仓配项目',
        projectId: 'project-98c5be271295',
        projectName: '北辰仓配项目',
        content: '版本1',
        contentHash: 'hash1',
        status: 'candidate',
        createdBy: 'ai',
        createdAt: '2026-08-25T10:00:00.000Z',
        updatedAt: '2026-08-25T10:00:00.000Z',
        sourceRefs: [],
        confirmation: null,
        currentSource: null,
        supersedes: null,
        history: [{ at: '2026-08-25T10:00:00.000Z', from: null, to: 'candidate' }],
      },
      {
        id: 'dup-1',
        scope: '北辰仓配项目',
        projectId: 'project-98c5be271295',
        projectName: '北辰仓配项目',
        content: '版本2',
        contentHash: 'hash2',
        status: 'candidate',
        createdBy: 'ai',
        createdAt: '2026-08-25T10:05:00.000Z',
        updatedAt: '2026-08-25T10:05:00.000Z',
        sourceRefs: [],
        confirmation: null,
        currentSource: null,
        supersedes: null,
        history: [{ at: '2026-08-25T10:05:00.000Z', from: null, to: 'candidate' }],
      },
    ],
  };
  writeFileSync(join(config.candidatesDir, 'records.json'), JSON.stringify(corruptedStore), 'utf8');

  const list = listCandidates(config);
  assert.equal(list.length, 1, 'Duplicate ID must be deduplicated on load');
  assert.equal(list[0].content, '版本2', 'Should retain the newest record');
  assert.equal(list[0].id.length, 36, 'Healed ID must be a standard 36-character UUID');
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(list[0].id), 'Must match standard UUID format');
  assertStoreValid(config);
});

test('P2-05: Malformed nested enums and absolute paths are cleaned to strictly conform to schema', () => {
  const { config } = sandbox();
  const rawWithBadNestedFields = {
    schemaVersion: 1,
    records: [
      {
        id: 'test-bad-nested',
        scope: '北辰仓配项目',
        projectId: 'invalid-project-format',
        projectName: '北辰仓配项目',
        content: '测试非法嵌套枚举与绝对路径清洗',
        contentHash: 'bad-hash',
        status: 'candidate',
        createdBy: 'user',
        createdAt: '2026-08-25T10:00:00.000Z',
        updatedAt: '2026-08-25T10:00:00.000Z',
        sourceRefs: ['C:/Forbidden/secret.md', 'valid/ref.md', '/var/path.md'],
        confirmation: {
          type: 'bogus',
          at: '2026-08-25T10:00:00.000Z',
          sourceRef: 'C:/Forbidden/secret.md',
        },
        currentSource: {
          path: 'C:/Forbidden/secret.md',
          contentHash: 'bad-hash',
          verifiedAt: '2026-08-25T10:00:00.000Z',
        },
        supersedes: 'not-a-uuid',
        history: [
          {
            at: '2026-08-25T10:00:00.000Z',
            from: 'bogus-state',
            to: 'candidate',
            confirmationType: 'bogus-conf',
            replacedBy: 'bogus-uuid',
          },
        ],
      },
    ],
  };
  writeFileSync(join(config.candidatesDir, 'records.json'), JSON.stringify(rawWithBadNestedFields), 'utf8');

  const list = listCandidates(config);
  assert.equal(list.length, 1);
  const rec = list[0];

  // Verify bad confirmation type resulted in cleaned null confirmation
  assert.equal(rec.confirmation, null);

  // Verify absolute currentSource path resulted in cleaned null currentSource
  assert.equal(rec.currentSource, null);

  // Verify invalid sourceRefs were filtered down to valid relative markdown paths
  assert.deepEqual(rec.sourceRefs, ['valid/ref.md']);

  // Verify invalid supersedes was cleaned to null
  assert.equal(rec.supersedes, null);

  // Verify history from and confirmationType were cleaned
  assert.equal(rec.history[0].from, null);
  assert.equal(rec.history[0].confirmationType, undefined);
  assert.equal(rec.history[0].replacedBy, undefined);

  // Assert full Draft 2020-12 schema validation passes
  assertStoreValid(config);
});

test('P2-05: Malformed pendingAudits container and history with null elements self-heal and pass Schema validation', () => {
  const { config } = sandbox();
  const malformedStore = {
    schemaVersion: 1,
    records: [
      {
        id: '11111111-2222-4333-8444-555555555555',
        status: 'candidate',
        content: 'Test content',
        history: [null, { from: null, to: 'candidate' }, 123, 'bad'],
      },
    ],
    pendingAudits: { malformed: true },
  };
  writeFileSync(join(config.candidatesDir, 'records.json'), JSON.stringify(malformedStore), 'utf8');

  // Load candidates and ensure no exception is thrown
  const list = listCandidates(config);
  assert.equal(list.length, 1);
  assert.equal(list[0].history.length, 1);
  assert.equal(list[0].history[0].to, 'candidate');

  // Verify on-disk format passes Schema validation
  assertStoreValid(config);

  // Verify second load is stable and does not throw
  const secondLoad = listCandidates(config);
  assert.equal(secondLoad.length, 1);
  assertStoreValid(config);
});

test('P2-05: Non-string dates, invalid recoveredFrom, and illegal top-level fields self-heal and pass Schema validation', () => {
  const { config } = sandbox();
  const malformedStore = {
    schemaVersion: 1,
    illegalTopLevelField: 'should be stripped',
    recoveredFrom: 12345, // invalid type: must be string
    records: [
      {
        id: '11111111-2222-4333-8444-555555555555',
        status: 'candidate',
        content: 'Numeric dates test',
        createdAt: 1, // numeric date: must be converted to ISO string
        updatedAt: 123, // numeric date: must be converted to ISO string
        history: [
          {
            at: 1, // numeric date: must be converted to ISO string
            from: null,
            to: 'candidate',
          },
        ],
      },
    ],
    pendingAudits: [],
  };
  writeFileSync(join(config.candidatesDir, 'records.json'), JSON.stringify(malformedStore), 'utf8');

  // Load candidates and verify self-healing
  const list = listCandidates(config);
  assert.equal(list.length, 1);
  assert.equal(typeof list[0].createdAt, 'string');
  assert.equal(typeof list[0].updatedAt, 'string');
  assert.equal(typeof list[0].history[0].at, 'string');

  // Verify on-disk format passes Draft 2020-12 Schema validation
  assertStoreValid(config);

  // Verify second load produces identical valid state with zero errors
  const secondLoad = listCandidates(config);
  assert.equal(secondLoad.length, 1);
  assertStoreValid(config);
});

test('P1-02: Legacy pending audits without eventId and without occurredAt replay deterministically across midnight', () => {
  const { config } = sandbox();
  mkdirSync(config.auditDir, { recursive: true });

  // 1. Simulate an existing audit event logged yesterday (2026-08-24.jsonl)
  const legacyTraceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const legacyCandidateId = '11111111-2222-4333-8444-555555555555';
  const expectedEventId = deterministicUuid(JSON.stringify({
    traceId: legacyTraceId,
    candidateId: legacyCandidateId,
    from: null,
    to: 'candidate',
    occurredAt: '1970-01-01T00:00:00.000Z',
    event: 'candidate-transition',
  }));

  const yesterdayLog = join(config.auditDir, '2026-08-24.jsonl');
  const existingAuditRecord = {
    schemaVersion: 1,
    traceId: legacyTraceId,
    eventId: expectedEventId,
    occurredAt: '2026-08-24T23:59:59.000Z',
    event: 'candidate-transition',
    candidateId: legacyCandidateId,
    from: null,
    to: 'candidate',
    confirmationType: null,
    sourceRefs: [],
  };
  writeFileSync(yesterdayLog, `${JSON.stringify(existingAuditRecord)}\n`, 'utf8');

  // 2. Prepare legacy store containing that pending audit (without eventId/occurredAt)
  const legacyStore = {
    schemaVersion: 1,
    records: [],
    pendingAudits: [
      {
        traceId: legacyTraceId,
        candidateId: legacyCandidateId,
        from: null,
        to: 'candidate',
        event: 'candidate-transition',
      },
    ],
  };
  writeFileSync(join(config.candidatesDir, 'records.json'), JSON.stringify(legacyStore), 'utf8');

  // 3. Load store: replay should recognize event in 2026-08-24.jsonl and NOT append duplicate
  listCandidates(config);

  const auditFiles = readdirSync(config.auditDir).filter((f) => f.endsWith('.jsonl'));
  let totalEventsCount = 0;
  for (const f of auditFiles) {
    const lines = readFileSync(join(config.auditDir, f), 'utf8').trim().split('\n').filter(Boolean);
    totalEventsCount += lines.length;
  }
  assert.equal(totalEventsCount, 1, 'Replay across date partitions must recognize existing event and not duplicate');
});

test('P1-02: Unreadable/corrupted audit partition fails closed without appending and preserves outbox', () => {
  const { config } = sandbox();
  mkdirSync(config.auditDir, { recursive: true });

  // Corrupt an existing audit partition file
  const corruptedLog = join(config.auditDir, '2026-08-24.jsonl');
  writeFileSync(corruptedLog, '{"corrupted json line without closing brace\n', 'utf8');

  // Prepare store with a pending audit
  const testTraceId = '11111111-1111-4111-a111-111111111111';
  const testCandidateId = '22222222-2222-4222-a222-222222222222';
  const storeWithPending = {
    schemaVersion: 1,
    records: [],
    pendingAudits: [
      {
        traceId: testTraceId,
        candidateId: testCandidateId,
        from: null,
        to: 'candidate',
        event: 'candidate-transition',
      },
    ],
  };
  writeFileSync(join(config.candidatesDir, 'records.json'), JSON.stringify(storeWithPending), 'utf8');

  // Load store: unreadable partition MUST cause flushCandidateAudits to fail closed and keep pendingAudits
  listCandidates(config);

  const rawStoreAfter = JSON.parse(readFileSync(join(config.candidatesDir, 'records.json'), 'utf8'));
  assert.equal(rawStoreAfter.pendingAudits.length, 1, 'Outbox must NOT be wiped when audit partition is unreadable');
  assert.equal(rawStoreAfter.pendingAudits[0].candidateId, testCandidateId);
});

test('parseable but schema-invalid historical audit line cannot suppress a pending eventId', () => {
  const { config } = sandbox();
  mkdirSync(config.auditDir, { recursive: true });
  const eventId = '33333333-3333-4333-a333-333333333333';
  writeFileSync(
    join(config.auditDir, '2026-08-24.jsonl'),
    `${JSON.stringify({ eventId })}\n`,
    'utf8',
  );
  const pending = {
    eventId,
    traceId: '11111111-1111-4111-a111-111111111111',
    candidateId: '22222222-2222-4222-a222-222222222222',
    from: null,
    to: 'candidate',
    occurredAt: '2026-08-25T12:00:00.000Z',
    confirmationType: null,
    sourceRefs: [],
  };
  writeFileSync(join(config.candidatesDir, 'records.json'), JSON.stringify({
    schemaVersion: 1,
    records: [],
    pendingAudits: [pending],
  }), 'utf8');

  listCandidates(config);

  const store = JSON.parse(readFileSync(join(config.candidatesDir, 'records.json'), 'utf8'));
  assert.equal(store.pendingAudits.length, 1, 'Invalid historical data must fail closed, not act as a dedup proof');
  assert.equal(store.pendingAudits[0].eventId, eventId);
});

test('invalid transition enums stay pending and extreme numeric timestamps normalize without RangeError', () => {
  const invalid = sandbox().config;
  writeFileSync(join(invalid.candidatesDir, 'records.json'), JSON.stringify({
    schemaVersion: 1,
    records: [],
    pendingAudits: [{
      traceId: '11111111-1111-4111-a111-111111111111',
      candidateId: '22222222-2222-4222-a222-222222222222',
      from: null,
      to: 'not-a-state',
      occurredAt: '2026-02-30T12:00:00.000Z',
    }],
  }), 'utf8');
  listCandidates(invalid);
  const invalidStore = JSON.parse(readFileSync(join(invalid.candidatesDir, 'records.json'), 'utf8'));
  assert.equal(invalidStore.pendingAudits.length, 1, 'Invalid state transition must not be written or cleared');

  const extreme = sandbox().config;
  writeFileSync(join(extreme.candidatesDir, 'records.json'), JSON.stringify({
    schemaVersion: 1,
    records: [],
    pendingAudits: [{
      traceId: '11111111-1111-4111-a111-111111111111',
      candidateId: '22222222-2222-4222-a222-222222222222',
      from: null,
      to: 'candidate',
      occurredAt: Number.MAX_VALUE,
    }],
  }), 'utf8');
  assert.doesNotThrow(() => listCandidates(extreme));
  const extremeStore = JSON.parse(readFileSync(join(extreme.candidatesDir, 'records.json'), 'utf8'));
  assert.equal(extremeStore.pendingAudits.length, 0);
  const audit = JSON.parse(readFileSync(join(extreme.auditDir, '1970-01-01.jsonl'), 'utf8'));
  assert.equal(audit.occurredAt, '1970-01-01T00:00:00.000Z');
});

test('P2-01: All flushed audit events strictly conform to audit-event.schema.json', () => {
  const { config } = sandbox();
  const auditSchemaRaw = readFileSync(fileURLToPath(new URL('../schemas/audit-event.schema.json', import.meta.url)), 'utf8');
  const auditSchema = JSON.parse(auditSchemaRaw);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  ajv.addFormat('date-time', (d) => typeof d === 'string' && RFC3339_DATETIME_REGEX.test(d.trim()) && Number.isFinite(Date.parse(d)));
  const validateAudit = ajv.compile(auditSchema);

  // Add candidate which flushes audit
  addCandidate(config, { content: '合规性审计测试事实', scope: '北辰仓配项目' });

  const auditFiles = readdirSync(config.auditDir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(auditFiles.length > 0, 'Audit file must be created');

  for (const f of auditFiles) {
    const lines = readFileSync(join(config.auditDir, f), 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      const valid = validateAudit(parsed);
      if (!valid) {
        console.error('Audit event schema validation errors:', validateAudit.errors, parsed);
      }
      assert.equal(valid, true, 'Audit event must validate against audit-event.schema.json');
    }
  }
});
