import test from 'node:test';
import assert from 'node:assert/strict';
import { decideEvidence, extractFactRequests } from '../src/evidence.js';

test('P1-01: Cross-entity intent collisions strictly return insufficient', () => {
  const applePriceEvidence = {
    sourceOpened: true,
    authorityScore: 95,
    state: 'current',
    snippet: '苹果仓储服务费每吨 100 元',
    path: 'apple.md',
    title: '苹果项目主页',
    heading: '费用',
    projectId: 'p-apple',
  };
  const applePermissionEvidence = {
    sourceOpened: true,
    authorityScore: 95,
    state: 'current',
    snippet: '苹果项目管理员账号权限为 admin',
    path: 'apple-perm.md',
    title: '苹果项目主页',
    heading: '权限',
    projectId: 'p-apple',
  };
  const appleStatusEvidence = {
    sourceOpened: true,
    authorityScore: 95,
    state: 'current',
    snippet: '苹果项目当前运行状态为正式上线',
    path: 'apple-status.md',
    title: '苹果项目主页',
    heading: '状态',
    projectId: 'p-apple',
  };

  const scope = {
    kind: 'project',
    project: { name: '苹果仓储项目', mainObject: '仓储' },
  };

  // 1. 火星香蕉价格 vs 苹果仓储费用 -> insufficient
  const res1 = decideEvidence({
    query: '火星香蕉发动机的费用是多少？',
    evidence: [applePriceEvidence],
    scope,
    indexFresh: true,
  });
  assert.equal(res1.decision, 'insufficient', 'Unrelated entity query must not be grounded by matching price intent words');

  // 2. 火星香蕉权限 vs 苹果管理员权限 -> insufficient
  const res2 = decideEvidence({
    query: '火星香蕉发动机的账号权限是什么？',
    evidence: [applePermissionEvidence],
    scope,
    indexFresh: true,
  });
  assert.equal(res2.decision, 'insufficient', 'Unrelated entity query must not be grounded by matching permission intent words');

  // 3. 火星香蕉状态 vs 苹果项目状态 -> insufficient
  const res3 = decideEvidence({
    query: '火星香蕉发动机的运行状态是什么？',
    evidence: [appleStatusEvidence],
    scope,
    indexFresh: true,
  });
  assert.equal(res3.decision, 'insufficient', 'Unrelated entity query must not be grounded by matching status intent words');

  // 4. Same entity legitimate query -> grounded
  const res4 = decideEvidence({
    query: '苹果仓储的费用是多少？',
    evidence: [applePriceEvidence],
    scope,
    indexFresh: true,
  });
  assert.equal(res4.decision, 'grounded', 'Same entity query must be grounded');
});

test('P1-01: Weak authority evidence alone cannot produce grounded', () => {
  const weakEvidence = {
    sourceOpened: true,
    authorityScore: 45,
    state: 'current',
    snippet: '苹果仓储服务费每吨 100 元',
    path: 'notes.md',
    title: '过程纪要',
    heading: '费用',
    projectId: 'p-apple',
  };
  const scope = {
    kind: 'project',
    project: { name: '苹果仓储项目', mainObject: '仓储' },
  };

  const res = decideEvidence({
    query: '苹果仓储服务费',
    evidence: [weakEvidence],
    scope,
    indexFresh: true,
  });
  assert.equal(res.decision, 'insufficient', 'Weak authority score (45) cannot produce grounded');
  assert.match(res.reason, /lacks current authoritative evidence/);
});

test('P1-01: Split evidence across disparate documents cannot bypass entity binding', () => {
  const docA = {
    sourceOpened: true,
    authorityScore: 95,
    state: 'current',
    snippet: '火星香蕉发动机设计概览',
    path: 'engine.md',
    title: '发动机文档',
    heading: '概览',
    projectId: 'p-engine',
  };
  const docB = {
    sourceOpened: true,
    authorityScore: 95,
    state: 'current',
    snippet: '苹果仓储费用报价单 100 元',
    path: 'apple.md',
    title: '苹果费用',
    heading: '费用',
    projectId: 'p-apple',
  };
  const scope = {
    kind: 'project',
    project: { name: '发动机项目', mainObject: '发动机' },
  };

  const res = decideEvidence({
    query: '火星香蕉发动机费用是多少？',
    evidence: [docA, docB],
    scope,
    indexFresh: true,
  });
  assert.equal(res.decision, 'insufficient', 'Entity in docA + intent in docB must not produce grounded');
});

test('P1-01: Disputed and numeric conflicts on foreign entities do not mislead into conflict decision', () => {  const scope = {
    kind: 'project',
    project: { name: '火星项目', mainObject: '发动机' },
  };

  // 1. Foreign entity disputed evidence (apple storage)
  const disputedAppleEvidence = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'disputed',
    snippet: '苹果仓储费用方案存在争议：标准仓储服务费到底是100元还是120元待定。',
    path: 'x.md',
    title: '争议记录',
    heading: '费用争议',
    projectId: 'p-apple',
  };

  const resConflict = decideEvidence({
    query: '火星香蕉发动机的费用有冲突吗',
    evidence: [disputedAppleEvidence],
    scope,
    indexFresh: true,
  });
  assert.equal(resConflict.decision, 'insufficient', 'Disputed note about foreign entity (apple) must not produce conflict for mars engine query');

  // 2. Foreign entity conflicting numbers (apple storage 80 vs 120)
  const apple80 = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '苹果仓储当前服务费每吨 80 元',
    path: 'a.md',
    title: '方案A',
    heading: '费用',
    projectId: 'p-apple',
  };
  const apple120 = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '苹果仓储当前服务费每吨 120 元',
    path: 'b.md',
    title: '方案B',
    heading: '费用',
    projectId: 'p-apple',
  };

  const resNumericConflict = decideEvidence({
    query: '火星香蕉发动机的费用是多少',
    evidence: [apple80, apple120],
    scope,
    indexFresh: true,
  });
  assert.equal(resNumericConflict.decision, 'insufficient', 'Numeric disagreement about foreign entity must not produce conflict for mars engine query');

  // 3. Multi-entity partial coverage: Query mentions both 苹果仓储 and 火星香蕉发动机, but evidence only has 苹果仓储
  const resPartial = decideEvidence({
    query: '苹果仓储和火星香蕉发动机的费用分别是多少',
    evidence: [apple120],
    scope: { kind: 'global' },
    indexFresh: true,
  });
  assert.match(resPartial.reason, /lacks coverage for fact|partial queried entities/);
});

test('P1-01: Multi-entity complete evidence with distinct prices is grounded, not a numeric conflict', () => {
  // Two different queried entities, each with its own current price, inside
  // the same umbrella project: these are two facts, never one conflicting fact.
  const appleStoragePrice = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '苹果仓储当前费用 80 元',
    path: 'apple.md',
    title: '苹果仓储',
    heading: '费用',
    projectId: 'p-combined',
  };
  const marsEnginePrice = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '火星香蕉发动机当前费用 120 元',
    path: 'mars.md',
    title: '火星香蕉发动机',
    heading: '费用',
    projectId: 'p-combined',
  };

  const res = decideEvidence({
    query: '苹果仓储和火星香蕉发动机的费用分别是多少',
    evidence: [appleStoragePrice, marsEnginePrice],
    scope: { kind: 'global' },
    indexFresh: true,
  });
  assert.equal(res.decision, 'grounded', 'Per-entity prices with full multi-entity coverage must be grounded');
  assert.match(res.reason, /current authoritative source opened/);
});

test('P1-01: Shared category term (线路) multi-entity evidence is grounded, not conflict', () => {
  const beijingLine = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路费用 80 元',
    path: 'beijing.md',
    title: '北京线路',
    heading: '费用',
    projectId: 'p-transport',
  };
  const shanghaiLine = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '上海线路费用 120 元',
    path: 'shanghai.md',
    title: '上海线路',
    heading: '费用',
    projectId: 'p-transport',
  };

  const res = decideEvidence({
    query: '北京线路和上海线路的费用分别是多少？',
    evidence: [beijingLine, shanghaiLine],
    scope: { kind: 'global' },
    indexFresh: true,
  });
  assert.equal(res.decision, 'grounded', 'Different entities sharing category word 线路 must be grounded');
});

test('P1-01: Shared prefix and suffix (火星...发动机) multi-entity evidence is grounded', () => {
  const engine1 = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '火星一号发动机当前费用 80 元',
    path: 'engine1.md',
    title: '火星一号发动机',
    heading: '费用',
    projectId: 'p-mars',
  };
  const engine2 = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '火星二号发动机当前费用 120 元',
    path: 'engine2.md',
    title: '火星二号发动机',
    heading: '费用',
    projectId: 'p-mars',
  };

  const res = decideEvidence({
    query: '火星一号发动机和火星二号发动机的费用分别是多少',
    evidence: [engine1, engine2],
    scope: { kind: 'global' },
    indexFresh: true,
  });
  assert.equal(res.decision, 'grounded', 'Distinct engine models must not conflict despite sharing 火星 and 发动机');
});

test('P1-01: Same entity with two different current prices stays a numeric conflict', () => {
  const beijing80 = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路当前费用 80 元',
    path: 'a.md',
    title: '方案A',
    heading: '费用',
    projectId: 'p-transport',
  };
  const beijing120 = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路当前费用 120 元',
    path: 'b.md',
    title: '方案B',
    heading: '费用',
    projectId: 'p-transport',
  };

  const res = decideEvidence({
    query: '北京线路的费用是多少',
    evidence: [beijing80, beijing120],
    scope: { kind: 'global' },
    indexFresh: true,
  });
  assert.equal(res.decision, 'conflict', 'Two authoritative current prices for the SAME entity must conflict');
  assert.match(res.reason, /disagree on the same numeric fact/);
  assert.deepEqual(res.conflictEvidencePaths.sort(), ['a.md', 'b.md']);
});

test('P1-01: Natural language multi-entity phrasing matrix all resolve to grounded without false conflicts', () => {
  const beijingLine = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路当前服务费用为 80 元/吨',
    path: 'beijing.md',
    title: '北京线路方案',
    heading: '费用',
    projectId: 'p-transport',
  };
  const shanghaiLine = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '上海线路当前服务费用为 120 元/吨',
    path: 'shanghai.md',
    title: '上海线路方案',
    heading: '费用',
    projectId: 'p-transport',
  };

  const naturalQueries = [
    '北京线路的费用和上海线路的费用分别是多少',
    '北京线路费用、上海线路费用分别是多少',
    '北京线路跟上海线路的费用分别是多少',
    '北京线路还有上海线路的费用分别是多少',
    '对比北京线路和上海线路的费用',
    '北京、上海两条线路的费用分别是多少',
    '北京线路和上海线路各多少钱',
    '请问北京线路以及上海线路的最新报价是多少',
    '北京线路 vs 上海线路 费用是多少',
  ];

  for (const query of naturalQueries) {
    const res = decideEvidence({
      query,
      evidence: [beijingLine, shanghaiLine],
      scope: { kind: 'global' },
      indexFresh: true,
    });
    assert.equal(
      res.decision,
      'grounded',
      `Natural query "${query}" must resolve to grounded with full distinct entity evidence`
    );
  }
});

test('P1-01 Counterexample A: Entity-metric crossed mismatch strictly returns insufficient', () => {
  const beijingStatus = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路当前状态为停运',
    path: 'beijing.md',
    title: '北京线路',
    heading: '状态',
  };
  const shanghaiPrice = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '上海线路当前价格为 120 元',
    path: 'shanghai.md',
    title: '上海线路',
    heading: '价格',
  };

  const res = decideEvidence({
    query: '北京线路的价格和上海线路的状态分别是什么',
    evidence: [beijingStatus, shanghaiPrice],
    scope: { kind: 'global' },
    indexFresh: true,
  });
  assert.equal(res.decision, 'insufficient');
});

test('P1-01 Counterexample B: Low authority draft cannot satisfy a high-impact entity fact', () => {
  const beijingAuthoritative = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路当前费用为 80 元',
    path: 'beijing.md',
    title: '北京线路',
    heading: '费用',
  };
  const shanghaiDraft = {
    sourceOpened: true,
    authorityScore: 55,
    state: 'current',
    snippet: '上海线路当前费用为 120 元',
    path: 'shanghai-draft.md',
    title: '上海线路草案',
    heading: '费用',
  };

  const res = decideEvidence({
    query: '北京线路和上海线路的费用分别是多少',
    evidence: [beijingAuthoritative, shanghaiDraft],
    scope: { kind: 'global' },
    indexFresh: true,
  });
  assert.equal(res.decision, 'insufficient');
});

test('P1-01 Counterexample C: connector parsing does not clobber place or project names', () => {
  const taizhou = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '台州线路当前服务费用为 80 元',
    path: 'taizhou.md',
    title: '台州线路',
    heading: '费用',
  };
  const wenzhou = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '温州线路当前服务费用为 120 元',
    path: 'wenzhou.md',
    title: '温州线路',
    heading: '费用',
  };

  const res = decideEvidence({
    query: '台州线路和温州线路的费用分别是多少',
    evidence: [taizhou, wenzhou],
    scope: { kind: 'global' },
    indexFresh: true,
  });
  assert.equal(res.decision, 'grounded');

  assert.deepEqual(extractFactRequests('和田线路和喀什线路的费用分别是多少'), [
    { entity: '和田线路', metric: 'price' },
    { entity: '喀什线路', metric: 'price' },
  ]);
  assert.deepEqual(extractFactRequests('呼和浩特线路和乌鲁木齐线路的费用分别是多少'), [
    { entity: '呼和浩特线路', metric: 'price' },
    { entity: '乌鲁木齐线路', metric: 'price' },
  ]);
  assert.deepEqual(extractFactRequests('同城配送和跨城配送的费用分别是多少'), [
    { entity: '同城配送', metric: 'price' },
    { entity: '跨城配送', metric: 'price' },
  ]);
  assert.deepEqual(extractFactRequests('参与项目和测试项目的状态分别是什么'), [
    { entity: '参与项目', metric: 'status' },
    { entity: '测试项目', metric: 'status' },
  ]);
  assert.deepEqual(extractFactRequests('呼和浩特和乌鲁木齐两条线路的费用分别是多少'), [
    { entity: '呼和浩特线路', metric: 'price' },
    { entity: '乌鲁木齐线路', metric: 'price' },
  ]);
});

test('P1-01 Counterexample D: Longest entity match binds snippet exclusively to specific entity', () => {
  const beijingRegular = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路当前费用为 80 元',
    path: 'beijing.md',
    title: '北京线路',
    heading: '费用',
  };
  const beijingExpress = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路加急当前费用为 150 元',
    path: 'beijing-express.md',
    title: '北京线路加急',
    heading: '费用',
  };

  const res = decideEvidence({
    query: '北京线路和北京线路加急的费用分别是多少',
    evidence: [beijingRegular, beijingExpress],
    scope: { kind: 'global' },
    indexFresh: true,
  });
  assert.equal(res.decision, 'grounded');
});

test('P1-01 Counterexample E: Unit conversion, qualifier pairing, and currency symbols', () => {
  // 1. 80 元/吨 vs 0.08 元/公斤 are equivalent, not conflict
  const itemTon = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路当前费用为 80 元/吨',
    path: 'beijing-ton.md',
    title: '北京线路',
    heading: '费用',
  };
  const itemKg = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路当前费用为 0.08 元/公斤',
    path: 'beijing-kg.md',
    title: '北京线路',
    heading: '费用',
  };
  const resEquiv = decideEvidence({
    query: '北京线路的费用是多少',
    evidence: [itemTon, itemKg],
    scope: { kind: 'global' },
    indexFresh: true,
  });
  assert.equal(resEquiv.decision, 'grounded');

  // 2. Heavy vs Light goods qualifier conflict
  const itemA = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路重货 80 元，轻货 120 元',
    path: 'beijing-a.md',
    title: '北京线路',
    heading: '费用',
  };
  const itemB = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路重货 90 元，轻货 120 元',
    path: 'beijing-b.md',
    title: '北京线路',
    heading: '费用',
  };
  const resQualifier = decideEvidence({
    query: '北京线路的费用是多少',
    evidence: [itemA, itemB],
    scope: { kind: 'global' },
    indexFresh: true,
  });
  assert.equal(resQualifier.decision, 'conflict');

  // 3. Currency symbol ¥80/吨 vs ¥120/吨
  const itemC = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路当前费用为 ¥80/吨',
    path: 'beijing-c.md',
    title: '北京线路',
    heading: '费用',
  };
  const itemD = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路当前费用为 ¥120/吨',
    path: 'beijing-d.md',
    title: '北京线路',
    heading: '费用',
  };
  const resCurrency = decideEvidence({
    query: '北京线路的费用是多少',
    evidence: [itemC, itemD],
    scope: { kind: 'global' },
    indexFresh: true,
  });
  assert.equal(resCurrency.decision, 'conflict');
});

test('P2-06 Counterexample F: Chinese ellipsis query (北京线路多少钱，上海呢) inherits fact key', () => {
  const beijing = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '北京线路当前服务费用为 80 元',
    path: 'beijing.md',
    title: '北京线路',
    heading: '费用',
  };
  const shanghai = {
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet: '上海线路当前服务费用为 120 元',
    path: 'shanghai.md',
    title: '上海线路',
    heading: '费用',
  };

  const res = decideEvidence({
    query: '北京线路多少钱，上海呢',
    evidence: [beijing, shanghai],
    scope: { kind: 'global' },
    indexFresh: true,
  });
  assert.equal(res.decision, 'grounded');
});

test('fact-key coverage rejects missing metrics, entity-boundary collisions, and unrelated authority', () => {
  let sequence = 0;
  const evidence = (snippet, {
    title = '北京线路', heading = '费用', authorityScore = 90,
  } = {}) => ({
    sourceOpened: true,
    authorityScore,
    state: 'current',
    snippet,
    title,
    heading,
    path: `fact-${sequence += 1}.md`,
    projectId: 'p-transport',
  });
  const assess = (query, items) => decideEvidence({
    query,
    evidence: items,
    scope: { kind: 'global' },
    indexFresh: true,
  });

  assert.equal(
    assess('北京线路的价格和状态分别是什么', [evidence('北京线路价格 80 元')]).decision,
    'insufficient',
  );
  assert.equal(
    assess('北京线路和上海线路的价格和状态分别是什么', [
      evidence('北京线路价格 80 元'),
      evidence('上海线路价格 90 元', { title: '上海线路' }),
    ]).decision,
    'insufficient',
  );
  assert.equal(
    assess('和田线路的费用是多少', [evidence('于田线路价格 80 元', { title: '于田线路' })]).decision,
    'insufficient',
  );
  assert.equal(
    assess('北京线路多少钱，上海呢', [
      evidence('北京线路价格 80 元'),
      evidence('上海仓库价格 90 元', { title: '上海仓库' }),
    ]).decision,
    'insufficient',
  );
  assert.equal(
    assess('北京线路加急的价格是多少', [
      evidence('北京线路普通价格 80 元；加急价格未知', { title: '北京线路加急' }),
    ]).decision,
    'insufficient',
  );
  assert.equal(
    assess('上海线路价格是多少', [
      evidence('上海线路价格 80 元', { title: '上海线路', authorityScore: 55 }),
      evidence('上海线路当前运行中，违约金 500 元', { title: '上海线路', heading: '状态' }),
    ]).decision,
    'insufficient',
  );
});

test('numeric conflicts are compared by entity, metric, qualifier, and canonical unit', () => {
  let sequence = 0;
  const evidence = (snippet) => ({
    sourceOpened: true,
    authorityScore: 90,
    state: 'current',
    snippet,
    title: '北京线路',
    heading: '费用',
    path: `numeric-${sequence += 1}.md`,
    projectId: 'p-transport',
  });
  const assess = (items) => decideEvidence({
    query: '北京线路价格是多少',
    evidence: items,
    scope: { kind: 'global' },
    indexFresh: true,
  });

  assert.equal(assess([
    evidence('北京线路运费 80 元/吨'),
    evidence('北京线路运费 0.09 元/公斤'),
  ]).decision, 'conflict');
  assert.equal(assess([
    evidence('北京线路重货价格 80 元，轻货价格 120 元'),
    evidence('北京线路重货价格 90 元，轻货价格 120 元'),
  ]).decision, 'conflict');
  assert.equal(assess([
    evidence('北京线路运费 80 元，保险 5 元'),
    evidence('北京线路运费 90 元，保险 5 元'),
  ]).decision, 'conflict');
  assert.equal(assess([
    evidence('北京线路价格 80 元，容量 100 吨'),
    evidence('北京线路价格 80 元，容量 120 吨'),
  ]).decision, 'grounded');
});
