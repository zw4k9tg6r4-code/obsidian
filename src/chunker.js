import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { isPathInside } from './config.js';

function walkMarkdown(root, vault, output = []) {
  if (!existsSync(root)) return output;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkMarkdown(full, vault, output);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const real = realpathSync.native(full);
      if (isPathInside(vault, real)) output.push(real);
    }
  }
  return output;
}

function inCollection(file, collection) {
  if (!isPathInside(collection.path, file)) return false;
  const rel = relative(collection.path, file).split(sep).join('/');
  if (collection.pattern.startsWith('{')) {
    const names = collection.pattern.slice(1, -1).split(',');
    if (!names.includes(rel)) return false;
  } else if (!rel.toLowerCase().endsWith('.md')) {
    return false;
  }
  for (const ignore of collection.ignore || []) {
    const prefix = ignore.replace(/\*\*.*$/, '').replace(/\/$/, '');
    if (prefix && (rel === prefix || rel.startsWith(`${prefix}/`))) return false;
  }
  return true;
}

export function chunkMarkdown(text, { maxChars = 2400, overlapLines = 2 } = {}) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let contentStart = 0;
  if (lines[0]?.trim() === '---') {
    const closing = lines.slice(1).findIndex((line) => line.trim() === '---');
    if (closing >= 0) contentStart = closing + 2;
  }
  let start = contentStart;
  let current = [];
  let currentLength = 0;

  const flush = (keepOverlap = false) => {
    if (!current.length) return;
    const value = current.join('\n').trim();
    if (value) chunks.push({ startLine: start + 1, endLine: start + current.length, text: value });
    const overlap = keepOverlap ? current.slice(Math.max(0, current.length - overlapLines)) : [];
    start += current.length - overlap.length;
    current = overlap;
    currentLength = overlap.join('\n').length;
  };

  lines.slice(contentStart).forEach((line, offset) => {
    const index = contentStart + offset;
    const headingBoundary = /^#{1,3}\s+/.test(line) && current.some((item) => item.trim());
    if (headingBoundary) flush(false);
    else if (currentLength + line.length + 1 > maxChars && current.length > overlapLines) flush(true);
    if (current.length === 0) start = index;
    current.push(line);
    currentLength += line.length + 1;
  });
  flush(false);
  return chunks;
}

export function collectSemanticChunks(vault, collections) {
  const files = walkMarkdown(vault, vault);
  const records = [];
  for (const file of files) {
    const memberships = collections.filter((collection) => inCollection(file, collection)).map((collection) => collection.name);
    if (memberships.length === 0) continue;
    const text = readFileSync(file, 'utf8');
    const sourceHash = createHash('sha256').update(text).digest('hex');
    const relativePath = relative(vault, file).split(sep).join('/');
    for (const [index, chunk] of chunkMarkdown(text).entries()) {
      records.push({
        id: createHash('sha256').update(`${relativePath}\0${sourceHash}\0${index}`).digest('hex'),
        sourcePath: file,
        relativePath,
        title: basename(file, '.md'),
        collections: memberships,
        sourceHash,
        chunkIndex: index,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
      });
    }
  }
  return records;
}
