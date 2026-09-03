import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { assertSourcePath, isPathInside } from './config.js';
import { isSkippedVaultEntry, parseMarkdown, projectForFile } from './vault.js';
import { DEFAULT_STRUCTURE, historicalPathPattern } from './structure.js';

const HIGH_IMPACT_PATTERN = /(价格|报价|金额|费用|收费|收钱|多少钱|运价|日期|状态|完成|已完成|发布|提交|上传|账号|路径|承诺|时效|截止|合同|库存|政策|权限|删除)|\b(price|pricing|cost|fee|quote|quotation|amount|deadline|due\s+date|schedule|date|status|release|deploy|submit|upload|account|password|path|contract|inventory|policy|permission|delete)\b/i;
const EXPLICIT_CONFLICT_PATTERN = /(存在冲突|互相矛盾|尚有争议|待裁决|disputed)|\b(conflict\w*|contradict\w*|inconsisten\w*|dispute\w*|disagre\w*)\b/i;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedRelative(vault, filePath) {
  return relative(vault, filePath).split(sep).join('/');
}

export function authorityForPath(relativePath, structure = DEFAULT_STRUCTURE) {
  const projectHomePattern = new RegExp(`^${escapeRegex(structure.projectsDir)}/[^/]+/${escapeRegex(structure.projectHome)}$`);
  if (relativePath === structure.vaultRuleFile) return { level: 'system-rule', score: 100 };
  if (projectHomePattern.test(relativePath)) return { level: 'project-home', score: 95 };
  if (relativePath.startsWith(`${structure.memoryDir}/`)) return { level: 'authoritative-memory', score: 92 };
  if (relativePath.includes(`/${structure.projectInputDir}/`)) return { level: 'primary-input', score: 90 };
  if (structure.homeNotes.includes(relativePath)) return { level: 'system-index', score: 85 };
  if (relativePath.includes(`/${structure.projectOutputDir}/`)) return { level: 'verified-output', score: 82 };
  if (relativePath.includes(`/${structure.projectFeedbackDir}/`)) return { level: 'feedback', score: 76 };
  if (relativePath.startsWith(`${structure.workflowDir}/`)) return { level: 'workflow', score: 75 };
  if (relativePath.includes(`/${structure.projectProcessDir}/`)) return { level: 'process', score: 45 };
  if (relativePath.startsWith(`${structure.conversationDir}/`)) return { level: 'conversation-history', score: 35 };
  return { level: 'note', score: 55 };
}

function stateFromDocument(frontmatter, text, relativePath, structure = DEFAULT_STRUCTURE) {
  const raw = String(frontmatter.state || frontmatter.fact_status || '').toLowerCase();
  if (['current', 'superseded', 'expired', 'disputed', 'candidate', 'confirmed'].includes(raw)) return raw;
  if (historicalPathPattern(structure).test(relativePath)) return 'historical';
  return 'current';
}

function queryTerms(query) {
  const normalized = String(query || '').normalize('NFKC').toLowerCase();
  const terms = new Set();
  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    for (const item of segmenter.segment(normalized)) {
      const value = item.segment.trim();
      if (item.isWordLike && value.length >= 2) terms.add(value);
    }
  } catch {
    for (const value of normalized.split(/[\s，。！？、；：,.!?;:()（）【】\[\]"']+/)) {
      if (value.length >= 2) terms.add(value);
    }
  }
  for (const number of normalized.match(/\d+(?:\.\d+)?/g) || []) terms.add(number);
  return [...terms].sort((a, b) => b.length - a.length).slice(0, 16);
}

function normalizedFactText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

// Strips ASCII and full-width thousands separators ("12,000" ≡ "12000")
// so grouped and ungrouped numerals compare as the same value.
function normalizeNumberSeparators(text) {
  return String(text || '').replace(/(\d)[,，](?=\d{3}(?!\d))/g, '$1');
}

export const METRIC_DEFS = [
  {
    key: 'price',
    pattern: /(?:价格|报价|参考价|单价|运费|服务费|租金|费率|金额|成本|费用|收费|收钱|多少钱|各多少钱|怎么收|如何收|花多少|多少)/i,
    evidencePattern: /(价格|报价|参考价|单价|运费|服务费|租金|费率|金额|成本|费用|收费|收钱|\bprice\b|\bpricing\b|\bcost\b|\bfee\b|\bquote\b)/i,
    highImpact: true,
  },
  {
    key: 'status',
    pattern: /(?:状态|进展|阶段|是否上线|上线|停运|运行状态|当前状态|什么状态|试运行|跑起来|运行|全面完成|已完成|完成|点头|确认)/i,
    evidencePattern: /(状态|进展|阶段|上线|正式上线|停运|运行中|试运行|跑起来|暂停|开发中|全面完成|已完成|完成|点头|确认|\bstatus\b)/i,
    highImpact: true,
  },
  {
    key: 'permission',
    pattern: /(?:权限|密码|账号|管理员|admin|密钥|私钥|秘钥)/i,
    evidencePattern: /(权限|密码|账号|管理员|admin|token|密钥|私钥|\bpermission\b|\bpassword\b|\baccount\b)/i,
    highImpact: true,
  },
  {
    key: 'date',
    pattern: /(?:日期|发车|发运|走车|班车|时间|时效|截止|哪一天|哪天|何时|什么时候|期限)/i,
    evidencePattern: /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}|发车|发运|走车|班车|日期|时间|时效|截止|\bdate\b|\bdeadline\b|\bschedule\b)/i,
    highImpact: true,
  },
];

function numericClaimsByUnit(text) {
  const claims = new Map();
  const normalizedText = normalizeNumberSeparators(String(text || '').normalize('NFKC'));

  const pattern = /(?:(重货|轻货|首重|续重|标快|特惠|加急|普通|运费|保险费|保险|违约金|容量|载重)\s*(?:价格|报价|运费|费用|费|为|是|[:：])?\s*)?([¥￥$])?\s*(\d+(?:\.\d+)?)\s*(亿元|亿|万元|万|元\/吨|元\/公斤|元\/千克|元\/kg|元\/斤|元\/克|元\/g|\/吨|\/公斤|\/千克|\/kg|\/斤|\/克|\/g|元|块|吨|公斤|千克|kg|克|g|斤|托盘|件|箱|年|天|小时|分钟|日|号|月|%|折)?/giu;
  const qualifierAliases = new Map([
    ['重货', 'heavy'], ['轻货', 'light'], ['首重', 'first-weight'], ['续重', 'additional-weight'],
    ['标快', 'standard-express'], ['特惠', 'economy'], ['加急', 'urgent'], ['普通', 'regular'],
    ['运费', 'freight'], ['保险费', 'insurance'], ['保险', 'insurance'], ['违约金', 'penalty'],
    ['容量', 'capacity'], ['载重', 'capacity'],
  ]);

  for (const match of normalizedText.matchAll(pattern)) {
    const rawQualifier = match[1] || '';
    const currencySymbol = match[2] || '';
    let value = Number(match[3]);
    let unit = (match[4] || '').toLowerCase();
    if (!Number.isFinite(value)) continue;

    let canonicalUnit = null;
    if (unit === '亿元' || unit === '亿') {
      value *= 100_000_000;
      canonicalUnit = 'currency-yuan';
    } else if (unit === '万元' || unit === '万') {
      value *= 10_000;
      canonicalUnit = 'currency-yuan';
    } else if (unit === '元/吨' || (unit === '/吨' && currencySymbol)) {
      value *= 0.001;
      canonicalUnit = 'currency-per-kg';
    } else if (unit === '元/公斤' || unit === '元/千克' || unit === '元/kg'
      || (currencySymbol && ['/公斤', '/千克', '/kg'].includes(unit))) {
      canonicalUnit = 'currency-per-kg';
    } else if (unit === '元/斤' || (unit === '/斤' && currencySymbol)) {
      value *= 2;
      canonicalUnit = 'currency-per-kg';
    } else if (unit === '元/克' || unit === '元/g' || (currencySymbol && ['/克', '/g'].includes(unit))) {
      value *= 1000;
      canonicalUnit = 'currency-per-kg';
    } else if (unit === '元' || unit === '块' || currencySymbol) {
      canonicalUnit = 'currency-yuan';
    } else if (unit === '吨') {
      value *= 1000;
      canonicalUnit = 'mass-kg';
    } else if (unit === '公斤' || unit === '千克' || unit === 'kg') {
      canonicalUnit = 'mass-kg';
    } else if (unit === '克' || unit === 'g') {
      value *= 0.001;
      canonicalUnit = 'mass-kg';
    } else if (unit === '斤') {
      value *= 0.5;
      canonicalUnit = 'mass-kg';
    } else if (unit === '折') {
      value *= 10;
      canonicalUnit = 'percent';
    } else if (unit === '%') {
      canonicalUnit = 'percent';
    } else if (unit) {
      canonicalUnit = unit;
    }

    if (!canonicalUnit) continue;

    const nearby = normalizedText.slice(Math.max(0, match.index - 12), match.index + match[0].length + 4);
    let qualifier = qualifierAliases.get(rawQualifier) || 'default';
    if (qualifier === 'default') {
      for (const [label, alias] of qualifierAliases) {
        if (nearby.includes(label)) {
          qualifier = alias;
          break;
        }
      }
    }

    let metric = 'generic';
    if (['insurance', 'penalty'].includes(qualifier)) {
      metric = 'ancillary';
    } else if (canonicalUnit.startsWith('currency-')) {
      metric = 'price';
    } else if (canonicalUnit === 'mass-kg' || ['托盘', '件', '箱'].includes(canonicalUnit)) {
      metric = 'capacity';
    } else if (['年', '天', '小时', '分钟', '日', '号', '月'].includes(canonicalUnit)) {
      metric = 'date';
    } else if (canonicalUnit === 'percent') {
      metric = 'rate';
    }

    const key = `${metric}::${qualifier}::${canonicalUnit}`;
    const cleanValue = String(Math.round(value * 10000) / 10000);
    if (!claims.has(key)) claims.set(key, new Set());
    claims.get(key).add(cleanValue);
  }
  return claims;
}

const STOP_WORDS = new Set([
  '当前', '历史', '最新', '现在', '过去', '最近', '是多少', '多少', '什么', '哪些',
  '哪天', '何时', '谁', '怎样', '怎么', '如何', '是否', '分别', '各自', '各个',
  '以及', '和', '与', '的', '了', '在', '是', '有', '个', '每', '从', '到'
]);

const ENTITY_CATEGORY_SOURCE = '(线路|发动机|仓配|仓储|运输|配送|项目|方案|系统|服务|仓库|设备|产品|网点|门店)';
const HARD_FACT_CONNECTOR = /以及|还有|另外|\bversus\b|\band\b|\bor\b|\bvs\b|、|,|，|;|；|\//giu;
const SOFT_FACT_CONNECTOR = /[跟和与及]/gu;

function categoryAppears(value) {
  return new RegExp(ENTITY_CATEGORY_SOURCE, 'u').test(String(value || ''));
}

function classifierCount(token) {
  const chineseCounts = new Map([
    ['两', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6],
    ['七', 7], ['八', 8], ['九', 9], ['十', 10],
  ]);
  return chineseCounts.get(token) || Number(token);
}

function combinations(values, count, start = 0, current = [], output = []) {
  if (current.length === count) {
    output.push([...current]);
    return output;
  }
  for (let index = start; index <= values.length - (count - current.length); index += 1) {
    current.push(values[index]);
    combinations(values, count, index + 1, current, output);
    current.pop();
  }
  return output;
}

function splitClassifierEntities(segment, classifierPattern) {
  const classifier = segment.match(classifierPattern);
  if (!classifier || classifier.index === undefined) return [segment];
  const expectedCount = classifierCount(classifier[1]);
  if (!Number.isInteger(expectedCount) || expectedCount < 2 || expectedCount > 10) return [segment];

  const prefix = segment.slice(0, classifier.index);
  const candidates = [...prefix.matchAll(SOFT_FACT_CONNECTOR)]
    .filter((match) => match.index > 0 && match.index + match[0].length < prefix.length)
    .map((match) => ({ index: match.index, length: match[0].length }));
  if (candidates.length < expectedCount - 1) return [segment];

  let best = null;
  for (const selected of combinations(candidates, expectedCount - 1)) {
    const parts = [];
    let start = 0;
    for (const connector of selected) {
      parts.push(prefix.slice(start, connector.index).trim());
      start = connector.index + connector.length;
    }
    parts.push(prefix.slice(start).trim());
    if (parts.some((part) => !part)) continue;
    const lengths = parts.map((part) => [...part].length);
    const score = (Math.min(...lengths) * 1000) - ((Math.max(...lengths) - Math.min(...lengths)) * 10);
    if (!best || score > best.score) best = { parts, score };
  }
  if (!best) return [segment];
  best.parts[best.parts.length - 1] += segment.slice(classifier.index);
  return best.parts;
}

function splitFactSegments(value, classifierPattern) {
  const hardSegments = [];
  let hardStart = 0;
  for (const match of value.matchAll(HARD_FACT_CONNECTOR)) {
    const segment = value.slice(hardStart, match.index).trim();
    if (segment) hardSegments.push(segment);
    hardStart = match.index + match[0].length;
  }
  const hardTail = value.slice(hardStart).trim();
  if (hardTail) hardSegments.push(hardTail);

  const segments = [];
  for (const hardSegment of hardSegments.length > 0 ? hardSegments : [value]) {
    let softStart = 0;
    for (const match of hardSegment.matchAll(SOFT_FACT_CONNECTOR)) {
      if (match.index === softStart) continue;
      const left = hardSegment.slice(softStart, match.index).trim();
      if (!categoryAppears(left)) continue;
      if (left) segments.push(left);
      softStart = match.index + match[0].length;
    }
    const tail = hardSegment.slice(softStart).trim();
    if (tail) segments.push(...splitClassifierEntities(tail, classifierPattern));
  }
  return segments.filter(Boolean);
}

export function extractFactRequests(query) {
  const clean = String(query || '').normalize('NFKC');
  const prefixStripped = clean.replace(/^(?:请问|查询|查看|检索|帮我查|当前|历史|最新|请给出|对比|比较|核对|请核对|了解一下)/, '');
  const categoryPattern = new RegExp(ENTITY_CATEGORY_SOURCE, 'gu');
  const classifierPattern = new RegExp(`(两|三|四|五|六|七|八|九|十|\\d+)(?:个|条|款|种|项|次|辆|台|套|座|栋|架|艘|支|门)${ENTITY_CATEGORY_SOURCE}`, 'u');
  const rawSegments = splitFactSegments(prefixStripped.trim(), classifierPattern);
  const categoryOf = (value) => [...String(value || '').matchAll(categoryPattern)].at(-1)?.[1] || null;
  const normalizeEntity = (value) => {
    const matches = [...String(value || '').matchAll(categoryPattern)];
    if (matches.length === 0) return String(value || '');
    const first = matches[0];
    const categoryEnd = first.index + first[0].length;
    const suffix = String(value).slice(categoryEnd);
    if (!suffix || /^(?:加急|普通|重货|轻货|首重|续重|标快|特惠)+$/u.test(suffix)) return String(value);
    return String(value).slice(0, categoryEnd);
  };
  const parts = rawSegments.map((segment) => {
    const metrics = METRIC_DEFS.filter((def) => def.pattern.test(segment)).map((def) => def.key);
    let metricStart = segment.length;
    for (const def of METRIC_DEFS) {
      const match = segment.match(def.pattern);
      if (match?.index < metricStart) metricStart = match.index;
    }
    let entity = segment.slice(0, metricStart).trim();
    const classifier = entity.match(classifierPattern);
    const classifierNoun = classifier?.[2] || null;
    if (classifier) entity = entity.replace(classifierPattern, '').trim();
    const ellipsis = /呢[？?]?$/.test(entity);
    entity = entity
      .replace(/呢[？?]?$/, '')
      .replace(/(?:的)?(?:最新|当前|历史|实际|现在|具体|相关|有关)$/u, '')
      .replace(/(?:的|各自|分别|各个|各)$/u, '')
      .replace(/^(?:请问|查询|查看|检索|对比|比较|当前|现在|最新)/u, '')
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      .trim();
    entity = normalizeEntity(entity);
    const category = categoryOf(entity);
    return { segment, metrics: [...new Set(metrics)], entity, ellipsis, category, classifierNoun };
  });

  const classifierNoun = parts.find((part) => part.classifierNoun)?.classifierNoun || null;
  const categories = [...new Set(parts.map((part) => part.category).filter(Boolean))];
  const sharedNoun = classifierNoun || (categories.length === 1 ? categories[0] : null);
  let previousNoun = sharedNoun;
  for (const part of parts) {
    if (!part.entity || STOP_WORDS.has(part.entity.toLowerCase())) {
      part.entity = null;
      continue;
    }
    if (!part.category && (part.ellipsis ? previousNoun : sharedNoun)) {
      part.entity = `${part.entity}${part.ellipsis ? previousNoun : sharedNoun}`;
    }
    part.category = categoryOf(part.entity) || part.category;
    if (part.category) previousNoun = part.category;
  }

  const entityParts = parts.map((part, index) => ({ ...part, index })).filter((part) => part.entity);
  if (entityParts.length === 0) return [];
  const entities = [...new Set(entityParts.map((part) => part.entity))];
  const metrics = [...new Set(parts.flatMap((part) => part.metrics))];
  if (metrics.length === 0) {
    return entities.length >= 2 ? entities.map((entity) => ({ entity, metric: 'generic' })) : [];
  }
  if (entities.length === 1 && !categoryOf(entities[0]) && rawSegments.length === 1) return [];

  const lastEntityIndex = entityParts[entityParts.length - 1].index;
  const explicitMetricBeforeLastEntity = parts.some((part, index) => (
    index < lastEntityIndex && part.entity && part.metrics.length > 0
  ));
  if (entities.length === 1 || !explicitMetricBeforeLastEntity) {
    return entities.flatMap((entity) => metrics.map((metric) => ({ entity, metric })));
  }

  const facts = [];
  const pendingEntities = [];
  let previousMetric = metrics.length === 1 ? metrics[0] : null;
  let previousEntity = null;
  for (const part of parts) {
    if (part.entity && part.metrics.length > 0) {
      for (const pending of pendingEntities.splice(0)) {
        for (const metric of part.metrics) facts.push({ entity: pending, metric });
      }
      for (const metric of part.metrics) facts.push({ entity: part.entity, metric });
      previousEntity = part.entity;
      previousMetric = part.metrics[part.metrics.length - 1];
    } else if (part.entity) {
      previousEntity = part.entity;
      if (part.ellipsis && previousMetric) facts.push({ entity: part.entity, metric: previousMetric });
      else pendingEntities.push(part.entity);
    } else if (part.metrics.length > 0 && previousEntity) {
      for (const metric of part.metrics) facts.push({ entity: previousEntity, metric });
      previousMetric = part.metrics[part.metrics.length - 1];
    }
  }
  for (const pending of pendingEntities) {
    facts.push({ entity: pending, metric: previousMetric || metrics[0] || 'generic' });
  }
  const seen = new Set();
  return facts.filter((fact) => {
    const key = `${fact.entity}\u0000${fact.metric}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractQueriedEntities(query) {
  const facts = extractFactRequests(query);
  const entities = facts.map((f) => f.entity).filter(Boolean);
  return Array.from(new Set(entities));
}

// Entities each evidence item is bound to with STRICT LONGEST MATCHING.
// If both "北京线路加急" and "北京线路" are candidate entities and the snippet
// contains "北京线路加急", it binds ONLY to "北京线路加急" and ignores substring "北京线路".
function evidenceEntityKeys(item, entityTerms) {
  if (!entityTerms || entityTerms.length === 0) return [null];
  const snippetText = normalizeNumberSeparators(String(item.snippet || '').normalize('NFKC')).toLowerCase();
  const metadataText = normalizeNumberSeparators(
    `${item.title || ''}\n${item.heading || ''}`.normalize('NFKC')
  ).toLowerCase();
  const snippetMatched = entityTerms.filter((term) => snippetText.includes(term.toLowerCase()));
  const matched = snippetMatched.length > 0
    ? snippetMatched
    : entityTerms.filter((term) => metadataText.includes(term.toLowerCase()));
  if (matched.length === 0) return [null];

  const nonSubsumed = matched.filter((term) => {
    return !matched.some((other) => other !== term && other.toLowerCase().includes(term.toLowerCase()));
  });

  return nonSubsumed.length > 0 ? nonSubsumed : [null];
}

function evidenceDeniesFact(item, fact) {
  if (!fact || fact.metric === 'generic') return false;
  const snippet = normalizedFactText(item.snippet);
  const unknown = '(?:未知|不详|未确定|待确认|暂无|未提供|没有|无|不适用)';
  const metricWords = {
    price: '(?:价格|报价|单价|运费|服务费|租金|费率|金额|成本|费用|收费)',
    status: '(?:状态|进展|阶段|上线|停运)',
    permission: '(?:权限|密码|账号|管理员)',
    date: '(?:日期|发车|时间|时效|截止)',
  }[fact.metric];
  if (!metricWords) return false;
  const qualifiers = ['加急', '普通', '重货', '轻货', '首重', '续重', '标快', '特惠']
    .filter((term) => fact.entity.includes(term));
  for (const qualifier of qualifiers) {
    const escaped = escapeRegex(qualifier);
    if (new RegExp(`${escaped}.{0,12}${metricWords}.{0,10}${unknown}`).test(snippet)
      || new RegExp(`${metricWords}.{0,8}${escaped}.{0,10}${unknown}`).test(snippet)) return true;
  }
  if (snippet.includes(normalizedFactText(fact.entity))) {
    const escapedEntity = escapeRegex(normalizedFactText(fact.entity));
    if (new RegExp(`${escapedEntity}.{0,16}${metricWords}.{0,10}${unknown}`).test(snippet)) return true;
  }
  return false;
}

function evidenceSupportsFact(item, fact, entityTerms) {
  if (fact.entity) {
    const boundEntities = evidenceEntityKeys(item, entityTerms);
    if (!boundEntities.includes(fact.entity)) return false;
  }
  if (evidenceDeniesFact(item, fact)) return false;
  if (fact.metric === 'generic') return true;
  const metric = METRIC_DEFS.find((definition) => definition.key === fact.metric);
  if (!metric) return true;
  const claimText = `${item.heading || ''}\n${item.snippet || ''}`.normalize('NFKC').toLowerCase();
  return metric.evidencePattern.test(claimText);
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function conflictingCurrentNumericEvidence(evidence, factRequests, entityTerms = [], requestedMetrics = []) {
  const current = evidence.filter((item) => item.sourceOpened && item.authorityScore >= 70 && item.state === 'current');
  const conflicts = new Set();
  const fallbackMetrics = requestedMetrics.length > 0 ? requestedMetrics : ['generic'];
  const facts = factRequests.length > 0
    ? factRequests
    : (entityTerms.length > 0
        ? entityTerms.flatMap((entity) => fallbackMetrics.map((metric) => ({ entity, metric })))
        : fallbackMetrics.map((metric) => ({ entity: null, metric })));

  for (const fact of facts) {
    const matching = current.filter((item) => evidenceSupportsFact(item, fact, entityTerms));
    for (let leftIndex = 0; leftIndex < matching.length; leftIndex += 1) {
      const left = matching[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < matching.length; rightIndex += 1) {
        const right = matching[rightIndex];
        if (left.projectId && right.projectId && left.projectId !== right.projectId) continue;
        const leftClaims = numericClaimsByUnit(left.snippet);
        const rightClaims = numericClaimsByUnit(right.snippet);
        for (const [key, leftValues] of leftClaims) {
          const claimMetric = key.split('::', 1)[0];
          if (fact.metric !== 'generic' && claimMetric !== fact.metric) continue;
          const rightValues = rightClaims.get(key);
          if (!rightValues) continue;
          if (!setsEqual(leftValues, rightValues)) {
            conflicts.add(left);
            conflicts.add(right);
            break;
          }
        }
      }
    }
  }
  return [...conflicts];
}

function charPositionToLine(text, position) {
  if (!Number.isFinite(position) || position < 0) return null;
  return text.slice(0, position).split(/\r?\n/).length;
}

function bestLine(lines, query, chunkPos, fullText, lineStartHint) {
  if (Number.isFinite(lineStartHint) && lineStartHint > 0) return Math.min(lineStartHint, lines.length);
  const fromChunk = charPositionToLine(fullText, chunkPos);
  if (fromChunk) return Math.min(Math.max(fromChunk, 1), lines.length);
  const terms = queryTerms(query);
  let best = { line: 1, score: -1 };
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    let score = 0;
    for (const term of terms) if (lower.includes(term)) score += term.length;
    if (/^#{1,6}\s/.test(line)) score += 0.25;
    if (score > best.score) best = { line: index + 1, score };
  });
  if (best.score > 0) return best.line;
  const firstHeading = lines.findIndex((line) => /^#\s+/.test(line));
  return firstHeading >= 0 ? firstHeading + 1 : 1;
}

function headingAt(lines, lineNumber) {
  for (let index = Math.min(lineNumber - 1, lines.length - 1); index >= 0; index -= 1) {
    const match = lines[index].match(/^#{1,6}\s+(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

function makeSnippet(lines, centerLine, radius = 3) {
  const start = Math.max(1, centerLine - radius);
  const end = Math.min(lines.length, centerLine + radius);
  const snippet = lines.slice(start - 1, end).join('\n').trim().slice(0, 600);
  return { start, end, snippet };
}

export function openEvidence(result, { vault, projects, query, matchType, structure = DEFAULT_STRUCTURE } = {}) {
  const source = assertSourcePath(vault, result.filepath);
  const fullText = readFileSync(source, 'utf8');
  const lines = fullText.split(/\r?\n/);
  const relativePath = normalizedRelative(vault, source);
  const { frontmatter } = parseMarkdown(source);
  const center = bestLine(lines, query, result.chunkPos, fullText, result.lineStartHint);
  const range = makeSnippet(lines, center);
  const authority = authorityForPath(relativePath, structure);
  const project = projectForFile(projects, source);
  const state = stateFromDocument(frontmatter, fullText, relativePath, structure);
  const contentHash = createHash('sha256').update(fullText).digest('hex');
  const sources = new Set(result.contributions?.map((item) => item.source) || []);
  return {
    path: relativePath,
    title: result.title || basename(source, extname(source)),
    heading: headingAt(lines, center),
    lineStart: range.start,
    lineEnd: range.end,
    snippet: range.snippet,
    projectId: project?.id || null,
    project: project?.name || null,
    authority: authority.level,
    authorityScore: authority.score,
    asOf: frontmatter.updated ? String(frontmatter.updated) : result.modifiedAt || null,
    effectiveAt: frontmatter.effective_at ? String(frontmatter.effective_at) : null,
    recordedAt: frontmatter.recorded_at ? String(frontmatter.recorded_at) : null,
    state,
    matchType: matchType || (sources.size > 1 ? 'hybrid' : [...sources][0] || result.source || 'unknown'),
    lexicalRank: result.lexicalRank ?? null,
    vectorRank: result.vectorRank ?? null,
    rrfScore: Number(result.rrfScore || 0),
    contentHash,
    sourceOpened: true,
    contributions: result.contributions || [],
  };
}

function walkMarkdown(dir, root = dir, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isSkippedVaultEntry(entry.name)) continue;
    const full = join(dir, entry.name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    const real = realpathSync.native(full);
    if (!isPathInside(root, real)) continue;
    if (entry.isDirectory()) walkMarkdown(real, root, output);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) output.push(real);
  }
  return output;
}

function parseWikiLinks(text) {
  const sanitized = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]+`/g, '');
  const links = [];
  const pattern = /(?:^|[^!])\[\[([^\]|#\r\n]+)(?:#[^\]|\r\n]+)?(?:\|[^\]\r\n]+)?\]\]/g;
  for (const match of sanitized.matchAll(pattern)) {
    const target = match[1].trim();
    if (target) links.push(target);
  }
  return [...new Set(links)];
}

function resolveWikiLink(vault, projectDirectory, link, fileList = null) {
  const clean = link.replaceAll('/', sep);
  const withExtension = clean.toLowerCase().endsWith('.md') ? clean : `${clean}.md`;
  const wantedName = basename(withExtension).trim();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)(\..*)?$/i.test(wantedName)) {
    return null;
  }
  const directInProject = resolve(projectDirectory, withExtension);
  if (existsSync(directInProject) && isPathInside(projectDirectory, directInProject)) return directInProject;
  const directInVault = resolve(vault, withExtension);
  if (existsSync(directInVault) && isPathInside(projectDirectory, directInVault)) return directInVault;
  const wanted = basename(withExtension).toLowerCase();
  const matches = (fileList || walkMarkdown(projectDirectory)).filter((file) => basename(file).toLowerCase() === wanted);
  return matches.length === 1 ? matches[0] : null;
}

export function expandLinkedEvidence(primaryEvidence, { vault, projects, scope, structure = DEFAULT_STRUCTURE, max = 2 } = {}) {
  if (scope.kind !== 'project' || max <= 0) return [];
  const output = [];
  const seen = new Set(primaryEvidence.map((item) => item.path));
  let projectFiles = null;
  try {
    projectFiles = walkMarkdown(scope.project.directory);
  } catch {}

  for (const evidence of primaryEvidence) {
    try {
      const sourcePath = join(vault, evidence.path.split('/').join(sep));
      if (!existsSync(sourcePath)) continue;
      const text = readFileSync(sourcePath, 'utf8');
      for (const link of parseWikiLinks(text)) {
        const resolved = resolveWikiLink(vault, scope.project.directory, link, projectFiles);
        if (!resolved) continue;
        const relativePath = normalizedRelative(vault, realpathSync.native(resolved));
        if (seen.has(relativePath)) continue;
        seen.add(relativePath);
        try {
          const linked = openEvidence({
            filepath: resolved,
            title: basename(resolved, extname(resolved)),
            score: 0,
            rrfScore: 0,
            contributions: [],
          }, { vault, projects, query: link, matchType: 'wiki-link', structure });
          output.push(linked);
        } catch {}
        if (output.length >= max) return output;
      }
    } catch {}
  }
  return output;
}

export function filterTemporalEvidence(evidence, temporalIntent) {
  if (temporalIntent === 'history') return evidence;
  return evidence.filter((item) => !['superseded', 'expired', 'historical'].includes(item.state));
}

export function decideEvidence({ query, evidence, scope, indexFresh, temporalIntent = 'current' }) {
  if (scope.kind === 'ambiguous' || scope.kind === 'unknown') {
    return { decision: 'insufficient', reason: `project scope is ${scope.kind}` };
  }
  if (evidence.length === 0) return { decision: 'insufficient', reason: 'no source evidence' };
  const projectIdentity = [scope.project?.name, scope.project?.mainObject]
    .filter(Boolean)
    .map((item) => String(item).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));
  const genericTerms = new Set([
    '当前', '现在', '项目', '是否', '是不是', '什么', '多少', '怎么', '参考', '情况',
    '每天', '业务', '有没有', '没有', '大约', '如何', '应该', '以前', '首批', '真实',
    '收集', '拉', '还是', '能不能', '可以', '分别是', '分别', '哪些', '有哪些', '以及',
    '和', '跟', '与', '及', '到底', '总共', '一共', '具体', '请问', '知道', '查询', '查看',
    '什么时候', '何时', '哪天', '哪一天', '哪一', '哪里', '何处', '为何', '怎样', '哪个', '怎么办',
    '尚待', '来源', '两份', '资料', '下一步', '已经', '全面', '尚未', '暂未', '目前', '现已',
    '配当', '一板', '一吨', '历史', '早期', '过去', '之前', '曾经'
  ]);
  const materialTerms = queryTerms(query).filter((term) => {
    const normalized = term.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    return normalized && !genericTerms.has(normalized)
      && !projectIdentity.some((identity) => identity.includes(normalized));
  });

  const numericClaims = [...new Set(normalizeNumberSeparators(String(query).normalize('NFKC')).match(/\d+(?:\.\d+)?/g) || [])];
  const openedText = normalizeNumberSeparators(evidence.map((item) => item.snippet).join('\n').normalize('NFKC'));
  if (numericClaims.some((number) => {
    const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`(?<!\\d)${escaped}(?!\\d)`).test(openedText);
  })) {
    return { decision: 'insufficient', reason: 'numeric claim is not present in opened evidence' };
  }

  // Intent patterns and synonyms
  const INTENT_PATTERNS = [
    { intent: /(收钱|多少钱|费用|收费|价格|报价|服务费|服务|运费|单价|租金|费率|金额|成本|花多少|怎么收|参考价|费|价)/i, evidence: /(费用|收费|价格|报价|服务费|运费|单价|租金|费率|金额|成本|参考价|元|¥|￥)/i },
    { intent: /(跑起来|运行|状态|进展|阶段|上线|发布|点头|确认|同意|完成|全面完成|已完成|进度|反馈|真实反馈|正式|试运行)/i, evidence: /(运行|状态|阶段|上线|发布|试运行|正式|确认|等待|完成|全面完成|已完成|进度|反馈|真实反馈|点头)/i },
    { intent: /(账号|密码|权限|登录|账户|管理员)/i, evidence: /(账号|密码|权限|登录|账户|admin|user|管理员)/i },
    { intent: /(存|仓储|存货|入库|出库|库存|货|板|托盘|箱|件|拉一吨)/i, evidence: /(仓储|存储|存|入库|出库|库存|托盘|板|箱|件|吨)/i },
    { intent: /(步骤|流程|规范|要求|查证|规范要求|先走|核对|打开原文)/i, evidence: /(步骤|流程|规范|要求|核对|查证|检索|规范要求|流程|打开原文)/i },
    { intent: /(日期|发车|班车|哪一天|哪一|哪天|什么时候|何时|截止|时效|排期|走车|走|车)/i, evidence: /(日期|发车|班车|时间|截止|时效|排期|天|月|日|号|冲突|矛盾|争议|分歧|裁决|走车|发车)/i },
    { intent: /(冲突|矛盾|争议|不一致|裁决|风险|分歧)/i, evidence: /(冲突|矛盾|争议|不一致|裁决|风险|分歧|待定|待确认|dispute|conflict)/i },
  ];

  // Separate materialTerms into entityTerms and intent-specific terms
  const factRequests = extractFactRequests(query);
  const queriedEntities = factRequests.map((f) => f.entity).filter(Boolean);
  const requestedMetrics = [...new Set(factRequests.map((fact) => fact.metric).filter((metric) => metric !== 'generic'))];
  const matchedIntentPatterns = INTENT_PATTERNS.filter((p) => p.intent.test(query));
  const fallbackEntityTerms = materialTerms.filter((term) => {
    const norm = term.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (/^\d+$/.test(norm)) return false;
    if (norm.length < 2) return false;
    if (STOP_WORDS.has(norm)) return false;
    return !INTENT_PATTERNS.some((p) => p.intent.test(norm));
  });
  const entityTerms = queriedEntities.length > 0 ? queriedEntities : fallbackEntityTerms;

  const conflictIntent = /(冲突|矛盾|争议|不一致|裁决|风险|日期|发车|班车|哪一天|什么时候走|哪天|走车)|\b(conflict\w*|contradict\w*|inconsisten\w*|dispute\w*|deadline|due\s+date|schedule|which\s+day)\b/i.test(query);

  // Helper to evaluate if a single evidence item is relevant to BOTH entity and intent
  function isEvidenceItemRelevant(item) {
    const itemText = normalizeNumberSeparators(
      `${item.title || ''}\n${item.heading || ''}\n${item.snippet || ''}`.normalize('NFKC')
    ).toLowerCase();

    // 1. Entity check: if query has specific entity terms, the item must match at least one
    if (entityTerms.length > 0) {
      const boundEntities = evidenceEntityKeys(item, entityTerms);
      const entityMatch = boundEntities.some((key) => key !== null);
      if (!entityMatch) return false;
    }

    // If item is a disputed note and query explicitly has conflict intent, it's relevant
    if ((item.state === 'disputed' || EXPLICIT_CONFLICT_PATTERN.test(item.snippet)) && conflictIntent) {
      return true;
    }

    if (factRequests.length > 0
      && !factRequests.some((fact) => evidenceSupportsFact(item, fact, entityTerms))) {
      return false;
    }

    // 2. Intent check: if query has intent patterns, the item must support the intent
    if (matchedIntentPatterns.length > 0) {
      const intentMatch = matchedIntentPatterns.some((p) => p.evidence.test(itemText));
      if (!intentMatch) return false;
    }

    // 3. If query had only material terms with no explicit intent/entity split, ensure at least one matches
    if (entityTerms.length === 0 && matchedIntentPatterns.length === 0 && materialTerms.length > 0) {
      const genericMatch = materialTerms.some((term) => itemText.includes(term.toLowerCase()));
      if (!genericMatch) return false;
    }

    return true;
  }

  // 1. Filter evidence that is genuinely relevant to the query entity and intent FIRST
  const relevantEvidence = evidence.filter((item) => item.sourceOpened && isEvidenceItemRelevant(item));

  if (relevantEvidence.length === 0) {
    return { decision: 'insufficient', reason: 'no material query terms matched in opened evidence' };
  }

  // 2. Per-Fact-Key completeness and authoritative coverage check
  const highImpact = HIGH_IMPACT_PATTERN.test(query);
  if (factRequests.length > 0) {
    for (const fact of factRequests) {
      const factMetricDef = METRIC_DEFS.find((d) => d.key === fact.metric);
      const isHighImpactFact = factMetricDef ? factMetricDef.highImpact : highImpact;

      // Find opened evidence that matches BOTH this specific entity and its metric
      const matchingEvidence = relevantEvidence.filter((item) => evidenceSupportsFact(item, fact, entityTerms));

      if (matchingEvidence.length === 0) {
        return {
          decision: 'insufficient',
          reason: `evidence lacks coverage for fact: (${fact.entity}, ${fact.metric})`,
        };
      }

      const disputedForFact = matchingEvidence.filter((item) => (
        item.state === 'disputed' || EXPLICIT_CONFLICT_PATTERN.test(item.snippet)
      ));
      if (disputedForFact.length > 0) {
        return {
          decision: 'conflict',
          reason: `material source evidence is disputed for fact: (${fact.entity}, ${fact.metric})`,
          conflictEvidencePaths: disputedForFact.map((item) => item.path).filter(Boolean),
        };
      }

      const authoritativeForFact = matchingEvidence.filter((item) => (
        temporalIntent === 'history'
          ? item.authorityScore >= 35 && ['current', 'historical', 'superseded', 'expired'].includes(item.state)
          : item.authorityScore >= 70 && item.state === 'current'
      ));

      if (isHighImpactFact && authoritativeForFact.length === 0) {
        return {
          decision: 'insufficient',
          reason: `high-impact fact (${fact.entity}, ${fact.metric}) lacks current authoritative evidence`,
        };
      }
    }
  }

  // 3. Conflict checks: execute ONLY within the relevant evidence set bound to the queried entities
  const disputed = relevantEvidence.filter((item) => item.state === 'disputed' || EXPLICIT_CONFLICT_PATTERN.test(item.snippet));
  const materialConflict = disputed.some((item) => conflictIntent
    || materialTerms.some((term) => item.snippet.normalize('NFKC').toLowerCase().includes(term.toLowerCase())));
  if (materialConflict) {
    return {
      decision: 'conflict',
      reason: 'material source evidence is disputed or conflicting',
      conflictEvidencePaths: disputed.map((item) => item.path).filter(Boolean),
    };
  }

  const numericConflicts = conflictingCurrentNumericEvidence(
    relevantEvidence,
    factRequests,
    entityTerms,
    requestedMetrics,
  );
  if (numericConflicts.length >= 2) {
    return {
      decision: 'conflict',
      reason: 'current authoritative sources disagree on the same numeric fact',
      conflictEvidencePaths: numericConflicts.map((item) => item.path).filter(Boolean),
    };
  }

  // 4. Grounded checks on relevant authoritative evidence
  const relevantAuthoritative = relevantEvidence.filter((item) => (
    temporalIntent === 'history'
      ? item.authorityScore >= 35 && ['current', 'historical', 'superseded', 'expired'].includes(item.state)
      : item.authorityScore >= 70 && item.state === 'current'
  ));

  if (relevantAuthoritative.length === 0) {
    return {
      decision: 'insufficient',
      reason: highImpact
        ? 'high-impact question lacks current authoritative evidence'
        : 'question lacks current authoritative evidence',
    };
  }

  return {
    decision: 'grounded',
    reason: temporalIntent === 'history'
      ? 'historical authoritative source opened for explicit history intent'
      : (highImpact ? 'current authoritative source opened' : 'current authoritative source opened for query'),
  };
}
