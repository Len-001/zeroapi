'use strict';
/**
 * 系统 B · 遗留仓库管理系统 (Legacy WMS) —— 模拟 2009 年上线的老系统
 * ---------------------------------------------------------------------------
 * 刻意保留的时代特征（每一条都是真实的"异构性"来源）：
 *   · 字段名：拼音首字母缩写（sp_mc / jg_fen ...）
 *   · 金额单位：分（整型），不是元（浮点）
 *   · 时间格式：Unix 秒级整型时间戳，不是 ISO 字符串
 *   · 布尔表示：0 / 1 整型，不是 boolean
 *   · 线上协议：XML，不是 JSON
 *   · 契约文档：SQL DDL 里的中文 COMMENT（而不是 OpenAPI）
 *
 * 控制面（/__chaos/*）不在真实系统里存在，它专门用来在演示中大屏直播
 * "当着评委的面把数据库字段名改乱" —— 即协议突变注入器。
 */

const http = require('http');
const { URL } = require('url');
const { NAME_STYLES } = require('../core/name-styles');

const PORT = Number(process.env.LEGACY_PORT || 8312);
const TABLE = 'erp_goods';

// ---------------------------------------------------------------------------
// 表结构与数据（列存：行数据按列序数组保存，因此改列名不动数据，1 行代码即完成突变）
// ---------------------------------------------------------------------------
const BASE_FIELDS = () => ([
  { name: 'sp_mc', sqlType: 'VARCHAR(64)', type: 'string', comment: '商品名称' },
  { name: 'jg_fen', sqlType: 'INT', type: 'number', comment: '价格（以分为单位）' },
  { name: 'kc_sl', sqlType: 'INT', type: 'number', comment: '库存数量' },
  { name: 'cjsj', sqlType: 'BIGINT', type: 'number', comment: '创建时间，Unix 秒级时间戳' },
  { name: 'sf_sx', sqlType: 'TINYINT', type: 'number', comment: '是否上架：1=上架，0=下架' },
  { name: 'fl_id', sqlType: 'VARCHAR(16)', type: 'string', comment: '分类编号' },
  { name: 'xq_ms', sqlType: 'VARCHAR(512)', type: 'string', comment: '详情描述' },
]);

const CSV_ABBR = NAME_STYLES.abbr;
const CSV_FULL = NAME_STYLES.full;
const CSV_UPPER = NAME_STYLES.upper;
const CSV_CAMEL = NAME_STYLES.camel;

const state = {
  fields: BASE_FIELDS(),
  /** 列存：rows[i][colIndex] */
  rows: [
    ['机械键盘 K870', 39999, 42, 1750000000, 1, 'C-013', '87 键热插拔轴体，PBT 键帽'],
    ['人体工学椅 Pro', 129900, 7, 1750100000, 1, 'C-021', '四级腰托，网布透气'],
    ['4K 显示器 27寸', 219900, 0, 1750200000, 0, 'C-017', '广色域，已停产待下架'],
    ['机械键盘 K870', 39999, 12, 1750300000, 1, 'C-013', '重复录入的历史脏数据'],
  ],
  unit: { jg_fen: 'cent' },
  restyle: 'abbr',
  chaosLog: [],
  nextId: 100,
};

function setStyle(mode) {
  const map = { abbr: CSV_ABBR, full: CSV_FULL, upper: CSV_UPPER, camel: CSV_CAMEL };
  const target = map[mode] || CSV_ABBR;
  // 只改字段名，注释（也就是老系统里唯一像样的"文档"）保持原样 —— 这才是真实情况
  state.fields = state.fields.map((f, i) => ({
    ...f,
    name: target[i] !== undefined ? target[i] : f.name,
  }));
  state.restyle = mode;
}

// ---------------------------------------------------------------------------
// XML 编解码（手写极简实现，对应 2009 年的技术栈）
// ---------------------------------------------------------------------------
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function rowToXml(row) {
  return state.fields
    .map((f, i) => `      <${f.name}>${esc(row[i])}</${f.name}>`)
    .join('\n');
}

function goodsXml(rows) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<response service="wms.QueryGoods" version="1.0">`,
    `  <resultCode>0</resultCode>`,
    `  <total>${rows.length}</total>`,
    `  <goodsList>`,
    rows.map((r) => `    <goods>\n${rowToXml(r)}\n    </goods>`).join('\n'),
    `  </goodsList>`,
    `</response>`,
  ].join('\n');
}

/** 极简 XML 解析：只支持 <tag>text</tag> 这种扁平结构，足够本项目使用 */
function parseFlatXml(xml) {
  const out = {};
  const re = /<([A-Za-z_][\w.\-]*)\s*>([^<]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) out[m[1]] = decodeEntities(m[2]);
  return out;
}
const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// ---------------------------------------------------------------------------
// 序列化当前真实表形态（供控制台展示"系统 B 眼里的世界"）
// ---------------------------------------------------------------------------
function serializeRow(row) {
  const o = {};
  state.fields.forEach((f, i) => { o[f.name] = row[i]; });
  return o;
}

// ---------------------------------------------------------------------------
// 突变注入器
// ---------------------------------------------------------------------------
const chaos = {
  rename({ from, to }) {
    if (!from || !to) throw new Error('rename 需要 {from, to}');
    const f = state.fields.find((x) => x.name === from);
    if (!f) throw new Error(`字段不存在: ${from}`);
    if (state.fields.some((x) => x.name === to)) throw new Error(`目标字段名已存在: ${to}`);
    const old = f.name;
    f.name = to;
    if (state.unit[old]) { state.unit[to] = state.unit[old]; delete state.unit[old]; }
    return { kind: 'rename', from: old, to };
  },
  restyle({ mode }) {
    const before = state.fields.map((f) => f.name);
    setStyle(mode);
    return { kind: 'restyle', mode, before, after: state.fields.map((f) => f.name) };
  },
  unitflip({ field, unit }) {
    const f = state.fields.find((x) => x.name === field);
    if (!f) throw new Error(`字段不存在: ${field}`);
    const i = state.fields.indexOf(f);
    const cur = state.unit[field] || 'cent';
    if (cur === unit) return { kind: 'unitflip', field, unit, noop: true };
    // 真把这个列的数据改掉 —— 模拟"某次上线把单位从分改成了元"
    for (const r of state.rows) {
      r[i] = unit === 'yuan' ? r[i] / 100 : r[i] * 100;
    }
    state.unit[field] = unit;
    return { kind: 'unitflip', field, from: cur, to: unit };
  },
  typeflip({ field, to }) {
    const f = state.fields.find((x) => x.name === field);
    if (!f) throw new Error(`字段不存在: ${field}`);
    const i = state.fields.indexOf(f);
    for (const r of state.rows) {
      if (to === 'string') r[i] = String(r[i]);
      else if (to === 'number') r[i] = Number(r[i]);
    }
    f.sqlType = to === 'string' ? 'VARCHAR(32)' : 'INT';
    return { kind: 'typeflip', field, to };
  },
  addfield({ name, sqlType = 'VARCHAR(32)', comment = '', value = '' }) {
    if (!name) throw new Error('addfield 需要 {name}');
    if (state.fields.some((f) => f.name === name)) throw new Error(`字段已存在: ${name}`);
    state.fields.push({ name, sqlType, type: 'string', comment });
    for (const r of state.rows) r.push(value);
    return { kind: 'addfield', name, comment };
  },
  dropfield({ name }) {
    const i = state.fields.findIndex((f) => f.name === name);
    if (i < 0) throw new Error(`字段不存在: ${name}`);
    state.fields.splice(i, 1);
    for (const r of state.rows) r.splice(i, 1);
    return { kind: 'dropfield', name };
  },
  hostile({ field }) {
    // 把字段改成词典完全无法锚定的乱码 —— 用于验证"宁缺毋滥"的匹配纪律
    const f = state.fields.find((x) => x.name === field);
    if (!f) throw new Error(`字段不存在: ${field}`);
    const old = f.name;
    f.name = `zz_qw_${old.length}`;
    f.comment = '';
    return { kind: 'hostile', from: old, to: f.name };
  },
  reset() {
    state.fields = BASE_FIELDS();
    state.unit = { jg_fen: 'cent' };
    state.restyle = 'abbr';
    state.rows = [
      ['机械键盘 K870', 39999, 42, 1750000000, 1, 'C-013', '87 键热插拔轴体，PBT 键帽'],
      ['人体工学椅 Pro', 129900, 7, 1750100000, 1, 'C-021', '四级腰托，网布透气'],
      ['4K 显示器 27寸', 219900, 0, 1750200000, 0, 'C-017', '广色域，已停产待下架'],
      ['机械键盘 K870', 39999, 12, 1750300000, 1, 'C-013', '重复录入的历史脏数据'],
    ];
    return { kind: 'reset' };
  },
};

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(body);
}
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj, null, 2), 'application/json; charset=utf-8');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 4e6) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;
  try {
    // ── 业务面：查询商品 ──────────────────────────────────────────────
    if (req.method === 'GET' && (p === '/api/goods' || p === '/wms/QueryGoods')) {
      return send(res, 200, goodsXml(state.rows), 'application/xml; charset=utf-8');
    }
    // ── 业务面：新增商品（写入端）────────────────────────────────────
    if (req.method === 'POST' && p === '/api/goods') {
      const body = await readBody(req);
      const obj = parseFlatXml(body);
      const row = state.fields.map((f) => {
        const v = obj[f.name];
        if (f.sqlType.startsWith('INT') || f.sqlType.startsWith('BIGINT') || f.sqlType.startsWith('TINYINT')) {
          const n = Number(v);
          return Number.isFinite(n) ? Math.trunc(n) : 0;
        }
        return v == null ? '' : String(v);
      });
      state.rows.push(row);
      return send(res, 200, `<response><resultCode>0</resultCode><inserted>1</inserted><total>${state.rows.length}</total></response>`, 'application/xml; charset=utf-8');
    }

    // ── 控制面（真实系统不存在，仅用于演示注入协议突变）─────────────────
    if (req.method === 'GET' && p === '/__schema') {
      return sendJson(res, 200, {
        table: TABLE,
        restyle: state.restyle,
        unit: state.unit,
        fields: state.fields.map((f, i) => ({ ...f, unit: state.unit[f.name] || null, sample: state.rows[0] ? state.rows[0][i] : null })),
        rowCount: state.rows.length,
      });
    }
    if (req.method === 'GET' && p === '/__raw') {
      return sendJson(res, 200, { rows: state.rows.map(serializeRow), xml: goodsXml(state.rows) });
    }
    if (req.method === 'POST' && p.startsWith('/__chaos/')) {
      const kind = p.slice('/__chaos/'.length);
      const fn = chaos[kind];
      if (typeof fn !== 'function') return sendJson(res, 404, { ok: false, error: `未知突变类型: ${kind}` });
      const params = JSON.parse((await readBody(req)) || '{}');
      const result = fn(params);
      result.at = Date.now();
      state.chaosLog.push(result);
      return sendJson(res, 200, { ok: true, result, schema: { fields: state.fields.map((f) => f.name), unit: state.unit } });
    }
    if (req.method === 'GET' && p === '/__chaos/log') return sendJson(res, 200, { log: state.chaosLog });

    send(res, 404, `legacy-wms: 无此端点 ${p}`);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message, stack: e.stack });
  }
});

function start(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ port, server }));
  });
}

if (require.main === module) {
  start().then(({ port }) => {
    console.log(`[legacy-wms] 系统 B 已启动 → http://127.0.0.1:${port}/api/goods (XML / 拼音缩写 / 分)`);
  });
}

module.exports = { start, state, chaos, goodsXml, parseFlatXml, serializeRow, BASE_FIELDS, PORT, setStyle, NAME_STYLES };
