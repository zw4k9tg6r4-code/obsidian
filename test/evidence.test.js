import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { discoverProjects } from '../src/vault.js';
import { decideEvidence, openEvidence } from '../src/evidence.js';

const vault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));
const projects = discoverProjects(vault);

test('opens the real source and returns resolvable evidence metadata', () => {
  const file = join(vault, '02-项目', '北辰仓配项目', '01-输入', '当前报价.md');
  const evidence = openEvidence({ filepath: file, title: '报价', rrfScore: 0.1, contributions: [
    { source: 'lexical', rank: 1 },
  ] }, { vault, projects, query: '每托盘 120 元' });
  assert.equal(evidence.path, '02-项目/北辰仓配项目/01-输入/当前报价.md');
  assert.equal(evidence.authority, 'primary-input');
  assert.equal(evidence.state, 'current');
  assert.equal(evidence.sourceOpened, true);
  assert.match(evidence.snippet, /120 元/);
  assert.ok(evidence.lineStart >= 1);
});

test('high-impact claims require a current authoritative source', () => {
  const low = [{ sourceOpened: true, authorityScore: 45, state: 'current', snippet: '草案价格' }];
  assert.equal(decideEvidence({ query: '当前价格是多少', evidence: low, scope: { kind: 'project' }, indexFresh: true }).decision, 'insufficient');
  const high = [{ sourceOpened: true, authorityScore: 90, state: 'current', snippet: '当前价格' }];
  assert.equal(decideEvidence({ query: '当前价格是多少', evidence: high, scope: { kind: 'project' }, indexFresh: true }).decision, 'grounded');
});

test('explicit disputed source returns conflict', () => {
  const disputed = [{ sourceOpened: true, authorityScore: 90, state: 'disputed', snippet: '存在冲突' }];
  assert.equal(decideEvidence({ query: '发车日期', evidence: disputed, scope: { kind: 'project' }, indexFresh: true }).decision, 'conflict');
});

test('numeric claims must appear in the opened evidence', () => {
  const evidence = [{ sourceOpened: true, authorityScore: 95, state: 'current', snippet: '当前标准费用是 120 元' }];
  const assessment = decideEvidence({
    query: '当前费用是不是 80 元',
    evidence,
    scope: { kind: 'project' },
    indexFresh: true,
  });
  assert.equal(assessment.decision, 'insufficient');
});
