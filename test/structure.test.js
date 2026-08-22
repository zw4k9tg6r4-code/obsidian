import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STRUCTURE, resolveStructure, historicalPathPattern } from '../src/structure.js';
import { buildCollections, discoverProjects, resolveProjectScope } from '../src/vault.js';
import { authorityForPath } from '../src/evidence.js';
import { resolveRuntimeConfig } from '../src/config.js';

const CUSTOM = {
  vaultRuleFile: 'RULES.md',
  projectsDir: 'projects',
  projectHome: 'PROJECT.md',
  memoryDir: 'memory',
  conversationDir: 'logs',
  workflowDir: 'flows',
  projectInputDir: 'inputs',
  projectProcessDir: 'process',
  projectOutputDir: 'outputs',
  projectFeedbackDir: 'feedback',
  homeNotes: ['RULES.md'],
  governanceFiles: ['RULES.md', 'memory/profile.md'],
};

function customVault() {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-structure-'));
  const vault = join(root, 'vault');
  for (const dir of [
    'memory',
    'logs',
    'flows',
    join('projects', 'alpha', 'inputs'),
    join('projects', 'alpha', 'process'),
    join('projects', 'alpha', 'outputs'),
    join('projects', 'alpha', 'feedback'),
  ]) {
    mkdirSync(join(vault, dir), { recursive: true });
  }
  writeFileSync(join(vault, 'RULES.md'), '# Rules\n', 'utf8');
  writeFileSync(join(vault, 'memory', 'profile.md'), '# Profile\n', 'utf8');
  writeFileSync(join(vault, 'projects', 'alpha', 'PROJECT.md'), [
    '---',
    'project: alpha-plan',
    'status: active',
    'updated: 2026-08-01',
    '---',
    '',
    '# alpha',
    '',
    '- 主对象：甲方案。',
    '- 不可混用：乙项目。',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(vault, 'projects', 'alpha', 'inputs', 'rate.md'), '# Rate\n费率说明。\n', 'utf8');
  writeFileSync(join(vault, 'projects', 'alpha', 'process', 'draft.md'), '# Draft\n草稿。\n', 'utf8');
  writeFileSync(join(vault, 'logs', '2026-08.md'), '# Log\n', 'utf8');
  writeFileSync(join(vault, 'flows', 'flow.md'), '# Flow\n', 'utf8');
  return { root, vault };
}

test('resolveStructure validates overrides and falls back to defaults', () => {
  assert.equal(resolveStructure(null), DEFAULT_STRUCTURE);
  assert.equal(resolveStructure({}).projectsDir, DEFAULT_STRUCTURE.projectsDir);
  assert.throws(() => resolveStructure({ unknown: 'x' }), /Unknown structure key/);
  assert.throws(() => resolveStructure({ projectsDir: '/absolute' }), /relative path/);
  assert.throws(() => resolveStructure({ projectsDir: '../outside' }), /relative path/);
  assert.throws(() => resolveStructure({ homeNotes: [] }), /non-empty array/);
  const merged = resolveStructure({ projectsDir: 'projects' });
  assert.equal(merged.projectsDir, 'projects');
  assert.equal(merged.memoryDir, DEFAULT_STRUCTURE.memoryDir);
});

test('custom structure discovers projects and builds matching collections', () => {
  const { vault } = customVault();
  const structure = resolveStructure(CUSTOM);
  assert.deepEqual(discoverProjects(vault), []);
  const projects = discoverProjects(vault, structure);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'alpha-plan');
  assert.equal(projects[0].status, 'active');
  assert.equal(projects[0].incompatible, '乙项目。');

  const collections = buildCollections(vault, projects, structure);
  const names = collections.map((item) => item.name);
  for (const expected of ['global-root', 'global-governance', 'global-memory', 'global-workflows', 'global-history']) {
    assert.ok(names.includes(expected), `missing collection ${expected}`);
  }
  const current = collections.find((item) => item.name.endsWith('-current'));
  assert.equal(current.path, projects[0].directory);
  assert.deepEqual(current.ignore, ['process/**']);
  const history = collections.find((item) => item.name.endsWith('-history') && item.name.startsWith('project-'));
  assert.equal(history.path, join(projects[0].directory, 'process'));
});

test('authority and historical patterns follow the configured structure', () => {
  const structure = resolveStructure(CUSTOM);
  assert.equal(authorityForPath('RULES.md', structure).level, 'system-rule');
  assert.equal(authorityForPath('projects/alpha/PROJECT.md', structure).level, 'project-home');
  assert.equal(authorityForPath('projects/alpha/inputs/rate.md', structure).level, 'primary-input');
  assert.equal(authorityForPath('projects/alpha/process/draft.md', structure).level, 'process');
  assert.equal(authorityForPath('logs/2026-08.md', structure).level, 'conversation-history');
  assert.equal(authorityForPath('flows/flow.md', structure).level, 'workflow');
  const pattern = historicalPathPattern(structure);
  assert.ok(pattern.test('logs/2026-08.md'));
  assert.ok(pattern.test('projects/alpha/process/draft.md'));
  assert.ok(!pattern.test('projects/alpha/inputs/rate.md'));
  assert.equal(authorityForPath('02-项目/甲/项目主页.md').level, 'project-home');
});

test('structure overrides reach resolveRuntimeConfig through config.json', () => {
  const { root, vault } = customVault();
  const dataDir = join(root, 'data');
  const configDir = join(dataDir, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    vault,
    structure: { projectsDir: 'projects', projectHome: 'PROJECT.md', vaultRuleFile: 'RULES.md' },
  }), 'utf8');
  const config = resolveRuntimeConfig({ dataDir });
  assert.equal(config.structure.projectsDir, 'projects');
  assert.equal(config.structure.projectHome, 'PROJECT.md');
  assert.equal(discoverProjects(config.vault, config.structure).length, 1);
});

test('BOM-prefixed project home frontmatter still parses', () => {
  const { vault } = customVault();
  const structure = resolveStructure(CUSTOM);
  writeFileSync(join(vault, 'projects', 'alpha', 'PROJECT.md'), [
    '---',
    'project: alpha-plan',
    'status: paused',
    'updated: 2026-08-02',
    '---',
    '',
    '# alpha',
    '',
  ].join('\n').replace(/^/, '\uFEFF'), 'utf8');
  const projects = discoverProjects(vault, structure);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].status, 'paused');
});

test('two-character project names participate in positive matching', () => {
  const projects = [{ id: 'p1', name: '北辰', status: 'active', mainObject: '', directory: '' }];
  assert.equal(resolveProjectScope(projects, { query: '北辰现在什么状态' }).kind, 'project');
});
