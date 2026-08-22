import { appendFileSync, closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
// locks older than the timeout are removed so a crashed writer cannot block
// the next one forever.
export function withJsonLock(lockPath, fn) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5000;
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
      } catch {
        // The lock disappeared between stat and unlink; retry immediately.
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for store lock: ${basename(lockPath)}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
}

