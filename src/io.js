import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function writeJsonAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, filePath);
}

export function appendJsonLine(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

// Exclusive create-based lock guarding read-modify-write cycles on the local
// candidate store when the CLI and MCP server run at the same time. Stale
// locks older than the timeout are claimed through an atomic rename so exactly
// one waiter can remove a crashed writer's lock; a bare unlink could delete a
// fresh lock another waiter recreated between the staleness check and the
// unlink, silently losing one writer's record. The residual risk is limited to
// a third writer creating a lock inside the few-syscall restore window.
export function withJsonLock(lockPath, fn) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5000;
  const token = `${process.pid}:${randomUUID()}`;
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      writeSync(fd, token);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stale = statSync(lockPath);
        if (Date.now() - stale.mtimeMs > 30_000) {
          const claim = `${lockPath}.${process.pid}.${randomUUID()}.claim`;
          renameSync(lockPath, claim);
          const moved = statSync(claim);
          if (moved.mtimeMs === stale.mtimeMs && moved.size === stale.size) {
            try { unlinkSync(claim); } catch { /* crash before cleanup leaves an inert claim file */ }
          } else if (!existsSync(lockPath)) {
            // We renamed a lock that was replaced after our staleness check;
            // put it back so its live owner keeps mutual exclusion.
            renameSync(claim, lockPath);
          }
        }
      } catch {
        // The lock disappeared between stat and rename; retry immediately.
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for store lock: ${basename(lockPath)}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath);
    } catch {
      // Already gone or no longer ours; nothing safe to unlink.
    }
  }
}

