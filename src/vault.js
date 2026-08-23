import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import YAML from 'yaml';
import { isPathInside } from './config.js';
import { DEFAULT_STRUCTURE, braceGlob } from './structure.js';

export function parseMarkdown(filePath) {
  const text = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  let frontmatter = {};
  let body = text;
  if (text.startsWith('---')) {
    // The closing delimiter must be a whole `---` line; `----` rules or
    // `--- inline text` are body content, not frontmatter terminators.
    const rest = text.slice(3);
    const match = rest.match(/\r?\n---[ \t]*(?:\r?\n|$)/);
    if (match) {
      const raw = rest.slice(0, match.index).trim();
      try {
        frontmatter = YAML.parse(raw) || {};
      } catch {
        frontmatter = {};
      }
      body = rest.slice(match.index + match[0].length);
    }
  }
  return { text, body, frontmatter };
}

function extractIdentity(body, label) {
  const match = body.match(new RegExp(`^-\\s*${label}：\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() || '';
}

export function stableProjectId(name, portableIdentity) {
  const digest = createHash('sha256').update(`${name}\0${portableIdentity}`).digest('hex').slice(0, 12);
  return `project-${digest}`;
}

export function discoverProjects(vault, structure = DEFAULT_STRUCTURE) {
  const projectsRootCandidate = join(vault, structure.projectsDir);
  if (!existsSync(projectsRootCandidate) || lstatSync(projectsRootCandidate).isSymbolicLink()) return [];
  const projectsRoot = realpathSync.native(projectsRootCandidate);
  if (!isPathInside(vault, projectsRoot)) return [];

  const projects = [];
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const directoryCandidate = join(projectsRoot, entry.name);
    if (lstatSync(directoryCandidate).isSymbolicLink()) continue;
    const directory = realpathSync.native(directoryCandidate);
    if (!isPathInside(vault, directory)) continue;
    const homePath = join(directory, structure.projectHome);
    if (!existsSync(homePath) || lstatSync(homePath).isSymbolicLink()) continue;
    const { body, frontmatter } = parseMarkdown(homePath);
    const name = String(frontmatter.project || entry.name).trim();
    const status = String(frontmatter.status || 'unknown').trim().toLowerCase();
    projects.push({
      id: stableProjectId(name, entry.name),
      name,
      directory,
      homePath,
      status,
      updated: frontmatter.updated ? String(frontmatter.updated) : null,
      mainObject: extractIdentity(body, '主对象'),
      objectType: extractIdentity(body, '对象类型'),
      applicableScope: extractIdentity(body, '适用范围'),
      incompatible: extractIdentity(body, '不可混用'),
    });
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

export function projectForFile(projects, filePath) {
  return projects.find((project) => isPathInside(project.directory, filePath)) || null;
}

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function positiveMatch(query, project) {
  const q = normalize(query);
  const names = [project.name, project.mainObject]
    .map(normalize)
    .filter((value) => value.length >= 2);
  return names.some((value) => q.includes(value));
}

export function resolveProjectScope(projects, { projectName, query = '' } = {}) {
  if (projectName) {
    const wanted = normalize(projectName);
    const exact = projects.filter((project) => normalize(project.name) === wanted);
    if (exact.length === 1) {
      const contradiction = projects.filter((project) => project.id !== exact[0].id && positiveMatch(query, project));
      if (contradiction.length) {
        return {
          kind: 'ambiguous',
          project: null,
          candidates: [exact[0], ...contradiction].map((item) => ({ id: item.id, name: item.name, status: item.status })),
        };
      }
      return { kind: 'project', project: exact[0], candidates: [] };
    }
    const partial = projects.filter((project) => normalize(project.name).includes(wanted) || wanted.includes(normalize(project.name)));
    if (partial.length === 1) {
      const contradiction = projects.filter((project) => project.id !== partial[0].id && positiveMatch(query, project));
      if (contradiction.length) {
        return {
          kind: 'ambiguous',
          project: null,
          candidates: [partial[0], ...contradiction].map((item) => ({ id: item.id, name: item.name, status: item.status })),
        };
      }
      return { kind: 'project', project: partial[0], candidates: [] };
    }
    return {
      kind: partial.length > 1 ? 'ambiguous' : 'unknown',
      project: null,
      candidates: partial.map((item) => ({ id: item.id, name: item.name, status: item.status })),
    };
  }

  const matches = projects.filter((project) => positiveMatch(query, project));
  if (matches.length === 1) return { kind: 'project', project: matches[0], candidates: [] };
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      project: null,
      candidates: matches.map((item) => ({ id: item.id, name: item.name, status: item.status })),
    };
  }
  return { kind: 'global', project: null, candidates: [] };
}

function collection(name, path, pattern = '**/*.md', ignore = []) {
  return { name, path, pattern, ignore, includeByDefault: false };
}

export function buildCollections(vault, projects, structure = DEFAULT_STRUCTURE) {
  const safeCollectionPath = (candidate) => {
    if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink()) return null;
    const real = realpathSync.native(candidate);
    return isPathInside(vault, real) ? real : null;
  };
  const collections = [
    collection('global-root', vault, braceGlob(structure.homeNotes)),
    collection('global-governance', vault, braceGlob(structure.governanceFiles)),
    collection('global-memory', safeCollectionPath(join(vault, structure.memoryDir))),
    collection('global-workflows', safeCollectionPath(join(vault, structure.workflowDir))),
    collection('global-history', safeCollectionPath(join(vault, structure.conversationDir))),
  ].filter((item) => item.path && existsSync(item.path));

  for (const project of projects) {
    collections.push(collection(
      `${project.id}-current`,
      project.directory,
      '**/*.md',
      [`${structure.projectProcessDir}/**`]
    ));
    collections.push(collection(
      `${project.id}-history`,
      join(project.directory, structure.projectProcessDir),
      '**/*.md'
    ));
  }
  return collections.filter((item) => existsSync(item.path));
}

export function qmdConfig(vault, collections) {
  return {
    global_context: 'Local Obsidian second-brain Markdown. Treat retrieval scores as relevance only and open sources before factual use.',
    collections: Object.fromEntries(collections.map((item) => [item.name, {
      path: item.path,
      pattern: item.pattern,
      ignore: item.ignore,
      includeByDefault: false,
    }])),
  };
}

export function collectionsForScope(scope, temporalIntent = 'current') {
  const names = scope.kind === 'project'
    ? ['global-governance', 'global-workflows', `${scope.project.id}-current`]
    : ['global-root', 'global-memory', 'global-workflows'];
  if (temporalIntent === 'history') {
    if (scope.kind === 'project') names.push(`${scope.project.id}-history`);
    else names.push('global-history');
  }
  return names;
}

export function vaultStats(vault) {
  let markdownFiles = 0;
  let bytes = 0;
  const stats = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.obsidian') continue;
      const full = join(dir, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const real = realpathSync.native(full);
        if (isPathInside(vault, real)) walk(real);
      }
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        markdownFiles += 1;
        bytes += stat.size;
        stats.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  walk(vault);
  // The fingerprint only gates the disposable derived index, so path+size+mtime
  // is sufficient and avoids re-reading every file's content on each command.
  const digest = createHash('sha256');
  for (const item of stats.sort((a, b) => a.file.localeCompare(b.file, 'en'))) {
    digest.update(relative(vault, item.file).split(sep).join('/'));
    digest.update('\0');
    digest.update(`${item.size}`);
    digest.update('\0');
    digest.update(`${item.mtimeMs}`);
    digest.update('\0');
  }
  return { markdownFiles, bytes, contentHash: digest.digest('hex') };
}

export function assertSafeVaultTree(vault) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.obsidian') continue;
      const full = join(dir, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Vault contains a symbolic link or junction: ${relative(vault, full)}`);
      const real = realpathSync.native(full);
      if (!isPathInside(vault, real)) throw new Error(`Vault entry escapes the vault: ${relative(vault, full)}`);
      if (entry.isDirectory()) walk(real);
    }
  };
  walk(vault);
  return true;
}

export function vaultRelative(vault, path) {
  return relative(vault, path).split(sep).join('/');
}
