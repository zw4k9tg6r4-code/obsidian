import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1));
const ignored = new Set(['node_modules', '.git', 'coverage', 'dist', 'package-stage', 'private-eval']);
const textExtensions = new Set(['.js', '.mjs', '.json', '.md', '.ps1', '.cmd', '.yaml', '.yml', '.txt', '.gitattributes', '.gitignore']);
const forbidden = [
  { name: 'personal Windows path', pattern: new RegExp('C:\\\\' + 'Users\\\\', 'i') },
  { name: 'Unix user profile path', pattern: new RegExp('/(?:' + 'Users|home)/[^/\\s]+/', 'i') },
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'common access token', pattern: /\b(?:ghp|gho|github_pat|xox[baprs]|sk)-[-_A-Za-z0-9]{10,}\b/ },
];

function walk(dir, output = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, output);
    else if (entry.isFile()) output.push(full);
  }
  return output;
}

const failures = [];
for (const file of walk(root)) {
  const rel = relative(root, file).replaceAll('\\', '/');
  const size = statSync(file).size;
  if (size > 1024 * 1024) failures.push(`${rel}: file exceeds 1 MiB release limit`);
  const extension = extname(file).toLowerCase();
  const name = rel.split('/').at(-1);
  if (!textExtensions.has(extension) && !['LICENSE', '.gitignore', '.gitattributes'].includes(name)) continue;
  const text = readFileSync(file, 'utf8');
  if (rel !== 'scripts/check.mjs') {
    for (const rule of forbidden) if (rule.pattern.test(text)) failures.push(`${rel}: ${rule.name}`);
  }
  if (extension === '.js' || extension === '.mjs') {
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (check.status !== 0) failures.push(`${rel}: syntax check failed: ${check.stderr.trim()}`);
  }
  if (extension === '.json') {
    try { JSON.parse(text); } catch (error) { failures.push(`${rel}: invalid JSON: ${error.message}`); }
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.private !== true) failures.push('package.json: private must be true to block accidental npm publishing');
if (pkg.dependencies?.['@tobilu/qmd'] !== '2.5.3') failures.push('package.json: QMD must be pinned exactly to 2.5.3');
if (pkg.dependencies?.['@modelcontextprotocol/sdk'] !== '1.29.0') failures.push('package.json: MCP SDK must be pinned exactly to 1.29.0');
if (pkg.config?.nodeLlamaCppPostinstall !== 'skip') failures.push('package.json: node-llama-cpp postinstall must be skipped for safe installation');
const semanticRequirements = readFileSync(join(root, 'requirements-semantic.txt'), 'utf8');
if (!/^fastembed==0\.8\.0$/m.test(semanticRequirements)) failures.push('requirements-semantic.txt: FastEmbed must be pinned exactly to 0.8.0');
if (!/^onnxruntime==1\.20\.1; platform_system == "Windows"$/m.test(semanticRequirements)) {
  failures.push('requirements-semantic.txt: Windows ONNX Runtime must be pinned exactly to 1.20.1');
}

const selfGuidedFiles = ['AGENTS.md', 'START-HERE.md', 'INSTALL.cmd'];
const selfGuidedPresent = selfGuidedFiles.filter((file) => existsSync(join(root, file)));
if (selfGuidedPresent.length > 0 && selfGuidedPresent.length !== selfGuidedFiles.length) {
  failures.push('self-guided installer: AGENTS.md, START-HERE.md, and INSTALL.cmd must be present together');
}
if (selfGuidedPresent.length === selfGuidedFiles.length) {
  const installerAgents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  if (!installerAgents.includes('install-wizard.ps1') || !installerAgents.includes('-PlanOnly') || !installerAgents.includes('-IndexMode lexical')) {
    failures.push('AGENTS.md: self-guided install route is incomplete');
  }
  const launcher = readFileSync(join(root, 'INSTALL.cmd'), 'utf8');
  if (!/%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/i.test(launcher) ||
      !/%INSTALLER_ROOT%scripts\\install-wizard\.ps1/i.test(launcher) ||
      !/exit \/b %INSTALL_EXIT%/i.test(launcher) ||
      /%\*|Invoke-Expression|\biex\b/i.test(launcher)) {
    failures.push('INSTALL.cmd: launcher must use only the fixed package-relative wizard and preserve its exit code');
  }
}

const skillPath = join(root, 'skill', 'obsidian-second-brain', 'SKILL.md');
const skillText = readFileSync(skillPath, 'utf8');
const frontmatterMatch = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!frontmatterMatch) failures.push('skill/obsidian-second-brain/SKILL.md: missing YAML frontmatter');
else {
  try {
    const frontmatter = YAML.parse(frontmatterMatch[1]);
    if (frontmatter?.name !== 'obsidian-second-brain' || !frontmatter?.description) {
      failures.push('skill/obsidian-second-brain/SKILL.md: invalid name or description');
    }
  } catch (error) {
    failures.push(`skill/obsidian-second-brain/SKILL.md: invalid YAML: ${error.message}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Static checks passed.');
