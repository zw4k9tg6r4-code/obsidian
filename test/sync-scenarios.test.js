import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeConfig } from '../src/config.js';
import { indexVault, syncVault, readHealth } from '../src/qmd-adapter.js';

const fixtureVault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

function createSyntheticEnv() {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-sync-scenarios-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });
  return { root, vault, dataDir, config };
}

test('mtime changed but content unchanged does not trigger file reindex', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  const health1 = await readHealth(config);
  assert.equal(health1.current.lexicalFresh, true);

  // Touch mtime of a file without changing content
  const target = join(vault, '02-项目', '北辰仓配项目', '01-输入', '当前报价.md');
  const now = new Date();
  const future = new Date(now.getTime() + 100000);
  utimesSync(target, future, future);

  // Health should still report lexicalFresh=true because content hash is identical
  const health2 = await readHealth(config);
  assert.equal(health2.current.lexicalFresh, true);
  assert.equal(health2.current.pendingFiles, 0);
});

test('project topology update updates collection mappings correctly', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  // Add a new project
  const newProjDir = join(vault, '02-项目', '东川物流项目');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(newProjDir, '01-输入'), { recursive: true });
  writeFileSync(join(newProjDir, '项目主页.md'), `---
project: 东川物流项目
status: active
updated: 2026-08-24
---

# 东川物流项目
- 主对象：东川冷链
`, 'utf8');
  writeFileSync(join(newProjDir, '01-输入', '冷链价目.md'), '# 冷链价格\n冷链起步价200元。\n', 'utf8');

  // Sync vault
  const syncRes = await syncVault(config, {
    temporalIntent: 'all',
    semanticMode: 'never',
  });
  assert.equal(syncRes.ok, true);

  const health = await readHealth(config);
  assert.equal(health.current.lexicalFresh, true);
  assert.equal(health.projects.length, 3);
});

test('v1 legacy metadata upgrades cleanly to schema v2', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  // Manually write a v1 metadata format
  const v1Meta = {
    schemaVersion: 1,
    qmdVersion: '2.5.3',
    vaultFingerprint: {
      markdownFiles: 10,
      bytes: 5000,
      contentHash: 'fc5467a23766faabcd1d140bf1cd06444fca12a3c9d432ba69d0a544c10be748',
    },
    projectCount: 2,
    collectionCount: 9,
    indexedAt: '2026-08-23T06:14:10.572Z',
    semanticRequested: false,
    semanticReady: false,
    semanticReason: 'semantic indexing not requested',
  };
  writeFileSync(config.metadataPath, JSON.stringify(v1Meta, null, 2), 'utf8');

  // Read health on v1 metadata -> must not crash and detect changes
  const health = await readHealth(config);
  assert.equal(health.schemaVersion, 2);

  // Syncing must upgrade metadata to schema v2
  const syncRes = await syncVault(config, {
    temporalIntent: 'current',
    semanticMode: 'never',
  });
  assert.equal(syncRes.ok, true);
  assert.equal(syncRes.metadata.schemaVersion, 2);
  assert.ok(syncRes.metadata.files);
});
