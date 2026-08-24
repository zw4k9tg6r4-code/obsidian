import { existsSync, openSync, closeSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, statSync, rmSync, renameSync } from 'node:fs';
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

function readSyncLockRaw(path) {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readSyncLock(config) {
  return readSyncLockRaw(lockPath(config));
}

export function isSyncLockActive(config, { maxStaleMs = 30000 } = {}) {
  const path = lockPath(config);
  if (!existsSync(path)) return false;
  try {
    const st = statSync(path);
    if (Date.now() - st.mtimeMs < 2000) {
      // Recent write within 2s is definitely active
      return true;
    }
  } catch {}
  const lock = readSyncLock(config);
  if (!lock) return false;
  if (!isPidAlive(lock.pid)) return false;
  const lastHeartbeat = lock.heartbeatAt || lock.startedAt || 0;
  if (Date.now() - lastHeartbeat > maxStaleMs) return false;
  return true;
}

function isLockDeadOrStale(path, maxStaleMs) {
  if (!existsSync(path)) return false;
  try {
    const st = statSync(path);
    if (Date.now() - st.mtimeMs < 2000) {
      // Recent write within 2s is never dead or stale
      return false;
    }
    const lock = readSyncLockRaw(path);
    if (!lock) {
      // Unparseable file: only dead if older than maxStaleMs
      return Date.now() - st.mtimeMs > maxStaleMs;
    }
    if (!isPidAlive(lock.pid)) return true;
    const lastHeartbeat = lock.heartbeatAt || lock.startedAt || 0;
    return Date.now() - lastHeartbeat > maxStaleMs;
  } catch {
    return false;
  }
}

function cleanStaleReclaimLock(rPath, maxReclaimStaleMs = 10000) {
  if (!existsSync(rPath)) return;
  try {
    const st = statSync(rPath);
    // Never touch a reclaim lock created/modified within maxReclaimStaleMs
    if (Date.now() - st.mtimeMs < maxReclaimStaleMs && Date.now() - st.birthtimeMs < maxReclaimStaleMs) {
      return;
    }
    // Only clean if genuinely older than maxReclaimStaleMs
    const ownerFile = join(rPath, 'owner.json');
    if (existsSync(ownerFile)) {
      const owner = readSyncLockRaw(ownerFile);
      if (owner && isPidAlive(owner.pid) && Date.now() - (owner.startedAt || 0) < maxReclaimStaleMs) {
        return;
      }
    }
    const deadDir = `${rPath}.dead.${Date.now()}.${randomBytes(4).toString('hex')}`;
    try {
      renameSync(rPath, deadDir);
      rmSync(deadDir, { recursive: true, force: true });
    } catch {
      rmSync(rPath, { recursive: true, force: true });
    }
  } catch {}
}

export async function acquireSyncLock(config, { timeoutMs = 10000, maxStaleMs = 30000 } = {}) {
  const path = lockPath(config);
  const rPath = reclaimLockPath(config);
  mkdirSync(dirname(path), { recursive: true });
  const start = Date.now();
  const token = randomBytes(16).toString('hex');
  const generationId = `gen-${Date.now()}-${randomBytes(4).toString('hex')}`;

  while (true) {
    // 1. If reclaim lock exists and is active, wait for ongoing reclamation to complete
    cleanStaleReclaimLock(rPath);
    if (existsSync(rPath)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Sync lock acquisition timed out after ${timeoutMs}ms (reclamation in progress)`);
      }
      await new Promise((res) => setTimeout(res, 20 + Math.floor(Math.random() * 30)));
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
        // Lost race, retry
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
        if (isLockDeadOrStale(path, maxStaleMs)) {
          // Stale or dead lock detected: acquire atomic directory reclamation lock
          cleanStaleReclaimLock(rPath);
          let acquiredReclaim = false;
          try {
            mkdirSync(rPath);
            writeFileSync(join(rPath, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), token }), 'utf8');
            acquiredReclaim = true;
          } catch (rErr) {
            // Another contender acquired reclaim lock; wait and retry
          }

          if (acquiredReclaim) {
            try {
              // Inside exclusive reclamation critical section:
              if (isLockDeadOrStale(path, maxStaleMs)) {
                try { unlinkSync(path); } catch {}

                // Directly create the new main lock while holding reclaim directory lock
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

                  // Release reclamation lock
                  rmSync(rPath, { recursive: true, force: true });

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
                } catch (createErr) {
                  // Creation failed, release reclaim lock and retry in next cycle
                  rmSync(rPath, { recursive: true, force: true });
                  await new Promise((res) => setTimeout(res, 20));
                  continue;
                }
              } else {
                // Main lock became fresh/alive while acquiring reclaim lock
                rmSync(rPath, { recursive: true, force: true });
              }
            } catch (innerErr) {
              rmSync(rPath, { recursive: true, force: true });
            }
          }
        }

        if (Date.now() - start > timeoutMs) {
          const existing = readSyncLock(config);
          throw new Error(`Sync lock acquisition timed out after ${timeoutMs}ms (held by PID ${existing?.pid})`);
        }

        await new Promise((res) => setTimeout(res, 25 + Math.floor(Math.random() * 35)));
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
