#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveRuntimeConfig, assertSourcePath, toVaultRelative } from './config.js';
import { discoverProjects } from './vault.js';
import { indexVault, publicHealth, readHealth, QMD_VERSION } from './qmd-adapter.js';
import { searchSecondBrain } from './retrieval.js';
import { activateCandidate, addCandidate, confirmCandidate, listCandidates, markCandidate } from './candidates.js';
import { VERSION } from './version.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf('=');
    if (equals !== -1) {
      flags[raw.slice(0, equals)] = raw.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[raw] = next;
      index += 1;
    } else {
      flags[raw] = true;
    }
  }
  return { positional, flags };
}

function option(flags, ...names) {
  for (const name of names) if (flags[name] !== undefined) return flags[name];
  return undefined;
}

function runtimeOptions(flags) {
  return { vault: option(flags, 'vault'), dataDir: option(flags, 'data-dir') };
}

function printHuman(command, value) {
  if (command === 'search') {
    console.log(`[${value.decision}] ${value.reason}`);
    if (value.degraded) console.log(`degraded: ${value.degradedReason}`);
    for (const item of value.evidence) {
      console.log(`- ${item.path}:${item.lineStart} [${item.authority}/${item.state}/${item.matchType}]`);
      console.log(`  ${item.snippet.replace(/\s+/g, ' ').slice(0, 240)}`);
    }
    console.log(`trace: ${value.traceId}`);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function help() {
  console.log(`Codex Obsidian Second Brain v${VERSION} (QMD ${QMD_VERSION})

Usage:
  sbrain index [--vault PATH] [--semantic]
  sbrain search --query TEXT [--project NAME] [--time current|history] [--max-evidence 4]
  sbrain health [--vault PATH]
  sbrain projects [--vault PATH]
  sbrain source-hash --path FILE [--vault PATH]
  sbrain candidate add --content TEXT --scope PROJECT [--source-ref FILE]
  sbrain candidate confirm --id ID (--user-confirmed | --source-ref FILE)
  sbrain candidate activate --id ID --target FILE --expected-hash SHA256 [--supersedes ID]
  sbrain candidate mark --id ID --status expired|disputed [--reason TEXT]
  sbrain candidate list [--status STATE]

Global:
  --data-dir PATH   Derived state outside the vault
  --json            Machine-readable output
`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || flags.help || command === 'help') {
    help();
    return;
  }
  let result;
  if (command === 'index') {
    const config = resolveRuntimeConfig(runtimeOptions(flags));
    result = await indexVault(config, { semantic: flags.semantic === true });
  } else if (command === 'search') {
    result = await searchSecondBrain({
      ...runtimeOptions(flags),
      query: option(flags, 'query', 'q'),
      projectName: option(flags, 'project'),
      temporalIntent: option(flags, 'time') || 'current',
      maxEvidence: option(flags, 'max-evidence'),
      maxRelated: option(flags, 'max-related'),
      lexicalOnly: flags['lexical-only'] === true,
    });
  } else if (command === 'health') {
    result = publicHealth(await readHealth(resolveRuntimeConfig(runtimeOptions(flags))));
  } else if (command === 'projects') {
    const config = resolveRuntimeConfig({ ...runtimeOptions(flags), createDataDir: false });
    result = discoverProjects(config.vault).map(({ id, name, status, updated, mainObject }) => ({ id, name, status, updated, mainObject }));
  } else if (command === 'source-hash') {
    const config = resolveRuntimeConfig({ ...runtimeOptions(flags), createDataDir: false });
    const source = assertSourcePath(config.vault, option(flags, 'path'));
    result = {
      path: toVaultRelative(config.vault, source),
      sha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    };
  } else if (command === 'candidate') {
    const action = positional[1];
    const config = resolveRuntimeConfig(runtimeOptions(flags));
    if (action === 'add') {
      result = addCandidate(config, {
        content: option(flags, 'content'),
        scope: option(flags, 'scope'),
        sourceRef: option(flags, 'source-ref'),
      });
    } else if (action === 'confirm') {
      result = confirmCandidate(config, {
        id: option(flags, 'id'),
        userConfirmed: flags['user-confirmed'] === true,
        sourceRef: option(flags, 'source-ref'),
      });
    } else if (action === 'activate') {
      result = activateCandidate(config, {
        id: option(flags, 'id'),
        targetPath: option(flags, 'target'),
        expectedHash: option(flags, 'expected-hash'),
        supersedes: option(flags, 'supersedes'),
      });
    } else if (action === 'mark') {
      result = markCandidate(config, {
        id: option(flags, 'id'),
        status: option(flags, 'status'),
        reason: option(flags, 'reason'),
      });
    } else if (action === 'list') {
      result = listCandidates(config, { status: option(flags, 'status') });
    } else {
      throw new Error('Unknown candidate action.');
    }
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  if (flags.json) console.log(JSON.stringify(result));
  else printHuman(command, result);
  if (command === 'index' && flags.semantic === true && result.semantic?.ok !== true) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
