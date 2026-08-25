import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdown, discoverProjects } from '../src/vault.js';
import { resolveStructure } from '../src/structure.js';

test('parseMarkdown and discoverProjects withstand malformed frontmatter', () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-fm-'));
  const vault = join(root, 'vault');
  const projDir = join(vault, '02-项目', '异常项目');
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(vault, 'AGENTS.md'), '# Rules\n', 'utf8');

  // 1. Array frontmatter
  const arrayFmPath = join(projDir, '项目主页.md');
  writeFileSync(arrayFmPath, '---\n- 列表条目1\n- 列表条目2\n---\n# 内容\n', 'utf8');
  assert.doesNotThrow(() => parseMarkdown(arrayFmPath));
  assert.doesNotThrow(() => discoverProjects(vault, resolveStructure()));

  // 2. Syntax-error YAML
  writeFileSync(arrayFmPath, '---\nstatus: [unclosed array\n---\n# 内容\n', 'utf8');
  const parsedSyntax = parseMarkdown(arrayFmPath);
  assert.deepEqual(parsedSyntax.frontmatter, {});
  assert.match(parsedSyntax.body, /内容/);
});
