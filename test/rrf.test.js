import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseRankedLists } from '../src/rrf.js';

test('RRF rewards results present in lexical and vector lists', () => {
  const result = fuseRankedLists([
    { source: 'lexical', collection: 'a', weight: 1.2, results: [
      { filepath: '/one.md', score: 0.9 },
      { filepath: '/both.md', score: 0.8 },
    ] },
    { source: 'vector', collection: 'a', weight: 1, results: [
      { filepath: '/both.md', score: 0.7 },
      { filepath: '/two.md', score: 0.6 },
    ] },
  ]);
  assert.equal(result[0].filepath, '/both.md');
  assert.equal(result[0].lexicalRank, 2);
  assert.equal(result[0].vectorRank, 1);
  assert.equal(result[0].contributions.length, 2);
});

test('list weight scales the RRF contribution', () => {
  const result = fuseRankedLists([
    { source: 'lexical', collection: 'light', weight: 0.65, results: [{ filepath: '/light.md' }] },
    { source: 'lexical', collection: 'heavy', weight: 1.2, results: [{ filepath: '/heavy.md' }] },
  ]);
  assert.equal(result[0].filepath, '/heavy.md');
});

test('results without an identity key are ignored', () => {
  const result = fuseRankedLists([
    { source: 'lexical', collection: 'a', weight: 1, results: [{ score: 1 }, { filepath: '/kept.md' }] },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].filepath, '/kept.md');
});

test('same document in multiple lists keeps its best rank per source', () => {
  const result = fuseRankedLists([
    { source: 'lexical', collection: 'a', weight: 1, results: [{ filepath: '/doc.md' }, { filepath: '/filler.md' }] },
    { source: 'lexical', collection: 'b', weight: 1, results: [{ filepath: '/doc.md' }] },
    { source: 'vector', collection: 'a', weight: 1, results: [{ filepath: '/doc.md' }] },
  ]);
  const doc = result.find((item) => item.filepath === '/doc.md');
  assert.equal(doc.lexicalRank, 1);
  assert.equal(doc.vectorRank, 1);
  assert.equal(doc.contributions.length, 3);
});

