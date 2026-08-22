import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { assertSourcePath, toVaultRelative } from './config.js';
import { writeJsonAtomic, withJsonLock } from './io.js';
import { recordCandidateAudit } from './audit.js';
import { authorityForPath } from './evidence.js';
import { discoverProjects, parseMarkdown, projectForFile } from './vault.js';

const ALLOWED_STATES = new Set(['candidate', 'confirmed', 'current', 'superseded', 'expired', 'disputed']);

function storePath(config) {
  return join(config.candidatesDir, 'records.json');
}

function lockPath(config) {
  return join(config.candidatesDir, 'records.lock');
}

function load(config) {
  const path = storePath(config);
  if (!existsSync(path)) return { schemaVersion: 1, records: [] };
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.records)) {
    // Quarantine the unreadable store instead of failing every command: the
    // derived queue is disposable, and the corrupt file is kept for inspection.
    const quarantine = join(config.candidatesDir, `records.corrupt-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`);
    try {
      renameSync(path, quarantine);
    } catch {
      // A concurrent writer may have replaced the file; proceed with a fresh store.
    }
    return { schemaVersion: 1, records: [], recoveredFrom: basename(quarantine) };
  }
  return parsed;
}

function save(config, store) {
  writeJsonAtomic(storePath(config), store);
}

function contentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function requireRecord(store, id) {
  const record = store.records.find((item) => item.id === id);
  if (!record) throw new Error(`Candidate not found: ${id}`);
  return record;
}

function normalizeProjectRef(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function requireProject(projects, reference) {
  const raw = String(reference || '').trim();
  if (!raw) throw new Error('Candidate project scope is required.');
  const wanted = normalizeProjectRef(raw);
  const matches = projects.filter((project) => project.id === raw || normalizeProjectRef(project.name) === wanted);
  if (matches.length !== 1) throw new Error('Candidate scope must identify exactly one existing project.');
  return matches[0];
}

function requireRecordProject(projects, record) {
  const project = record.projectId
    ? projects.find((item) => item.id === record.projectId)
    : requireProject(projects, record.scope);
  if (!project
    || (record.projectName && record.projectName !== project.name)
    || (record.scope && normalizeProjectRef(record.scope) !== normalizeProjectRef(project.name))) {
    throw new Error('Candidate is not bound to a valid project.');
  }
  record.projectId = project.id;
  record.projectName = project.name;
  record.scope = project.name;
  return project;
}

export function addCandidate(config, { content, scope, sourceRef, createdBy = 'ai' }) {
  const text = String(content || '').trim();
  if (!text) throw new Error('Candidate content is required.');
  const projects = discoverProjects(config.vault, config.structure);
  const project = requireProject(projects, scope);
  const hash = contentHash(text);
  return withJsonLock(lockPath(config), () => {
    const store = load(config);
    const duplicate = store.records.find((item) => (
      item.projectId === project.id
      || (!item.projectId && normalizeProjectRef(item.scope) === normalizeProjectRef(project.name))
    ) && item.contentHash === hash && !['expired', 'superseded'].includes(item.status));
    if (duplicate) {
      requireRecordProject(projects, duplicate);
      save(config, store);
      return { created: false, record: duplicate };
    }

    const sourceRefs = [];
    if (sourceRef) {
      const source = assertSourcePath(config.vault, sourceRef);
      const sourceProject = projectForFile(projects, source);
      if (sourceProject && sourceProject.id !== project.id) {
        throw new Error('Candidate source belongs to a different project scope.');
      }
      sourceRefs.push(toVaultRelative(config.vault, source));
    }
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      scope: project.name,
      projectId: project.id,
      projectName: project.name,
      content: text,
      contentHash: hash,
      status: 'candidate',
      createdBy,
      createdAt: now,
      updatedAt: now,
      sourceRefs,
      confirmation: null,
      currentSource: null,
      supersedes: null,
      history: [{ at: now, from: null, to: 'candidate' }],
    };
    store.records.push(record);
    save(config, store);
    recordCandidateAudit(config, { candidateId: record.id, from: null, to: 'candidate', sourceRefs });
    return { created: true, record };
  });
}

export function confirmCandidate(config, { id, userConfirmed = false, sourceRef }) {
  if (!userConfirmed && !sourceRef) {
    throw new Error('Confirmation requires explicit user confirmation or an authoritative Markdown source.');
  }
  const projects = discoverProjects(config.vault, config.structure);
  return withJsonLock(lockPath(config), () => {
    const store = load(config);
    const record = requireRecord(store, id);
    const project = requireRecordProject(projects, record);
    if (record.status !== 'candidate') throw new Error(`Only candidate records can be confirmed; current status is ${record.status}.`);

    let confirmationType;
    let normalizedSource = null;
    if (sourceRef) {
      const source = assertSourcePath(config.vault, sourceRef);
      normalizedSource = toVaultRelative(config.vault, source);
      const authority = authorityForPath(normalizedSource, config.structure);
      if (authority.score < 70) throw new Error('Confirmation source is not authoritative enough.');
      const parsed = parseMarkdown(source);
      const state = String(parsed.frontmatter.state || parsed.frontmatter.fact_status || 'current').toLowerCase();
      if (['superseded', 'expired', 'disputed', 'candidate'].includes(state)) {
        throw new Error(`Confirmation source is not current; source state is ${state}.`);
      }
      if (!parsed.text.includes(record.content)) {
        throw new Error('Authoritative confirmation source does not contain the candidate content.');
      }
      const sourceProject = projectForFile(projects, source);
      if (!sourceProject || sourceProject.id !== project.id) {
        throw new Error('Confirmation source must belong to the candidate bound project.');
      }
      confirmationType = 'authoritative-source';
    } else {
      confirmationType = 'explicit-user';
    }
    const now = new Date().toISOString();
    record.status = 'confirmed';
    record.updatedAt = now;
    record.confirmation = { type: confirmationType, at: now, sourceRef: normalizedSource };
    if (normalizedSource && !record.sourceRefs.includes(normalizedSource)) record.sourceRefs.push(normalizedSource);
    record.history.push({ at: now, from: 'candidate', to: 'confirmed', confirmationType });
    save(config, store);
    recordCandidateAudit(config, {
      candidateId: id,
      from: 'candidate',
      to: 'confirmed',
      confirmationType,
      sourceRefs: record.sourceRefs,
    });
    return record;
  });
}

export function activateCandidate(config, { id, targetPath, expectedHash, supersedes }) {
  const projects = discoverProjects(config.vault, config.structure);
  return withJsonLock(lockPath(config), () => {
    const store = load(config);
    const record = requireRecord(store, id);
    const project = requireRecordProject(projects, record);
    if (record.status !== 'confirmed') throw new Error(`Only confirmed records can become current; current status is ${record.status}.`);
    const source = assertSourcePath(config.vault, targetPath);
    const targetProject = projectForFile(projects, source);
    if (!targetProject || targetProject.id !== project.id) {
      throw new Error('Activation target must belong to the candidate bound project.');
    }
    const sourceText = readFileSync(source, 'utf8');
    const actualHash = contentHash(sourceText);
    if (!expectedHash || actualHash !== expectedHash) throw new Error('Target Markdown hash does not match the verified write hash.');
    if (!sourceText.includes(record.content)) throw new Error('Target Markdown does not contain the confirmed candidate content.');

    const now = new Date().toISOString();
    if (supersedes) {
      const old = requireRecord(store, supersedes);
      const oldProject = requireRecordProject(projects, old);
      if (oldProject.id !== project.id) throw new Error('A candidate cannot supersede a record from another project.');
      if (old.status !== 'current') throw new Error(`Superseded record must be current; found ${old.status}.`);
      old.status = 'superseded';
      old.updatedAt = now;
      old.history.push({ at: now, from: 'current', to: 'superseded', replacedBy: id });
      record.supersedes = old.id;
    }
    record.status = 'current';
    record.updatedAt = now;
    record.currentSource = {
      path: toVaultRelative(config.vault, source),
      contentHash: actualHash,
      verifiedAt: now,
    };
    record.history.push({ at: now, from: 'confirmed', to: 'current' });
    save(config, store);
    recordCandidateAudit(config, {
      candidateId: id,
      from: 'confirmed',
      to: 'current',
      confirmationType: record.confirmation?.type,
      sourceRefs: [...record.sourceRefs, record.currentSource.path],
    });
    return record;
  });
}

export function markCandidate(config, { id, status, reason = '' }) {
  if (!['expired', 'disputed'].includes(status)) throw new Error('Manual status must be expired or disputed.');
  return withJsonLock(lockPath(config), () => {
    const store = load(config);
    const record = requireRecord(store, id);
    if (!ALLOWED_STATES.has(record.status)) throw new Error(`Invalid current state: ${record.status}`);
    const from = record.status;
    const now = new Date().toISOString();
    record.status = status;
    record.updatedAt = now;
    record.history.push({ at: now, from, to: status, reason: String(reason).slice(0, 300) });
    save(config, store);
    recordCandidateAudit(config, { candidateId: id, from, to: status, sourceRefs: record.sourceRefs });
    return record;
  });
}

export function listCandidates(config, { status } = {}) {
  const records = load(config).records;
  return status ? records.filter((item) => item.status === status) : records;
}
