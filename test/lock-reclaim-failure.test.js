import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRuntimeConfig } from '../src/config.js';
import { acquireSyncLock, lockPath, reclaimLockPath, safeRmDir } from '../src/lock.js';

// A PID the OS reports as non-existent, so the stale main lock and the dead
// reclaim owner are both immediately considered dead by the lock logic.
const GHOST_PID = 4194302;

test('P2-06: reclaim content held against cleanup blocks acquisition with a diagnosable failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-reclaim-hold-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'AGENTS.md'), '# Agents\n', 'utf8');
  const config = resolveRuntimeConfig({ vault, dataDir });

  const mainPath = lockPath(config);
  const rPath = reclaimLockPath(config);
  mkdirSync(config.indexDir, { recursive: true });

  // A stale main lock held by a dead PID, plus a reclaim directory whose
  // owner is dead but whose content is held against cleanup.
  writeFileSync(mainPath, JSON.stringify({ token: 'stale-token', pid: GHOST_PID, startedAt: Date.now() - 120000, heartbeatAt: Date.now() - 120000 }), 'utf8');
  mkdirSync(rPath);
  writeFileSync(join(rPath, 'owner.json'), JSON.stringify({ pid: GHOST_PID, startedAt: Date.now() - 120000, token: 'reclaim-token' }), 'utf8');

  if (process.platform === 'win32') {
    // A process CWD cannot be renamed (EBUSY) or removed (EPERM) on Windows.
    process.chdir(rPath);
  } else {
    // Without directory write permission the owner file cannot be unlinked
    // and the reclaim directory cannot be renamed away, on POSIX.
    chmodSync(rPath, 0o555);
    chmodSync(config.indexDir, 0o555);
  }

  try {
    await assert.rejects(
      acquireSyncLock(config, { timeoutMs: 900, maxStaleMs: 5000 }),
      (err) => {
        assert.match(err.message, /timed out after 900ms/);
        assert.match(err.message, /reclamation in progress at/, 'Failure reason must point at the stuck reclaim lock path');
        return true;
      }
    );

    // The stale main lock must NOT have been taken over or handed to us
    assert.equal(existsSync(mainPath), true, 'Main lock file must still exist');
    const mainContent = JSON.parse(readFileSync(mainPath, 'utf8'));
    assert.equal(mainContent.pid, GHOST_PID, 'Main lock must still belong to the dead owner, never acquired');
    // The held reclaim directory must not have been destroyed either
    assert.equal(existsSync(rPath), true, 'Held reclaim directory must remain');
  } finally {
    if (process.platform === 'win32') {
      // Leave root entirely before removing it: a process cannot delete its own CWD
      process.chdir(tmpdir());
    } else {
      chmodSync(config.indexDir, 0o755);
      chmodSync(rPath, 0o755);
    }
    safeRmDir(rPath);
    rmSync(root, { recursive: true, force: true });
  }
});
