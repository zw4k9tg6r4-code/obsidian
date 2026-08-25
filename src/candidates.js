import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { assertSourcePath, toVaultRelative } from './config.js';
import { writeJsonAtomic, withJsonLock } from './io.js';
import { flushCandidateAudits } from './audit.js';
import { authorityForPath } from './evidence.js';
import { discoverProjects, parseMarkdown, projectForFile } from './vault.js';
import { epochToIsoOrNull, isStrictRfc3339DateTime } from './validation.js';

const ALLOWED_STATES = new Set(['candidate', 'confirmed', 'current', 'superseded', 'expired', 'disputed']);

function storePath(config) {
  return join(config.candidatesDir, 'records.json');
}

function lockPath(config) {
  return join(config.candidatesDir, 'records.lock');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_ID_PATTERN = /^project-[0-9a-f]{12}$/;
const RELATIVE_MD_PATTERN = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$)).+\.md$/;
const ALLOWED_CONFIRMATION_TYPES = new Set(['explicit-user', 'authoritative-source']);

function deterministicUuid(input) {
  const hash = createHash('sha256').update(String(input).trim()).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function isValidIsoDate(val) {
  return isStrictRfc3339DateTime(val);
}

function sanitizeRecord(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id !== 'string' || !item.id.trim()) return null;
  if (!ALLOWED_STATES.has(item.status)) return null;

  const validId = UUID_PATTERN.test(item.id.trim())
    ? item.id.trim()
    : deterministicUuid(item.id.trim());

  const validCreatedAt = isValidIsoDate(item.createdAt)
    ? item.createdAt
    : new Date().toISOString();
  const validUpdatedAt = isValidIsoDate(item.updatedAt)
    ? item.updatedAt
    : validCreatedAt;

  const validProjectId = typeof item.projectId === 'string' && PROJECT_ID_PATTERN.test(item.projectId.trim())
    ? item.projectId.trim()
    : (typeof item.projectId === 'string' && item.projectId.trim()
        ? `project-${createHash('sha256').update(item.projectId.trim()).digest('hex').slice(0, 12)}`
        : `project-${createHash('sha256').update(String(item.scope || 'default')).digest('hex').slice(0, 12)}`);

  const cleanSourceRefs = Array.isArray(item.sourceRefs)
    ? [...new Set(item.sourceRefs.filter((ref) => typeof ref === 'string' && RELATIVE_MD_PATTERN.test(ref.replaceAll('\\', '/'))).map((ref) => ref.replaceAll('\\', '/')))]
    : [];

  let cleanConfirmation = null;
  if (item.confirmation && typeof item.confirmation === 'object') {
    const confType = ALLOWED_CONFIRMATION_TYPES.has(item.confirmation.type) ? item.confirmation.type : null;
    if (confType) {
      const confSource = typeof item.confirmation.sourceRef === 'string' && RELATIVE_MD_PATTERN.test(item.confirmation.sourceRef.replaceAll('\\', '/'))
        ? item.confirmation.sourceRef.replaceAll('\\', '/')
        : null;
      cleanConfirmation = {
        type: confType,
        at: isValidIsoDate(item.confirmation.at) ? item.confirmation.at : validUpdatedAt,
        sourceRef: confSource,
      };
    }
  }

  let cleanCurrentSource = null;
  if (item.currentSource && typeof item.currentSource === 'object' && typeof item.currentSource.path === 'string') {
    const normPath = item.currentSource.path.replaceAll('\\', '/');
    if (RELATIVE_MD_PATTERN.test(normPath)) {
      cleanCurrentSource = {
        path: normPath,
        contentHash: typeof item.currentSource.contentHash === 'string' && /^[0-9a-f]{64}$/.test(item.currentSource.contentHash)
          ? item.currentSource.contentHash
          : contentHash(item.content || ''),
        verifiedAt: isValidIsoDate(item.currentSource.verifiedAt)
          ? item.currentSource.verifiedAt
          : validUpdatedAt,
      };
    }
  }

  const cleanSupersedes = typeof item.supersedes === 'string' && UUID_PATTERN.test(item.supersedes.trim())
    ? item.supersedes.trim()
    : null;

  const rawHistory = Array.isArray(item.history)
    ? item.history.filter((h) => h && typeof h === 'object')
    : [];

  const cleanHistory = rawHistory.length > 0
    ? rawHistory.map((h) => {
        const from = ALLOWED_STATES.has(h.from) ? h.from : null;
        const to = ALLOWED_STATES.has(h.to) ? h.to : item.status;
        const confType = ALLOWED_CONFIRMATION_TYPES.has(h.confirmationType) ? h.confirmationType : undefined;
        const replacedBy = typeof h.replacedBy === 'string' && UUID_PATTERN.test(h.replacedBy.trim()) ? h.replacedBy.trim() : undefined;
        const reason = typeof h.reason === 'string' ? h.reason.slice(0, 300) : undefined;
        return {
          at: isValidIsoDate(h.at) ? h.at : validCreatedAt,
          from,
          to,
          ...(confType ? { confirmationType: confType } : {}),
          ...(replacedBy ? { replacedBy } : {}),
          ...(reason ? { reason } : {}),
        };
      })
    : [{ at: validCreatedAt, from: null, to: item.status }];

  const cleanCreatedBy = typeof item.createdBy === 'string' && item.createdBy.trim()
    ? item.createdBy.trim().slice(0, 100)
    : 'user';

  return {
    id: validId,
    scope: String(item.scope || '').trim().slice(0, 300) || 'default',
    projectId: validProjectId,
    projectName: String(item.projectName || item.scope || '').trim().slice(0, 300) || 'default',
    content: String(item.content || '').trim() || 'empty',
    contentHash: typeof item.contentHash === 'string' && /^[0-9a-f]{64}$/.test(item.contentHash)
      ? item.contentHash
      : contentHash(item.content || ''),
    status: item.status,
    createdBy: cleanCreatedBy,
    createdAt: validCreatedAt,
    updatedAt: validUpdatedAt,
    sourceRefs: cleanSourceRefs,
    confirmation: cleanConfirmation,
    currentSource: cleanCurrentSource,
    supersedes: cleanSupersedes,
    history: cleanHistory,
  };
}

function load(config) {
  const path = storePath(config);
  if (!existsSync(path)) return { schemaVersion: 1, records: [], pendingAudits: [] };
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
    const quarantine = join(config.candidatesDir, `records.corrupt-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`);
    try {
      renameSync(path, quarantine);
    } catch {}
    const fresh = { schemaVersion: 1, records: [], recoveredFrom: basename(quarantine), pendingAudits: [] };
    try { save(config, fresh); } catch {}
    return fresh;
  }

  let diskModified = false;

  if (parsed.schemaVersion !== 1) {
    parsed.schemaVersion = 1;
    diskModified = true;
  }

  if (!Array.isArray(parsed.pendingAudits)) {
    parsed.pendingAudits = [];
    diskModified = true;
  } else {
    const validPending = parsed.pendingAudits.filter((e) => e && typeof e === 'object' && Object.keys(e).length > 0);
    if (validPending.length !== parsed.pendingAudits.length) {
      parsed.pendingAudits = validPending;
      diskModified = true;
    }
  }

  // Deduplicate duplicate IDs based on latest updatedAt timestamp
  const recordsById = new Map();
  for (const raw of parsed.records) {
    const clean = sanitizeRecord(raw);
    if (!clean) {
      diskModified = true;
      continue;
    }
    if (JSON.stringify(clean) !== JSON.stringify(raw)) {
      diskModified = true;
    }
    if (!recordsById.has(clean.id)) {
      recordsById.set(clean.id, clean);
    } else {
      diskModified = true;
      const existing = recordsById.get(clean.id);
      const existingTime = Date.parse(existing.updatedAt || existing.createdAt || 0) || 0;
      const cleanTime = Date.parse(clean.updatedAt || clean.createdAt || 0) || 0;
      if (cleanTime > existingTime) {
        recordsById.set(clean.id, clean);
      } else if (cleanTime === existingTime) {
        if (clean.contentHash > existing.contentHash) {
          recordsById.set(clean.id, clean);
        }
      }
    }
  }
  const sanitized = Array.from(recordsById.values());
  if (sanitized.length !== parsed.records.length) {
    diskModified = true;
  }

  // Replay any pending audits from previous interrupted writes with stable eventId & occurredAt
  if (Array.isArray(parsed.pendingAudits) && parsed.pendingAudits.length > 0) {
    const migratedAudits = parsed.pendingAudits.map((evt) => {
      const rawOccurredAt = evt.occurredAt ?? evt.at;
      const stableOccurredAt = isStrictRfc3339DateTime(rawOccurredAt)
        ? rawOccurredAt.trim()
        : (epochToIsoOrNull(rawOccurredAt) || '1970-01-01T00:00:00.000Z');

      const traceId = (typeof evt.traceId === 'string' && UUID_PATTERN.test(evt.traceId.trim()))
        ? evt.traceId.trim()
        : deterministicUuid(String(evt.traceId || randomUUID()));

      const candidateId = (typeof evt.candidateId === 'string' && UUID_PATTERN.test(evt.candidateId.trim()))
        ? evt.candidateId.trim()
        : deterministicUuid(String(evt.candidateId || randomUUID()));

      const eventId = (typeof evt.eventId === 'string' && UUID_PATTERN.test(evt.eventId.trim()))
        ? evt.eventId.trim()
        : deterministicUuid(JSON.stringify({
            traceId,
            candidateId,
            from: evt.from || null,
            to: evt.to || null,
            occurredAt: stableOccurredAt,
            event: evt.event || 'candidate-transition',
          }));

      return {
        ...evt,
        traceId,
        candidateId,
        eventId,
        occurredAt: stableOccurredAt,
      };
    }).filter((evt) => evt.candidateId && evt.traceId);

    const flushSuccess = flushCandidateAudits(config, migratedAudits);
    if (flushSuccess) {
      parsed.pendingAudits = [];
      diskModified = true;
    }
  }

  const ALLOWED_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'records', 'pendingAudits', 'recoveredFrom']);
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      diskModified = true;
    }
  }

  let cleanRecoveredFrom = undefined;
  if ('recoveredFrom' in parsed) {
    if (typeof parsed.recoveredFrom === 'string' && parsed.recoveredFrom.trim()) {
      cleanRecoveredFrom = parsed.recoveredFrom.trim();
    } else {
      diskModified = true;
    }
  }

  const result = {
    schemaVersion: 1,
    records: sanitized,
    pendingAudits: parsed.pendingAudits || [],
    ...(cleanRecoveredFrom ? { recoveredFrom: cleanRecoveredFrom } : {}),
  };

  // If records were cleaned, repaired, deduplicated, or pending audits flushed, persist back to disk atomically
  if (diskModified) {
    save(config, result);
  }

  return result;
}

function save(config, store) {
  writeJsonAtomic(storePath(config), store);
}

function saveWithAudit(config, store, eventsToAudit = []) {
  if (eventsToAudit.length > 0) {
    const formattedEvents = eventsToAudit.map((evt) => ({
      ...evt,
      eventId: (typeof evt.eventId === 'string' && UUID_PATTERN.test(evt.eventId.trim())) ? evt.eventId.trim() : randomUUID(),
      occurredAt: isValidIsoDate(evt.occurredAt) ? evt.occurredAt : new Date().toISOString(),
    }));
    store.pendingAudits = [...(store.pendingAudits || []), ...formattedEvents];
  }
  save(config, store);
  if (store.pendingAudits && store.pendingAudits.length > 0) {
    const flushSuccess = flushCandidateAudits(config, store.pendingAudits);
    if (flushSuccess) {
      store.pendingAudits = [];
      save(config, store);
    }
  }
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

function requireRecordProject(projects, record, { allowOrphan = false } = {}) {
  const project = record.projectId
    ? projects.find((item) => item.id === record.projectId)
    : projects.find((item) => normalizeProjectRef(item.name) === normalizeProjectRef(record.scope));

  if (!project) {
    if (allowOrphan) return null;
    throw new Error('Candidate is not bound to a valid project.');
  }

  if ((record.projectName && normalizeProjectRef(record.projectName) !== normalizeProjectRef(project.name))
    || (record.scope && normalizeProjectRef(record.scope) !== normalizeProjectRef(project.name))) {
    if (allowOrphan) return null;
    throw new Error('Candidate is not bound to a valid project.');
  }

  record.projectId = project.id;
  record.projectName = project.name;
  record.scope = project.name;
  return project;
}

export function addCandidate(config, { content, scope, sourceRef, createdBy = 'ai', traceId }) {
  const text = String(content || '').trim();
  if (!text) throw new Error('Candidate content is required.');
  const effectiveTraceId = traceId || randomUUID();
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
      return { created: false, record: duplicate, traceId: effectiveTraceId };
    }

    const sourceRefs = [];
    if (sourceRef) {
      const source = assertSourcePath(config.vault, sourceRef);
      const sourceProject = projectForFile(projects, source);
      if (!sourceProject || sourceProject.id !== project.id) {
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
    saveWithAudit(config, store, [{
      traceId: effectiveTraceId,
      candidateId: record.id,
      from: null,
      to: 'candidate',
      sourceRefs,
    }]);

    return { created: true, record, traceId: effectiveTraceId };
  });
}

export function confirmCandidate(config, { id, userConfirmed = false, sourceRef, traceId }) {
  if (!userConfirmed && !sourceRef) {
    throw new Error('Confirmation requires explicit user confirmation or an authoritative Markdown source.');
  }
  const effectiveTraceId = traceId || randomUUID();
  const projects = discoverProjects(config.vault, config.structure);

  return withJsonLock(lockPath(config), () => {
    const store = load(config);
    const record = requireRecord(store, id);
    const project = requireRecordProject(projects, record);
    if (record.status !== 'candidate') {
      throw new Error(`Only candidates can be confirmed; current status is ${record.status}.`);
    }

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
    if (normalizedSource && !record.sourceRefs.includes(normalizedSource)) {
      record.sourceRefs.push(normalizedSource);
    }
    record.history.push({ at: now, from: 'candidate', to: 'confirmed', confirmationType });

    saveWithAudit(config, store, [{
      traceId: effectiveTraceId,
      candidateId: id,
      from: 'candidate',
      to: 'confirmed',
      confirmationType,
      sourceRefs: record.sourceRefs,
    }]);

    return { ...record, traceId: effectiveTraceId };
  });
}

export function activateCandidate(config, { id, targetPath, expectedHash, supersedes, traceId }) {
  const effectiveTraceId = traceId || randomUUID();
  const projects = discoverProjects(config.vault, config.structure);

  return withJsonLock(lockPath(config), () => {
    const store = load(config);
    const record = requireRecord(store, id);
    const project = requireRecordProject(projects, record);
    if (record.status !== 'confirmed') {
      throw new Error(`Only confirmed records can become current; current status is ${record.status}.`);
    }

    const source = assertSourcePath(config.vault, targetPath);
    const targetProject = projectForFile(projects, source);
    if (!targetProject || targetProject.id !== project.id) {
      throw new Error('Activation target must belong to the candidate bound project.');
    }
    const sourceText = readFileSync(source, 'utf8');
    const actualHash = contentHash(sourceText);
    if (!expectedHash || actualHash !== expectedHash) {
      throw new Error('Target Markdown hash does not match the verified write hash.');
    }
    if (!sourceText.includes(record.content)) {
      throw new Error('Target Markdown does not contain the confirmed candidate content.');
    }

    const eventsToAudit = [];
    const now = new Date().toISOString();
    if (supersedes) {
      if (supersedes === id) throw new Error('A candidate cannot supersede itself.');
      const old = requireRecord(store, supersedes);
      const oldProject = requireRecordProject(projects, old);
      if (oldProject.id !== project.id) {
        throw new Error('A candidate cannot supersede a record from another project.');
      }
      if (old.status !== 'current') {
        throw new Error(`Superseded record must be current; found ${old.status}.`);
      }

      old.status = 'superseded';
      old.updatedAt = now;
      old.currentSource = null;
      old.history.push({ at: now, from: 'current', to: 'superseded', replacedBy: id });
      record.supersedes = old.id;

      eventsToAudit.push({
        traceId: effectiveTraceId,
        candidateId: old.id,
        from: 'current',
        to: 'superseded',
        sourceRefs: old.sourceRefs,
      });
    }

    record.status = 'current';
    record.updatedAt = now;
    record.currentSource = {
      path: toVaultRelative(config.vault, source),
      contentHash: actualHash,
      verifiedAt: now,
    };
    record.history.push({ at: now, from: 'confirmed', to: 'current' });

    eventsToAudit.push({
      traceId: effectiveTraceId,
      candidateId: id,
      from: 'confirmed',
      to: 'current',
      confirmationType: record.confirmation?.type,
      sourceRefs: [...new Set([...record.sourceRefs, record.currentSource.path])],
    });

    saveWithAudit(config, store, eventsToAudit);

    return { ...record, traceId: effectiveTraceId };
  });
}

export function markCandidate(config, { id, status, reason = '', traceId }) {
  if (!['expired', 'disputed'].includes(status)) {
    throw new Error('Manual status must be expired or disputed.');
  }
  const effectiveTraceId = traceId || randomUUID();
  const projects = discoverProjects(config.vault, config.structure);

  return withJsonLock(lockPath(config), () => {
    const store = load(config);
    const record = requireRecord(store, id);
    requireRecordProject(projects, record);

    if (!ALLOWED_STATES.has(record.status)) {
      throw new Error(`Invalid current state: ${record.status}`);
    }
    if (record.status === 'superseded') {
      throw new Error('Cannot change status of a superseded record.');
    }
    if (record.status === status) {
      return { ...record, traceId: effectiveTraceId };
    }

    const from = record.status;
    const now = new Date().toISOString();
    record.status = status;
    record.updatedAt = now;
    if (from === 'current') {
      record.currentSource = null;
    }
    record.history.push({ at: now, from, to: status, reason: String(reason).slice(0, 300) });

    saveWithAudit(config, store, [{
      traceId: effectiveTraceId,
      candidateId: id,
      from,
      to: status,
      sourceRefs: record.sourceRefs,
    }]);

    return { ...record, traceId: effectiveTraceId };
  });
}

export function listCandidates(config, { status } = {}) {
  return withJsonLock(lockPath(config), () => {
    const records = load(config).records;
    return status ? records.filter((item) => item.status === status) : records;
  });
}
