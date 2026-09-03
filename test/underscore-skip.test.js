import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeConfig } from '../src/config.js';
import { collectTrackedFiles, buildCollections, discoverProjects, vaultStats } from '../src/vault.js';
import { indexVault } from '../src/qmd-adapter.js';
import { searchSecondBrain } from '../src/retrieval.js';

const fixture = fileURLToPath(new URL('./fixtures/vault', import.meta.url));
const DRAFT_KEYWORD = '独一无二的草稿暗号鹦鹉螺12345';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-underscore-'));
  const vault = join(root, 'vault');
  cpSync(fixture, vault, { recursive: true });
  return { root, vault, dataDir: join(root, 'data') };
}

test('underscore entries are excluded from stats, tracking, and discovery', () => {
  const { vault, dataDir } = sandbox();
  const before = vaultStats(vault);
  const config = resolveRuntimeConfig({ vault, dataDir });
  const projectsBefore = discoverProjects(vault).map((p) => p.name);

  mkdirSync(join(vault, '02-项目', '北辰仓配项目', '_草稿'), { recursive: true });
  writeFileSync(
    join(vault, '02-项目', '北辰仓配项目', '_草稿', '草稿.md'),
    `# 草稿\n\n${DRAFT_KEYWORD}。\n`,
    'utf8',
  );
  mkdirSync(join(vault, '02-项目', '_隐藏项目'), { recursive: true });
  writeFileSync(
    join(vault, '02-项目', '_隐藏项目', '项目主页.md'),
    '---\nproject: 隐藏项目\nstatus: active\n---\n\n# 隐藏\n',
    'utf8',
  );

  const after = vaultStats(vault);
  assert.equal(after.markdownFiles, before.markdownFiles);
  assert.equal(after.contentHash, before.contentHash);

  const tracked = collectTrackedFiles(vault, buildCollections(vault, discoverProjects(vault)));
  assert.ok(tracked.every((file) => !file.rel.split('/').some((part) => part.startsWith('_'))));

  const names = discoverProjects(vault).map((p) => p.name);
  assert.deepEqual(names, projectsBefore);
  assert.ok(!names.includes('隐藏项目'));
});

test('underscore drafts are never recalled as evidence', async () => {
  const { vault, dataDir } = sandbox();
  mkdirSync(join(vault, '02-项目', '北辰仓配项目', '_草稿'), { recursive: true });
  writeFileSync(
    join(vault, '02-项目', '北辰仓配项目', '_草稿', '草稿.md'),
    `# 草稿\n\n${DRAFT_KEYWORD}。\n`,
    'utf8',
  );
  const config = resolveRuntimeConfig({ vault, dataDir });
  await indexVault(config, { semantic: false });

  const result = await searchSecondBrain({
    vault,
    dataDir,
    query: '草稿暗号鹦鹉螺',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });

  assert.equal(result.decision, 'insufficient');
  assert.deepEqual(result.evidence, []);
});
