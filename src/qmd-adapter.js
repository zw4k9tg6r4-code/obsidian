import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { assertSafeVaultTree, buildCollections, collectTrackedFiles, detectVaultChanges, discoverProjects, qmdConfig, resolveProjectScope, vaultStats } from './vault.js';
import { writeJsonAtomic } from './io.js';
import { indexSemantic, searchSemantic, syncSemantic, SEMANTIC_MODEL } from './semantic-adapter.js';
import { acquireSyncLock, isSyncLockActive, withSyncLock } from './lock.js';

export const QMD_VERSION = '2.5.3';

export function publicHealth(health) {
  return {
    schemaVersion: 2,
    indexed: health.indexed,
    current: health.current,
    history: health.history,
    overall: health.overall,
    // Deprecated backward-compatible fields mapped to current.*
    indexFresh: health.indexFresh ?? false,
    semanticHealthy: health.semanticHealthy ?? false,
    vectorCoverage: health.vectorCoverage ?? 0,
    degraded: health.degraded ?? false,
    reason: health.reason || null,
    qmdVersion: health.qmdVersion || QMD_VERSION,
    indexedAt: health.indexedAt || null,
    semanticModel: health.semanticModel || null,
  };
}

function prepareQmdEnvironment(dataDir) {
  process.env.XDG_CACHE_HOME = dataDir;
  process.env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = 'true';
  if (process.env.SECOND_BRAIN_USE_GPU !== '1') process.env.QMD_FORCE_CPU = '1';
}

async function openStore(config) {
  prepareQmdEnvironment(config.dataDir);
  const { createStore } = await import('@tobilu/qmd');
  const projects = discoverProjects(config.vault, config.structure);
  const collections = buildCollections(config.vault, projects, config.structure);
  const store = await createStore({
    dbPath: config.dbPath,
    config: qmdConfig(config.vault, collections),
  });
  return { store, projects, collections };
}

// Opens the index once for a compound read (health + search) instead of paying
// the store open/close cost for every helper call.
export async function withStore(config, fn) {
  const context = await openStore(config);
  try {
    return await fn(context);
  } finally {
    await context.store.close();
  }
}

function materializeResults(results, collectionName, collections) {
  const definition = collections.find((item) => item.name === collectionName);
  if (!definition) return [];
  return results.map((result) => {
    const prefix = `${collectionName}/`;
    const relativePath = result.displayPath?.startsWith(prefix)
      ? result.displayPath.slice(prefix.length)
      : result.displayPath;
    return {
      ...result,
      qmdUri: result.filepath,
      filepath: join(definition.path, ...String(relativePath || '').split('/')),
    };
  });
}

export function lexicalVariants(query) {
  const variants = [{ query, weight: 1.2, label: 'original' }];
  const stop = new Set(['什么', '怎么', '如何', '是否', '多少', '目前', '现在', '当前', '一下', '这个', '那个', '存在']);
  const terms = [];
  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    for (const item of segmenter.segment(String(query).normalize('NFKC'))) {
      const term = item.segment.trim();
      if (item.isWordLike && term.length >= 2 && !stop.has(term)) terms.push(term);
    }
  } catch {
    terms.push(...String(query).split(/[^\p{L}\p{N}.]+/gu).filter((term) => term.length >= 2 && !stop.has(term)));
  }
  for (const number of String(query).match(/\d+(?:\.\d+)?/g) || []) terms.push(number);
  const unique = [...new Set(terms)].slice(0, 12);
  if (unique.length > 1) unique.slice(0, 8).forEach((term, index) => {
    variants.push({ query: term, weight: 0.65, label: `term-${index + 1}` });
  });
  return variants;
}

export async function indexVault(config, { semantic = false } = {}) {
  assertSafeVaultTree(config.vault);
  const startedAt = Date.now();
  const generationId = `gen-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const { store, projects, collections } = await openStore(config);
  let update;
  try {
    update = await store.update();
  } finally {
    await store.close();
  }

  const fingerprint = vaultStats(config.vault);
  let semanticResult = { ok: false, skipped: true, reason: 'semantic indexing not requested' };
  if (semantic) {
    semanticResult = await indexSemantic(config, collections, fingerprint);
  }

  const trackedFiles = collectTrackedFiles(config.vault, collections);
  const filesMap = {};
  for (const item of trackedFiles) {
    const text = readFileSync(item.fullPath, 'utf8');
    const contentHash = createHash('sha256').update(text).digest('hex');
    filesMap[item.rel] = {
      size: item.size,
      mtimeMs: item.mtimeMs,
      contentHash,
      collections: item.collections,
      timeScope: item.timeScope,
      generation: generationId,
    };
  }

  const metadata = {
    schemaVersion: 2,
    qmdVersion: QMD_VERSION,
    generationId,
    indexedAt: new Date().toISOString(),
    files: filesMap,
    vaultFingerprint: fingerprint,
    projectCount: projects.length,
    collectionCount: collections.length,
    semanticRequested: semantic,
    semanticReady: semanticResult.ok === true,
    semanticReason: semanticResult.ok ? null : semanticResult.reason,
  };
  writeJsonAtomic(config.metadataPath, metadata);
  return {
    ok: true,
    update,
    semantic: semanticResult,
    metadata,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function syncVault(config, {
  projectName,
  temporalIntent = 'current',
  semanticMode = 'auto',
  budgetMs = 10000,
  _testHookAfterSnapshot,
} = {}) {
  assertSafeVaultTree(config.vault);
  const startedAt = Date.now();

  return withSyncLock(config, { timeoutMs: budgetMs, mode: semanticMode }, async (lock) => {
    const projects = discoverProjects(config.vault, config.structure);
    const collections = buildCollections(config.vault, projects, config.structure);

    let targetCollectionNames = [];
    if (projectName) {
      const scope = resolveProjectScope(projects, { projectName });
      if (scope.kind === 'project') {
        if (temporalIntent === 'current') {
          targetCollectionNames = ['global-governance', 'global-workflows', `${scope.project.id}-current`];
        } else if (temporalIntent === 'history') {
          targetCollectionNames = ['global-governance', 'global-workflows', `${scope.project.id}-current`, `${scope.project.id}-history`];
        } else {
          targetCollectionNames = ['global-governance', 'global-workflows', `${scope.project.id}-current`, `${scope.project.id}-history`];
        }
      } else {
        throw new Error(`Cannot sync unknown or ambiguous project: ${projectName}`);
      }
    } else {
      if (temporalIntent === 'current') {
        targetCollectionNames = collections.filter((c) => !c.name.endsWith('-history') && c.name !== 'global-history').map((c) => c.name);
      } else if (temporalIntent === 'history') {
        targetCollectionNames = collections.map((c) => c.name);
      } else {
        targetCollectionNames = collections.map((c) => c.name);
      }
    }

    let metadata = null;
    if (existsSync(config.metadataPath)) {
      try { metadata = JSON.parse(readFileSync(config.metadataPath, 'utf8')); } catch { metadata = null; }
    }
    const metaFiles = metadata?.files || {};

    // Snapshot tracked files BEFORE sync
    const trackedBeforeSync = collectTrackedFiles(config.vault, collections);
    const snapshotBefore = new Map();
    for (const item of trackedBeforeSync) {
      const text = readFileSync(item.fullPath, 'utf8');
      const hash = createHash('sha256').update(text).digest('hex');
      snapshotBefore.set(item.rel, { ...item, contentHash: hash });
    }

    if (typeof _testHookAfterSnapshot === 'function') {
      await _testHookAfterSnapshot();
    }

    const { dirtyFiles } = detectVaultChanges(config.vault, collections, metaFiles);
    const targetDirty = dirtyFiles.filter((d) => d.collections.some((c) => targetCollectionNames.includes(c)));
    const affectedCollections = [...new Set(targetDirty.flatMap((d) => d.collections).filter((c) => targetCollectionNames.includes(c)))];

    let update = null;
    if (affectedCollections.length > 0) {
      const { store } = await openStore(config);
      try {
        update = await store.update({ collections: affectedCollections });
      } finally {
        await store.close();
      }
    }

    let semanticResult = { ok: true, skipped: true, reason: 'semantic indexing not requested or not needed' };
    if (semanticMode !== 'never') {
      semanticResult = await syncSemantic(config, collections, targetCollectionNames, {
        mode: semanticMode,
        budgetMs,
      });
    }

    // Snapshot tracked files AFTER sync to check for concurrent writes during sync
    const trackedAfterSync = collectTrackedFiles(config.vault, collections);
    const changedDuringSync = [];
    for (const item of trackedAfterSync) {
      if (!item.collections.some((c) => targetCollectionNames.includes(c))) continue;
      const text = readFileSync(item.fullPath, 'utf8');
      const hashAfter = createHash('sha256').update(text).digest('hex');
      const before = snapshotBefore.get(item.rel);
      if (!before || before.contentHash !== hashAfter) {
        changedDuringSync.push(item.rel);
      }
    }
    const sourceChangedDuringSync = changedDuringSync.length > 0;

    const updatedFilesMap = { ...metaFiles };

    for (const item of dirtyFiles.filter((d) => d.status === 'deleted')) {
      if (item.collections.some((c) => targetCollectionNames.includes(c))) {
        delete updatedFilesMap[item.path];
      }
    }
    for (const item of trackedAfterSync) {
      if (item.collections.some((c) => targetCollectionNames.includes(c))) {
        if (changedDuringSync.includes(item.rel)) {
          continue;
        }
        const before = snapshotBefore.get(item.rel);
        if (before) {
          updatedFilesMap[item.rel] = {
            size: before.size,
            mtimeMs: before.mtimeMs,
            contentHash: before.contentHash,
            collections: before.collections,
            timeScope: before.timeScope,
            generation: lock.generationId,
          };
        }
      }
    }

    const semanticOk = semanticResult.ok === true && semanticResult.skipped !== true;
    const topLevelOk = semanticMode === 'always' ? (semanticResult.ok === true && semanticResult.skipped !== true) : true;

    const newMetadata = {
      schemaVersion: 2,
      qmdVersion: QMD_VERSION,
      generationId: lock.generationId,
      indexedAt: new Date().toISOString(),
      files: updatedFilesMap,
      projectCount: projects.length,
      collectionCount: collections.length,
      semanticRequested: semanticMode !== 'never',
      semanticReady: semanticOk,
      semanticReason: semanticOk ? null : (semanticResult.reason || null),
    };
    writeJsonAtomic(config.metadataPath, newMetadata);

    return {
      schemaVersion: 2,
      ok: topLevelOk,
      generationId: lock.generationId,
      syncedCollections: targetCollectionNames,
      affectedCollections,
      updatedFiles: targetDirty.length,
      sourceChangedDuringSync,
      semantic: semanticResult,
      metadata: newMetadata,
      elapsedMs: Date.now() - startedAt,
    };
  });
}

async function collectHealth(config, store) {
  const [status, health] = await Promise.all([store.getStatus(), store.getIndexHealth()]);
  let metadata = null;
  if (existsSync(config.metadataPath)) {
    try { metadata = JSON.parse(readFileSync(config.metadataPath, 'utf8')); } catch { metadata = null; }
  }
  let semanticMetadata = null;
  if (existsSync(config.semanticMetadataPath)) {
    try { semanticMetadata = JSON.parse(readFileSync(config.semanticMetadataPath, 'utf8')); } catch { semanticMetadata = null; }
  }

  const projects = discoverProjects(config.vault, config.structure);
  const collections = buildCollections(config.vault, projects, config.structure);
  const metaFiles = metadata?.files || {};

  const { dirtyFiles } = detectVaultChanges(config.vault, collections, metaFiles);

  const historyCollections = collections.filter((c) => c.name.endsWith('-history') || c.name === 'global-history').map((c) => c.name);
  const currentCollections = collections.filter((c) => !c.name.endsWith('-history') && c.name !== 'global-history').map((c) => c.name);

  const dirtyCurrent = dirtyFiles.filter((d) => d.collections.some((c) => currentCollections.includes(c)));
  const dirtyHistory = dirtyFiles.filter((d) => d.collections.some((c) => historyCollections.includes(c)));

  const currentLexicalFresh = dirtyCurrent.length === 0 && metadata !== null;
  const historyLexicalFresh = dirtyHistory.length === 0 && metadata !== null;

  const { calculateSemanticHealth } = await import('./semantic-adapter.js');
  const semanticHealth = calculateSemanticHealth(config, collections);
  const isSemanticConfigured = semanticHealth.available && semanticMetadata?.model === SEMANTIC_MODEL;
  const currentSemanticHealthy = Boolean(isSemanticConfigured && currentLexicalFresh && semanticHealth.currentPending === 0);
  const historySemanticHealthy = Boolean(isSemanticConfigured && historyLexicalFresh && semanticHealth.historyPending === 0);

  const currentVectorCoverage = isSemanticConfigured ? semanticHealth.currentCoverage : 0;
  const historyVectorCoverage = isSemanticConfigured ? semanticHealth.historyCoverage : 0;

  const currentDegraded = !currentLexicalFresh || !currentSemanticHealthy || (currentVectorCoverage < 1);
  const currentReason = !currentLexicalFresh
    ? 'vault changed after the last successful index update'
    : (currentSemanticHealthy ? null : 'local semantic index is missing or stale');

  const historyReason = !historyLexicalFresh
    ? 'history semantic updates are pending on demand'
    : (historySemanticHealthy ? null : 'local semantic index is missing or stale');

  const semanticFresh = !metadata?.semanticRequested || (isSemanticConfigured && currentSemanticHealthy && historySemanticHealthy);
  const allFresh = currentLexicalFresh && historyLexicalFresh && semanticFresh;
  const syncInProgress = isSyncLockActive(config);

  return {
    schemaVersion: 2,
    indexed: true,
    current: {
      lexicalFresh: currentLexicalFresh,
      semanticHealthy: currentSemanticHealthy,
      vectorCoverage: currentVectorCoverage,
      pendingFiles: dirtyCurrent.length,
      pendingChunks: semanticHealth.currentPending,
      degraded: currentDegraded,
      reason: currentReason,
    },
    history: {
      lexicalFresh: historyLexicalFresh,
      semanticHealthy: historySemanticHealthy,
      vectorCoverage: historyVectorCoverage,
      pendingFiles: dirtyHistory.length,
      pendingChunks: semanticHealth.historyPending,
      degraded: false,
      reason: historyReason,
    },
    overall: {
      allFresh,
      syncInProgress,
    },
    // Deprecated backward-compatible fields mapped to current.*
    indexFresh: currentLexicalFresh,
    semanticHealthy: currentSemanticHealthy,
    vectorCoverage: currentVectorCoverage,
    degraded: currentDegraded,
    reason: currentReason,
    qmdVersion: metadata?.qmdVersion || QMD_VERSION,
    indexedAt: metadata?.indexedAt || null,
    semanticModel: semanticMetadata?.model || null,
    status,
    health,
    metadata,
    semanticMetadata,
    dirtyFiles,
    collections,
    projects,
  };
}

export async function readHealth(config, { store: existingStore } = {}) {
  if (!existsSync(config.dbPath)) {
    return {
      schemaVersion: 2,
      indexed: false,
      current: {
        lexicalFresh: false,
        semanticHealthy: false,
        vectorCoverage: 0,
        pendingFiles: 0,
        pendingChunks: 0,
        degraded: true,
        reason: 'index database is missing',
      },
      history: {
        lexicalFresh: false,
        semanticHealthy: false,
        vectorCoverage: 0,
        pendingFiles: 0,
        pendingChunks: 0,
        degraded: true,
        reason: 'index database is missing',
      },
      overall: {
        allFresh: false,
        syncInProgress: false,
      },
      indexFresh: false,
      semanticHealthy: false,
      vectorCoverage: 0,
      degraded: true,
      reason: 'index database is missing',
    };
  }
  if (existingStore) return collectHealth(config, existingStore);
  const { store } = await openStore(config);
  try {
    return await collectHealth(config, store);
  } finally {
    await store.close();
  }
}

export async function lexicalSearch(config, query, collectionNames, limit = 20, { store: existingStore, onSearchError } = {}) {
  const searchOnce = async (store, collections) => {
    const lists = [];
    for (const collection of collectionNames) {
      for (const variant of lexicalVariants(query)) {
        let raw = [];
        try {
          raw = await store.searchLex(variant.query, { collection, limit });
        } catch (error) {
          onSearchError?.(String(error?.message || error));
          continue;
        }
        const results = materializeResults(raw, collection, collections);
        lists.push({
          source: 'lexical',
          collection: variant.label === 'original' ? collection : `${collection}#${variant.label}`,
          weight: variant.weight,
          results,
        });
      }
    }
    return lists;
  };
  if (existingStore) {
    const collections = buildCollections(config.vault, discoverProjects(config.vault, config.structure), config.structure);
    return searchOnce(existingStore, collections);
  }
  const { store, collections } = await openStore(config);
  try {
    return await searchOnce(store, collections);
  } finally {
    await store.close();
  }
}

export async function vectorSearch(config, query, collectionNames, limit = 20, options = {}) {
  return searchSemantic(config, query, collectionNames, limit, options);
}
