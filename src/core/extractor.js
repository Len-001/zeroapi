'use strict';
/**
 * ZeroAPI · 第一层：无感契约嗅探器 (Zero-Doc Topology Extractor)
 * ---------------------------------------------------------------------------
 * 把「一个软件系统的数据形态」抽取成一张代数数据类型图（ADT Graph）。
 * 三条证据链，互相补强：
 *   ① 静态·SQL DDL 扫描   —— 老系统：表结构 + 中文 COMMENT 是免费的高质量语义线索
 *   ② 静态·TS 接口扫描    —— 新系统：interface 声明 + 行尾注释
 *   ③ 动态·流量样本推断   —— 抓真实 payload，推断类型/单位/取值范围，并可与静态声明对账
 *
 * 冲突裁决原则（贯穿全项目的核心纪律）：
 *   值证据 > 命名线索 > 默认值。冲突不静默吞掉，一律落成 warnings 上报。
 */

const { resolve: resolveSemantic, commentEvidence, tokenize } = require('./lexicon');

// ---------------------------------------------------------------------------
// 类型系统（保守的、可参与代价计算的小格）
// ---------------------------------------------------------------------------
const TYPES = {
  string: { rank: 0 },
  number: { rank: 1 },
  boolean: { rank: 2 },
  object: { rank: 3 },
  array: { rank: 4 },
  any: { rank: 5 },
};

const SQL_TYPE_MAP = [
  [/^(varchar|nvarchar|char|nchar|text|mediumtext|longtext|clob)/i, 'string'],
  [/^(tinyint|smallint|int|integer|bigint|mediumint)/i, 'number'],
  [/^(decimal|numeric|float|double|real|money)/i, 'number'],
  [/^(bool|boolean|bit)/i, 'boolean'],
  [/^(datetime|timestamp|date|time)/i, 'number'],
  [/^(json|jsonb|blob|binary|varbinary)/i, 'object'],
];

const TS_TYPE_MAP = [
  [/^(string)$/i, 'string'],
  [/^(number|bigint|int|float|double)$/i, 'number'],
  [/^(boolean|bool)$/i, 'boolean'],
  [/^(Date)$/i, 'number'],
  [/^([A-Za-z_$][\w$]*)(\[\])?$/, 'object'],
  [/^(any|unknown)$/i, 'any'],
];

function normalizeSqlType(decl) {
  const s = String(decl || '').trim();
  for (const [re, t] of SQL_TYPE_MAP) if (re.test(s)) return t;
  return 'any';
}
function normalizeTsType(decl) {
  const s = String(decl || '').trim();
  if (s.endsWith('[]')) return 'array';
  for (const [re, t] of TS_TYPE_MAP) if (re.test(s)) return t;
  if (/^['"].*['"]$/.test(s)) return 'string';
  return 'any';
}

// ---------------------------------------------------------------------------
// ① SQL DDL 扫描
// ---------------------------------------------------------------------------
/**
 * 仅支持演示所需的 DDL 子集（CREATE TABLE + 列定义 + COMMENT），
 * 刻意不引入 SQL 解析器依赖。遇到无法识别的行直接跳过而非抛错——
 * 嗅探器必须对残缺输入具备降级能力。
 */
function parseDdl(sql) {
  const tables = [];
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)[`"\]]?\s*\(([\s\S]*?)\n\s*\)/gi;
  let m;
  while ((m = tableRe.exec(sql))) {
    const table = m[1];
    const body = m[2];
    const fields = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line || /^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN)/i.test(line)) continue;
      if (/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN)\s/i.test(line)) continue;
      const cm = line.match(/COMMENT\s+'([^']*)'/i);
      const comment = cm ? cm[1] : '';
      const lm = line.match(/^[`"[]?(\w+)[`"\]]?\s+([A-Za-z]+(?:\s*\([^)]*\))?)/);
      if (!lm) continue;
      const name = lm[1];
      const declared = lm[2].replace(/\s+/g, '');
      fields.push({
        name,
        declared,
        type: normalizeSqlType(declared),
        comment,
        source: 'sql-ddl',
      });
    }
    tables.push({ table, fields });
  }
  return tables;
}

// ---------------------------------------------------------------------------
// ② TypeScript 接口扫描
// ---------------------------------------------------------------------------
function parseTsInterfaces(ts) {
  const out = [];
  const ifaceRe = /export\s+interface\s+(\w+)[^{]*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = ifaceRe.exec(ts))) {
    const iface = m[1];
    const body = m[2];
    const fields = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      const fm = line.match(/^(\w+)\s*(\?)?\s*:\s*([^;]+);?\s*(?:\/\/\s*(.*))?$/);
      if (!fm) continue;
      const [, name, optional, typeDecl, comment] = fm;
      fields.push({
        name,
        declared: typeDecl.trim(),
        optional: !!optional,
        type: normalizeTsType(typeDecl),
        comment: (comment || '').trim(),
        source: 'ts-interface',
      });
    }
    out.push({ iface, fields });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ③ 动态样本推断
// ---------------------------------------------------------------------------
function jsTypeOf(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  return 'object';
}

/**
 * 从样本数组推断每个字段的类型与统计量。
 * 空样本集是合法输入（动态证据缺失），返回空 schema 而非抛错。
 */
function inferFromSamples(samples) {
  const acc = new Map();
  const list = Array.isArray(samples) ? samples : [samples];
  let objectsSeen = 0;
  for (const s of list) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    objectsSeen++;
    for (const [k, v] of Object.entries(s)) {
      if (!acc.has(k)) acc.set(k, { name: k, values: [], types: new Set(), nulls: 0 });
      const slot = acc.get(k);
      slot.values.push(v);
      slot.types.add(jsTypeOf(v));
      if (v === null || v === undefined) slot.nulls++;
    }
  }
  const fields = [];
  for (const slot of acc.values()) {
    const nonNull = slot.values.filter((v) => v !== null && v !== undefined);
    const types = [...slot.types].filter((t) => t !== 'null');
    let type = types.length === 1 ? types[0] : types.length === 0 ? 'any' : 'any';
    if (type === 'number') {
      const allInt = nonNull.every((v) => Number.isInteger(v));
      if (!allInt) type = 'number';
      else type = 'number';
    }
    const nums = nonNull.filter((v) => typeof v === 'number');
    fields.push({
      name: slot.name,
      type,
      source: 'traffic-sample',
      samples: slot.values.slice(0, 32),
      nullRatio: objectsSeen ? slot.nulls / objectsSeen : 0,
      stats: nums.length
        ? {
            n: nums.length,
            min: Math.min(...nums),
            max: Math.max(...nums),
            median: median(nums),
            allInteger: nums.every((v) => Number.isInteger(v)),
          }
        : null,
      stringShape: inferStringShape(nonNull),
    });
  }
  return fields;
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return NaN;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/;
function inferStringShape(nonNull) {
  const strs = nonNull.filter((v) => typeof v === 'string');
  if (!strs.length) return null;
  return {
    allIso8601: strs.every((s) => ISO_RE.test(s)),
    allNumeric: strs.every((s) => /^-?\d+(\.\d+)?$/.test(s)),
    maxLen: Math.max(...strs.map((s) => s.length)),
  };
}

// ---------------------------------------------------------------------------
// 单位推断（值证据 > 命名线索 > 默认值）
// ---------------------------------------------------------------------------
/**
 * @returns {{unit: string|null, evidence: string, conflict: boolean}}
 */
function inferUnit(field) {
  const nameHint = unitHintFromName(field.name, field.comment);
  const valueUnit = unitFromValues(field, nameHint);
  if (valueUnit && nameHint && valueUnit !== nameHint) {
    // 命名说 A、数据说 B —— 采信数据，但必须留痕（这正是"单位突变自愈"的触发点）
    return { unit: valueUnit, evidence: 'value-outvotes-name', conflict: true, nameHint };
  }
  if (valueUnit) return { unit: valueUnit, evidence: 'value', conflict: false, nameHint };
  if (nameHint) return { unit: nameHint, evidence: 'name', conflict: false, nameHint };
  return { unit: null, evidence: 'none', conflict: false, nameHint: null };
}

/**
 * 从命名/注释推导单位线索。
 *
 * 实现要点：**按 token 判定而非子串匹配**。
 * 理由：'jgFen'（驼峰）经子串匹配 `\bfen\b` 会漏判（dfen 之间无词边界），
 * 而 tokenize 后得到 ['jg','fen'] 可以稳定命中；'jg_fen' / 'JG_FEN' / 'jiage_fen'
 * 三种形态同理。中文侧则保留注释全文匹配（注释里写的是自然语言，不宜分词）。
 */
function unitHintFromName(name, comment) {
  const toks = tokenize(name).map((t) => t.toLowerCase());
  const s = String(comment || '').toLowerCase();
  const centHit = toks.includes('fen') || toks.includes('cent') || toks.includes('cents')
    || /以分为单位|单位为分|分为单位|（分）|\(分\)|单位:分/.test(s);
  const yuanHit = toks.includes('yuan') || toks.includes('cny') || toks.includes('rmb')
    || /以元为单位|单位为元|元为单位|（元）|\(元\)|人民币/.test(s);
  // 时间类声明线索：DDL 里最常见的写法是"Unix 秒级时间戳"这种自然语言描述。
  // 先判毫秒再判秒 —— "毫秒时间戳"里也含"时间戳"三个字，顺序反了会把毫秒误判成秒（差 1000 倍）。
  const unixMsHit = /毫秒(级)?时间戳|unix\s*毫秒|milliseconds?\s*(timestamp|epoch)/.test(s);
  const unixSecHit = /秒(级)?时间戳|unix\s*时间戳|unix\s*(timestamp|epoch)|epoch\s*秒/.test(s);
  const isoHit = /iso\s*8601|iso8601/.test(s);
  // 冲突或缺失时返回 null，把决策权交给值证据 —— 不做"和稀泥"的猜测
  if (centHit && yuanHit) return null;
  if (centHit) return 'cent';
  if (yuanHit) return 'yuan';
  if (unixMsHit) return 'unix_ms';
  if (unixSecHit) return 'unix_s';
  if (isoHit) return 'iso8601';
  return null;
}

function unitFromValues(field, nameHint) {
  const st = field.stats;
  const shape = field.stringShape;
  // 字符串形态的时间
  if (shape && shape.allIso8601) return 'iso8601';
  // 数值时间戳：10 位秒级 / 13 位毫秒级
  if (st && st.n) {
    const med = st.median;
    if (med >= 1e9 && med < 1e11) return 'unix_s';
    if (med >= 1e11 && med < 1e13) return 'unix_ms';
  }
  // 布尔型 0/1 整型
  if (st && st.allInteger && st.min >= 0 && st.max <= 1 && isBoolishHint(nameHint, field)) return 'int01';
  // 金额：命名已明确单位时，用小数位/量级做交叉验证
  if (nameHint === 'cent') {
    if (st && st.allInteger) return 'cent';
    // 声明是"分"但出现小数 → 值证据推翻命名
    if (st && !st.allInteger) return 'yuan';
    return 'cent';
  }
  if (nameHint === 'yuan') {
    if (st && !st.allInteger) return 'yuan';
    if (st && st.allInteger) return 'yuan'; // 整数元在小样本下无法与分区分，信命名
    return 'yuan';
  }
  return null;
}

function isBoolishHint(nameHint, field) {
  // 若命名线索指向"分/元"这类金额单位，则 0/1 更可能是金额而非布尔
  if (nameHint === 'cent' || nameHint === 'yuan') return false;
  const n = String(field.name || '').toLowerCase();
  const c = String(field.comment || '');
  return /^(sf|is|has|enable|active|sx$|sfsx)/.test(n) || /是否|启用|状态/.test(c);
}

// ---------------------------------------------------------------------------
// 合并：静态声明 ⊗ 动态观测 → ADT 图
// ---------------------------------------------------------------------------
/**
 * @param {Array} staticFields 来自 parseDdl / parseTsInterfaces 的字段数组
 * @param {Array} dynamicFields 来自 inferFromSamples 的字段数组
 * @returns {{nodes: Array, warnings: Array}}
 */
function buildAdt(staticFields = [], dynamicFields = []) {
  const byName = new Map();
  const norm = (x) => String(x || '').toLowerCase();
  const warnings = [];

  for (const f of staticFields) {
    byName.set(norm(f.name), {
      name: f.name,
      type: f.type,
      unit: null,
      comment: f.comment || '',
      declared: f.declared,
      samples: [],
      staticSource: f.source,
      dynamicSource: null,
      optional: !!f.optional,
    });
  }

  for (const f of dynamicFields) {
    const key = norm(f.name);
    if (!byName.has(key)) {
      byName.set(key, {
        name: f.name,
        type: f.type,
        unit: null,
        comment: '',
        declared: null,
        samples: [],
        staticSource: null,
        dynamicSource: f.source,
        optional: false,
      });
      warnings.push({ code: 'unplanned_field', field: f.name, detail: '仅动态流量中出现，静态声明未覆盖（疑似字段新增）' });
    }
    const node = byName.get(key);
    node.dynamicSource = f.source;
    node.samples = f.samples || [];
    node.stats = f.stats || null;
    node.stringShape = f.stringShape || null;
    if (node.staticSource && node.type !== f.type && f.type !== 'any' && node.type !== 'any') {
      warnings.push({
        code: 'type_mismatch',
        field: f.name,
        detail: `静态声明 ${node.type} ≠ 动态观测 ${f.type}`,
      });
      node.type = f.type; // 值证据优先
      node.typeConflict = true;
    }
  }

  const nodes = [];
  for (const node of byName.values()) {
    const u = inferUnit(node);
    node.unit = u.unit;
    node.unitEvidence = u.evidence;
    if (u.conflict) {
      warnings.push({
        code: 'unit_drift',
        field: node.name,
        detail: `命名线索 ${u.nameHint} 与实测数据不符，采信数据 ${u.unit}`,
      });
      node.unitDrift = true;
    }
    const anchored = resolveSemantic(node.name);
    node.concept = anchored.concept;
    node.anchor = { via: anchored.via, confidence: anchored.confidence, unitHint: u.nameHint || null };
    // 注释证据：中文 COMMENT 命中目标概念的官方中文名，加一档置信度
    node.commentEvidence = node.concept ? commentEvidence(node.comment, node.name) : 0;
    if (node.comment && node.commentEvidence > 0) {
      node.anchor.confidence = Math.min(1, node.anchor.confidence + 0.05);
      node.anchor.via += '+comment';
    }
    nodes.push(node);
  }
  nodes.sort((a, b) => a.name.localeCompare(b.name)); // 确定性顺序（求解器依赖）
  return { nodes, warnings };
}

// ---------------------------------------------------------------------------
// 指纹：结构签名，用于桥接器缓存与"突变检测"
// ---------------------------------------------------------------------------
/**
 * 只包含参与语义/转换决策的字段（name|type|unit），排除样本值与注释。
 * 采用 FNV-1a 32bit —— 无依赖、确定性、分布足够。
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function fingerprint(nodes) {
  const sig = [...nodes]
    .map((n) => `${n.name}|${n.type}|${n.unit || '-'}`)
    .sort()
    .join(';');
  return fnv1a(sig);
}

module.exports = {
  TYPES,
  parseDdl,
  parseTsInterfaces,
  inferFromSamples,
  inferUnit,
  unitHintFromName,
  buildAdt,
  fingerprint,
  fnv1a,
  normalizeSqlType,
  normalizeTsType,
  median,
};
