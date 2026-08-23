import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactLocalPaths, redactText, recordSearchAudit } from '../src/audit.js';

test('redactText strips common secret shapes', () => {
  const token = ['sk', 'abcdefghijklmnop1234'].join('-');
  assert.equal(redactText(`token ${token} end`), 'token [REDACTED] end');
  assert.match(redactText('api_key = example-value-123'), /^\[REDACTED\]$/);
  assert.match(redactText('password: dummy-hunter2'), /\[REDACTED\]/);
  const keyHeader = ['-----BEGIN RSA PRIVATE', 'KEY-----'].join(' ');
  assert.ok(redactText(keyHeader).includes('[REDACTED]'));
  assert.equal(redactText('普通中文内容保持不变'), '普通中文内容保持不变');
});

test('redactLocalPaths strips absolute filesystem locations', () => {
  const vault = String.raw`D:\Notes\Vault`;
  const raw = `无法读取 ${vault}${String.raw`\02-项目\a.md`}，数据库位于 ${String.raw`E:\data\qmd.sqlite`}`;
  const output = redactLocalPaths(raw, vault);
  assert.ok(!output.includes('D:\\Notes'));
  assert.ok(!output.includes('E:\\data'));
  assert.ok(!output.match(/[A-Za-z]:\\/));
  assert.ok(output.includes('[local-path]'));
  assert.equal(redactLocalPaths('普通原因'), '普通原因');
  assert.equal(redactLocalPaths(null), '');
});

test('search audit stores hashed queries and redacted reasons only', () => {
  const auditDir = mkdtempSync(join(tmpdir(), 'sbrain-audit-'));
  const traceId = recordSearchAudit({ auditDir }, {
    query: '价格是多少',
    decision: 'insufficient',
    reason: 'api_key=example-abcdef-123456',
    degradedReason: null,
    scope: { kind: 'global', project: null },
    temporalIntent: 'current',
    evidence: [],
  });
  const date = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(join(auditDir, `${date}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const record = lines.find((item) => item.traceId === traceId);
  assert.ok(record);
  assert.match(record.queryHash, /^[0-9a-f]{64}$/);
  assert.equal(record.reason, '[REDACTED]');
  assert.ok(!JSON.stringify(record).includes('价格是多少'));
});
