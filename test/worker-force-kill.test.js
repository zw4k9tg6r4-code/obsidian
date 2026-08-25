import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import cluster from 'node:cluster';
import { spawn } from 'node:child_process';
import {
  registerActiveWorker,
  getActiveWorkersCount,
  killAllActiveWorkers,
  resetWorkerShutdownStateForTests,
  workerKillFaults,
} from '../src/semantic-adapter.js';
import { GracefulShutdownController } from '../src/mcp-server.js';

// The long-lived worker process is started through the cluster module (its
// only configuration is the fixed fixture path below; no shell, no string
// commands, no user input of any kind reaches process creation).
cluster.setupPrimary({
  exec: fileURLToPath(new URL('./fixtures/worker-forever.mjs', import.meta.url)),
  args: [],
  silent: true,
  windowsHide: true,
});

function startWorkerProcess() {
  const clusterWorker = cluster.fork();
  return clusterWorker.process;
}

// A PID the OS reports as non-existent (verified, not guessed): taskkill or
// SIGKILL can never terminate it, so its exit can never be confirmed.
function findNonExistentPid() {
  for (let pid = 4194302; pid > 4190000; pid -= 1) {
    try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') return pid; }
  }
  return 0;
}

// Injectable child proxy: kill() is a no-op so the test deterministically
// reaches the 500ms force-kill branch instead of relying on Windows signal
// semantics (child.kill terminates immediately, hiding the taskkill path).
function makeUnkillableChildProxy(realChild, fallbackPid) {
  const exitListeners = [];
  const proxy = {
    pid: realChild ? realChild.pid : fallbackPid,
    get exitCode() { return realChild ? realChild.exitCode : null; },
    get signalCode() { return realChild ? realChild.signalCode : null; },
    kill() { return true; },
    once(event, cb) {
      if (event === 'exit') exitListeners.push(cb);
      if (realChild) realChild.once(event, cb);
      return proxy;
    },
    // Test-only cleanup: simulate the eventual exit so the active set drains.
    __emitExit() {
      for (const cb of exitListeners.splice(0)) cb(1, null);
    },
  };
  return proxy;
}

test('P2-07: force-kill branch is actually reached and verified by PID disappearance', async (t) => {
  const realWorker = startWorkerProcess();
  const workerPid = realWorker.pid;
  await new Promise((resolve) => realWorker.once('spawn', resolve));

  // The cluster IPC channel keeps this file's process alive while the worker
  // runs, so a worker that survives the test would hang the whole run.
  // Belt-and-braces: guarantee termination even if the taskkill path
  // transiently fails under concurrent test load (kill('SIGKILL') is an
  // immediate TerminateProcess on Windows and does not depend on taskkill).
  t.after(async () => {
    try { realWorker.kill('SIGKILL'); } catch {}
    await new Promise((resolve) => {
      if (realWorker.exitCode !== null || realWorker.signalCode !== null) return resolve();
      const guard = setTimeout(resolve, 3000);
      realWorker.once('exit', () => { clearTimeout(guard); resolve(); });
    });
  });

  // POSIX: the fixture itself ignores SIGTERM. Windows: the proxy no-ops kill().
  const trackedChild = process.platform === 'win32'
    ? makeUnkillableChildProxy(realWorker)
    : realWorker;
  registerActiveWorker(trackedChild);
  assert.ok(getActiveWorkersCount() >= 1, 'Stubborn worker must be tracked');

  const startedAt = Date.now();
  const result = await killAllActiveWorkers({ waitMs: 3000 });
  const elapsed = Date.now() - startedAt;

  // Windows must use taskkill /T while the parent PID is still alive so a
  // detached descendant cannot outlive an already-exited parent. POSIX keeps
  // the delayed SIGKILL fallback.
  if (process.platform !== 'win32') {
    assert.ok(elapsed >= 450, `Force-kill branch must be exercised (elapsed ${elapsed}ms)`);
  }
  assert.equal(result, true, 'Force-killed worker must be reported as terminated');

  // The OS-level PID must be gone, not merely removed from the active set
  let pidStillExists = true;
  try { process.kill(workerPid, 0); } catch (err) { pidStillExists = err.code !== 'ESRCH'; }
  assert.equal(pidStillExists, false, `Worker PID ${workerPid} must no longer exist after force kill`);

  assert.equal(getActiveWorkersCount(), 0, 'Active set must be empty after confirmed exit');
});

test('P1: exited worker PIDs are removed and never targeted by a later shutdown', {
  skip: process.platform !== 'win32',
}, async () => {
  resetWorkerShutdownStateForTests();
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  const exitedPid = child.pid;
  registerActiveWorker(child);
  await new Promise((resolve) => child.once('exit', resolve));

  const targetedPids = [];
  workerKillFaults.spawnSyncAdapter = (_command, args) => {
    targetedPids.push(Number(args.at(-1)));
    return { status: 0, error: null };
  };
  const result = await killAllActiveWorkers({ waitMs: 100 });

  assert.equal(result, true);
  assert.equal(targetedPids.includes(exitedPid), false, 'A historical PID must never be passed to taskkill');
  resetWorkerShutdownStateForTests();
});

test('P2: taskkill failure cannot report successful Windows tree shutdown', {
  skip: process.platform !== 'win32',
}, async (t) => {
  resetWorkerShutdownStateForTests();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
  await new Promise((resolve) => child.once('spawn', resolve));
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
    resetWorkerShutdownStateForTests();
  });
  registerActiveWorker(child);
  workerKillFaults.spawnSyncAdapter = () => ({
    status: null,
    error: new Error('taskkill unavailable'),
  });

  const result = await killAllActiveWorkers({ waitMs: 1000 });
  assert.equal(result, false, 'Parent exit alone cannot prove the Windows process tree was terminated');
});

test('P2-07: unconfirmed worker exit keeps the worker tracked and reports failure', async () => {
  const ghostPid = findNonExistentPid();
  assert.ok(ghostPid > 0, 'Test requires a PID the OS reports as non-existent');

  const proxy = makeUnkillableChildProxy(null, ghostPid);
  registerActiveWorker(proxy);
  const before = getActiveWorkersCount();

  const result = await killAllActiveWorkers({ waitMs: 1200 });
  assert.equal(result, false, 'A worker whose exit cannot be confirmed must be reported as failure');
  assert.equal(getActiveWorkersCount(), before, 'Unconfirmed worker must NOT be removed from the active set');

  // Simulate the leaked process finally exiting: tracking must drain then
  proxy.__emitExit();
  assert.equal(getActiveWorkersCount(), before - 1, 'Tracking must drain once the exit is finally observed');
});

test('P2-07: graceful shutdown exposes a verifiable failure status when worker recycling fails', async () => {
  let transportClosed = false;
  let serverClosed = false;
  const mockTransport = { close: async () => { transportClosed = true; } };
  const mockServer = { close: async () => { serverClosed = true; } };

  const ghostPid = findNonExistentPid();
  assert.ok(ghostPid > 0, 'Test requires a PID the OS reports as non-existent');
  const proxy = makeUnkillableChildProxy(null, ghostPid);
  registerActiveWorker(proxy);

  const controller = new GracefulShutdownController(mockServer, mockTransport, { exitProcess: false });
  const shutdownResult = await controller.performGracefulShutdown('SIGTERM');

  assert.equal(transportClosed, true, 'Transport must be closed during graceful shutdown');
  assert.equal(serverClosed, true, 'Server must be closed during graceful shutdown');
  assert.equal(shutdownResult.workersKilled, false, 'Shutdown must expose failure when a worker cannot be confirmed as exited');
  proxy.__emitExit();
  resetWorkerShutdownStateForTests();
});

test('P2-07: Late worker registration after shutdown starts is terminated and drained, not leaked', async (t) => {
  resetWorkerShutdownStateForTests();
  const realWorker1 = startWorkerProcess();
  await new Promise((resolve) => realWorker1.once('spawn', resolve));
  const trackedChild1 = process.platform === 'win32'
    ? makeUnkillableChildProxy(realWorker1)
    : realWorker1;
  registerActiveWorker(trackedChild1);

  // Start shutdown (takes >=500ms due to force-kill threshold on stubborn worker)
  const shutdownPromise = killAllActiveWorkers({ waitMs: 3000 });

  // During active shutdown draining, simulate a late worker being started and registered
  await new Promise((r) => setTimeout(r, 100));
  const lateWorker = startWorkerProcess();
  await new Promise((resolve) => lateWorker.once('spawn', resolve));
  const latePid = lateWorker.pid;

  t.after(async () => {
    try { realWorker1.kill('SIGKILL'); } catch {}
    try { lateWorker.kill('SIGKILL'); } catch {}
  });

  registerActiveWorker(lateWorker);

  const result = await shutdownPromise;
  assert.equal(result, true, 'Shutdown must succeed and drain all workers including late registered one');
  assert.equal(getActiveWorkersCount(), 0, 'Active workers count must be 0');

  let latePidStillExists = true;
  try { process.kill(latePid, 0); } catch (err) { latePidStillExists = err.code !== 'ESRCH'; }
  assert.equal(latePidStillExists, false, `Late worker PID ${latePid} must be terminated`);
  resetWorkerShutdownStateForTests();
});

test('P2-07: Concurrent calls to performGracefulShutdown wait for the same promise and return the same verified status', async () => {
  resetWorkerShutdownStateForTests();
  let transportCloseCount = 0;
  let serverCloseCount = 0;
  const mockTransport = { close: async () => { transportCloseCount += 1; } };
  const mockServer = { close: async () => { serverCloseCount += 1; } };

  const controller = new GracefulShutdownController(mockServer, mockTransport, { exitProcess: false });

  // Call shutdown concurrently
  const [res1, res2, res3] = await Promise.all([
    controller.performGracefulShutdown('SIGTERM'),
    controller.performGracefulShutdown('SIGINT'),
    controller.performGracefulShutdown('stdin_close'),
  ]);

  assert.equal(transportCloseCount, 1, 'Transport must only be closed once');
  assert.equal(serverCloseCount, 1, 'Server must only be closed once');
  assert.equal(res1.workersKilled, true, 'First shutdown call must succeed');
  assert.equal(res2.workersKilled, true, 'Second concurrent call must receive the same verified result');
  assert.equal(res3.workersKilled, true, 'Third concurrent call must receive the same verified result');
  assert.equal(res1, res2, 'Concurrent callers must share the exact same result object');
  resetWorkerShutdownStateForTests();
});

test('P2-07: Transport close failure is captured and reflected in shutdown failure without skipping server close', async () => {
  resetWorkerShutdownStateForTests();
  let serverClosed = false;
  const mockTransport = { close: async () => { throw new Error('Transport stream broken'); } };
  const mockServer = { close: async () => { serverClosed = true; } };

  const controller = new GracefulShutdownController(mockServer, mockTransport, { exitProcess: false });
  const result = await controller.performGracefulShutdown('SIGTERM');

  assert.equal(serverClosed, true, 'Server close must not be skipped when transport close fails');
  assert.equal(result.workersKilled, false, 'Shutdown status must report failure when transport close errors');
  assert.ok(result.errors.some((msg) => msg.includes('Transport stream broken')), 'Errors array must contain transport error message');
  resetWorkerShutdownStateForTests();
});

test('P2-04: Shutdown start immediately sets worker shutdown gate and rejects new spawns during transport close', async () => {
  resetWorkerShutdownStateForTests();
  const { runPython } = await import('../src/semantic-adapter.js');

  let transportClosePending = true;
  const mockTransport = {
    close: async () => {
      await new Promise((r) => setTimeout(r, 50));
      transportClosePending = false;
    },
  };
  const mockServer = { close: async () => {} };

  const controller = new GracefulShutdownController(mockServer, mockTransport, { exitProcess: false });
  const shutdownPromise = controller.performGracefulShutdown('SIGTERM');

  // While transport close is still pending, attempt to run a python worker
  const spawnAttempt = await runPython({ dataDir: 'test' }, ['test']);
  assert.equal(spawnAttempt.ok, false, 'New worker spawn must be rejected immediately during shutdown window');
  assert.match(spawnAttempt.error, /shutdown in progress/i);

  await shutdownPromise;
  resetWorkerShutdownStateForTests();
});

test('P2-05: Synchronous re-entrant performGracefulShutdown calls return the exact same Promise instance', async () => {
  resetWorkerShutdownStateForTests();
  let transportCloseCount = 0;
  let reentrantPromise = null;
  let controller = null;

  const mockTransport = {
    close: () => {
      transportCloseCount += 1;
      // Synchronously re-enter shutdown from inside close callback
      reentrantPromise = controller.performGracefulShutdown('SIGINT');
    },
  };
  const mockServer = { close: async () => {} };

  controller = new GracefulShutdownController(mockServer, mockTransport, { exitProcess: false });
  const initialPromise = controller.performGracefulShutdown('SIGTERM');

  const [resInitial, resReentrant] = await Promise.all([initialPromise, reentrantPromise]);
  assert.equal(transportCloseCount, 1, 'Transport close must only be called once');
  assert.equal(initialPromise, reentrantPromise, 'Re-entrant call must return identical Promise instance');
  assert.equal(resInitial, resReentrant, 'Both promises must resolve to identical result object');
  resetWorkerShutdownStateForTests();
});
