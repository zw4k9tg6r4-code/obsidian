import { performance } from 'node:perf_hooks';
import { existsSync } from 'node:fs';
import { resolveRuntimeConfig } from './config.js';
import { assertSafeVaultTree, discoverProjects, resolveProjectScope, collectionsForScope } from './vault.js';
import { readHealth, lexicalSearch, vectorSearch, withStore } from './qmd-adapter.js';
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
  let semanticFailure = null;
  if (health.semanticHealthy && options.lexicalOnly !== true) {
    const semantic = await vectorSearch(config, query, collectionNames, Number(options.candidateLimit || 20));
    if (semantic.ok) lists.push(...semantic.lists);
    else semanticFailure = redactLocalPaths(semantic.reason, config.vault, config.dataDir);
  }

  const fused = fuseRankedLists(lists);
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
  const relatedEvidence = expandLinkedEvidence(filtered, {
    vault: config.vault,
    projects,
    scope,
    structure: config.structure,
    max: boundedCount(options.maxRelated, 2, 0, 2),
  });
  const indexFresh = health.indexFresh === true;
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
  const degraded = Boolean(health.degraded || semanticFailure || sourceErrors.length);
  const degradedReason = semanticFailure
    || (sourceErrors.length ? `${sourceErrors.length} source result(s) rejected` : health.reason);
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
