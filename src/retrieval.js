import { performance } from 'node:perf_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveRuntimeConfig, toVaultRelative } from './config.js';
import { assertSafeVaultTree, discoverProjects, resolveProjectScope, collectionsForScope } from './vault.js';
import { readHealth, lexicalSearch, vectorSearch, withStore, lexicalVariants } from './qmd-adapter.js';
import { fuseRankedLists } from './rrf.js';
import {
  decideEvidence,
  expandLinkedEvidence,
  filterTemporalEvidence,
  openEvidence,
} from './evidence.js';
import { recordSearchAudit, redactLocalPaths } from './audit.js';

export function publicScope(scope) {
  return {
    kind: scope.kind,
    project: scope.project ? {
      id: scope.project.id,
      name: scope.project.name,
      status: scope.project.status,
      updated: scope.project.updated,
    } : null,
    candidates: (scope.candidates || []).map(({ id, name, status }) => ({ id, name, status })),
  };
}

function boundedCount(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric option: ${String(value)}`);
  return Math.max(minimum, Math.min(Math.trunc(parsed), maximum));
}

function runInMemoryOverlay(dirtyFilesInScope, query) {
  const overlayResults = [];
  const variants = lexicalVariants(query);
  for (const d of dirtyFilesInScope) {
    if (d.status === 'deleted') continue;
    let text = d.text;
    if (!text && d.fullPath && existsSync(d.fullPath)) {
      try { text = readFileSync(d.fullPath, 'utf8'); } catch {}
    }
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    let bestScore = 0;
    let bestLine = 1;
    let lineFound = false;
    for (const variant of variants) {
      const term = variant.query.toLowerCase();
      lines.forEach((line, idx) => {
        if (line.toLowerCase().includes(term)) {
          bestScore += (term.length * variant.weight);
          if (!lineFound) {
            bestLine = idx + 1;
            lineFound = true;
          }
        }
      });
    }
    const threshold = variants.length > 1 ? 2.5 : 1.0;
    if (bestScore >= threshold) {
      overlayResults.push({
        filepath: d.fullPath,
        displayPath: d.path,
        title: basename(d.path, '.md'),
        score: bestScore,
        lineStartHint: bestLine,
        source: 'overlay',
      });
    }
  }
  overlayResults.sort((a, b) => b.score - a.score);
  return overlayResults;
}

function safeVaultRelative(vaultRoot, filePath) {
  if (!filePath) return null;
  try {
    const rel = relative(resolve(vaultRoot), resolve(filePath));
    if (rel === '') return '';
    if (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) {
      return rel.split(sep).join('/');
    }
  } catch {}
  return null;
}

export async function searchSecondBrain(options) {
  const started = performance.now();
  const query = String(options.query || '').trim();
  if (!query) throw new Error('Search query is required.');
  const temporalIntent = options.temporalIntent === 'history' ? 'history' : 'current';
  const maxEvidence = boundedCount(options.maxEvidence, 4, 1, 4);
  const config = resolveRuntimeConfig(options);
  assertSafeVaultTree(config.vault);
  const projects = discoverProjects(config.vault, config.structure);
  const scope = resolveProjectScope(projects, { projectName: options.projectName, query });

  if (scope.kind === 'ambiguous' || scope.kind === 'unknown') {
    const result = {
      schemaVersion: 1,
      decision: 'insufficient',
      reason: `project scope is ${scope.kind}`,
      degraded: false,
      degradedReason: null,
      indexFresh: false,
      scope: publicScope(scope),
      temporalIntent,
      evidence: [],
      relatedEvidence: [],
      conflicts: [],
      elapsedMs: Math.round(performance.now() - started),
    };
    result.traceId = recordSearchAudit(config, { query, ...result });
    return result;
  }

  if (scope.kind === 'project' && scope.project.status === 'archived' && temporalIntent === 'current') {
    const result = {
      schemaVersion: 1,
      decision: 'insufficient',
      reason: 'project is archived; use explicit history intent to retrieve it',
      degraded: false,
      degradedReason: null,
      indexFresh: false,
      scope: publicScope(scope),
      temporalIntent,
      evidence: [],
      relatedEvidence: [],
      conflicts: [],
      elapsedMs: Math.round(performance.now() - started),
    };
    result.traceId = recordSearchAudit(config, { query, ...result });
    return result;
  }

  // Opening the lexical store would create the database as a side effect, so an
  // initialized index (database plus metadata from a successful `sbrain index`)
  // must be confirmed before any store is opened on the read-only search path.
  if (!existsSync(config.dbPath) || !existsSync(config.metadataPath)) {
    const result = {
      schemaVersion: 1,
      decision: 'insufficient',
      reason: 'index is not initialized; run sbrain index',
      degraded: true,
      degradedReason: existsSync(config.dbPath) ? 'index metadata is missing' : 'index database is missing',
      indexFresh: false,
      scope: publicScope(scope),
      temporalIntent,
      evidence: [],
      relatedEvidence: [],
      conflicts: [],
      elapsedMs: Math.round(performance.now() - started),
    };
    result.traceId = recordSearchAudit(config, { query, ...result });
    return result;
  }

  const collectionNames = collectionsForScope(scope, temporalIntent);
  const searchErrors = [];
  const outcome = await withStore(config, async ({ store }) => {
    const health = await readHealth(config, { store });
    if (!health.indexed) return { notIndexed: health };
    const lists = await lexicalSearch(config, query, collectionNames, Number(options.candidateLimit || 20), {
      store,
      onSearchError: (message) => searchErrors.push(redactLocalPaths(message, config.vault, config.dataDir)),
    });
    return { health, lists };
  });
  if (outcome.notIndexed) {
    const result = {
      schemaVersion: 1,
      decision: 'insufficient',
      reason: 'index is not initialized; run sbrain index',
      degraded: true,
      degradedReason: outcome.notIndexed.reason,
      indexFresh: false,
      scope: publicScope(scope),
      temporalIntent,
      evidence: [],
      relatedEvidence: [],
      conflicts: [],
      elapsedMs: Math.round(performance.now() - started),
    };
    result.traceId = recordSearchAudit(config, { query, ...result });
    return result;
  }
  const { health, lists } = outcome;

  // Filter dirty files that belong specifically to the current search scope's collections
  const dirtyFilesInScope = (health.dirtyFiles || []).filter((d) => d.collections.some((c) => collectionNames.includes(c)));
  const scopeLexicalFresh = dirtyFilesInScope.length === 0;
  const dirtyVaultPaths = new Set(dirtyFilesInScope.map((d) => d.path.split('\\').join('/')));

  // Filter out any dirty paths from QMD lexical lists so stale lexical results don't pollute RRF
  const cleanLexicalLists = lists.map((l) => ({
    ...l,
    results: l.results.filter((r) => {
      const relPath = (r.displayPath || '').split('\\').join('/');
      const vaultRel = safeVaultRelative(config.vault, r.filepath);
      const isFileDeleted = r.filepath ? !existsSync(r.filepath) : false;
      const isDirty = isFileDeleted
        || dirtyVaultPaths.has(relPath)
        || (vaultRel && dirtyVaultPaths.has(vaultRel))
        || dirtyFilesInScope.some((d) => relPath === d.path || relPath.endsWith('/' + d.path) || d.path.endsWith('/' + relPath));
      return !isDirty;
    }),
  }));
  const allLists = [...cleanLexicalLists];

  // Run in-memory overlay for unindexed dirty files in scope
  if (dirtyFilesInScope.length > 0) {
    const overlayResults = runInMemoryOverlay(dirtyFilesInScope, query);
    if (overlayResults.length > 0) {
      allLists.push({
        source: 'overlay',
        collection: 'overlay-scope',
        weight: 1.3,
        results: overlayResults,
      });
    }
  }

  let semanticFailure = null;
  if (health.semanticHealthy && options.lexicalOnly !== true) {
    const semantic = await vectorSearch(config, query, collectionNames, Number(options.candidateLimit || 20), {
      excludePaths: [...dirtyVaultPaths],
    });
    if (semantic.ok) {
      const filteredVectorLists = semantic.lists.map((l) => ({
        ...l,
        results: l.results.filter((r) => {
          const relPath = (r.displayPath || '').split('\\').join('/');
          const vaultRel = safeVaultRelative(config.vault, r.filepath);
          const isFileDeleted = r.filepath ? !existsSync(r.filepath) : false;
          const isDirty = isFileDeleted
            || dirtyVaultPaths.has(relPath)
            || (vaultRel && dirtyVaultPaths.has(vaultRel))
            || dirtyFilesInScope.some((d) => relPath.endsWith(d.path) || d.path.endsWith(relPath));
          return !isDirty;
        }),
      }));
      allLists.push(...filteredVectorLists);
    } else {
      semanticFailure = redactLocalPaths(semantic.reason, config.vault, config.dataDir);
    }
  }

  const fused = fuseRankedLists(allLists);
  const opened = [];
  const sourceErrors = [...searchErrors];
  for (const result of fused) {
    try {
      opened.push(openEvidence(result, { vault: config.vault, projects, query, structure: config.structure }));
    } catch (error) {
      sourceErrors.push(redactLocalPaths(String(error?.message || error), config.vault, config.dataDir));
    }
    if (opened.length >= Math.max(maxEvidence * 3, 8)) break;
  }
  const temporalEvidence = filterTemporalEvidence(opened, temporalIntent);
  const filtered = temporalEvidence.slice(0, maxEvidence);
  const expandedRelatedEvidence = expandLinkedEvidence(filtered, {
    vault: config.vault,
    projects,
    scope,
    structure: config.structure,
    max: boundedCount(options.maxRelated, 2, 0, 2),
  });
  const relatedEvidence = filterTemporalEvidence(expandedRelatedEvidence, temporalIntent);

  const indexFresh = scopeLexicalFresh;
  const assessmentEvidence = [...filtered, ...relatedEvidence];
  const broaderAssessmentEvidence = [...temporalEvidence, ...relatedEvidence];
  const broaderAssessment = decideEvidence({
    query,
    evidence: broaderAssessmentEvidence,
    scope,
    indexFresh,
    temporalIntent,
  });
  const assessment = broaderAssessment.decision === 'conflict'
    ? broaderAssessment
    : decideEvidence({ query, evidence: assessmentEvidence, scope, indexFresh, temporalIntent });

  const semanticDegraded = !options.lexicalOnly && !health.semanticHealthy;
  const degraded = Boolean(
    !scopeLexicalFresh ||
    semanticFailure ||
    sourceErrors.length ||
    semanticDegraded ||
    (health.degraded && !options.lexicalOnly)
  );
  const degradedReason = semanticFailure
    || (sourceErrors.length ? `${sourceErrors.length} source result(s) rejected` : null)
    || (!scopeLexicalFresh ? `${dirtyFilesInScope.length} unindexed file(s) in scope` : null)
    || (semanticDegraded ? (health.reason || 'local semantic index is missing or stale') : null)
    || (health.degraded && !options.lexicalOnly ? health.reason : null);
  const conflictEvidencePaths = new Set(assessment.conflictEvidencePaths || []);
  const result = {
    schemaVersion: 1,
    decision: assessment.decision,
    reason: assessment.reason,
    degraded,
    degradedReason: degradedReason || null,
    indexFresh,
    vectorCoverage: health.vectorCoverage,
    scope: publicScope(scope),
    temporalIntent,
    evidence: filtered,
    relatedEvidence,
    conflicts: assessment.decision === 'conflict'
      ? broaderAssessmentEvidence.filter((item) => item.state === 'disputed' || conflictEvidencePaths.has(item.path))
      : [],
    elapsedMs: Math.round(performance.now() - started),
  };
  result.traceId = recordSearchAudit(config, { query, ...result });
  return result;
}
