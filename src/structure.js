import { isAbsolute } from 'node:path';

// Single source of truth for every vault-structure convention the tool relies on.
// Every value is a vault-relative POSIX-style path. Overrides come from the
// optional `structure` section of config/config.json and are validated here.
export const DEFAULT_STRUCTURE = Object.freeze({
  projectsDir: '02-项目',
  projectHome: '项目主页.md',
  memoryDir: '01-长期记忆',
  conversationDir: '04-对话纪要',
  workflowDir: '05-工作流',
  vaultRuleFile: 'AGENTS.md',
  homeNotes: Object.freeze(['AGENTS.md', '首页.md']),
  governanceFiles: Object.freeze(['AGENTS.md', '01-长期记忆/用户档案.md', '01-长期记忆/合作规则.md']),
  projectInputDir: '01-输入',
  projectProcessDir: '02-过程',
  projectOutputDir: '03-输出',
  projectFeedbackDir: '04-反馈',
});

const LIST_KEYS = new Set(['homeNotes', 'governanceFiles']);

function assertRelativePath(key, value) {
  const normalized = String(value).replaceAll('\\', '/');
  if (isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')
    || normalized.split('/').includes('..') || normalized === '.') {
    throw new Error(`structure.${key} must be a relative path inside the vault: ${value}`);
  }
}

export function resolveStructure(overrides) {
  if (!overrides) return DEFAULT_STRUCTURE;
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('structure config must be an object.');
  }
  const merged = {
    ...DEFAULT_STRUCTURE,
    homeNotes: [...DEFAULT_STRUCTURE.homeNotes],
    governanceFiles: [...DEFAULT_STRUCTURE.governanceFiles],
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULT_STRUCTURE)) throw new Error(`Unknown structure key: ${key}`);
    if (LIST_KEYS.has(key)) {
      if (!Array.isArray(value) || !value.length) {
        throw new Error(`structure.${key} must be a non-empty array of vault-relative paths.`);
      }
      for (const item of value) {
        const text = String(item ?? '').trim();
        if (!text) throw new Error(`structure.${key} must not contain empty paths.`);
        assertRelativePath(key, text);
        merged[key].push(text);
      }
      merged[key] = [...new Set(merged[key])];
      continue;
    }
    const text = String(value ?? '').trim().replaceAll('\\', '/');
    if (!text) throw new Error(`structure.${key} must not be empty.`);
    assertRelativePath(key, text);
    merged[key] = text;
  }
  return merged;
}

export function braceGlob(paths) {
  return `{${[...paths].join(',')}}`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Paths under the conversation log directory or a project process directory
// are historical by default and excluded from current retrieval.
export function historicalPathPattern(structure = DEFAULT_STRUCTURE) {
  const names = [structure.conversationDir, structure.projectProcessDir]
    .map((name) => escapeRegex(name.replaceAll('\\', '/')));
  return new RegExp(`(^|/)(${names.join('|')})(/|$)`);
}
