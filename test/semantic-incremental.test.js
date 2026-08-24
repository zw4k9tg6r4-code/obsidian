import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkMarkdown, collectSemanticChunks } from '../src/chunker.js';
import { buildCollections, discoverProjects } from '../src/vault.js';

const fixtureVault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

test('inserting a heading or paragraph preserves chunk IDs for unchanged text sections', () => {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-chunk-reuse-'));
  const vault = join(root, 'vault');
  cpSync(fixtureVault, vault, { recursive: true });

  const projects = discoverProjects(vault);
  const collections = buildCollections(vault, projects);

  // Baseline chunks
  const initialRecords = collectSemanticChunks(vault, collections);
  const quoteRecord = initialRecords.find((r) => r.relativePath.includes('当前报价.md'));
  assert.ok(quoteRecord);
  const initialQuoteId = quoteRecord.id;

  // Prepend a new section at top of 当前报价.md
  const quotePath = join(vault, '02-项目', '北辰仓配项目', '01-输入', '当前报价.md');
  const originalText = readFileSync(quotePath, 'utf8');
  writeFileSync(quotePath, `---\nupdated: 2026-08-24\n---\n\n# 前置须知\n\n所有价格需经财务复核。\n\n` + originalText, 'utf8');

  // Re-collect chunks
  const updatedRecords = collectSemanticChunks(vault, collections);
  const matchedOriginalChunk = updatedRecords.find((r) => r.text === quoteRecord.text);
  assert.ok(matchedOriginalChunk, 'The original text chunk must still exist');
  assert.equal(matchedOriginalChunk.id, initialQuoteId, 'Chunk ID must be identical so its vector embedding is reused without re-calculation');
  assert.notEqual(matchedOriginalChunk.startLine, quoteRecord.startLine, 'Line numbers updated but chunk ID preserved');
});
