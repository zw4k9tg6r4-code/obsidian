import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown } from '../src/chunker.js';

test('P2-04: CommonMark code fences do not close on lines with info strings and split correctly on real boundaries', () => {
  const markdown = [
    '# 文档开始',
    '第一段前言内容。',
    '```markdown',
    '这里是 markdown 代码块内部',
    '# 这个标题在代码块内部不应作为切块边界',
    '```',
    '# 文档结束后的真正标题',
    '外部独立内容。',
  ].join('\n');

  const chunks = chunkMarkdown(markdown);
  assert.equal(chunks.length, 2, 'Markdown with 1 outer code block and 2 top headings should produce 2 chunks');

  // Chunk 1 starts at line 1 and includes the code block
  assert.ok(chunks[0].text.startsWith('# 文档开始'));
  assert.ok(chunks[0].text.includes('# 这个标题在代码块内部不应作为切块边界'));

  // Chunk 2 starts precisely at line 7 with the outer heading
  assert.ok(chunks[1].text.startsWith('# 文档结束后的真正标题'));
  assert.equal(chunks[1].startLine, 7);
});

test('P2-04: 4-backtick code fence requires 4 or more backticks to close', () => {
  const markdown = [
    '# 四反引号代码块',
    '````markdown',
    '```js',
    '# 3反引号内的标题',
    '```',
    '````',
    '# 外部新标题',
    '外部内容。',
  ].join('\n');

  const chunks = chunkMarkdown(markdown);
  assert.equal(chunks.length, 2, 'Should produce 2 chunks');

  const innerChunk = chunks.find((c) => c.text.startsWith('# 3反引号内的标题'));
  assert.equal(innerChunk, undefined, '3-backtick fence inside 4-backtick fence must not close outer block');

  assert.ok(chunks[1].text.startsWith('# 外部新标题'));
  assert.equal(chunks[1].startLine, 7);
});

test('P2-04: Tilde fences ~~~ handle nested backticks and close only on matching tildes', () => {
  const markdown = [
    '# 波浪线代码块',
    '~~~python',
    '```',
    '# 伪反引号标题',
    '```',
    '~~~',
    '# 真正外层标题',
    '外层文字。',
  ].join('\n');

  const chunks = chunkMarkdown(markdown);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].text.includes('# 伪反引号标题'));
  assert.ok(chunks[1].text.startsWith('# 真正外层标题'));
  assert.equal(chunks[1].startLine, 7);
});

test('P2-04: Unclosed code fences do not split on subsequent markdown headings', () => {
  const markdown = [
    '# 起始标题',
    '```javascript',
    'const x = 1;',
    '# 代码块未闭合时的标题',
    'const y = 2;',
  ].join('\n');

  const chunks = chunkMarkdown(markdown);
  assert.equal(chunks.length, 1, 'Unclosed fence must keep all subsequent headings inside the single chunk');
  assert.ok(chunks[0].text.includes('# 代码块未闭合时的标题'));
});

test('P2-04: safeSlice handles surrogate pairs and tiny limits without unpaired surrogates', () => {
  const emojiLine = '你好世界🌟🎉🚀🔥'.repeat(10);
  const chunks = chunkMarkdown(emojiLine, { maxChars: 5 });
  assert.ok(chunks.length > 0);

  // Check that every chunk contains valid UTF-16 code units with no unpaired surrogates
  for (const chunk of chunks) {
    assert.ok(chunk.text.length > 0);
    assert.equal(chunk.text.includes('\uFFFD'), false);

    // Strict regex checking for unpaired high or low surrogates
    const hasUnpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk.text);
    assert.equal(hasUnpairedSurrogate, false, `Chunk must not contain unpaired surrogates: ${chunk.text}`);
  }
});
