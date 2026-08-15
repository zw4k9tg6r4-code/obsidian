import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeConfig } from '../src/config.js';
import { indexVault } from '../src/qmd-adapter.js';
import { searchSecondBrain } from '../src/retrieval.js';
import { activateCandidate, addCandidate, confirmCandidate } from '../src/candidates.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'test', 'fixtures', 'vault');
const questionsPath = join(root, 'test', 'eval', 'questions.jsonl');
const args = new Set(process.argv.slice(2));
const semantic = args.has('--semantic');
const dataArgIndex = process.argv.indexOf('--data-dir');
const requestedData = dataArgIndex >= 0 ? process.argv[dataArgIndex + 1] : null;
const dataDir = requestedData
  ? (isAbsolute(requestedData) ? requestedData : resolve(root, requestedData))
  : mkdtempSync(join(tmpdir(), 'sbrain-eval-index-'));

const questions = readFileSync(questionsPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
if (questions.length !== 40) throw new Error(`Expected 40 evaluation cases, found ${questions.length}.`);

const searchConfig = resolveRuntimeConfig({ vault: fixture, dataDir });
await indexVault(searchConfig, { semantic });

function includesPath(items, suffix) {
  return items.some((item) => item.path.endsWith(suffix));
}

function assertResult(condition, message) {
  if (!condition) throw new Error(message);
}

function runCandidateCase(operation) {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'sbrain-eval-candidate-'));
  const vault = join(sandboxRoot, 'vault');
  cpSync(fixture, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir: join(sandboxRoot, 'data') });
  const content = `候选评测事实-${operation}`;
  const first = addCandidate(config, { content, scope: '北辰仓配项目' });
  if (operation === 'add') return first.record.status === 'candidate';
  if (operation === 'deduplicate') return addCandidate(config, { content, scope: '北辰仓配项目' }).created === false;
  if (operation === 'reject-self-confirm') {
    try { confirmCandidate(config, { id: first.record.id }); } catch { return true; }
    return false;
  }
  if (operation === 'user-confirm') {
    return confirmCandidate(config, { id: first.record.id, userConfirmed: true }).status === 'confirmed';
  }
  if (operation === 'reject-bad-activate') {
    confirmCandidate(config, { id: first.record.id, userConfirmed: true });
    const target = join(vault, '02-项目', '北辰仓配项目', '项目主页.md');
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n${content}\n`, 'utf8');
    try {
      activateCandidate(config, { id: first.record.id, targetPath: target, expectedHash: createHash('sha256').update('wrong').digest('hex') });
    } catch { return true; }
    return false;
  }
  return false;
}

const results = [];
for (const question of questions) {
  const started = performance.now();
  try {
    if (question.type === 'candidate') {
      assertResult(runCandidateCase(question.operation), `candidate operation failed: ${question.operation}`);
    } else {
      const result = await searchSecondBrain({
        vault: fixture,
        dataDir,
        query: question.query,
        projectName: question.project,
        temporalIntent: question.time || 'current',
        maxEvidence: question.maxEvidence,
        maxRelated: question.maxRelated,
        lexicalOnly: !semantic,
      });
      const expectedDecision = semantic
        ? (question.semanticExpectDecision || question.expectDecision)
        : (question.lexicalExpectDecision || question.expectDecision);
      if (expectedDecision) assertResult(result.decision === expectedDecision, `decision ${result.decision}, expected ${expectedDecision}`);
      if (question.expectScope) assertResult(result.scope.kind === question.expectScope, `scope ${result.scope.kind}, expected ${question.expectScope}`);
      const allEvidence = [...result.evidence, ...result.relatedEvidence];
      if (question.expectPath) assertResult(includesPath(allEvidence, question.expectPath), `missing path ${question.expectPath}`);
      if (question.semanticOnlyPath && semantic) assertResult(includesPath(allEvidence, question.semanticOnlyPath), `missing semantic path ${question.semanticOnlyPath}`);
      if (question.expectRelated) assertResult(includesPath(result.relatedEvidence, question.expectRelated), `missing related path ${question.expectRelated}`);
      if (question.forbidPath) assertResult(!allEvidence.some((item) => item.path.includes(question.forbidPath)), `forbidden path ${question.forbidPath}`);
      assertResult(result.evidence.length <= 4, 'primary evidence exceeds four');
      assertResult(result.relatedEvidence.length <= 2, 'related evidence exceeds two');
      assertResult(allEvidence.every((item) => !isAbsolute(item.path)), 'absolute evidence path leaked');
      assertResult(!JSON.stringify(result.scope).includes(fixture), 'absolute scope path leaked');
      assertResult(allEvidence.every((item) => Number.isInteger(item.lineStart) && item.lineStart >= 1), 'invalid source line');
    }
    results.push({ id: question.id, category: question.category, passed: true, elapsedMs: Math.round(performance.now() - started) });
  } catch (error) {
    results.push({ id: question.id, category: question.category, passed: false, error: String(error?.message || error), elapsedMs: Math.round(performance.now() - started) });
  }
}

const categories = {};
for (const item of results) {
  categories[item.category] ||= { passed: 0, total: 0 };
  categories[item.category].total += 1;
  if (item.passed) categories[item.category].passed += 1;
}
const elapsed = results.map((item) => item.elapsedMs).sort((a, b) => a - b);
const report = {
  schemaVersion: 1,
  mode: semantic ? 'hybrid' : 'lexical',
  passed: results.filter((item) => item.passed).length,
  total: results.length,
  passRate: results.filter((item) => item.passed).length / results.length,
  p95Ms: elapsed[Math.max(0, Math.ceil(elapsed.length * 0.95) - 1)],
  categories,
  failures: results.filter((item) => !item.passed),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.passed !== report.total) process.exitCode = 1;
