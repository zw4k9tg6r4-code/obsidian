import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { DatabaseSync } from 'node:sqlite';
import { collectSemanticChunks } from './chunker.js';
import { writeJsonAtomic } from './io.js';

export const SEMANTIC_MODEL = 'BAAI/bge-small-zh-v1.5';
export const FASTEMBED_VERSION = '0.8.0';

const activeChildProcesses = new Set();
const activePids = new Set();
let isShuttingDown = false;
let shutdownTreeKillFailed = false;

export const workerKillFaults = {
  spawnSyncAdapter: (...args) => spawnSync(...args),
};

export function setWorkerShuttingDown(val = true) {
  isShuttingDown = Boolean(val);
}

export function resetWorkerShutdownStateForTests() {
  isShuttingDown = false;
  shutdownTreeKillFailed = false;
  activeChildProcesses.clear();
  activePids.clear();
  workerKillFaults.spawnSyncAdapter = (...args) => spawnSync(...args);
}

function killProcessTreeSync(pid) {
  if (!pid || isProcessDead(pid)) return true;
  try {
    if (process.platform === 'win32') {
      const killed = workerKillFaults.spawnSyncAdapter(
        'taskkill.exe',
        ['/F', '/T', '/PID', String(pid)],
        { windowsHide: true },
      );
      const terminated = !killed.error && killed.status === 0;
      if (!terminated && !isProcessDead(pid)) {
        process.stderr.write(`[WARN] taskkill could not terminate worker PID ${pid}: ${killed.error?.message || `exit status ${killed.status}`}\n`);
        return false;
      }
      return true;
    } else {
      process.kill(pid, 'SIGKILL');
      return true;
    }
  } catch {
    return isProcessDead(pid);
  }
}

function isProcessDead(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

export function registerActiveWorker(child) {
  if (!child) return;
  const pid = child.pid;
  if (pid) activePids.add(pid);

  const onChildExit = () => {
    activeChildProcesses.delete(child);
    if (pid) activePids.delete(pid);
  };
  child.once('exit', onChildExit);
  child.once('close', onChildExit);
  activeChildProcesses.add(child);

  if (isShuttingDown) {
    try { child.kill('SIGTERM'); } catch {}
    if (pid && !killProcessTreeSync(pid)) shutdownTreeKillFailed = true;
  }
}

export function getActiveWorkersCount() {
  return activeChildProcesses.size;
}

export async function killAllActiveWorkers({ waitMs = 2000 } = {}) {
  if (!isShuttingDown) shutdownTreeKillFailed = false;
  isShuttingDown = true;
  const start = Date.now();
  const forceKillThreshold = Math.min(waitMs, 500);
  const treeKillAttempted = new Set();
  let emptySince = null;

  while (Date.now() - start < waitMs) {
    const unexited = Array.from(activeChildProcesses).filter(
      (c) => c && c.exitCode === null && c.signalCode === null
    );

    if (unexited.length === 0) {
      for (const child of Array.from(activeChildProcesses)) {
        if (child.exitCode !== null || child.signalCode !== null) activeChildProcesses.delete(child);
      }
      for (const pid of Array.from(activePids)) {
        if (isProcessDead(pid)) activePids.delete(pid);
      }
      if (activeChildProcesses.size === 0 && activePids.size === 0) {
        if (emptySince === null) emptySince = Date.now();
        if (Date.now() - emptySince >= Math.min(150, waitMs)) return !shutdownTreeKillFailed;
      } else {
        emptySince = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    emptySince = null;

    const elapsed = Date.now() - start;
    for (const child of unexited) {
      if (process.platform === 'win32' && child.pid && !treeKillAttempted.has(child.pid)) {
        treeKillAttempted.add(child.pid);
        if (!killProcessTreeSync(child.pid)) {
          shutdownTreeKillFailed = true;
          try { child.kill('SIGTERM'); } catch {}
        }
      } else if (process.platform !== 'win32' && elapsed >= forceKillThreshold && child.pid) {
        if (!killProcessTreeSync(child.pid)) shutdownTreeKillFailed = true;
      } else {
        try { child.kill('SIGTERM'); } catch {}
      }
    }

    await new Promise((r) => setTimeout(r, 25));
  }

  for (const child of Array.from(activeChildProcesses)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      activeChildProcesses.delete(child);
    }
  }
  for (const pid of Array.from(activePids)) {
    if (isProcessDead(pid)) activePids.delete(pid);
  }

  return activeChildProcesses.size === 0 && activePids.size === 0 && !shutdownTreeKillFailed;
}

export function isSemanticRuntimeConfigured(config) {
  const py = pythonCommand(config);
  const pyExists = existsSync(py);
  const localModel = join(config.dataDir, 'models', 'fastembed');
  const defaultModel = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'CodexSecondBrain', 'models', 'fastembed')
    : null;
  const modelExists = existsSync(localModel) || Boolean(defaultModel && existsSync(defaultModel));
  return Boolean(pyExists && modelExists);
}

function pythonCommand(config) {
  if (process.env.SECOND_BRAIN_PYTHON) return process.env.SECOND_BRAIN_PYTHON;
  if (existsSync(config.semanticPython)) return config.semanticPython;
  const defaultPython = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || '', 'CodexSecondBrain', 'runtime', '.venv', 'Scripts', 'python.exe')
    : join(process.env.HOME || '', '.local', 'share', 'CodexSecondBrain', 'runtime', '.venv', 'bin', 'python');
  if (existsSync(defaultPython)) return defaultPython;
  // py.exe (the Windows Python launcher) avoids the Microsoft Store python.exe alias.
  return process.platform === 'win32' ? 'py.exe' : 'python3';
}

export function runPython(config, payload, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const worker = join(dirname(fileURLToPath(import.meta.url)), 'fastembed_worker.py');
  return new Promise((resolve) => {
    if (isShuttingDown) {
      resolve({
        ok: false,
        error: 'Semantic worker spawn rejected: shutdown in progress',
        semanticReady: false,
      });
      return;
    }

    const child = spawn(pythonCommand(config), ['-X', 'utf8', worker], {
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        TOKENIZERS_PARALLELISM: 'false',
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    registerActiveWorker(child);

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill.exe', ['/F', '/PID', String(child.pid), '/T'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch {}
      resolve({ ok: false, reason: `FastEmbed worker timed out after ${timeoutMs}ms`, stderr: stderr.slice(-2000) });
    }, timeoutMs);

    child.stdin.on('error', () => {
      // Catch EPIPE/ECONNRESET if Python child exited early before reading stdin
    });
    child.stdout.on('data', (chunk) => { stdout += stdoutDecoder.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += stderrDecoder.write(chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, reason: error.message, stderr: stderr.slice(-2000) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
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

export function calculateSemanticHealth(config, collections) {
  if (!existsSync(config.semanticDbPath)) {
    return { available: false, currentCoverage: 0, historyCoverage: 0, currentPending: 0, historyPending: 0, totalChunksInDb: 0 };
  }
  let db = null;
  let rows = null;
  try {
    db = new DatabaseSync(config.semanticDbPath, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'").all();
    if (tables.length === 0) {
      db.close();
      db = null;
      return { available: false, currentCoverage: 0, historyCoverage: 0, currentPending: 0, historyPending: 0, totalChunksInDb: 0 };
    }
    rows = db.prepare('SELECT id, collections, source_hash FROM chunks').all();
    db.close();
    db = null;
  } catch {
    if (db) try { db.close(); } catch {}
    return { available: false, currentCoverage: 0, historyCoverage: 0, currentPending: 0, historyPending: 0, totalChunksInDb: 0 };
  }

  try {
    if (!rows || rows.length === 0) {
      return { available: false, currentCoverage: 0, historyCoverage: 0, currentPending: 0, historyPending: 0, totalChunksInDb: 0 };
    }

    const dbChunkMap = new Map();
    for (const r of rows) {
      dbChunkMap.set(r.id, {
        collections: new Set(JSON.parse(r.collections || '[]')),
        sourceHash: r.source_hash,
      });
    }

    const allRecords = collectSemanticChunks(config.vault, collections);
    const historyColls = collections.filter((c) => c.name.endsWith('-history') || c.name === 'global-history').map((c) => c.name);
    const currentColls = collections.filter((c) => !c.name.endsWith('-history') && c.name !== 'global-history').map((c) => c.name);

    const currentExpected = allRecords.filter((r) => r.collections.some((c) => currentColls.includes(c)));
    const historyExpected = allRecords.filter((r) => r.collections.some((c) => historyColls.includes(c)));

    const currentValid = currentExpected.filter((r) => {
      const existing = dbChunkMap.get(r.id);
      return existing && existing.sourceHash === r.sourceHash;
    });
    const historyValid = historyExpected.filter((r) => {
      const existing = dbChunkMap.get(r.id);
      return existing && existing.sourceHash === r.sourceHash;
    });

    const currentCoverage = currentExpected.length > 0 ? (currentValid.length / currentExpected.length) : 1;
    const historyCoverage = historyExpected.length > 0 ? (historyValid.length / historyExpected.length) : 1;
    const currentPending = currentExpected.length - currentValid.length;
    const historyPending = historyExpected.length - historyValid.length;

    return {
      available: true,
      currentCoverage: Number(currentCoverage.toFixed(4)),
      historyCoverage: Number(historyCoverage.toFixed(4)),
      currentPending,
      historyPending,
      totalChunksInDb: rows.length,
    };
  } catch {
    return { available: false, currentCoverage: 0, historyCoverage: 0, currentPending: 0, historyPending: 0, totalChunksInDb: 0 };
  }
}

export async function indexSemantic(config, collections, vaultFingerprint) {
  const records = collectSemanticChunks(config.vault, collections);
  const result = await runPython(config, {
    action: 'index',
    records,
    syncedCollections: collections.map((c) => c.name),
  }, { timeoutMs: 30 * 60 * 1000 });
  if (result.ok) {
    writeJsonAtomic(config.semanticMetadataPath, {
      schemaVersion: 2,
      model: SEMANTIC_MODEL,
      fastembedVersion: FASTEMBED_VERSION,
      indexedAt: new Date().toISOString(),
      vaultFingerprint,
      sourceFiles: new Set(records.map((item) => item.relativePath)).size,
      chunks: records.length,
      embedded: result.embedded ?? records.length,
      reused: result.reused ?? 0,
      pending: result.pending ?? 0,
      dimensions: result.dimensions,
    });
  }
  return result;
}

export async function syncSemantic(config, collections, targetCollectionNames, { mode = 'auto', budgetMs = 10000 } = {}) {
  const records = collectSemanticChunks(config.vault, collections);
  const targetRecords = records.filter((r) => r.collections.some((c) => targetCollectionNames.includes(c)));

  if (mode === 'auto' && budgetMs < 100) {
    return {
      ok: true,
      action: 'sync',
      mode: 'auto',
      embedded: 0,
      reused: 0,
      pending: targetRecords.length,
      skipped: false,
      reason: 'embedding skipped due to zero or near-zero budget in auto mode',
    };
  }

  if (!isSemanticRuntimeConfigured(config)) {
    if (mode === 'auto') {
      return { ok: true, skipped: true, reason: 'semantic runtime or model not configured' };
    }
    return { ok: false, reason: 'semantic runtime or model not configured. Run scripts/setup-semantic.ps1 first.' };
  }

  const result = await runPython(config, {
    action: 'sync',
    records: targetRecords,
    syncedCollections: targetCollectionNames,
    mode,
    budgetMs,
  }, { timeoutMs: Math.max(budgetMs + 5000, 15000) });

  if (result.ok) {
    let prevMeta = null;
    if (existsSync(config.semanticMetadataPath)) {
      try { prevMeta = JSON.parse(readFileSync(config.semanticMetadataPath, 'utf8')); } catch {}
    }
    const metadata = {
      schemaVersion: 2,
      model: SEMANTIC_MODEL,
      fastembedVersion: FASTEMBED_VERSION,
      indexedAt: new Date().toISOString(),
      sourceFiles: new Set(targetRecords.map((item) => item.relativePath)).size,
      chunks: targetRecords.length,
      embedded: result.embedded ?? 0,
      reused: result.reused ?? 0,
      pending: result.pending ?? 0,
      dimensions: result.dimensions || prevMeta?.dimensions || 0,
    };
    writeJsonAtomic(config.semanticMetadataPath, metadata);
  }
  return result;
}

export async function searchSemantic(config, query, collectionNames, limit = 20, { excludePaths = [], validSourceHashes = [] } = {}) {
  const result = await runPython(config, {
    action: 'search',
    query,
    collectionNames,
    excludePaths,
    validSourceHashes,
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
