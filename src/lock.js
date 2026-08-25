import { existsSync, openSync, closeSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, statSync, rmSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getProcessIdentity, isProcessLockOwnerActive, writeJsonAtomic } from './io.js';

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
  const lock = readSyncLock(config);
  if (!lock) return false;
  return isProcessLockOwnerActive(lock);
}

function isLockActive(lock, maxStaleMs) {
  if (!lock || typeof lock !== 'object') return false;
  return isProcessLockOwnerActive(lock);
}

function isLockDeadOrStale(path, maxStaleMs) {
  if (!existsSync(path)) return false;
  try {
    const lock = readSyncLockRaw(path);
    if (!lock || typeof lock !== 'object' || !lock.pid) {
      // Unparseable or missing PID: only reclaim if mtime is older than maxStaleMs
      const st = statSync(path);
      return (Date.now() - st.mtimeMs) > maxStaleMs;
    }
    // A dead process or reused PID cannot own this lock and may be reclaimed immediately.
    if (!isProcessLockOwnerActive(lock)) return true;

    // As long as the holding PID is alive, it is active and MUST NOT be stolen or preempted
    return false;
  } catch {
    return false;
  }
}

export function safeRmDir(dirPath, { maxRetries = 4, retryDelayMs = 50 } = {}) {
  if (!existsSync(dirPath)) return true;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return true;
    } catch (err) {
      const code = err?.code;
      if (code === 'ENOENT') return true;
      if (['EPERM', 'EBUSY', 'EACCES'].includes(code)) {
        if (attempt < maxRetries) {
          const delay = retryDelayMs * Math.pow(2, attempt - 1);
          const start = Date.now();
          while (Date.now() - start < delay) {
            // sync spin wait for transient lock release
          }
          continue;
        }
        return false;
      }
      // Non-retriable error: return false immediately
      return false;
    }
  }
  return false;
}

export function cleanStaleReclaimLock(configOrPath, { maxReclaimStaleMs = 30000 } = {}) {
  const rPath = typeof configOrPath === 'string' ? configOrPath : reclaimLockPath(configOrPath);
  if (!rPath || !existsSync(rPath)) return true;
  try {
    const ownerFile = join(rPath, 'owner.json');
    if (existsSync(ownerFile)) {
      const owner = readSyncLockRaw(ownerFile);
      if (owner && isProcessLockOwnerActive(owner)) return false;
      if (owner) {
        // A dead process or reused PID cannot own the reclaim lock.
        const deadDir = `${rPath}.dead.${Date.now()}.${randomBytes(4).toString('hex')}`;
        try {
          renameSync(rPath, deadDir);
          return safeRmDir(deadDir);
        } catch {
          return safeRmDir(rPath);
        }
      }
    }
    const st = statSync(rPath);
    const mtimeAge = Date.now() - st.mtimeMs;
    const birthAge = Date.now() - st.birthtimeMs;
    // Never touch a reclaim lock created/modified within maxReclaimStaleMs if owner is still alive/recent
    if ((mtimeAge < 0 || mtimeAge < maxReclaimStaleMs) && (birthAge < 0 || birthAge < maxReclaimStaleMs)) {
      return false;
    }
    // Only clean if genuinely older than maxReclaimStaleMs
    if (existsSync(ownerFile)) {
      const owner = readSyncLockRaw(ownerFile);
      const ownerAge = Date.now() - (owner?.startedAt || 0);
      if (owner && isProcessLockOwnerActive(owner) && (ownerAge < 0 || ownerAge < maxReclaimStaleMs)) {
        return false;
      }
    }
    const deadDir = `${rPath}.dead.${Date.now()}.${randomBytes(4).toString('hex')}`;
    try {
      renameSync(rPath, deadDir);
      return safeRmDir(deadDir);
    } catch {
      return safeRmDir(rPath);
    }
  } catch {
    return false;
  }
}

// A reclaim lock directory that cannot be released must surface as an
// explicit, diagnosable failure (code ERECLAIMCLEANUP) instead of being
// silently swallowed by the acquisition retry loop.
function reclaimReleaseFailure(rPath, context, cause) {
  const details = cause ? ` (${cause})` : '';
  const failure = new Error(`Sync lock recovery could not release the reclaim lock directory during ${context}: ${rPath}${details}`);
  failure.code = 'ERECLAIMCLEANUP';
  return failure;
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
          throw new Error(`Sync lock acquisition timed out after ${timeoutMs}ms (reclamation in progress at ${rPath})`);
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
        processIdentity: getProcessIdentity(process.pid),
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
            writeFileSync(join(rPath, 'owner.json'), JSON.stringify({
              pid: process.pid,
              processIdentity: getProcessIdentity(process.pid),
              startedAt: Date.now(),
              token,
            }), 'utf8');
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
                    processIdentity: getProcessIdentity(process.pid),
                    generationId,
                    startedAt: Date.now(),
                    heartbeatAt: Date.now(),
                  };
                  writeFileSync(newFd, JSON.stringify(lockData, null, 2), 'utf8');
                  closeSync(newFd);

                  // Release reclamation lock
                  const rCleaned = safeRmDir(rPath);
                  if (!rCleaned) {
                    try { unlinkSync(path); } catch {}
                    throw reclaimReleaseFailure(rPath, 'reclaim cleanup after acquiring the main lock');
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
                } catch (createErr) {
                  // Reclaim cleanup already failed and the main lock was rolled back:
                  // propagate instead of retrying on an unreleasable reclaim lock.
                  if (createErr?.code === 'ERECLAIMCLEANUP') throw createErr;
                  // Creation failed: release the reclaim lock and retry next cycle
                  if (!safeRmDir(rPath)) {
                    throw reclaimReleaseFailure(rPath, 'main-lock creation recovery', `creation error: ${createErr?.message || createErr}`);
                  }
                  await new Promise((res) => setTimeout(res, 20));
                  continue;
                }
              } else {
                // Main lock became fresh/alive while acquiring reclaim lock
                if (!safeRmDir(rPath)) {
                  throw reclaimReleaseFailure(rPath, 'lock-became-fresh recovery');
                }
              }
            } catch (innerErr) {
              if (!safeRmDir(rPath)) {
                throw reclaimReleaseFailure(rPath, 'reclamation error recovery', innerErr?.message || String(innerErr));
              }
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
