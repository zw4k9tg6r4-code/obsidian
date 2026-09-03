import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { isPathInside } from './config.js';
import { inCollection, isSkippedVaultEntry } from './vault.js';

function walkMarkdown(root, vault, output = []) {
  if (!existsSync(root)) return output;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (isSkippedVaultEntry(entry.name)) continue;
    const full = join(root, entry.name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkMarkdown(full, vault, output);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const real = realpathSync.native(full);
      if (isPathInside(vault, real)) output.push({ logical: full, real });
    }
  }
  return output;
}

function safeSlice(str, start, length) {
  if (length <= 0) length = 1;
  let end = start + length;
  if (end >= str.length) return str.slice(start);
  const code = str.charCodeAt(end - 1);
  if (code >= 0xD800 && code <= 0xDBFF) {
    end -= 1;
  }
  if (end <= start) {
    end = start + Math.min(str.length - start, Math.max(1, length + 1));
  }
  return str.slice(start, end);
}

export function chunkMarkdown(text, { maxChars = 2400, overlapLines = 2 } = {}) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const chunks = [];
  let contentStart = 0;
  if (lines[0]?.trim() === '---') {
    const closing = lines.slice(1).findIndex((line) => line.trim() === '---');
    if (closing >= 0) contentStart = closing + 2;
  }
  let start = contentStart;
  let current = [];
  let currentLength = 0;
  let hasContent = false;
  let activeFence = null;

  const flush = (keepOverlap = false) => {
    if (!current.length) return;
    const value = current.join('\n').trim();
    if (value) chunks.push({ startLine: start + 1, endLine: start + current.length, text: value });
    const overlap = keepOverlap ? current.slice(Math.max(0, current.length - overlapLines)) : [];
    start += current.length - overlap.length;
    current = overlap;
    currentLength = overlap.join('\n').length;
    hasContent = overlap.some((item) => item.trim());
  };

  lines.slice(contentStart).forEach((line, offset) => {
    const index = contentStart + offset;
    const trimmed = line.trim();

    if (activeFence) {
      const closeMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closeMatch && closeMatch[1][0] === activeFence.char && closeMatch[1].length >= activeFence.length) {
        activeFence = null;
      }
    } else {
      const openMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
      if (openMatch) {
        const charType = openMatch[1][0];
        const fenceLen = openMatch[1].length;
        const rest = openMatch[2];
        if (charType === '~' || !rest.includes('`')) {
          activeFence = { char: charType, length: fenceLen };
        }
      }
    }

    if (line.length > maxChars) {
      flush(false);
      let cursor = 0;
      while (cursor < line.length) {
        const slice = safeSlice(line, cursor, maxChars);
        chunks.push({ startLine: index + 1, endLine: index + 1, text: slice });
        cursor += slice.length;
      }
      start = index + 1;
      return;
    }
    const inCodeBlock = activeFence !== null;
    const headingBoundary = !inCodeBlock && /^#{1,3}\s+/.test(line) && hasContent;
    if (headingBoundary) flush(false);
    else if (currentLength + line.length + 1 > maxChars && current.length > overlapLines) flush(true);
    if (current.length === 0) start = index;
    current.push(line);
    currentLength += line.length + 1;
    if (trimmed) hasContent = true;
  });
  flush(false);
  return chunks;
}

export function collectSemanticChunks(vault, collections) {
  const canonicalVault = realpathSync.native(vault);
  const canonicalCollections = collections.map((collection) => ({
    ...collection,
    path: realpathSync.native(collection.path),
  }));
  const files = walkMarkdown(canonicalVault, canonicalVault);
  const records = [];
  for (const file of files) {
    const memberships = canonicalCollections.filter((collection) => inCollection(file.real, collection)).map((collection) => collection.name);
    if (memberships.length === 0) continue;
    const text = readFileSync(file.real, 'utf8');
    const sourceHash = createHash('sha256').update(text).digest('hex');
    // Preserve the logical, user-visible path. On Windows, realpath can use an
    // 8.3 alias for a temporary directory while traversal returns the long
    // path; mixing those representations can exclude every file or produce a
    // prefixed relative path.
    const relativePath = relative(canonicalVault, file.logical).split(sep).join('/');
    const textOccurrences = new Map();
    for (const [index, chunk] of chunkMarkdown(text).entries()) {
      const chunkTextHash = createHash('sha256').update(chunk.text).digest('hex');
      const occ = textOccurrences.get(chunkTextHash) || 0;
      textOccurrences.set(chunkTextHash, occ + 1);
      const id = createHash('sha256').update(`${relativePath}\0${chunkTextHash}\0${occ}`).digest('hex');
      records.push({
        id,
        sourcePath: file.real,
        relativePath,
        title: basename(file.logical, '.md'),
        collections: memberships,
        sourceHash,
        chunkTextHash,
        chunkIndex: index,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
      });
    }
  }
  return records;
}
