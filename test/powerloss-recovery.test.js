import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeConfig } from '../src/config.js';
import { indexVault, readHealth } from '../src/qmd-adapter.js';
import { searchSecondBrain } from '../src/retrieval.js';
import {
  appendJsonLine,
  appendLineFaults,
  atomicWriteFaults,
  resetAppendLineFaults,
  resetAtomicWriteFaults,
  writeJsonAtomic,
} from '../src/io.js';
import { addCandidate, listCandidates } from '../src/candidates.js';

const fixtureVault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

test('Zero-byte corrupted metadata.json degrades gracefully without throwing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-zero-meta-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });

  await indexVault(config, { semantic: false });

  // Simulate power loss truncation to 0 bytes
  writeFileSync(config.metadataPath, '', 'utf8');

  const health = await readHealth(config);
  assert.equal(health.indexed, true);
  assert.equal(health.current.lexicalFresh, false);

  const searchResult = await searchSecondBrain({
    vault,
    dataDir,
    query: '标准仓储服务费 120元',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });

  assert.equal(searchResult.degraded, true);
});

test('P2-08: writeJsonAtomic write failure cleans up temporary files without altering target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-atomic-fail-'));
  const target = join(dir, 'data.json');
  writeFileSync(target, JSON.stringify({ original: true }), 'utf8');

  // 1. Inject write serialization error (circular reference)
  const circular = {};
  circular.self = circular;

  assert.throws(() => {
    writeJsonAtomic(target, circular);
  }, /circular|Converting circular structure to JSON/i);

  // Assert target file remained unmodified
  const content = JSON.parse(readFileSync(target, 'utf8'));
  assert.deepEqual(content, { original: true });

  // Assert no leftover temporary files in directory
  const files = readdirSync(dir);
  assert.deepEqual(files, ['data.json']);
});

test('P2-08: powerloss residue temporary files do not corrupt candidate store or listCandidates', () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-tmp-residue-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });

  // 1. Add valid candidate
  const added = addCandidate(config, { content: '正常候选事实', scope: '北辰仓配项目' });
  assert.equal(added.created, true);

  // 2. Simulate crashed intermediate temp files in candidates directory
  const tempFile1 = join(config.candidatesDir, 'records.json.1234.abcd.tmp');
  const tempFile2 = join(config.candidatesDir, 'records.json.5678.ef01.tmp');
  writeFileSync(tempFile1, '{"partial": true', 'utf8');
  writeFileSync(tempFile2, 'corrupted half-written data', 'utf8');

  // 3. Verify listCandidates still returns the valid record without error
  const list = listCandidates(config);
  assert.equal(list.length, 1);
  assert.equal(list[0].content, '正常候选事实');

  // 4. Perform atomic write and verify operation succeeds cleanly
  const added2 = addCandidate(config, { content: '第二条事实', scope: '北辰仓配项目' });
  assert.equal(added2.created, true);
  assert.equal(listCandidates(config).length, 2);
});

function assertTargetIntactAndNoTempResidue(dir, target) {
  const content = JSON.parse(readFileSync(target, 'utf8'));
  assert.deepEqual(content, { original: true }, 'Old target must remain intact after an injected durability failure');
  const residues = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(residues, [], 'Failed temporary file must be cleaned up, not left behind');
}

test('P2-08: direct write syscall failure injection keeps old target intact and cleans temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-io-write-direct-'));
  const target = join(dir, 'data.json');
  writeFileSync(target, JSON.stringify({ original: true }), 'utf8');

  atomicWriteFaults.writeAdapter = () => { throw new Error('EIO: write syscall failure'); };
  try {
    assert.throws(() => writeJsonAtomic(target, { updated: true }), /EIO: write syscall failure/);
    assertTargetIntactAndNoTempResidue(dir, target);
  } finally {
    resetAtomicWriteFaults();
  }
});

test('P2-08: direct fsync syscall failure injection keeps old target intact and cleans temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-io-fsync-direct-'));
  const target = join(dir, 'data.json');
  writeFileSync(target, JSON.stringify({ original: true }), 'utf8');

  atomicWriteFaults.fsyncAdapter = () => { throw new Error('EIO: fsync syscall failure'); };
  try {
    assert.throws(() => writeJsonAtomic(target, { updated: true }), /EIO: fsync syscall failure/);
    assertTargetIntactAndNoTempResidue(dir, target);
  } finally {
    resetAtomicWriteFaults();
  }
});

test('P2-08: post-write crash injection keeps the old target intact and removes the temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-io-write-'));
  const target = join(dir, 'data.json');
  writeFileSync(target, JSON.stringify({ original: true }), 'utf8');

  atomicWriteFaults.onPostWrite = () => { throw new Error('simulated crash immediately after write stage'); };
  try {
    assert.throws(() => writeJsonAtomic(target, { updated: true }), /simulated crash immediately after write stage/);
    assertTargetIntactAndNoTempResidue(dir, target);
  } finally {
    resetAtomicWriteFaults();
  }
});

test('P2-08: post-fsync crash injection keeps the old target intact and removes the temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-io-fsync-'));
  const target = join(dir, 'data.json');
  writeFileSync(target, JSON.stringify({ original: true }), 'utf8');

  atomicWriteFaults.onPostFsync = () => { throw new Error('simulated crash immediately after fsync stage'); };
  try {
    assert.throws(() => writeJsonAtomic(target, { updated: true }), /simulated crash immediately after fsync stage/);
    assertTargetIntactAndNoTempResidue(dir, target);
  } finally {
    resetAtomicWriteFaults();
  }
});

test('P2-08: rename retry exhaustion keeps the old target intact and removes the temp file after exactly 5 attempts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-io-rename-'));
  const target = join(dir, 'data.json');
  writeFileSync(target, JSON.stringify({ original: true }), 'utf8');

  let attemptsCount = 0;
  atomicWriteFaults.onRename = (attempt) => {
    attemptsCount = attempt;
    throw Object.assign(new Error('EPERM: simulated persistent rename failure'), { code: 'EPERM' });
  };
  try {
    assert.throws(() => writeJsonAtomic(target, { updated: true }), /simulated persistent rename failure/);
    assert.equal(attemptsCount, 5, 'Must attempt exactly 5 times before exhausting linear backoff');
    assertTargetIntactAndNoTempResidue(dir, target);
  } finally {
    resetAtomicWriteFaults();
  }
});

test('P2-08: direct renameAdapter syscall failure injection keeps old target intact and cleans temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-io-rename-direct-'));
  const target = join(dir, 'data.json');
  writeFileSync(target, JSON.stringify({ original: true }), 'utf8');

  atomicWriteFaults.renameAdapter = () => {
    throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
  };
  try {
    assert.throws(() => writeJsonAtomic(target, { updated: true }), /EXDEV: cross-device link not permitted/);
    assertTargetIntactAndNoTempResidue(dir, target);
  } finally {
    resetAtomicWriteFaults();
  }
});

test('P1-03: appendJsonLine durably flushes line to file with fsync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-io-append-'));
  const target = join(dir, 'audit.jsonl');
  const { appendJsonLine } = await import('../src/io.js');
  appendJsonLine(target, { event: 'test-event-1' });
  appendJsonLine(target, { event: 'test-event-2' });
  const lines = readFileSync(target, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, 'test-event-1');
  assert.equal(lines[1].event, 'test-event-2');
});

test('audit append loops over short writes and persists one complete JSON line', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-io-append-short-'));
  t.after(() => {
    resetAppendLineFaults();
    rmSync(dir, { recursive: true, force: true });
  });
  const target = join(dir, 'audit.jsonl');
  appendLineFaults.writeAdapter = (fd, buffer, offset, length) => (
    writeSync(fd, buffer, offset, Math.min(3, length))
  );

  appendJsonLine(target, { event: 'short-write-safe' });
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { event: 'short-write-safe' });
});

test('audit fsync failure is surfaced and candidate outbox remains pending', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-audit-fsync-failure-'));
  t.after(() => {
    resetAppendLineFaults();
    rmSync(root, { recursive: true, force: true });
  });
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });
  appendLineFaults.fsyncAdapter = () => { throw new Error('EIO: audit fsync failed'); };

  const added = addCandidate(config, { content: '审计耐久失败测试', scope: '北辰仓配项目' });
  assert.equal(added.created, true);
  const store = JSON.parse(readFileSync(join(config.candidatesDir, 'records.json'), 'utf8'));
  assert.equal(store.pendingAudits.length, 1, 'Outbox must not clear when durable append cannot be confirmed');
});

test('P2-08: transient rename failure recovers on retry and the new file is fully readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-io-retry-'));
  const target = join(dir, 'data.json');
  writeFileSync(target, JSON.stringify({ original: true }), 'utf8');

  let renameAttempts = 0;
  atomicWriteFaults.onRename = (attempt) => {
    renameAttempts = attempt;
    if (attempt < 3) {
      throw Object.assign(new Error('EPERM: simulated transient rename failure'), { code: 'EPERM' });
    }
  };
  try {
    writeJsonAtomic(target, { updated: true, nested: { list: [1, 2, 3] } });
    assert.ok(renameAttempts >= 3, 'Rename retry path must actually be exercised');
    const content = JSON.parse(readFileSync(target, 'utf8'));
    assert.deepEqual(content, { updated: true, nested: { list: [1, 2, 3] } }, 'New file must be complete and readable after recovery');
    const residues = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(residues, [], 'No temp residue may remain after a successful write');
  } finally {
    resetAtomicWriteFaults();
  }

  // Success path without any injected fault: the new file is fully readable
  writeJsonAtomic(target, { final: true });
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { final: true });
});
