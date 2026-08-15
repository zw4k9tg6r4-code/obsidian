import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSecondBrainMcpServer } from '../src/mcp-server.js';
import { resolveRuntimeConfig } from '../src/config.js';
import { indexVault } from '../src/qmd-adapter.js';

const vault = fileURLToPath(new URL('./fixtures/vault', import.meta.url));

test('MCP exposes bounded read tools and candidate-only write', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sbrain-mcp-'));
  process.env.SECOND_BRAIN_VAULT = vault;
  process.env.SECOND_BRAIN_DATA_DIR = dataDir;
  await indexVault(resolveRuntimeConfig({ vault, dataDir }), { semantic: false });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createSecondBrainMcpServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
    delete process.env.SECOND_BRAIN_VAULT;
    delete process.env.SECOND_BRAIN_DATA_DIR;
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((item) => item.name).sort(), [
    'second_brain_candidate_add',
    'second_brain_health',
    'second_brain_projects',
    'second_brain_search',
  ]);

  const search = await client.callTool({
    name: 'second_brain_search',
    arguments: {
      query: '标准仓储服务费 每托盘 120 元',
      project: '北辰仓配项目',
      lexicalOnly: true,
    },
  });
  const searchJson = JSON.parse(search.content[0].text);
  assert.equal(searchJson.decision, 'grounded');
  assert.equal(searchJson.scope.project.directory, undefined);
  assert.ok(!JSON.stringify(searchJson).includes(vault));

  const candidate = await client.callTool({
    name: 'second_brain_candidate_add',
    arguments: { content: '等待确认的测试候选事实', scope: '北辰仓配项目' },
  });
  const candidateJson = JSON.parse(candidate.content[0].text);
  assert.equal(candidateJson.record.status, 'candidate');
  assert.equal(candidateJson.record.createdBy, 'external-agent');
  assert.match(candidateJson.record.projectId, /^project-/);
});
