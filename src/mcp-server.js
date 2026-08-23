#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { resolveRuntimeConfig } from './config.js';
import { discoverProjects } from './vault.js';
import { publicHealth, readHealth } from './qmd-adapter.js';
import { searchSecondBrain } from './retrieval.js';
import { addCandidate } from './candidates.js';
import { VERSION } from './version.js';

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function runtime() {
  return resolveRuntimeConfig({
    vault: process.env.SECOND_BRAIN_VAULT,
    dataDir: process.env.SECOND_BRAIN_DATA_DIR,
  });
}

export function createSecondBrainMcpServer() {
  const server = new McpServer({
    name: 'codex-obsidian-second-brain',
    version: VERSION,
  });

  server.registerTool('second_brain_search', {
    title: 'Search the second brain',
    description: 'Search local Markdown with project isolation and return opened, source-located evidence. Read-only.',
    inputSchema: {
      query: z.string().min(1).max(2000),
      project: z.string().min(1).max(200).optional(),
      time: z.enum(['current', 'history']).default('current'),
      maxEvidence: z.number().int().min(1).max(4).default(4),
      maxRelated: z.number().int().min(0).max(2).default(2),
      lexicalOnly: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ query, project, time, maxEvidence, maxRelated, lexicalOnly }) => toolResult(
    await searchSecondBrain({
      vault: process.env.SECOND_BRAIN_VAULT,
      dataDir: process.env.SECOND_BRAIN_DATA_DIR,
      query,
      projectName: project,
      temporalIntent: time,
      maxEvidence,
      maxRelated,
      lexicalOnly,
    }),
  ));

  server.registerTool('second_brain_projects', {
    title: 'List project identities',
    description: 'List only public project identity fields used to disambiguate searches. Read-only.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => {
    const config = runtime();
    // structuredContent must be an object per the MCP schema; the bare array
    // this tool used to return was rejected by every spec-compliant client.
    return toolResult({ projects: discoverProjects(config.vault, config.structure).map(({ id, name, status, updated, mainObject }) => ({
      id, name, status, updated, mainObject,
    })) });
  });

  server.registerTool('second_brain_health', {
    title: 'Check second-brain health',
    description: 'Report index freshness and degradation without exposing local paths. Read-only.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => toolResult(publicHealth(await readHealth(runtime()))));

  server.registerTool('second_brain_candidate_add', {
    title: 'Propose candidate memory',
    description: 'Store a proposed memory bound to one existing project as candidate-only derived state outside the vault. It cannot confirm or activate itself.',
    inputSchema: {
      content: z.string().min(1).max(20000),
      scope: z.string().min(1).max(200),
      sourceRef: z.string().min(1).max(1000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ content, scope, sourceRef }) => toolResult(addCandidate(runtime(), {
    content,
    scope,
    sourceRef,
    createdBy: 'external-agent',
  })));

  return server;
}

export async function runStdioServer() {
  const server = createSecondBrainMcpServer();
  await server.connect(new StdioServerTransport());
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runStdioServer().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
