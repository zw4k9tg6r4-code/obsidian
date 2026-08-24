import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { lockPath, isSyncLockActive } from '../src/lock.js';

const workerCode = `
import { appendFileSync } from 'node:fs';
import { withSyncLock } from './src/lock.js';

const config = JSON.parse(process.argv[1]);
const holdMs = Number(process.argv[2] || 20);
const logFile = process.argv[3];

async function main() {
  await withSyncLock(config, { timeoutMs: 15000, maxStaleMs: 30000 }, async (lock) => {
    const start = Date.now();
    appendFileSync(logFile, JSON.stringify({ pid: process.pid, event: 'enter', start }) + '\\n', 'utf8');
    await new Promise((res) => setTimeout(res, holdMs));
    const end = Date.now();
    appendFileSync(logFile, JSON.stringify({ pid: process.pid, event: 'exit', start, end }) + '\\n', 'utf8');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

test('lock concurrency: multi-process stale-lock stress test guarantees zero critical section overlap', async () => {
  const rounds = 12;
  const workersPerRound = 16;
  const holdMs = 20;

  for (let round = 0; round < rounds; round++) {
    const root = mkdtempSync(join(tmpdir(), `sbrain-lock-stress-r${round}-`));
    const config = { indexDir: join(root, 'index') };
    mkdirSync(config.indexDir, { recursive: true });

    // Pre-inject a dead PID stale lock
    const p = lockPath(config);
    const staleLock = {
      token: `stale-token-round-${round}`,
      pid: 999999, // guaranteed dead PID
      generationId: `gen-stale-${round}`,
      startedAt: Date.now() - 60000,
      heartbeatAt: Date.now() - 60000,
    };
    writeFileSync(p, JSON.stringify(staleLock, null, 2), 'utf8');

    const logFile = join(root, 'events.jsonl');
    writeFileSync(logFile, '', 'utf8');

    // Spawn 16 independent Node child processes simultaneously
    const spawnWorker = () => new Promise((resolve, reject) => {
      const cp = spawn(process.execPath, ['--input-type=module', '-e', workerCode, JSON.stringify(config), String(holdMs), logFile], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      cp.stderr.on('data', (d) => { stderr += d; });
      cp.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Worker PID ${cp.pid} failed with code ${code}: ${stderr}`));
      });
    });

    const workers = Array.from({ length: workersPerRound }, () => spawnWorker());
    await Promise.all(workers);

    // Read log and verify zero critical section overlap
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    const intervals = [];
    for (const line of lines) {
      const data = JSON.parse(line);
      if (data.event === 'exit') {
        intervals.push({ pid: data.pid, start: data.start, end: data.end });
      }
    }

    assert.equal(intervals.length, workersPerRound, `Round ${round}: all ${workersPerRound} workers must complete`);

    // Check every pair for interval overlap: [startA, endA] and [startB, endB]
    intervals.sort((a, b) => a.start - b.start);
    let overlaps = 0;
    for (let i = 0; i < intervals.length - 1; i++) {
      const current = intervals[i];
      const next = intervals[i + 1];
      if (next.start < current.end) {
        overlaps++;
      }
    }

    assert.equal(overlaps, 0, `Round ${round}: Critical sections must never overlap (overlaps found: ${overlaps})`);
    assert.equal(existsSync(lockPath(config)), false);
  }
});
