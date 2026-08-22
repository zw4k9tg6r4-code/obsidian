import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { assertSourcePath, isPathInside } from './config.js';
import { parseMarkdown, projectForFile } from './vault.js';
import { DEFAULT_STRUCTURE, historicalPathPattern } from './structure.js';

const HIGH_IMPACT_PATTERN = /(价格|报价|金额|费用|收费|收钱|多少钱|运价|日期|状态|完成|已完成|发布|提交|上传|账号|路径|承诺|时效|截止|合同|库存|政策|权限|删除)|\b(price|pricing|cost|fee|quote|quotation|amount|deadline|due\s+date|schedule|date|status|release|deploy|submit|upload|account|password|path|contract|inventory|policy|permission|delete)\b/i;
const EXPLICIT_CONFLICT_PATTERN = /(存在冲突|互相矛盾|尚有争议|待裁决|disputed)|\b(conflict\w*|contradict\w*|inconsisten\w*|dispute\w*|disagre\w*)\b/i;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedRelative(vault, filePath) {
  return relative(vault, filePath).split(sep).join('/');
}

export function authorityForPath(relativePath, structure = DEFAULT_STRUCTURE) {
  const projectHomePattern = new RegExp(`^${escapeRegex(structure.projectsDir)}/[^/]+/${escapeRegex(structure.projectHome)}$`);
  if (relativePath === structure.vaultRuleFile) return { level: 'system-rule', score: 100 };
  if (projectHomePattern.test(relativePath)) return { level: 'project-home', score: 95 };
  if (relativePath.startsWith(`${structure.memoryDir}/`)) return { level: 'authoritative-memory', score: 92 };
  if (relativePath.includes(`/${structure.projectInputDir}/`)) return { level: 'primary-input', score: 90 };
  if (structure.homeNotes.includes(relativePath)) return { level: 'system-index', score: 85 };
  if (relativePath.includes(`/${structure.projectOutputDir}/`)) return { level: 'verified-output', score: 82 };
  if (relativePath.includes(`/${structure.projectFeedbackDir}/`)) return { level: 'feedback', score: 76 };
  if (relativePath.startsWith(`${structure.workflowDir}/`)) return { level: 'workflow', score: 75 };
  if (relativePath.includes(`/${structure.projectProcessDir}/`)) return { level: 'process', score: 45 };
  if (relativePath.startsWith(`${structure.conversationDir}/`)) return { level: 'conversation-history', score: 35 };
  return { level: 'note', score: 55 };
}

function stateFromDocument(frontmatter, text, relativePath, structure = DEFAULT_STRUCTURE) {
  const raw = String(frontmatter.state || frontmatter.fact_status || '').toLowerCase();
  if (['current', 'superseded', 'expired', 'disputed', 'candidate', 'confirmed'].includes(raw)) return raw;
  if (historicalPathPattern(structure).test(relativePath)) return 'historical';
  return 'current';
}

function queryTerms(query) {
  const normalized = String(query || '').normalize('NFKC').toLowerCase();
  const terms = new Set();
  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    for (const item of segmenter.segment(normalized)) {
      const value = item.segment.trim();
      if (item.isWordLike && value.length >= 2) terms.add(value);
    }
  } catch {
    for (const value of normalized.split(/[\s，。！？、；：,.!?;:()（）【】\[\]"']+/)) {
      if (value.length >= 2) terms.add(value);
    }
  }
  for (const number of normalized.match(/\d+(?:\.\d+)?/g) || []) terms.add(number);
  return [...terms].sort((a, b) => b.length - a.length).slice(0, 16);
}

function normalizedFactText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

// Strips ASCII and full-width thousands separators ("12,000" ≡ "12000")
// so grouped and ungrouped numerals compare as the same value.
function normalizeNumberSeparators(text) {
  return String(text || '').replace(/(\d)[,，](?=\d{3}(?!\d))/g, '$1');
}

function numericClaimsByUnit(text) {
  const claims = new Map();
  const pattern = /(\d{1,3}(?:[,，]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(万元|元|块|吨|公斤|千克|kg|托盘|件|箱|天|小时|分钟|日|号|月|%)/giu;
  for (const match of normalizeNumberSeparators(String(text || '').normalize('NFKC')).matchAll(pattern)) {
    let value = Number(match[1]);
    let unit = match[2].toLowerCase();
    if (!Number.isFinite(value)) continue;
    if (unit === '万元') {
      value *= 10_000;
      unit = 'currency-yuan';
    } else if (unit === '元' || unit === '块') {
      unit = 'currency-yuan';
    } else if (unit === '吨') {
      value *= 1_000;
      unit = 'mass-kg';
    } else if (unit === '公斤' || unit === '千克' || unit === 'kg') {
      unit = 'mass-kg';
    } else if (unit === '%') {
      unit = 'percent';
    }
    if (!claims.has(unit)) claims.set(unit, new Set());
    claims.get(unit).add(String(value));
  }
  return claims;
}

function refersToSameFact(left, right, materialTerms) {
  const leftText = normalizedFactText([left.title, left.heading, left.snippet].filter(Boolean).join('\n'));
  const rightText = normalizedFactText([right.title, right.heading, right.snippet].filter(Boolean).join('\n'));
  if (materialTerms.some((term) => {
    const normalized = normalizedFactText(term);
    return normalized.length >= 2 && leftText.includes(normalized) && rightText.includes(normalized);
  })) return true;

  const leftLabel = normalizedFactText(left.heading || left.title);
  const rightLabel = normalizedFactText(right.heading || right.title);
  return leftLabel.length >= 2 && leftLabel === rightLabel;
}

function conflictingCurrentNumericEvidence(evidence, materialTerms) {
  const current = evidence.filter((item) => item.sourceOpened && item.authorityScore >= 70 && item.state === 'current');
  const conflicts = new Set();
  for (let leftIndex = 0; leftIndex < current.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < current.length; rightIndex += 1) {
      const left = current[leftIndex];
      const right = current[rightIndex];
      if (left.projectId && right.projectId && left.projectId !== right.projectId) continue;
      if (!refersToSameFact(left, right, materialTerms)) continue;
      const leftClaims = numericClaimsByUnit(left.snippet);
      const rightClaims = numericClaimsByUnit(right.snippet);
      for (const [unit, leftValues] of leftClaims) {
        const rightValues = rightClaims.get(unit);
        if (!rightValues || [...leftValues].some((value) => rightValues.has(value))) continue;
        conflicts.add(left);
        conflicts.add(right);
        break;
      }
    }
  }
  return [...conflicts];
}

function charPositionToLine(text, position) {
  if (!Number.isFinite(position) || position < 0) return null;
  return text.slice(0, position).split(/\r?\n/).length;
}

function bestLine(lines, query, chunkPos, fullText, lineStartHint) {
  if (Number.isFinite(lineStartHint) && lineStartHint > 0) return Math.min(lineStartHint, lines.length);
  const fromChunk = charPositionToLine(fullText, chunkPos);
  if (fromChunk) return Math.min(Math.max(fromChunk, 1), lines.length);
  const terms = queryTerms(query);
  let best = { line: 1, score: -1 };
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    let score = 0;
    for (const term of terms) if (lower.includes(term)) score += term.length;
    if (/^#{1,6}\s/.test(line)) score += 0.25;
    if (score > best.score) best = { line: index + 1, score };
  });
  if (best.score > 0) return best.line;
  const firstHeading = lines.findIndex((line) => /^#\s+/.test(line));
  return firstHeading >= 0 ? firstHeading + 1 : 1;
}

function headingAt(lines, lineNumber) {
  for (let index = Math.min(lineNumber - 1, lines.length - 1); index >= 0; index -= 1) {
    const match = lines[index].match(/^#{1,6}\s+(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

function makeSnippet(lines, centerLine, radius = 3) {
  const start = Math.max(1, centerLine - radius);
  const end = Math.min(lines.length, centerLine + radius);
  const snippet = lines.slice(start - 1, end).join('\n').trim().slice(0, 600);
  return { start, end, snippet };
}

export function openEvidence(result, { vault, projects, query, matchType, structure = DEFAULT_STRUCTURE } = {}) {
  const source = assertSourcePath(vault, result.filepath);
  const fullText = readFileSync(source, 'utf8');
  const lines = fullText.split(/\r?\n/);
  const relativePath = normalizedRelative(vault, source);
  const { frontmatter } = parseMarkdown(source);
  const center = bestLine(lines, query, result.chunkPos, fullText, result.lineStartHint);
  const range = makeSnippet(lines, center);
  const authority = authorityForPath(relativePath, structure);
  const project = projectForFile(projects, source);
  const state = stateFromDocument(frontmatter, fullText, relativePath, structure);
  const contentHash = createHash('sha256').update(fullText).digest('hex');
  const sources = new Set(result.contributions?.map((item) => item.source) || []);
  return {
    path: relativePath,
    title: result.title || basename(source, extname(source)),
    heading: headingAt(lines, center),
    lineStart: range.start,
    lineEnd: range.end,
    snippet: range.snippet,
    projectId: project?.id || null,
    project: project?.name || null,
    authority: authority.level,
    authorityScore: authority.score,
    asOf: frontmatter.updated ? String(frontmatter.updated) : result.modifiedAt || null,
    effectiveAt: frontmatter.effective_at ? String(frontmatter.effective_at) : null,
    recordedAt: frontmatter.recorded_at ? String(frontmatter.recorded_at) : null,
    state,
    matchType: matchType || (sources.size > 1 ? 'hybrid' : [...sources][0] || result.source || 'unknown'),
    lexicalRank: result.lexicalRank ?? null,
    vectorRank: result.vectorRank ?? null,
    rrfScore: Number(result.rrfScore || 0),
    contentHash,
    sourceOpened: true,
    contributions: result.contributions || [],
  };
}

function walkMarkdown(dir, root = dir, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    const real = realpathSync.native(full);
    if (!isPathInside(root, real)) continue;
    if (entry.isDirectory()) walkMarkdown(real, root, output);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) output.push(real);
  }
  return output;
}

function parseWikiLinks(text) {
  const links = [];
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  for (const match of text.matchAll(pattern)) links.push(match[1].trim());
  return [...new Set(links)];
}

function resolveWikiLink(vault, projectDirectory, link) {
  const withExtension = link.toLowerCase().endsWith('.md') ? link : `${link}.md`;
  const direct = resolve(vault, withExtension.replaceAll('/', sep));
  if (existsSync(direct) && isPathInside(projectDirectory, direct)) return direct;
  const wanted = basename(withExtension).toLowerCase();
  const matches = walkMarkdown(projectDirectory).filter((file) => basename(file).toLowerCase() === wanted);
  return matches.length === 1 ? matches[0] : null;
}

export function expandLinkedEvidence(primaryEvidence, { vault, projects, scope, structure = DEFAULT_STRUCTURE, max = 2 } = {}) {
  if (scope.kind !== 'project' || max <= 0) return [];
  const output = [];
  const seen = new Set(primaryEvidence.map((item) => item.path));
  for (const evidence of primaryEvidence) {
    const sourcePath = join(vault, evidence.path.split('/').join(sep));
    const text = readFileSync(sourcePath, 'utf8');
    for (const link of parseWikiLinks(text)) {
      const resolved = resolveWikiLink(vault, scope.project.directory, link);
      if (!resolved) continue;
      const relativePath = normalizedRelative(vault, realpathSync.native(resolved));
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      const linked = openEvidence({
        filepath: resolved,
        title: basename(resolved, extname(resolved)),
        score: 0,
        rrfScore: 0,
        contributions: [],
      }, { vault, projects, query: link, matchType: 'wiki-link', structure });
      output.push(linked);
      if (output.length >= max) return output;
    }
  }
  return output;
}

export function filterTemporalEvidence(evidence, temporalIntent) {
  if (temporalIntent === 'history') return evidence;
  return evidence.filter((item) => !['superseded', 'expired', 'historical'].includes(item.state));
}

export function decideEvidence({ query, evidence, scope, indexFresh, temporalIntent = 'current' }) {
  if (scope.kind === 'ambiguous' || scope.kind === 'unknown') {
    return { decision: 'insufficient', reason: `project scope is ${scope.kind}` };
  }
  if (evidence.length === 0) return { decision: 'insufficient', reason: 'no source evidence' };
  const conflictIntent = /(冲突|矛盾|争议|不一致|裁决|风险|日期|发车|班车|哪一天|什么时候走)|\b(conflict\w*|contradict\w*|inconsisten\w*|dispute\w*|deadline|due\s+date|schedule|which\s+day)\b/i.test(query);
  const projectIdentity = [scope.project?.name, scope.project?.mainObject]
    .filter(Boolean)
    .map((item) => String(item).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));
  const genericTerms = new Set(['当前', '现在', '项目', '是否', '什么', '多少', '怎么', '参考', '情况']);
  const materialTerms = queryTerms(query).filter((term) => {
    const normalized = term.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    return normalized && !genericTerms.has(normalized)
      && !projectIdentity.some((identity) => identity.includes(normalized));
  });
  const disputed = evidence.filter((item) => item.state === 'disputed' || EXPLICIT_CONFLICT_PATTERN.test(item.snippet));
  const materialConflict = disputed.some((item) => conflictIntent
    || materialTerms.some((term) => item.snippet.normalize('NFKC').toLowerCase().includes(term.toLowerCase())));
  if (materialConflict) {
    return {
      decision: 'conflict',
      reason: 'material source evidence is disputed or conflicting',
      conflictEvidencePaths: disputed.map((item) => item.path).filter(Boolean),
    };
  }
  const numericConflicts = conflictingCurrentNumericEvidence(evidence, materialTerms);
  if (numericConflicts.length >= 2) {
    return {
      decision: 'conflict',
      reason: 'current authoritative sources disagree on the same numeric fact',
      conflictEvidencePaths: numericConflicts.map((item) => item.path).filter(Boolean),
    };
  }
  const numericClaims = [...new Set(normalizeNumberSeparators(String(query).normalize('NFKC')).match(/\d+(?:\.\d+)?/g) || [])];
  const openedText = normalizeNumberSeparators(evidence.map((item) => item.snippet).join('\n').normalize('NFKC'));
  if (numericClaims.some((number) => !openedText.includes(number))) {
    return { decision: 'insufficient', reason: 'numeric claim is not present in opened evidence' };
  }
  const highImpact = HIGH_IMPACT_PATTERN.test(query);
  const authoritative = evidence.filter((item) => item.sourceOpened && (
    temporalIntent === 'history'
      ? item.authorityScore >= 35 && ['current', 'historical', 'superseded', 'expired'].includes(item.state)
      : item.authorityScore >= 70 && item.state === 'current'
  ));
  if (highImpact && authoritative.length === 0) {
    return { decision: 'insufficient', reason: 'high-impact question lacks current authoritative evidence' };
  }
  if (!indexFresh && authoritative.length === 0) {
    return { decision: 'insufficient', reason: 'degraded index and no authoritative lexical evidence' };
  }
  return {
    decision: 'grounded',
    reason: temporalIntent === 'history'
      ? 'historical source opened for explicit history intent'
      : (highImpact ? 'current authoritative source opened' : 'source evidence opened'),
  };
}
