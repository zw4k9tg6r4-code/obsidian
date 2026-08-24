import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSyncLock, isSyncLockActive, lockPath, withSyncLock } from '../src/lock.js';

test('lock concurrency: multiple async contenders acquire sequentially without corruption', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-lock-race-'));
  const config = { indexDir: join(root, 'index') };

  const history = [];
  const runWorker = async (id, durationMs) => {
    return withSyncLock(config, { timeoutMs: 10000 }, async (lock) => {
      assert.ok(lock.token);
      assert.ok(lock.generationId);
      history.push({ id, action: 'start', time: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      history.push({ id, action: 'end', time: Date.now() });
      return id;
    });
  };

  // Run 4 concurrent worker tasks competing for the same sync.lock
  const results = await Promise.all([
    runWorker(1, 100),
    runWorker(2, 80),
    runWorker(3, 60),
    runWorker(4, 40),
  ]);

  assert.deepEqual(results.sort(), [1, 2, 3, 4]);
  assert.equal(history.length, 8);

  // Verify that critical sections never overlapped
  for (let i = 0; i < history.length; i += 2) {
    assert.equal(history[i].action, 'start');
    assert.equal(history[i + 1].action, 'end');
    assert.equal(history[i].id, history[i + 1].id);
  }

  // After all workers finish, lock file must be released
  assert.equal(existsSync(lockPath(config)), false);
  assert.equal(isSyncLockActive(config), false);
});
