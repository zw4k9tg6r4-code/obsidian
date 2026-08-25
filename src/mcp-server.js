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
import { redactLocalPaths } from './audit.js';
import { VERSION } from './version.js';

function sanitizeMemoryContent(content) {
  if (typeof content !== 'string') return '';
  return content
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

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

function safeExecute(fn) {
  return async (...args) => {
    try {
      const value = await fn(...args);
      return toolResult(value);
    } catch (err) {
      const raw = err?.message || String(err);
      let vaultRoot = process.env.SECOND_BRAIN_VAULT;
      let dataRoot = process.env.SECOND_BRAIN_DATA_DIR;
      try {
        const conf = runtime();
        vaultRoot = conf.vault;
        dataRoot = conf.dataDir;
      } catch {}
      const sanitized = redactLocalPaths(
        raw,
        vaultRoot,
        dataRoot,
      );
      throw new Error(sanitized);
    }
  };
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
  }, safeExecute(async ({ query, project, time, maxEvidence, maxRelated, lexicalOnly }) => {
    const config = runtime();
    return await searchSecondBrain({
      vault: config.vault,
      dataDir: config.dataDir,
      query: sanitizeMemoryContent(query),
      projectName: project,
      temporalIntent: time,
      maxEvidence,
      maxRelated,
      lexicalOnly,
    });
  }));

  server.registerTool('second_brain_projects', {
    title: 'List project identities',
    description: 'List only public project identity fields used to disambiguate searches. Read-only.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, safeExecute(async () => {
    const config = runtime();
    // structuredContent must be an object per the MCP schema; the bare array
    // this tool used to return was rejected by every spec-compliant client.
    return { projects: discoverProjects(config.vault, config.structure).map(({ id, name, status, updated, mainObject }) => ({
      id, name, status, updated, mainObject,
    })) };
  }));

  server.registerTool('second_brain_health', {
    title: 'Check second-brain health',
    description: 'Report index freshness and degradation without exposing local paths. Read-only.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, safeExecute(async () => publicHealth(await readHealth(runtime()))));

  server.registerTool('second_brain_candidate_add', {
    title: 'Propose candidate memory',
    description: 'Store a proposed memory bound to one existing project as candidate-only derived state outside the vault. It cannot confirm or activate itself.',
    inputSchema: {
      content: z.string().min(1).max(20000),
      scope: z.string().min(1).max(200),
      sourceRef: z.string().min(1).max(1000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, safeExecute(async ({ content, scope, sourceRef }) => addCandidate(runtime(), {
    content: sanitizeMemoryContent(content),
    scope,
    sourceRef,
    createdBy: 'external-agent',
  })));

  server.registerTool('second_brain_sync', {
    title: 'Synchronize derived index',
    description: 'Incrementally synchronize derived keyword and semantic indexes for a project or all current collections. Safe and bounded.',
    inputSchema: {
      project: z.string().min(1).max(200).optional(),
      time: z.enum(['current', 'history', 'all']).default('current'),
      semantic: z.enum(['auto', 'always', 'never']).default('auto'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, safeExecute(async ({ project, time, semantic }) => {
    const { syncVault } = await import('./qmd-adapter.js');
    return syncVault(runtime(), {
      projectName: project,
      temporalIntent: time,
      semanticMode: semantic,
    });
  }));

  return server;
}

import { killAllActiveWorkers, setWorkerShuttingDown } from './semantic-adapter.js';

export class GracefulShutdownController {
  constructor(server, transport, { exitProcess = true } = {}) {
    this.server = server;
    this.transport = transport;
    this.exitProcess = exitProcess;
    this.isShuttingDown = false;
  }

  install() {
    const shutdown = (signal) => this.performGracefulShutdown(signal);

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));

    process.on('uncaughtException', (err) => {
      process.stderr.write(`[FATAL] Uncaught Exception: ${err?.stack || err}\n`);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
      process.stderr.write(`[FATAL] Unhandled Rejection: ${reason?.stack || reason}\n`);
      shutdown('unhandledRejection');
    });

    process.stdin.on('close', () => shutdown('stdin_close'));
    process.stdin.on('end', () => shutdown('stdin_end'));
  }

  performGracefulShutdown(trigger) {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.isShuttingDown = true;
    setWorkerShuttingDown(true);

    let resolvePromise;
    let rejectPromise;
    this.shutdownPromise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    (async () => {
      try {
        const closeErrors = [];

        if (this.transport && typeof this.transport.close === 'function') {
          try {
            await this.transport.close();
          } catch (err) {
            closeErrors.push(err);
            process.stderr.write(`[ERROR] Transport close failed: ${err?.message || err}\n`);
          }
        }

        if (this.server && typeof this.server.close === 'function') {
          try {
            await this.server.close();
          } catch (err) {
            closeErrors.push(err);
            process.stderr.write(`[ERROR] Server close failed: ${err?.message || err}\n`);
          }
        }

        let workersKilled = true;
        try {
          workersKilled = await killAllActiveWorkers({ waitMs: 2000 });
          if (!workersKilled) {
            process.stderr.write(`[ERROR] Semantic workers could not be verified as exited during graceful shutdown; shutdown status is failure\n`);
          }
        } catch (err) {
          workersKilled = false;
          process.stderr.write(`[ERROR] Error killing semantic workers: ${err?.message || err}\n`);
        }

        const success = workersKilled && closeErrors.length === 0;
        this.shutdownResult = {
          workersKilled: success,
          trigger,
          errors: closeErrors.map((e) => e?.message || String(e)),
        };

        if (this.exitProcess) {
          const cleanSignalExit = trigger === 'SIGINT' || trigger === 'SIGTERM' || trigger.startsWith('stdin');
          process.exit(success && cleanSignalExit ? 0 : 1);
        }
        resolvePromise(this.shutdownResult);
      } catch (err) {
        rejectPromise(err);
      }
    })();

    return this.shutdownPromise;
  }
}

export async function runStdioServer() {
  console.log = (...args) => process.stderr.write(`[INFO] ${args.join(' ')}\n`);
  console.info = (...args) => process.stderr.write(`[INFO] ${args.join(' ')}\n`);
  console.warn = (...args) => process.stderr.write(`[WARN] ${args.join(' ')}\n`);

  const server = createSecondBrainMcpServer();
  const transport = new StdioServerTransport();
  const shutdownCtrl = new GracefulShutdownController(server, transport);
  shutdownCtrl.install();

  await server.connect(transport);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runStdioServer().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    killAllActiveWorkers();
    process.exitCode = 1;
  });
}
