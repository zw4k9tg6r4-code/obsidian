import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Fault-injection seams for the durability stages of writeJsonAtomic.
// Low-level operation adapters allow testing direct syscall failures (write, fsync, rename);
// post-hooks allow simulating power loss crashes immediately after stages succeed.
export const atomicWriteFaults = {
  writeAdapter: (fd, payload) => writeFileSync(fd, payload, 'utf8'),
  fsyncAdapter: (fd) => fsyncSync(fd),
  renameAdapter: (temp, target) => renameSync(temp, target),
  onPostWrite: null,  // (tempPath) => void, after write completes, before fsync
  onPostFsync: null,  // (tempPath) => void, after fsync completes, before close
  onRename: null,     // (attempt) => void, before each rename attempt
};

export function resetAtomicWriteFaults() {
  atomicWriteFaults.writeAdapter = (fd, payload) => writeFileSync(fd, payload, 'utf8');
  atomicWriteFaults.fsyncAdapter = (fd) => fsyncSync(fd);
  atomicWriteFaults.renameAdapter = (temp, target) => renameSync(temp, target);
  atomicWriteFaults.onPostWrite = null;
  atomicWriteFaults.onPostFsync = null;
  atomicWriteFaults.onRename = null;
}

export const appendLineFaults = {
  writeAdapter: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsyncAdapter: (fd) => fsyncSync(fd),
};

export function resetAppendLineFaults() {
  appendLineFaults.writeAdapter = (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length);
  appendLineFaults.fsyncAdapter = (fd) => fsyncSync(fd);
}

export function writeJsonAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = openSync(temp, 'w', 0o666);
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    atomicWriteFaults.writeAdapter(fd, payload);
    if (atomicWriteFaults.onPostWrite) atomicWriteFaults.onPostWrite(temp);
    atomicWriteFaults.fsyncAdapter(fd);
    if (atomicWriteFaults.onPostFsync) atomicWriteFaults.onPostFsync(temp);
    closeSync(fd);
    fd = null;
    let attempts = 0;
    while (true) {
      attempts += 1;
      try {
        if (atomicWriteFaults.onRename) atomicWriteFaults.onRename(attempts);
        atomicWriteFaults.renameAdapter(temp, filePath);
        break;
      } catch (err) {
        if (attempts >= 5) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempts * 10);
      }
    }
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    if (existsSync(temp)) {
      try { unlinkSync(temp); } catch {}
    }
  }
}

export function appendJsonLine(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const line = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  const fd = openSync(filePath, 'a', 0o666);
  let failure = null;
  try {
    let offset = 0;
    while (offset < line.length) {
      const written = appendLineFaults.writeAdapter(fd, line, offset, line.length - offset);
      if (!Number.isInteger(written) || written <= 0 || written > line.length - offset) {
        throw new Error('Audit append returned an invalid or zero-length write');
      }
      offset += written;
    }
    appendLineFaults.fsyncAdapter(fd);
  } catch (error) {
    failure = error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    if (!failure) failure = error;
  }
  if (failure) throw failure;
}

const CURRENT_PROCESS_STARTED_AT_MS = Math.round(Date.now() - (process.uptime() * 1000));
let cachedCurrentProcessIdentity;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function getProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid && cachedCurrentProcessIdentity !== undefined) {
    return cachedCurrentProcessIdentity;
  }

  let identity = null;
  try {
    if (process.platform === 'win32') {
      if (pid === process.pid) {
        identity = `windows-start-ms:${CURRENT_PROCESS_STARTED_AT_MS}`;
      } else {
        const command = `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`;
        const result = spawnSync('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
        ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        const startedAt = String(result.stdout || '').trim();
        if (!result.error && result.status === 0 && /^\d+$/.test(startedAt)) {
          identity = `windows-start-ms:${startedAt}`;
        }
      }
    } else if (existsSync(`/proc/${pid}/stat`)) {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const startTicks = afterCommand[19];
      if (/^\d+$/.test(startTicks || '')) identity = `proc-start-ticks:${startTicks}`;
    } else {
      const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 5000,
      });
      const started = String(result.stdout || '').trim().replace(/\s+/g, ' ');
      if (!result.error && result.status === 0 && started) identity = `ps-start:${started}`;
    }
  } catch {}

  if (pid === process.pid) cachedCurrentProcessIdentity = identity;
  return identity;
}

function readJsonLock(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    if (!raw) return { raw, record: null };
    try {
      const parsed = JSON.parse(raw);
      return { raw, record: parsed && typeof parsed === 'object' ? parsed : null };
    } catch {
      const legacy = raw.match(/^(\d+):/);
      return { raw, record: legacy ? { pid: Number(legacy[1]), legacy: true } : null };
    }
  } catch {
    return { raw: null, record: null };
  }
}

export function isProcessLockOwnerActive(record) {
  if (!record || !isPidAlive(record.pid)) return false;
  if (!record.processIdentity) return true;
  const currentIdentity = getProcessIdentity(record.pid);
  if (!currentIdentity) return true;
  if (currentIdentity === record.processIdentity) return true;
  const expectedWindowsStart = String(record.processIdentity).match(/^windows-start-ms:(\d+)$/);
  const currentWindowsStart = currentIdentity.match(/^windows-start-ms:(\d+)$/);
  if (expectedWindowsStart && currentWindowsStart) {
    return Math.abs(Number(expectedWindowsStart[1]) - Number(currentWindowsStart[1])) <= 500;
  }
  return false;
}

// Exclusive create-based lock guarding candidate-store read-modify-write cycles.
// A valid live owner is never preempted because of wall-clock or mtime drift.
// New locks bind the PID to the OS process start identity so PID reuse does not
// make an orphaned lock permanently live. Legacy PID-only locks remain
// fail-closed while that PID is alive.
export function withJsonLock(lockPath, fn, { timeoutMs = 5000, maxStaleMs = 30_000 } = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const lockRecord = {
    token,
    pid: process.pid,
    processIdentity: getProcessIdentity(process.pid),
    startedAt: Date.now(),
  };
  const RETRIABLE_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EACCES']);
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, JSON.stringify(lockRecord), 'utf8');
      } catch (error) {
        try { closeSync(fd); } catch {}
        try { unlinkSync(lockPath); } catch {}
        throw error;
      }
      closeSync(fd);
      break;
    } catch (error) {
      if (!RETRIABLE_CODES.has(error?.code)) throw error;
      try {
        const observed = readJsonLock(lockPath);
        const stat = statSync(lockPath);
        const reclaimable = observed.record
          ? !isProcessLockOwnerActive(observed.record)
          : Date.now() - stat.mtimeMs > maxStaleMs;
        if (reclaimable) {
          const claim = `${lockPath}.${process.pid}.${randomUUID()}.claim`;
          renameSync(lockPath, claim);
          const moved = readJsonLock(claim);
          if (moved.raw === observed.raw) {
            try { unlinkSync(claim); } catch { /* crash before cleanup leaves an inert claim file */ }
          } else if (!existsSync(lockPath)) {
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
    try {
      if (readJsonLock(lockPath).record?.token === token) unlinkSync(lockPath);
    } catch {
      // Already gone or no longer ours; nothing safe to unlink.
    }
  }
}
