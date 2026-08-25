import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSyncLock,
  cleanStaleReclaimLock,
  isSyncLockActive,
  lockPath,
  reclaimLockPath,
  safeRmDir,
} from '../src/lock.js';
import { getProcessIdentity } from '../src/io.js';

test('P1-03: Live lock with future timestamps is active and cannot be preempted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-future-lock-'));
  const config = { indexDir: root };
  const path = lockPath(config);

  // 1. Acquire lock normally
  const lock1 = await acquireSyncLock(config, { timeoutMs: 2000 });
  assert.ok(lock1.token);

  // 2. Simulate clock skew / future timestamp: set heartbeat and mtime to +60 seconds into the future
  const futureTime = Date.now() + 60000;
  const lockData = {
    token: lock1.token,
    pid: process.pid,
    generationId: lock1.generationId,
    startedAt: futureTime,
    heartbeatAt: futureTime,
  };
  writeFileSync(path, JSON.stringify(lockData, null, 2), 'utf8');
  utimesSync(path, new Date(futureTime), new Date(futureTime));

  // 3. Verify isSyncLockActive returns true for the live PID even with future timestamp
  assert.equal(isSyncLockActive(config), true, 'Live process with future timestamp must remain active');

  // 4. A contender trying to acquire lock must NOT preempt and should timeout
  let acquired = false;
  try {
    await acquireSyncLock(config, { timeoutMs: 300, maxStaleMs: 5000 });
    acquired = true;
  } catch (err) {
    assert.match(err.message, /Sync lock acquisition timed out/);
  }
  assert.equal(acquired, false, 'Contender must not preempt a live lock with future timestamp');

  // 5. Clean up
  lock1.release();
});

test('P1-03: Dead PID with future timestamp is safely reclaimed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-dead-future-lock-'));
  const config = { indexDir: root };
  const path = lockPath(config);

  // Dead PID (e.g. 999999) with future timestamp
  const futureTime = Date.now() + 60000;
  const deadLockData = {
    token: 'dead-token-123',
    pid: 999999,
    generationId: 'gen-dead',
    startedAt: futureTime,
    heartbeatAt: futureTime,
  };
  writeFileSync(path, JSON.stringify(deadLockData, null, 2), 'utf8');

  // isSyncLockActive should be false because PID is dead
  assert.equal(isSyncLockActive(config), false);

  // Contender should be able to reclaim dead lock
  const lock = await acquireSyncLock(config, { timeoutMs: 2000, maxStaleMs: 5000 });
  assert.ok(lock.token);
  assert.notEqual(lock.token, 'dead-token-123');
  lock.release();
});

test('P1-04: Live PID with heartbeatAge > maxStaleMs is NEVER preempted by a secondary contender while PID is alive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-stale-live-lock-'));
  const config = { indexDir: root };
  const path = lockPath(config);

  // Acquire lock
  const lock1 = await acquireSyncLock(config, { timeoutMs: 2000 });

  // Simulate process pausing / long GC / expired heartbeat older than maxStaleMs (e.g. -60 seconds)
  const staleHeartbeatTime = Date.now() - 60000;
  const staleLockData = {
    token: lock1.token,
    pid: process.pid, // holding PID is still alive!
    generationId: lock1.generationId,
    startedAt: staleHeartbeatTime,
    heartbeatAt: staleHeartbeatTime,
  };
  writeFileSync(path, JSON.stringify(staleLockData, null, 2), 'utf8');
  utimesSync(path, new Date(staleHeartbeatTime), new Date(staleHeartbeatTime));

  // isSyncLockActive must be true because holding PID is alive
  assert.equal(isSyncLockActive(config), true, 'Lock held by a live PID is active regardless of heartbeat age');

  // A secondary contender must NOT be able to preempt or steal the lock
  let secondaryAcquired = false;
  try {
    await acquireSyncLock(config, { timeoutMs: 300, maxStaleMs: 5000 });
    secondaryAcquired = true;
  } catch (err) {
    assert.match(err.message, /Sync lock acquisition timed out/);
  }
  assert.equal(secondaryAcquired, false, 'Secondary contender must never preempt or enter critical section while owner PID is alive');

  lock1.release();
});

test('sync lock does not mistake a reused live PID for the original owner process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-sync-lock-pid-reuse-'));
  const config = { indexDir: root };
  const path = lockPath(config);
  const currentIdentity = getProcessIdentity(process.pid);
  assert.ok(currentIdentity, 'Test requires an OS process-start identity');
  writeFileSync(path, JSON.stringify({
    token: 'orphaned-token',
    pid: process.pid,
    processIdentity: `${currentIdentity}-previous-process`,
    generationId: 'gen-orphaned',
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
  }), 'utf8');

  assert.equal(isSyncLockActive(config), false, 'PID match without process-identity match is not a live owner');
  const lock = await acquireSyncLock(config, { timeoutMs: 2000 });
  assert.notEqual(lock.token, 'orphaned-token');
  lock.release();
});

test('stale timestamps never remove a reclaim lock owned by the same live process identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-live-reclaim-owner-'));
  const config = { indexDir: root };
  const path = reclaimLockPath(config);
  mkdirSync(path);
  const old = Date.now() - 60_000;
  writeFileSync(join(path, 'owner.json'), JSON.stringify({
    pid: process.pid,
    processIdentity: getProcessIdentity(process.pid),
    startedAt: old,
    token: 'live-reclaimer',
  }), 'utf8');
  utimesSync(path, new Date(old), new Date(old));

  assert.equal(cleanStaleReclaimLock(config, { maxReclaimStaleMs: 1 }), false);
  assert.equal(existsSync(path), true, 'Live reclaim owner must retain exclusive reclamation rights');
  assert.equal(safeRmDir(path), true);
});
