import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_STRUCTURE, resolveStructure } from './structure.js';

export const DEFAULT_DATA_DIR = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'CodexSecondBrain')
  : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'CodexSecondBrain');

export function isPathInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function assertVault(vaultInput, ruleFile = DEFAULT_STRUCTURE.vaultRuleFile) {
  if (!vaultInput) {
    throw new Error('Vault path is required. Pass --vault or set SECOND_BRAIN_VAULT.');
  }
  const absolute = resolve(vaultInput);
  if (!existsSync(absolute)) throw new Error(`Vault does not exist: ${absolute}`);
  const vault = realpathSync.native(absolute);
  if (!existsSync(join(vault, ruleFile))) {
    throw new Error(`Vault root ${ruleFile} is missing: ${vault}`);
  }
  return vault;
}

export function resolveDataDir(dataInput, { create = true } = {}) {
  const absolute = resolve(dataInput || process.env.SECOND_BRAIN_DATA_DIR || DEFAULT_DATA_DIR);
  const missingSegments = [];
  let existingAncestor = absolute;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  const physicalAncestor = existsSync(existingAncestor)
    ? realpathSync.native(existingAncestor)
    : existingAncestor;
  const prospective = resolve(physicalAncestor, ...missingSegments);
  if (create) mkdirSync(prospective, { recursive: true });
  return existsSync(prospective) ? realpathSync.native(prospective) : prospective;
}

function readLocalConfig(dataDir) {
  const configPath = join(dataDir, 'config', 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error(`Local config is invalid JSON: ${configPath}`);
  }
}

function assertSafeDerivedTree(dataDir, candidate, vault, { recursive = true } = {}) {
  if (!existsSync(candidate)) return;
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error('Derived data paths must not use symbolic links or junctions.');
  const real = realpathSync.native(candidate);
  if (!isPathInside(dataDir, real) || isPathInside(vault, real) || isPathInside(real, vault)) {
    throw new Error('Derived data path escapes its isolated data directory.');
  }
  if (!recursive || !stat.isDirectory()) return;
  for (const entry of readdirSync(real, { withFileTypes: true })) {
    assertSafeDerivedTree(dataDir, join(real, entry.name), vault, { recursive: true });
  }
}

function assertSafeDerivedRoots(dataDir, vault) {
  assertSafeDerivedTree(dataDir, dataDir, vault, { recursive: false });
  if (!existsSync(dataDir)) return;
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    assertSafeDerivedTree(dataDir, join(dataDir, entry.name), vault, { recursive: false });
  }
}

export function resolveRuntimeConfig(options = {}) {
  // Resolve and validate the relationship before creating any derived-data path.
  const requestedDataDir = resolve(options.dataDir || process.env.SECOND_BRAIN_DATA_DIR || DEFAULT_DATA_DIR);
  const dataDir = resolveDataDir(options.dataDir, { create: false });
  const localConfig = readLocalConfig(dataDir);
  const structure = resolveStructure(localConfig.structure);
  const vaultInput = options.vault || process.env.SECOND_BRAIN_VAULT || localConfig.vault;
  const requestedVault = vaultInput ? resolve(vaultInput) : vaultInput;
  const vault = assertVault(vaultInput, structure.vaultRuleFile);
  if (isPathInside(requestedVault, requestedDataDir)
    || isPathInside(requestedDataDir, requestedVault)
    || isPathInside(vault, requestedDataDir)
    || isPathInside(requestedDataDir, vault)
    || isPathInside(vault, dataDir)
    || isPathInside(dataDir, vault)) {
    throw new Error('Derived data directory and vault must not contain one another.');
  }

  const indexDir = join(dataDir, 'index');
  const auditDir = join(dataDir, 'audit');
  const candidatesDir = join(dataDir, 'candidates');
  const backupsDir = join(dataDir, 'backups');
  const configDir = join(dataDir, 'config');
  const protectedTrees = [indexDir, auditDir, candidatesDir, configDir];
  assertSafeDerivedRoots(dataDir, vault);
  for (const dir of protectedTrees) assertSafeDerivedTree(dataDir, dir, vault);
  assertSafeDerivedTree(dataDir, backupsDir, vault, { recursive: false });
  if (options.createDataDir !== false) {
    for (const dir of [indexDir, auditDir, candidatesDir, backupsDir, configDir]) {
      mkdirSync(dir, { recursive: true });
    }
    assertSafeDerivedRoots(dataDir, vault);
    for (const dir of protectedTrees) assertSafeDerivedTree(dataDir, dir, vault);
    assertSafeDerivedTree(dataDir, backupsDir, vault, { recursive: false });
  }

  return {
    vault,
    dataDir,
    indexDir,
    auditDir,
    candidatesDir,
    backupsDir,
    configDir,
    structure,
    dbPath: join(indexDir, 'qmd.sqlite'),
    metadataPath: join(indexDir, 'metadata.json'),
    semanticDbPath: join(indexDir, 'semantic.sqlite'),
    semanticMetadataPath: join(indexDir, 'semantic-metadata.json'),
    semanticPython: process.env.SECOND_BRAIN_PYTHON || (process.platform === 'win32'
      ? join(dataDir, 'runtime', '.venv', 'Scripts', 'python.exe')
      : join(dataDir, 'runtime', '.venv', 'bin', 'python')),
  };
}

export function assertSourcePath(vault, candidate) {
  if (!candidate) throw new Error('Source path is required.');
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(vault, candidate);
  if (!existsSync(absolute)) throw new Error(`Source file does not exist: ${absolute}`);
  const real = realpathSync.native(absolute);
  if (!isPathInside(vault, real)) throw new Error(`Source escapes vault: ${candidate}`);
  if (!real.toLowerCase().endsWith('.md')) throw new Error(`Source must be Markdown: ${candidate}`);
  return real;
}

export function ensureParent(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function toVaultRelative(vault, filePath) {
  const real = assertSourcePath(vault, filePath);
  return relative(vault, real).split(sep).join('/');
}
