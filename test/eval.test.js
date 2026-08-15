import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('40-case synthetic lexical safety baseline passes', () => {
  const script = fileURLToPath(new URL('../scripts/run-eval.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout);
  assert.equal(report.total, 40);
  assert.equal(report.passed, 40);
});

