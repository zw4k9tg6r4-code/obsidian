import { existsSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

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

export async function acquireSyncLock(config, { timeoutMs = 10000, maxStaleMs = 30000 } = {}) {
  const path = lockPath(config);
  const start = Date.now();
  const token = randomBytes(16).toString('hex');
  const generationId = `gen-${Date.now()}-${randomBytes(4).toString('hex')}`;

  while (true) {
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

      const heartbeatTimer = setInterval(() => {
        try {
          const current = readSyncLock(config);
          if (current && current.token === token) {
            current.heartbeatAt = Date.now();
            writeFileSync(path, JSON.stringify(current, null, 2), 'utf8');
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
      if (err.code === 'EEXIST') {
        const existing = readSyncLock(config);
        const isDead = !existing || !isPidAlive(existing.pid);
        const isStale = existing && (Date.now() - (existing.heartbeatAt || existing.startedAt || 0) > maxStaleMs);

        if (isDead || isStale) {
          try { unlinkSync(path); } catch {}
          continue;
        }

        if (Date.now() - start > timeoutMs) {
          throw new Error(`Sync lock acquisition timed out after ${timeoutMs}ms (held by PID ${existing?.pid})`);
        }

        await new Promise((res) => setTimeout(res, 200));
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
