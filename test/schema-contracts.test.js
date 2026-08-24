import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { resolveRuntimeConfig } from '../src/config.js';
import { indexVault, syncVault, readHealth, publicHealth } from '../src/qmd-adapter.js';
import { searchSecondBrain } from '../src/retrieval.js';

const fixtureVault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

function createSyntheticEnv() {
  const root = mkdtempSync(join(tmpdir(), 'sbrain-schema-test-'));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  cpSync(fixtureVault, vault, { recursive: true });
  const config = resolveRuntimeConfig({ vault, dataDir });
  return { root, vault, dataDir, config };
}

test('schema contract: full Draft 2020-12 validation of syncResult against sync-result.schema.json', async () => {
  const { config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  const syncResult = await syncVault(config, {
    projectName: '北辰仓配项目',
    temporalIntent: 'current',
    semanticMode: 'never',
  });

  const schemaRaw = readFileSync(fileURLToPath(new URL('../schemas/sync-result.schema.json', import.meta.url)), 'utf8');
  const schema = JSON.parse(schemaRaw);

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(syncResult);

  if (!valid) {
    console.error('Validation errors for syncResult:', validate.errors);
  }
  assert.equal(valid, true, `syncResult must strictly validate against sync-result.schema.json`);
});

test('schema contract: full Draft 2020-12 validation of publicHealth against health-v2.schema.json', async () => {
  const { config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  const rawHealth = await readHealth(config);
  const health = publicHealth(rawHealth);

  const schemaRaw = readFileSync(fileURLToPath(new URL('../schemas/health-v2.schema.json', import.meta.url)), 'utf8');
  const schema = JSON.parse(schemaRaw);

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(health);

  if (!valid) {
    console.error('Validation errors for publicHealth:', validate.errors);
  }
  assert.equal(valid, true, `publicHealth must strictly validate against health-v2.schema.json`);
});

test('schema contract: full Draft 2020-12 validation of searchResult against evidence.schema.json', async () => {
  const { vault, dataDir, config } = createSyntheticEnv();
  await indexVault(config, { semantic: false });

  const searchResult = await searchSecondBrain({
    vault,
    dataDir,
    query: '标准仓储服务费',
    projectName: '北辰仓配项目',
    lexicalOnly: true,
  });

  const schemaRaw = readFileSync(fileURLToPath(new URL('../schemas/evidence.schema.json', import.meta.url)), 'utf8');
  const schema = JSON.parse(schemaRaw);

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(searchResult);

  if (!valid) {
    console.error('Validation errors for searchResult:', validate.errors);
  }
  assert.equal(valid, true, `searchResult must strictly validate against evidence.schema.json`);
});
