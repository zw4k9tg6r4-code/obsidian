import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeConfig } from '../src/config.js';
import { addCandidate, listCandidates } from '../src/candidates.js';
import { withJsonLock } from '../src/io.js';

const fixture = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-recovery-'));
  const config = resolveRuntimeConfig({ vault: fixture, dataDir: join(root, 'data') });
  return { root, config };
}

test('corrupt candidate store is quarantined and rebuilt', () => {
  const { config } = sandbox();
  writeFileSync(join(config.candidatesDir, 'records.json'), '{not valid json', 'utf8');
  const added = addCandidate(config, { content: '损坏后新增的候选事实', scope: '北辰仓配项目' });
  assert.equal(added.created, true);
  assert.equal(listCandidates(config).length, 1);
  const quarantined = readdirSync(config.candidatesDir).filter((name) => name.startsWith('records.corrupt-'));
  assert.equal(quarantined.length, 1);
});

test('withJsonLock runs the critical section and removes the lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbrain-lock-'));
  const lock = join(dir, 'records.lock');
  assert.equal(withJsonLock(lock, () => 'done'), 'done');
  assert.equal(existsSync(lock), false);
  assert.equal(withJsonLock(lock, (value) => value), undefined);
});
