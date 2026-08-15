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

