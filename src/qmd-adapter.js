import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSafeVaultTree, buildCollections, discoverProjects, qmdConfig, vaultStats } from './vault.js';
import { writeJsonAtomic } from './io.js';
import { indexSemantic, searchSemantic, SEMANTIC_MODEL } from './semantic-adapter.js';

export const QMD_VERSION = '2.5.3';

export function publicHealth(health) {
  return {
    indexed: health.indexed,
    indexFresh: health.indexFresh ?? false,
    semanticHealthy: health.semanticHealthy,
    vectorCoverage: health.vectorCoverage,
    degraded: health.degraded,
    reason: health.reason || null,
    qmdVersion: health.metadata?.qmdVersion || QMD_VERSION,
    indexedAt: health.metadata?.indexedAt || null,
    semanticModel: health.semanticMetadata?.model || null,
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

function lexicalVariants(query) {
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

  const metadata = {
    schemaVersion: 1,
    qmdVersion: QMD_VERSION,
    vaultFingerprint: fingerprint,
    projectCount: projects.length,
    collectionCount: collections.length,
    indexedAt: new Date().toISOString(),
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
  const currentFingerprint = vaultStats(config.vault);
  const indexFresh = Boolean(metadata?.vaultFingerprint
    && metadata.vaultFingerprint.markdownFiles === currentFingerprint.markdownFiles
    && metadata.vaultFingerprint.bytes === currentFingerprint.bytes
    && metadata.vaultFingerprint.contentHash === currentFingerprint.contentHash);
  const semanticFresh = Boolean(semanticMetadata?.vaultFingerprint
    && semanticMetadata.vaultFingerprint.markdownFiles === currentFingerprint.markdownFiles
    && semanticMetadata.vaultFingerprint.bytes === currentFingerprint.bytes
    && semanticMetadata.vaultFingerprint.contentHash === currentFingerprint.contentHash);
  const semanticHealthy = Boolean(existsSync(config.semanticDbPath)
    && semanticFresh
    && semanticMetadata?.model === SEMANTIC_MODEL);
  const vectorCoverage = semanticHealthy ? 1 : 0;
  return {
    indexed: true,
    indexFresh,
    semanticHealthy,
    vectorCoverage,
    degraded: !semanticHealthy || !indexFresh,
    reason: !indexFresh
      ? 'vault changed after the last successful index update'
      : (semanticHealthy ? null : 'local semantic index is missing or stale'),
    status,
    health,
    metadata,
    semanticMetadata,
    currentFingerprint,
  };
}

export async function readHealth(config, { store: existingStore } = {}) {
  if (!existsSync(config.dbPath)) {
    return {
      indexed: false,
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
          // Surface backend failures to the caller instead of silently dropping them.
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

export async function vectorSearch(config, query, collectionNames, limit = 20) {
  return searchSemantic(config, query, collectionNames, limit);
}
