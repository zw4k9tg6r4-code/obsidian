import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeConfig } from '../src/config.js';
import { indexVault, syncVault, readHealth, publicHealth } from '../src/qmd-adapter.js';

const fixtureVault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

function createSyntheticEnv() {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-schema-test-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });
  return { root, vault, dataDir, config };
}

test('schema contract: syncResult conforms to sync-result.schema.json', async () => {
  const { config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  const syncResult = await syncVault(config, {
    projectName: '北辰仓配项目',
    temporalIntent: 'current',
    semanticMode: 'never',
  });

  const schemaRaw = readFileSync(fileURLToPath(new URL('../schemas/sync-result.schema.json', import.meta.url)), 'utf8');
  const schema = JSON.parse(schemaRaw);

  // Validate required properties
  assert.equal(typeof schema, 'object');
  for (const prop of schema.required) {
    assert.ok(prop in syncResult, `syncResult missing required property: ${prop}`);
  }
  assert.equal(syncResult.schemaVersion, 2);
  assert.equal(typeof syncResult.ok, 'boolean');
  assert.equal(typeof syncResult.generationId, 'string');
  assert.ok(Array.isArray(syncResult.syncedCollections));
  assert.ok(Array.isArray(syncResult.affectedCollections));
  assert.equal(typeof syncResult.updatedFiles, 'number');
  assert.equal(typeof syncResult.sourceChangedDuringSync, 'boolean');
  assert.equal(typeof syncResult.semantic, 'object');
  assert.equal(typeof syncResult.metadata, 'object');
  assert.equal(typeof syncResult.elapsedMs, 'number');
});

test('schema contract: health output conforms to health-v2.schema.json', async () => {
  const { config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  const rawHealth = await readHealth(config);
  const health = publicHealth(rawHealth);

  const schemaRaw = readFileSync(fileURLToPath(new URL('../schemas/health-v2.schema.json', import.meta.url)), 'utf8');
  const schema = JSON.parse(schemaRaw);

  assert.equal(typeof schema, 'object');
  for (const prop of schema.required) {
    assert.ok(prop in health, `health missing required property: ${prop}`);
  }
  assert.equal(health.schemaVersion, 2);
  assert.equal(typeof health.indexed, 'boolean');
  assert.equal(typeof health.current, 'object');
  assert.equal(typeof health.current.lexicalFresh, 'boolean');
  assert.equal(typeof health.current.semanticHealthy, 'boolean');
  assert.equal(typeof health.current.vectorCoverage, 'number');
  assert.equal(typeof health.history, 'object');
  assert.equal(typeof health.overall, 'object');
  assert.equal(typeof health.overall.allFresh, 'boolean');
  assert.equal(typeof health.overall.syncInProgress, 'boolean');
});
