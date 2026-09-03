import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeConfig } from '../src/config.js';
import { activateCandidate, addCandidate, confirmCandidate, listCandidates, markCandidate } from '../src/candidates.js';

const fixture = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-candidate-'));
  const vault = join(root, 'vault');
  cpSync(fixture, vault, { recursive: true });
  return resolveRuntimeConfig({ vault, dataDir: join(root, 'data') });
}

test('AI candidate cannot confirm itself', () => {
  const config = sandbox();
  const added = addCandidate(config, { content: '经确认的新事实', scope: '北辰仓配项目' });
  assert.throws(() => confirmCandidate(config, { id: added.record.id }), /explicit user confirmation|authoritative/i);
  assert.equal(listCandidates(config)[0].status, 'candidate');
});

test('candidate scope must bind to one existing project', () => {
  const config = sandbox();
  assert.throws(() => addCandidate(config, {
    content: '无项目归属的候选事实',
    scope: '不存在项目',
  }), /existing project/i);
  const added = addCandidate(config, { content: '已绑定项目的事实', scope: '北辰仓配项目' });
  assert.match(added.record.projectId, /^project-/);
  assert.equal(added.record.projectName, '北辰仓配项目');
});

test('unrelated or historical Markdown cannot confirm an AI candidate', () => {
  const config = sandbox();
  const added = addCandidate(config, { content: '并未出现在来源中的候选事实', scope: '北辰仓配项目' });
  const unrelated = join(config.vault, '02-项目', '北辰仓配项目', '01-输入', '当前报价.md');
  assert.throws(() => confirmCandidate(config, {
    id: added.record.id,
    sourceRef: unrelated,
  }), /does not contain/i);

  const historical = join(config.vault, '02-项目', '北辰仓配项目', '02-过程', '旧方案.md');
  assert.throws(() => confirmCandidate(config, {
    id: added.record.id,
    sourceRef: historical,
  }), /authoritative|current/i);
});

test('global memory cannot confirm a project-bound candidate', () => {
  const config = sandbox();
  const globalSource = join(config.vault, '01-长期记忆', '项目专属事实.md');
  const content = '西岭运输项目的专属雪岭结算码为 7788，仅限西岭运输项目使用，不得用于北辰仓配项目。';
  const added = addCandidate(config, { content, scope: '北辰仓配项目' });
  assert.throws(() => confirmCandidate(config, {
    id: added.record.id,
    sourceRef: globalSource,
  }), /bound project/i);
  assert.equal(listCandidates(config)[0].status, 'candidate');
});

test('confirmed candidate becomes current only after verified Markdown write', () => {
  const config = sandbox();
  const added = addCandidate(config, { content: '经确认的新事实', scope: '北辰仓配项目' });
  confirmCandidate(config, { id: added.record.id, userConfirmed: true });
  const wrongTarget = join(config.vault, '02-项目', '西岭运输项目', '项目主页.md');
  const wrongUpdated = `${readFileSync(wrongTarget, 'utf8')}\n经确认的新事实\n`;
  writeFileSync(wrongTarget, wrongUpdated, 'utf8');
  const wrongHash = createHash('sha256').update(wrongUpdated).digest('hex');
  assert.throws(() => activateCandidate(config, {
    id: added.record.id,
    targetPath: wrongTarget,
    expectedHash: wrongHash,
  }), /bound project/i);
  assert.equal(listCandidates(config)[0].status, 'confirmed');

  const target = join(config.vault, '02-项目', '北辰仓配项目', '项目主页.md');
  const updated = `${readFileSync(target, 'utf8')}\n经确认的新事实\n`;
  writeFileSync(target, updated, 'utf8');
  const hash = createHash('sha256').update(updated).digest('hex');
  assert.throws(() => activateCandidate(config, {
    id: added.record.id,
    targetPath: target,
    expectedHash: 'bad-hash',
  }), /hash/i);
  const current = activateCandidate(config, {
    id: added.record.id,
    targetPath: target,
    expectedHash: hash,
  });
  assert.equal(current.status, 'current');
  assert.match(current.currentSource.path, /项目主页\.md$/);
});

test('mark revalidates project binding like confirm and activate', () => {
  const config = sandbox();
  const added = addCandidate(config, { content: '待标记的候选事实', scope: '北辰仓配项目' });
  rmSync(join(config.vault, '02-项目', '北辰仓配项目', '项目主页.md'));
  assert.throws(() => markCandidate(config, { id: added.record.id, status: 'expired' }), /valid project/i);
  assert.equal(listCandidates(config)[0].status, 'candidate');
});

test('a stale lock is reclaimed safely and the next write still lands', () => {
  const config = sandbox();
  const lock = join(config.candidatesDir, 'records.lock');
  writeFileSync(lock, 'crashed-writer', 'utf8');
  const stale = new Date(Date.now() - 60_000);
  utimesSync(lock, stale, stale);
  const added = addCandidate(config, { content: '陈旧锁恢复后的写入', scope: '北辰仓配项目' });
  assert.equal(added.created, true);
  assert.ok(!existsSync(lock), 'lock must be released after the write');
  assert.equal(listCandidates(config).length, 1);
});

test('confirmer identity is recorded and must differ from the creator', () => {
  const config = sandbox();
  const added = addCandidate(config, { content: '需要署名的事实', scope: '北辰仓配项目' });
  assert.throws(() => confirmCandidate(config, {
    id: added.record.id,
    userConfirmed: true,
    confirmedBy: 'ai',
  }), /differ from the candidate creator/i);
  assert.equal(listCandidates(config)[0].status, 'candidate');
  const done = confirmCandidate(config, {
    id: added.record.id,
    userConfirmed: true,
    confirmedBy: 'tester',
  });
  assert.equal(done.status, 'confirmed');
  assert.equal(done.confirmation.confirmedBy, 'tester');
  assert.equal(listCandidates(config)[0].confirmation.confirmedBy, 'tester');
});
