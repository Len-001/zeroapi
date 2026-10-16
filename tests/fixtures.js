'use strict';
/**
 * 测试夹具：两个"真实系统"的契约与数据快照。
 * 所有用例共用同一份 ground truth，避免"每个用例自己造期望值"导致的自证循环。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const {
  parseDdl, parseTsInterfaces, buildAdt, inferFromSamples, fingerprint,
} = require('../src/core/extractor');

const ddl = parseDdl(fs.readFileSync(path.join(ROOT, 'contracts/legacy_erp.sql'), 'utf8'));
const ts = parseTsInterfaces(fs.readFileSync(path.join(ROOT, 'contracts/modern_crm.d.ts'), 'utf8'));

const legacyTable = ddl.find((t) => t.table === 'erp_goods');
const legacyBak = ddl.find((t) => t.table === 'erp_goods_bak_2009');
const productIface = ts.find((i) => i.iface === 'ProductDTO');
const orderIface = ts.find((i) => i.iface === 'OrderDTO');

/** 老 ERP 的线上样本（XML 解码 + 数字强制转型之后的样子） */
const legacyRows = [
  { sp_mc: '机械键盘 K870', jg_fen: 39999, kc_sl: 42, cjsj: 1750000000, sf_sx: 1, fl_id: 'C-013', xq_ms: '87 键热插拔轴体，PBT 键帽' },
  { sp_mc: '人体工学椅 Pro', jg_fen: 129900, kc_sl: 7, cjsj: 1750100000, sf_sx: 1, fl_id: 'C-021', xq_ms: '四级腰托，网布透气' },
  { sp_mc: '4K 显示器 27寸', jg_fen: 219900, kc_sl: 0, cjsj: 1750200000, sf_sx: 0, fl_id: 'C-017', xq_ms: '广色域' },
];

/** Ground truth：唯一正确的字段对应关系（人工标注，用于算 Precision/Recall） */
const GROUND_TRUTH = [
  ['sp_mc', 'productName'],
  ['jg_fen', 'priceYuan'],
  ['kc_sl', 'stockQty'],
  ['cjsj', 'createdAt'],
  ['sf_sx', 'isListed'],
  ['fl_id', 'categoryId'],
  ['xq_ms', 'description'],
];

/** 期望的算子链（人工推导：分→元、秒→ISO、0/1→bool） */
const EXPECTED_OPS = {
  'jg_fen→priceYuan': ['cent2yuan'],
  'cjsj→createdAt': ['unixS2Iso'],
  'sf_sx→isListed': ['int01ToBool'],
  'sp_mc→productName': [],
  'kc_sl→stockQty': [],
  'fl_id→categoryId': [],
  'xq_ms→description': [],
};

function sourceAdt(rows = legacyRows) {
  return buildAdt(legacyTable.fields, inferFromSamples(rows)).nodes;
}
function targetAdt(iface = 'ProductDTO') {
  const f = iface === 'OrderDTO' ? orderIface : productIface;
  return buildAdt(f.fields, []).nodes;
}
function staticSource(rows = legacyRows) {
  const byDdl = new Map(legacyTable.fields.map((f) => [f.name, f]));
  return Object.keys(rows[0] || {}).map((name) => {
    const d = byDdl.get(name);
    return {
      name,
      declared: d ? d.declared : 'VARCHAR(32)',
      type: d ? d.type : 'string',
      comment: d ? d.comment : '',
      source: d ? 'sql-ddl' : 'live-schema',
    };
  });
}

/** 把 legacyRows 按给定字段名与取值规则重塑（用于构造对抗用例） */
function reshape(row, mapper) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const m = mapper(k, v);
    if (m === null) continue;
    if (typeof m === 'object' && m.__rename) { out[m.__rename] = m.value; continue; }
    out[k] = m;
  }
  return out;
}

/**
 * 重命名对象键。
 * @param {object} map **统一约定：{ 原字段名 → 现字段名 }**
 * 这个方向约定被 renameKeys / styleMap / ctxFor 三处共享。
 * 最初版本三处方向不一致，直接导致"风格矩阵用例其实没改名却全绿"的假阳性 —— 特此固化。
 */
function renameKeys(row, map) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[map[k] || k] = v;
  return out;
}

/** 反转映射：{原→现} ⇒ {现→原} */
function invert(map) {
  const out = {};
  for (const [k, v] of Object.entries(map)) out[v] = k;
  return out;
}

/** 四种命名风格（与 src/servers/legacy.js 的突变注入器共享同一份数据，避免两边漂移） */
const { NAME_STYLES, styleMap } = require('../src/core/name-styles');

/**
 * 构造 Bridge 调用上下文。
 * @param {Array} rows 当前形态的样本
 * @param {object} renamed `{ 原字段名 → 现字段名 }`，默认为恒等
 *
 * 这里刻意复刻真实网关的行为：**注释跟着列走，不跟着名字走**。
 * 真实系统里改字段名不会顺手改掉 SQL 注释，所以嗅探器必须能从
 * "名字已经变了、注释还在"的夹杂状态下恢复出语义 —— 这正是最难的一档。
 */
function ctxFor(rows, renamed = {}) {
  const rev = invert(renamed); // 现名 → 原名
  const statics = Object.keys(rows[0] || {}).map((name) => {
    const orig = rev[name] || name;
    const d = legacyTable.fields.find((f) => f.name === orig);
    return {
      name,
      declared: d ? d.declared : 'VARCHAR(32)',
      type: d ? d.type : 'string',
      comment: d ? d.comment : '',
      source: d ? 'sql-ddl' : 'live-schema',
    };
  });
  return {
    targetAdt: targetAdt(),
    meta: { targetLabel: 'ProductDTO', staticSource: () => statics, targetFp: fingerprint(targetAdt()) },
  };
}

/** 计算匹配的 Precision / Recall / F1（对照 Ground Truth） */
function scoreMapping(pairs) {
  const got = new Set(pairs.map((p) => `${p.source.name}→${p.target.name}`));
  const want = new Set(GROUND_TRUTH.map(([a, b]) => `${a}→${b}`));
  let tp = 0;
  for (const g of got) if (want.has(g)) tp++;
  const fp = got.size - tp;
  const fn = want.size - tp;
  const precision = got.size ? tp / got.size : 0;
  const recall = want.size ? tp / want.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1, missing: [...want].filter((w) => !got.has(w)), spurious: [...got].filter((g) => !want.has(g)) };
}

module.exports = {
  ROOT, ddl, ts, legacyTable, legacyBak, productIface, orderIface,
  legacyRows, GROUND_TRUTH, EXPECTED_OPS, NAME_STYLES, styleMap, invert,
  sourceAdt, targetAdt, staticSource, reshape, renameKeys, ctxFor, scoreMapping, fingerprint,
};
