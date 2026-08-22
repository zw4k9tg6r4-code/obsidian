import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSemanticChunks } from './chunker.js';
import { writeJsonAtomic } from './io.js';

export const SEMANTIC_MODEL = 'BAAI/bge-small-zh-v1.5';
export const FASTEMBED_VERSION = '0.8.0';

function pythonCommand(config) {
  if (process.env.SECOND_BRAIN_PYTHON) return process.env.SECOND_BRAIN_PYTHON;
  if (existsSync(config.semanticPython)) return config.semanticPython;
  // py.exe (the Windows Python launcher) avoids the Microsoft Store python.exe alias.
  return process.platform === 'win32' ? 'py.exe' : 'python3';
}

function runPython(config, payload, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const worker = join(dirname(fileURLToPath(import.meta.url)), 'fastembed_worker.py');
  return new Promise((resolve) => {
    const child = spawn(pythonCommand(config), ['-X', 'utf8', worker], {
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        TOKENIZERS_PARALLELISM: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: error.message, stderr: stderr.slice(-2000) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({
          ok: false,
          reason: `FastEmbed worker exited with code ${code}. Run scripts/setup-semantic.ps1 first.`,
          stderr: stderr.slice(-2000),
        });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ ok: false, reason: 'FastEmbed worker returned invalid JSON', stderr: stderr.slice(-2000) });
      }
    });
    child.stdin.end(JSON.stringify({ ...payload, dataDir: config.dataDir, dbPath: config.semanticDbPath }));
  });
}

export async function indexSemantic(config, collections, vaultFingerprint) {
  const records = collectSemanticChunks(config.vault, collections);
  const result = await runPython(config, { action: 'index', records }, { timeoutMs: 30 * 60 * 1000 });
  if (result.ok) {
    writeJsonAtomic(config.semanticMetadataPath, {
      schemaVersion: 1,
      model: SEMANTIC_MODEL,
      fastembedVersion: FASTEMBED_VERSION,
      indexedAt: new Date().toISOString(),
      vaultFingerprint,
      sourceFiles: new Set(records.map((item) => item.relativePath)).size,
      chunks: records.length,
      dimensions: result.dimensions,
    });
  }
  return result;
}

export async function searchSemantic(config, query, collectionNames, limit = 20) {
  const result = await runPython(config, {
    action: 'search',
    query,
    collectionNames,
    limit: Math.min(Math.max(limit * 4, limit), 100),
  }, { timeoutMs: 90 * 1000 });
  if (!result.ok) return result;
  const uniqueSources = new Map();
  for (const item of result.results) {
    if (Number(item.score) < 0.4) continue;
    if (!uniqueSources.has(item.filepath)) uniqueSources.set(item.filepath, item);
  }
  return {
    ok: true,
    model: result.model,
    lists: [{
      source: 'vector',
      collection: 'semantic-scope',
      weight: 1,
      results: [...uniqueSources.values()].slice(0, limit),
    }],
  };
}
