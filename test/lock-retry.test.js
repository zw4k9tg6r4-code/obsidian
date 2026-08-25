import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { safeRmDir, cleanStaleReclaimLock } from '../src/lock.js';
import { killAllActiveWorkers, registerActiveWorker, getActiveWorkersCount } from '../src/semantic-adapter.js';
import { GracefulShutdownController } from '../src/mcp-server.js';
import { resolveRuntimeConfig } from '../src/config.js';

test('P2-06: safeRmDir removes directory cleanly and succeeds on non-existent path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-saferm-'));
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  assert.equal(existsSync(sub), true);

  const res = safeRmDir(sub);
  assert.equal(res, true);
  assert.equal(existsSync(sub), false);

  // Non-existent path returns true (idempotent)
  assert.equal(safeRmDir(sub), true);
});

test('P2-06: safeRmDir retries on transient file lock (EPERM/EBUSY) and returns false when exhausted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-lock-retry-'));
  const sub = join(dir, 'locked_dir');
  mkdirSync(sub);
  const filePath = join(sub, 'held.txt');
  writeFileSync(filePath, 'lock test', 'utf8');

  if (process.platform === 'win32') {
    // Hold an exclusive FileShare.None lock on Windows using PowerShell
    const psCode = `
      $file = [System.IO.File]::Open('${filePath.replaceAll('\\', '\\\\')}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      [Console]::WriteLine('LOCKED')
      [Console]::ReadLine()
      $file.Close()
    `;
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', psCode], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await new Promise((resolve) => {
      child.stdout.on('data', (d) => {
        if (d.toString().includes('LOCKED')) resolve();
      });
    });

    // 1. With file held exclusively, safeRmDir should retry and return false when exhausted
    const resFail = safeRmDir(sub, { maxRetries: 2, retryDelayMs: 20 });
    assert.equal(resFail, false, 'safeRmDir must return false when retries exhausted on locked file');
    assert.equal(existsSync(sub), true, 'Directory must still exist when removal fails');

    // 2. Release lock and verify safeRmDir now succeeds
    child.stdin.write('\n');
    await new Promise((resolve) => child.on('close', resolve));

    const resSuccess = safeRmDir(sub, { maxRetries: 4, retryDelayMs: 20 });
    assert.equal(resSuccess, true, 'safeRmDir must succeed after file is unlocked');
    assert.equal(existsSync(sub), false, 'Directory must be removed');
  } else {
    assert.equal(safeRmDir(sub), true);
  }
});

test('P2-06: cleanStaleReclaimLock returns true on non-existent or cleanly removed reclaim lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-reclaim-'));
  const vault = join(dir, 'vault');
  const dataDir = join(dir, 'data');
  mkdirSync(vault);
  writeFileSync(join(vault, 'AGENTS.md'), '# Agents\n', 'utf8');
  const config = resolveRuntimeConfig({ vault, dataDir });
  const res = cleanStaleReclaimLock(config);
  assert.equal(res, true, 'cleanStaleReclaimLock on non-existent lock must return true');
});

test('P2-07: killAllActiveWorkers terminates registered active workers including stubborn processes', async () => {
  // 1. Empty set returns true
  const resEmpty = await killAllActiveWorkers({ waitMs: 200 });
  assert.equal(resEmpty, true);

  // 2. Spawn a normal active worker and register it
  const normalWorker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  registerActiveWorker(normalWorker);
  assert.ok(getActiveWorkersCount() >= 1, 'Active worker must be tracked in active set');

  const killNormalRes = await killAllActiveWorkers({ waitMs: 2000 });
  assert.equal(killNormalRes, true, 'Normal worker must be terminated cleanly');
  assert.equal(getActiveWorkersCount(), 0, 'Active set must be cleared on process exit');

  // 3. Spawn a stubborn worker that ignores SIGTERM and register it
  const stubbornWorker = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    { stdio: 'ignore' }
  );
  registerActiveWorker(stubbornWorker);
  assert.ok(getActiveWorkersCount() >= 1, 'Stubborn worker must be tracked');

  const killStubbornRes = await killAllActiveWorkers({ waitMs: 2000 });
  assert.equal(killStubbornRes, true, 'Stubborn worker must be forcibly terminated via forceKill/taskkill');
  assert.equal(getActiveWorkersCount(), 0, 'Active set must be 0 after force kill');
});

test('P2-07: MCP GracefulShutdownController closes transports/servers and cleans all active workers', async () => {
  let transportClosed = false;
  let serverClosed = false;

  const mockTransport = {
    close: async () => { transportClosed = true; },
  };
  const mockServer = {
    close: async () => { serverClosed = true; },
  };

  // Spawn an active worker and register it
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  registerActiveWorker(child);
  assert.ok(getActiveWorkersCount() >= 1);

  const controller = new GracefulShutdownController(mockServer, mockTransport, { exitProcess: false });
  await controller.performGracefulShutdown('SIGTERM');

  assert.equal(transportClosed, true, 'Transport must be closed during graceful shutdown');
  assert.equal(serverClosed, true, 'Server must be closed during graceful shutdown');
  assert.equal(getActiveWorkersCount(), 0, 'All active workers must be cleaned during graceful shutdown');
});
