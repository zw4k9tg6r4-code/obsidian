import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendJsonLine } from './io.js';

const SECRET_PATTERNS = [
  /\b(?:sk|ghp|gho|github_pat|xox[baprs])-[-_A-Za-z0-9]{10,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
];

export function redactText(value) {
  let output = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[REDACTED]');
  return output;
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
  const traceId = event.traceId || randomUUID();
  const record = {
    schemaVersion: 1,
    traceId,
    occurredAt: new Date().toISOString(),
    event: 'search',
    queryHash: hashQuery(event.query),
    queryLength: String(event.query || '').length,
    temporalIntent: event.temporalIntent,
    scopeKind: event.scope?.kind || 'unknown',
    projectId: event.scope?.project?.id || null,
    decision: event.decision,
    reason: redactText(event.reason).slice(0, 300),
    degraded: Boolean(event.degraded),
    degradedReason: redactText(event.degradedReason || '').slice(0, 300) || null,
    evidence: (event.evidence || []).map((item) => ({
      path: item.path,
      lineStart: item.lineStart,
      lineEnd: item.lineEnd,
      authority: item.authority,
      state: item.state,
      matchType: item.matchType,
      lexicalRank: item.lexicalRank,
      vectorRank: item.vectorRank,
      rrfScore: item.rrfScore,
      contentHash: item.contentHash,
    })),
  };
  const date = record.occurredAt.slice(0, 10);
  appendJsonLine(join(config.auditDir, `${date}.jsonl`), record);
  return traceId;
}

export function recordCandidateAudit(config, event) {
  const traceId = randomUUID();
  const record = {
    schemaVersion: 1,
    traceId,
    occurredAt: new Date().toISOString(),
    event: 'candidate-transition',
    candidateId: event.candidateId,
    from: event.from,
    to: event.to,
    confirmationType: event.confirmationType || null,
    sourceRefs: safeAuditSourceRefs(event.sourceRefs),
  };
  const date = record.occurredAt.slice(0, 10);
  appendJsonLine(join(config.auditDir, `${date}.jsonl`), record);
  return traceId;
}
