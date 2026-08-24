import { existsSync, openSync, closeSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeJsonAtomic } from './io.js';

export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function lockPath(config) {
  return join(config.indexDir, 'sync.lock');
}

export function reclaimLockPath(config) {
  return join(config.indexDir, 'sync.reclaim.lock');
}

export function readSyncLock(config) {
  const path = lockPath(config);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function isSyncLockActive(config, { maxStaleMs = 30000 } = {}) {
  const lock = readSyncLock(config);
  if (!lock) return false;
  if (!isPidAlive(lock.pid)) return false;
  const lastHeartbeat = lock.heartbeatAt || lock.startedAt || 0;
  if (Date.now() - lastHeartbeat > maxStaleMs) return false;
  return true;
}

function cleanStaleReclaimLock(rPath, maxReclaimStaleMs = 10000) {
  if (!existsSync(rPath)) return;
  try {
    const raw = readFileSync(rPath, 'utf8');
    const data = JSON.parse(raw);
    if (!isPidAlive(data.pid) || (Date.now() - (data.startedAt || 0) > maxReclaimStaleMs)) {
      try { unlinkSync(rPath); } catch {}
    }
  } catch {
    try { unlinkSync(rPath); } catch {}
  }
}

export async function acquireSyncLock(config, { timeoutMs = 10000, maxStaleMs = 30000 } = {}) {
  const path = lockPath(config);
  const rPath = reclaimLockPath(config);
  mkdirSync(dirname(path), { recursive: true });
  const start = Date.now();
  const token = randomBytes(16).toString('hex');
  const generationId = `gen-${Date.now()}-${randomBytes(4).toString('hex')}`;

  while (true) {
    // 1. If reclaim lock exists and is active, wait for ongoing reclamation to finish
    cleanStaleReclaimLock(rPath);
    if (existsSync(rPath)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Sync lock acquisition timed out after ${timeoutMs}ms (reclamation in progress)`);
      }
      await new Promise((res) => setTimeout(res, 20 + Math.floor(Math.random() * 20)));
      continue;
    }

    // 2. Try to directly acquire the main lock
    try {
      const fd = openSync(path, 'wx');
      const lockData = {
        token,
        pid: process.pid,
        generationId,
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
      };
      writeFileSync(fd, JSON.stringify(lockData, null, 2), 'utf8');
      closeSync(fd);

      // Verify token ownership
      const verified = readSyncLock(config);
      if (!verified || verified.token !== token) {
        // Lost race or corrupted write, retry
        continue;
      }

      const heartbeatTimer = setInterval(() => {
        try {
          const current = readSyncLock(config);
          if (current && current.token === token) {
            current.heartbeatAt = Date.now();
            writeJsonAtomic(path, current);
          }
        } catch {}
      }, 5000);
      heartbeatTimer.unref();

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearInterval(heartbeatTimer);
        try {
          const current = readSyncLock(config);
          if (current && current.token === token) {
            unlinkSync(path);
          }
        } catch {}
      };

      return { token, generationId, release };
    } catch (err) {
      if (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
        const existing = readSyncLock(config);
        const isDead = existing && !isPidAlive(existing.pid);
        const isStale = existing && (Date.now() - (existing.heartbeatAt || existing.startedAt || 0) > maxStaleMs);

        if (isDead || isStale) {
          // Stale or dead lock detected: acquire exclusive reclamation lock to serialize cleanup and creation
          cleanStaleReclaimLock(rPath);
          let rFd = null;
          try {
            rFd = openSync(rPath, 'wx');
            writeFileSync(rFd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
            closeSync(rFd);

            // Inside exclusive reclamation critical section:
            const recheck = readSyncLock(config);
            const stillDeadOrStale = !recheck || !isPidAlive(recheck.pid) || (Date.now() - (recheck.heartbeatAt || recheck.startedAt || 0) > maxStaleMs);

            if (stillDeadOrStale) {
              try { unlinkSync(path); } catch {}

              // Directly create the new main lock while holding reclaim lock
              try {
                const newFd = openSync(path, 'wx');
                const lockData = {
                  token,
                  pid: process.pid,
                  generationId,
                  startedAt: Date.now(),
                  heartbeatAt: Date.now(),
                };
                writeFileSync(newFd, JSON.stringify(lockData, null, 2), 'utf8');
                closeSync(newFd);
              } catch (createErr) {
                // If openSync fails during creation, clean up and retry in next cycle
                try { unlinkSync(rPath); } catch {}
                await new Promise((res) => setTimeout(res, 20));
                continue;
              }

              // Clean up reclaim lock
              try { unlinkSync(rPath); } catch {}

              const heartbeatTimer = setInterval(() => {
                try {
                  const current = readSyncLock(config);
                  if (current && current.token === token) {
                    current.heartbeatAt = Date.now();
                    writeJsonAtomic(path, current);
                  }
                } catch {}
              }, 5000);
              heartbeatTimer.unref();

              let released = false;
              const release = () => {
                if (released) return;
                released = true;
                clearInterval(heartbeatTimer);
                try {
                  const current = readSyncLock(config);
                  if (current && current.token === token) {
                    unlinkSync(path);
                  }
                } catch {}
              };

              return { token, generationId, release };
            } else {
              // Lock became fresh/acquired by someone else; release reclaim lock and retry
              try { unlinkSync(rPath); } catch {}
            }
          } catch (rErr) {
            // Another contender acquired reclaim lock; wait and retry
          }
        }

        if (Date.now() - start > timeoutMs) {
          throw new Error(`Sync lock acquisition timed out after ${timeoutMs}ms (held by PID ${existing?.pid})`);
        }

        await new Promise((res) => setTimeout(res, 30 + Math.floor(Math.random() * 30)));
        continue;
      }
      throw err;
    }
  }
}

export async function withSyncLock(config, options, fn) {
  const lock = await acquireSyncLock(config, options);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}
