import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonLine } from './io.js';
import { epochToIsoOrNull, isStrictRfc3339DateTime } from './validation.js';

const SECRET_PATTERNS = [
  // GitHub / OpenAI / Slack / Generic tokens
  /\b(?:sk|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs])-[-_A-Za-z0-9]{10,}\b/gi,
  // AWS Access Key ID
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Google API Key
  /\bAIza[0-9A-Za-z-_]{35}\b/g,
  // JWT Tokens
  /\beyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*\b/g,
  // Bearer Token
  /\bBearer\s+[a-zA-Z0-9_\-\.]{20,}\b/gi,
  // RSA / OpenSSH Private Keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  // Key-value credentials (EN + CN)
  /\b(?:api[_-]?key|token|password|secret|passwd|access[_-]?key|私钥|秘钥|密码|凭证)\s*[:=：]\s*\S+/gi,
];

export function redactText(value) {
  let output = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[REDACTED]');
  return output;
}

// Error strings surfaced to MCP clients must honor the same no-local-paths
// promise the health tool makes: replace absolute filesystem locations with
// opaque placeholders.
export function redactLocalPaths(value, ...knownRoots) {
  let output = String(value ?? '');
  for (const root of knownRoots.filter(Boolean)) {
    output = output.split(String(root)).join('[local-path]');
  }
  return output
    .replace(/\\\\[^\\/"\s]+\\[^"\s]*/g, '[local-path]')
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, '[local-path]')
    .replace(/\/(?:Users|home|tmp|var|opt|etc)\/[^\s"']*/g, '[local-path]');
}

export function hashQuery(query) {
  return createHash('sha256').update(String(query)).digest('hex');
}

function safeAuditSourceRefs(sourceRefs) {
  const output = new Set();
  for (const value of Array.isArray(sourceRefs) ? sourceRefs : []) {
    const normalized = String(value ?? '').trim().normalize('NFKC').replaceAll('\\', '/');
    if (!normalized) continue;
    if (/^sha256:[0-9a-f]{64}$/i.test(normalized)) {
      output.add(normalized.toLowerCase());
    } else {
      output.add(`sha256:${createHash('sha256').update(normalized).digest('hex')}`);
    }
    if (output.size >= 32) break;
  }
  return [...output];
}

export function recordSearchAudit(config, event) {
  const traceId = typeof event.traceId === 'string' && UUID_PATTERN.test(event.traceId.trim())
    ? event.traceId.trim()
    : deterministicUuid(String(event.traceId || randomUUID()));
  const temporalIntent = ['current', 'history'].includes(event.temporalIntent) ? event.temporalIntent : 'current';
  const scopeKind = ['project', 'global', 'ambiguous', 'unknown'].includes(event.scope?.kind)
    ? event.scope.kind
    : 'unknown';
  const decision = ['grounded', 'insufficient', 'conflict'].includes(event.decision)
    ? event.decision
    : 'insufficient';
  const record = {
    schemaVersion: 1,
    traceId,
    occurredAt: new Date().toISOString(),
    event: 'search',
    queryHash: hashQuery(event.query),
    queryLength: String(event.query || '').length,
    temporalIntent,
    scopeKind,
    projectId: typeof event.scope?.project?.id === 'string' ? event.scope.project.id : null,
    decision,
    reason: redactLocalPaths(redactText(event.reason), config.vault, config.dataDir).slice(0, 300),
    degraded: Boolean(event.degraded),
    degradedReason: event.degradedReason
      ? redactLocalPaths(redactText(event.degradedReason), config.vault, config.dataDir).slice(0, 300)
      : null,
    evidence: (event.evidence || []).slice(0, 6).map((item) => ({
      path: String(item.path || ''),
      lineStart: Number.isInteger(item.lineStart) && item.lineStart >= 1 ? item.lineStart : 1,
      lineEnd: Number.isInteger(item.lineEnd) && item.lineEnd >= 1 ? item.lineEnd : 1,
      authority: String(item.authority || 'unknown'),
      state: String(item.state || 'current'),
      matchType: String(item.matchType || 'unknown'),
      lexicalRank: Number.isInteger(item.lexicalRank) && item.lexicalRank >= 1 ? item.lexicalRank : null,
      vectorRank: Number.isInteger(item.vectorRank) && item.vectorRank >= 1 ? item.vectorRank : null,
      rrfScore: Number.isFinite(item.rrfScore) && item.rrfScore >= 0 ? item.rrfScore : 0,
      contentHash: /^[0-9a-f]{64}$/i.test(String(item.contentHash || ''))
        ? String(item.contentHash).toLowerCase()
        : createHash('sha256').update(String(item.contentHash || item.path || '')).digest('hex'),
    })).filter((item) => RELATIVE_MD_PATTERN.test(item.path.replaceAll('\\', '/'))),
  };
  const date = record.occurredAt.slice(0, 10);
  try {
    appendJsonLine(join(config.auditDir, `${date}.jsonl`), record);
  } catch {}
  return traceId;
}

function deterministicUuid(input) {
  const hash = createHash('sha256').update(String(input).trim()).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELATIVE_MD_PATTERN = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$)).+\.md$/;
const CANDIDATE_STATES = new Set(['candidate', 'confirmed', 'current', 'superseded', 'expired', 'disputed']);
const CONFIRMATION_TYPES = new Set(['explicit-user', 'authoritative-source']);

function hasOnlyKeys(value, allowed) {
  return value && typeof value === 'object'
    && Object.keys(value).every((key) => allowed.has(key));
}

function isValidAuditEvidence(item) {
  const allowed = new Set([
    'path', 'lineStart', 'lineEnd', 'authority', 'state', 'matchType',
    'lexicalRank', 'vectorRank', 'rrfScore', 'contentHash',
  ]);
  return hasOnlyKeys(item, allowed)
    && RELATIVE_MD_PATTERN.test(String(item.path || '').replaceAll('\\', '/'))
    && Number.isInteger(item.lineStart) && item.lineStart >= 1
    && Number.isInteger(item.lineEnd) && item.lineEnd >= 1
    && typeof item.authority === 'string' && item.authority.length > 0
    && typeof item.state === 'string' && item.state.length > 0
    && typeof item.matchType === 'string' && item.matchType.length > 0
    && (item.lexicalRank === null || (Number.isInteger(item.lexicalRank) && item.lexicalRank >= 1))
    && (item.vectorRank === null || (Number.isInteger(item.vectorRank) && item.vectorRank >= 1))
    && Number.isFinite(item.rrfScore) && item.rrfScore >= 0
    && /^[0-9a-f]{64}$/i.test(item.contentHash);
}

export function isValidAuditRecord(record) {
  if (!record || typeof record !== 'object' || record.schemaVersion !== 1) return false;
  if (!UUID_PATTERN.test(String(record.traceId || '')) || !isStrictRfc3339DateTime(record.occurredAt)) return false;

  if (record.event === 'candidate-transition') {
    const allowed = new Set([
      'schemaVersion', 'traceId', 'eventId', 'occurredAt', 'event', 'candidateId',
      'from', 'to', 'confirmationType', 'confirmedBy', 'sourceRefs',
    ]);
    return hasOnlyKeys(record, allowed)
      && UUID_PATTERN.test(String(record.eventId || ''))
      && UUID_PATTERN.test(String(record.candidateId || ''))
      && (record.from === null || CANDIDATE_STATES.has(record.from))
      && CANDIDATE_STATES.has(record.to)
      && (record.confirmationType === null || CONFIRMATION_TYPES.has(record.confirmationType))
      && (record.confirmedBy === null
        || (typeof record.confirmedBy === 'string'
          && record.confirmedBy.trim().length > 0
          && record.confirmedBy.length <= 100))
      && Array.isArray(record.sourceRefs) && record.sourceRefs.length <= 32
      && new Set(record.sourceRefs).size === record.sourceRefs.length
      && record.sourceRefs.every((ref) => /^sha256:[0-9a-f]{64}$/.test(ref)
        || RELATIVE_MD_PATTERN.test(String(ref).replaceAll('\\', '/')));
  }

  if (record.event === 'search') {
    const allowed = new Set([
      'schemaVersion', 'traceId', 'occurredAt', 'event', 'queryHash', 'queryLength',
      'temporalIntent', 'scopeKind', 'projectId', 'decision', 'reason', 'degraded',
      'degradedReason', 'evidence',
    ]);
    return hasOnlyKeys(record, allowed)
      && /^[0-9a-f]{64}$/i.test(String(record.queryHash || ''))
      && Number.isInteger(record.queryLength) && record.queryLength >= 0
      && ['current', 'history'].includes(record.temporalIntent)
      && ['project', 'global', 'ambiguous', 'unknown'].includes(record.scopeKind)
      && (record.projectId === null || typeof record.projectId === 'string')
      && ['grounded', 'insufficient', 'conflict'].includes(record.decision)
      && typeof record.reason === 'string' && record.reason.length <= 300
      && typeof record.degraded === 'boolean'
      && (record.degradedReason === null
        || (typeof record.degradedReason === 'string' && record.degradedReason.length <= 300))
      && Array.isArray(record.evidence) && record.evidence.length <= 6
      && record.evidence.every(isValidAuditEvidence);
  }

  return false;
}

function normalizeCandidateTransition(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.event !== undefined && event.event !== 'candidate-transition') return null;
  if (!CANDIDATE_STATES.has(event.to)) return null;
  if (event.from !== undefined && event.from !== null && !CANDIDATE_STATES.has(event.from)) return null;
  if (event.confirmationType !== undefined && event.confirmationType !== null
    && !CONFIRMATION_TYPES.has(event.confirmationType)) return null;

  const rawOccurredAt = event.occurredAt ?? event.at;
  const stableOccurredAt = isStrictRfc3339DateTime(rawOccurredAt)
    ? rawOccurredAt.trim()
    : (epochToIsoOrNull(rawOccurredAt) || '1970-01-01T00:00:00.000Z');
  const traceId = typeof event.traceId === 'string' && UUID_PATTERN.test(event.traceId.trim())
    ? event.traceId.trim()
    : deterministicUuid(String(event.traceId || randomUUID()));
  const candidateId = typeof event.candidateId === 'string' && UUID_PATTERN.test(event.candidateId.trim())
    ? event.candidateId.trim()
    : deterministicUuid(String(event.candidateId || randomUUID()));
  const eventId = typeof event.eventId === 'string' && UUID_PATTERN.test(event.eventId.trim())
    ? event.eventId.trim()
    : deterministicUuid(JSON.stringify({
        traceId,
        candidateId,
        from: event.from ?? null,
        to: event.to,
        occurredAt: stableOccurredAt,
        event: 'candidate-transition',
      }));

  const record = {
    schemaVersion: 1,
    traceId,
    eventId,
    occurredAt: stableOccurredAt,
    event: 'candidate-transition',
    candidateId,
    from: event.from ?? null,
    to: event.to,
    confirmationType: event.confirmationType ?? null,
    confirmedBy: typeof event.confirmedBy === 'string' && event.confirmedBy.trim()
      ? event.confirmedBy.trim().slice(0, 100)
      : null,
    sourceRefs: safeAuditSourceRefs(event.sourceRefs),
  };
  return isValidAuditRecord(record) ? record : null;
}

export function flushCandidateAudits(config, events) {
  if (!Array.isArray(events) || events.length === 0) return true;
  const normalizedEvents = events.map(normalizeCandidateTransition);
  if (normalizedEvents.some((event) => event === null)) return false;
  const existingEventIds = new Set();
  let scanDegraded = false;
  if (existsSync(config.auditDir)) {
    try {
      const files = readdirSync(config.auditDir).filter((f) => f.endsWith('.jsonl'));
      for (const file of files) {
        try {
          const filePath = join(config.auditDir, file);
          const lines = readFileSync(filePath, 'utf8').split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (!isValidAuditRecord(parsed)) {
                scanDegraded = true;
                continue;
              }
              if (parsed.event === 'candidate-transition') existingEventIds.add(parsed.eventId);
            } catch {
              scanDegraded = true;
            }
          }
        } catch {
          scanDegraded = true;
        }
      }
    } catch {
      scanDegraded = true;
    }
  }

  if (scanDegraded) {
    // Fail closed: an unreadable audit partition prevents strict idempotence.
    // Do not append events and do not clear Outbox.
    return false;
  }

  for (const record of normalizedEvents) {
    if (existingEventIds.has(record.eventId)) {
      continue; // Already flushed in this or another date partition, idempotent skip
    }
    const date = record.occurredAt.slice(0, 10);
    const auditFile = join(config.auditDir, `${date}.jsonl`);
    try {
      appendJsonLine(auditFile, record);
    } catch {
      return false;
    }
    existingEventIds.add(record.eventId);
  }
  return true;
}

export function recordCandidateAudit(config, event) {
  const traceId = event.traceId || randomUUID();
  const eventId = event.eventId || randomUUID();
  const occurredAt = isStrictRfc3339DateTime(event.occurredAt)
    ? event.occurredAt.trim()
    : new Date().toISOString();
  flushCandidateAudits(config, [{ ...event, traceId, eventId, occurredAt }]);
  return traceId;
}
