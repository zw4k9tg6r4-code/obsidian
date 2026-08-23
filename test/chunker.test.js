import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chunkMarkdown, collectSemanticChunks } from '../src/chunker.js';
import { buildCollections, discoverProjects } from '../src/vault.js';

const vault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

test('chunkMarkdown skips frontmatter and splits on top headings', () => {
  const text = '---\ntitle: x\n---\n\n# A\n\nalpha line\n\n# B\n\nbeta line\n';
  const chunks = chunkMarkdown(text);
  assert.equal(chunks.length, 2);
  assert.ok(!chunks[0].text.includes('title'));
  assert.match(chunks[0].text, /alpha line/);
  assert.match(chunks[1].text, /beta line/);
  assert.ok(chunks[0].startLine >= 4);
});

test('chunkMarkdown flushes oversized chunks with overlap', () => {
  const text = `# Long\n\n${'x'.repeat(100)}\n`.repeat(30);
  const chunks = chunkMarkdown(text, { maxChars: 600 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 2400));
});

test('oversized single lines are hard-split instead of forming one giant chunk', () => {
  const text = `# 标题\n\n${'长'.repeat(10_000)}\n\n结尾行\n`;
  const chunks = chunkMarkdown(text, { maxChars: 2400 });
  assert.ok(chunks.length >= 5);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 2400));
  assert.match(chunks.at(-1).text, /结尾行/);
});

test('BOM-prefixed notes skip frontmatter in semantic chunks', () => {
  const text = '\uFEFF---\ntitle: x\n---\n\n正文内容\n';
  const chunks = chunkMarkdown(text);
  assert.equal(chunks.length, 1);
  assert.ok(!chunks[0].text.includes('title'));
  assert.match(chunks[0].text, /正文内容/);
});

test('collectSemanticChunks only includes files that belong to a collection', () => {
  const projects = discoverProjects(vault);
  const collections = buildCollections(vault, projects);
  const records = collectSemanticChunks(vault, collections);
  assert.ok(records.length > 0);
  const paths = new Set(records.map((item) => item.relativePath));
  assert.ok(paths.has('AGENTS.md'));
  assert.ok(paths.has('04-对话纪要/2026-08.md'));
  const projectRecord = records.find((item) => item.relativePath.includes('当前报价'));
  assert.ok(projectRecord);
  assert.ok(projectRecord.collections.some((name) => name.endsWith('-current')));
  for (const record of records) {
    assert.ok(Array.isArray(record.collections) && record.collections.length > 0);
    assert.match(record.id, /^[0-9a-f]{64}$/);
  }
});
