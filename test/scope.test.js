import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { discoverProjects, resolveProjectScope, collectionsForScope } from '../src/vault.js';

const vault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

test('discovers project identity cards and resolves a unique positive match', () => {
  const projects = discoverProjects(vault);
  assert.equal(projects.length, 2);
  const scope = resolveProjectScope(projects, { query: '北辰仓配现在是什么状态' });
  assert.equal(scope.kind, 'project');
  assert.equal(scope.project.name, '北辰仓配项目');
});

test('returns ambiguity instead of searching two projects', () => {
  const projects = discoverProjects(vault);
  const scope = resolveProjectScope(projects, { query: '比较北辰仓配和西岭运输' });
  assert.equal(scope.kind, 'ambiguous');
  assert.equal(scope.candidates.length, 2);
});

test('explicit unknown project does not fall back to a similar project', () => {
  const projects = discoverProjects(vault);
  const scope = resolveProjectScope(projects, { projectName: '不存在项目', query: '当前价格' });
  assert.equal(scope.kind, 'unknown');
  assert.deepEqual(scope.candidates, []);
});

test('explicit scope conflicting with another named project abstains', () => {
  const projects = discoverProjects(vault);
  const scope = resolveProjectScope(projects, {
    projectName: '北辰仓配项目',
    query: '西岭运输现在每吨多少钱',
  });
  assert.equal(scope.kind, 'ambiguous');
  assert.deepEqual(scope.candidates.map((item) => item.name).sort(), ['北辰仓配项目', '西岭运输项目']);
});

test('history collections are opt-in', () => {
  const projects = discoverProjects(vault);
  const scope = resolveProjectScope(projects, { projectName: '北辰仓配项目' });
  const current = collectionsForScope(scope, 'current');
  const history = collectionsForScope(scope, 'history');
  assert.ok(current.includes('global-governance'));
  assert.ok(!current.includes('global-memory'));
  assert.ok(!current.includes('global-root'));
  assert.ok(!current.some((item) => item.includes('history')));
  assert.ok(!history.includes('global-history'));
  assert.ok(history.some((item) => item.endsWith('-history')));

  const global = resolveProjectScope(projects, { query: '没有项目归属的历史规则' });
  assert.ok(collectionsForScope(global, 'history').includes('global-history'));
});
