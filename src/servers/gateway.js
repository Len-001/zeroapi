'use strict';
/**
 * ZeroAPI 网关（端口 8310）—— 原型的大脑
 * ---------------------------------------------------------------------------
 * 承担的职责：
 *   1. 控制面：把「老 ERP 的 XML 报文」变成「现代 CRM 的 ProductDTO JSON」；
 *   2. 观测面：把嗅探 / 求解 / 验证 / 编译 / 自愈的全过程通过 SSE 直播给大屏；
 *   3. 演示面：注入协议突变、触发全链路同步、展示自动合成的胶水代码。
 *
 * 上游拓扑：
 *   老 ERP  (8312)  ← 数据源，XML / 拼音缩写 / 分
 *   现代 CRM (8311) ← 验收方，严格 ProductDTO 契约
 *   本网关   (8310) ← 中间那条"看不见的缝合线"
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { Bus } = require('../core/bus');
const { Bridge } = require('../core/bridge');
const {
  parseDdl, parseTsInterfaces, buildAdt, fingerprint,
} = require('../core/extractor');
const { fnv1a } = require('../core/extractor');

const PORT = Number(process.env.GATEWAY_PORT || 8310);
const LEGACY = `http://127.0.0.1:${process.env.LEGACY_PORT || 8312}`;
const MODERN = `http://127.0.0.1:${process.env.MODERN_PORT || 8311}`;
const ROOT = path.resolve(__dirname, '../..');

const bus = new Bus();

// ---------------------------------------------------------------------------
// 静态契约装载
// ---------------------------------------------------------------------------
const ddlText = fs.readFileSync(path.join(ROOT, 'contracts/legacy_erp.sql'), 'utf8');
const tsText = fs.readFileSync(path.join(ROOT, 'contracts/modern_crm.d.ts'), 'utf8');

const ddlTables = parseDdl(ddlText);
const ddlTable = ddlTables.find((t) => t.table === 'erp_goods') || ddlTables[0] || { fields: [] };
const tsIfaces = parseTsInterfaces(tsText);
const tsIface = (name) => {
  const f = tsIfaces.find((i) => i.iface === name);
  if (!f) throw new Error(`契约中缺少 ${name}`);
  return f.fields.map((x) => ({ ...x, type: x.type }));
};

/** 目标侧 ADT：只有静态证据（新系统还没跑起来就有类型） */
let targetProductAdt = buildAdt(tsIface('ProductDTO'), []).nodes;
const targetOrderAdt = buildAdt(tsIface('OrderDTO'), []).nodes;

/**
 * 契约收紧开关（演示用）：
 * 把 ProductDTO 里的可选字段改为必填，观察 ZeroAPI 如何**立刻**把
 * "源系统根本没有这个数据"这件事暴露成一次精确的 CRM 拒收，
 * 而不是悄悄塞一个 null 进去让问题延后爆发。
 */
let contractStrict = false;
function setContractStrict(strict) {
  const fields = tsIface('ProductDTO').map((f) => ({ ...f, optional: strict ? false : f.optional }));
  targetProductAdt = buildAdt(fields, []).nodes;
  contractStrict = !!strict;
  bridge.reset();
  bus.emit('contract', { strict: contractStrict, fields: targetProductAdt.map((n) => ({ name: n.name, optional: !!n.optional })) });
  return targetProductAdt;
}

// ---------------------------------------------------------------------------
// 老 ERP 的实时 schema（每次请求刷新；静态 DDL 与它的差集就是"文档过期度"）
// ---------------------------------------------------------------------------
let legacySchema = { fields: [], restyle: 'abbr', unit: {}, rowCount: 0 };
let ddlCoverage = { matched: 0, total: 0, ratio: 0, missing: [] };

async function refreshLegacySchema() {
  const r = await call('GET', `${LEGACY}/__schema`);
  legacySchema = JSON.parse(r.body);
  const live = new Set(legacySchema.fields.map((f) => f.name));
  const ddlNames = ddlTable.fields.map((f) => f.name);
  const matched = ddlNames.filter((n) => live.has(n));
  ddlCoverage = {
    matched: matched.length,
    total: live.size,
    ratio: live.size ? matched.length / live.size : 0,
    missing: [...live].filter((n) => !ddlNames.includes(n)),
    staleDdl: ddlNames.filter((n) => !live.has(n)),
  };
  return legacySchema;
}

/**
 * 老 ERP 的静态契约证据（SQL DDL ⊕ 线上实时 schema）。
 * 注意：这个函数描述的是**系统 B 的形态**，因此它只能用作"源侧静态证据"（读路径）
 * 或"目标侧契约"(写路径) —— 绝不能拿去描述系统 A。
 * 早期版本在写路径里误把它当成"OrderDTO 的静态声明"传入，导致源 ADT 里凭空
 * 多出 7 个老 ERP 字段，桥接器把它们全部映射成 null（一个安静但致命的错值）。
 */
function legacyStaticFields() {
  const byDdl = new Map(ddlTable.fields.map((f) => [f.name, f]));
  return legacySchema.fields.map((f) => {
    const d = byDdl.get(f.name);
    return {
      name: f.name,
      declared: d ? d.declared : f.sqlType,
      type: f.type === 'number' ? 'number' : f.type,
      comment: (d && d.comment) || f.comment || '',
      source: d ? 'sql-ddl' : 'live-schema',
    };
  });
}

// ---------------------------------------------------------------------------
// 桥接器实例（读路径 / 写路径各一条）
// ---------------------------------------------------------------------------
const bridge = new Bridge({
  name: 'zeroapi',
  sourceLabel: 'erp_goods (XML/拼音/分)',
  targetLabel: 'ProductDTO (JSON/camel/元)',
  bus,
  opts: { sampleWindow: 6, maxRebuildPerCall: 3 },
});
const bridgeWrite = new Bridge({
  name: 'zeroapi-write',
  sourceLabel: 'OrderDTO (JSON/camel/元)',
  targetLabel: 'erp_order (XML/拼音缩写/分)',
  bus,
  opts: { sampleWindow: 6, maxRebuildPerCall: 3 },
});

// ---------------------------------------------------------------------------
// 信封层编解码（对应 BP 里的 "XML 转 JSON" 节点）
// ---------------------------------------------------------------------------
const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escXml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** XML → JS 对象：数值型文本强制转型（否则一切字段都是 string，单位推断全部失效） */
function decodeEnvelope(xml) {
  const rows = [];
  const itemRe = /<goods>([\s\S]*?)<\/goods>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const obj = {};
    const fieldRe = /<([A-Za-z_][\w.\-]*)\s*>([^<]*?)<\/\1>/g;
    let f;
    while ((f = fieldRe.exec(m[1]))) {
      const raw = decodeEntities(f[2]);
      obj[f[1]] = coerce(raw);
    }
    rows.push(obj);
  }
  return rows;
}

function coerce(raw) {
  if (raw === '') return '';
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
    return raw;
  }
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

function encodeEnvelope(obj) {
  const body = Object.entries(obj)
    .map(([k, v]) => `  <${k}>${escXml(v)}</${k}>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<request service="wms.InsertGoods" version="1.0">\n${body}\n</request>`;
}

// ---------------------------------------------------------------------------
// HTTP 客户端
// ---------------------------------------------------------------------------
function call(method, url, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: body ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 读路径：老 ERP → 信封解码 → 桥接 → ProductDTO[]
// ---------------------------------------------------------------------------
async function readBridged({ withTrace = false } = {}) {
  const t0 = Number(process.hrtime.bigint()) / 1e6;
  await refreshLegacySchema();
  const raw = await call('GET', `${LEGACY}/api/goods`);
  const xml = raw.body;
  const decodeStart = Number(process.hrtime.bigint()) / 1e6;
  const rows = decodeEnvelope(xml);
  const decodeMs = Number(process.hrtime.bigint()) / 1e6 - decodeStart;

  const out = [];
  const perRow = [];
  let driftedAny = false;
  for (const row of rows) {
    const t1 = Number(process.hrtime.bigint()) / 1e6;
    const r = bridge.convert('/api/goods', row, targetProductAdt, {
      targetLabel: 'ProductDTO',
      staticSource: legacyStaticFields,
      targetFp: fingerprint(targetProductAdt),
    });
    perRow.push({ ms: r.ms, healed: r.healed, degraded: r.degraded });
    if (r.drift && r.drift.length) driftedAny = true;
    out.push(r.out);
  }
  const totalMs = Number(process.hrtime.bigint()) / 1e6 - t0;
  bus.emit('request', {
    bridge: 'zeroapi', route: '/api/goods', mode: 'bridge',
    rows: rows.length, totalMs: Math.round(totalMs * 1000) / 1000,
    decodeMs: Math.round(decodeMs * 1000) / 1000,
    avgRowMs: Math.round((perRow.reduce((a, x) => a + x.ms, 0) / Math.max(1, perRow.length)) * 1000) / 1000,
    healed: perRow.some((x) => x.healed), degraded: perRow.some((x) => x.degraded),
  });
  return { rows: out, rawXml: xml, legacyRows: rows, totalMs, decodeMs, perRow, driftedAny };
}

// ---------------------------------------------------------------------------
// 写路径：OrderDTO → 反向桥接 → XML → 老 ERP
// ---------------------------------------------------------------------------
async function writeOrder(dto) {
  await refreshLegacySchema();
  // 写路径的目标是"老 ERP 的字段形态"，直接由老 ERP 当前 schema 构造
  const targetAdt = buildAdt(legacyStaticFields(), []).nodes;
  const r = bridgeWrite.convert('/api/order', dto, targetAdt, {
    targetLabel: 'erp_goods',
    // 注意这里**不传 staticSource**：源侧是运行时的 OrderDTO 对象，
    // 没有任何静态契约文件可以作证。若硬塞老 ERP 的字段进去，
    // 源 ADT 会凭空多出 7 个不存在的字段，产物变成一串 null。
    targetFp: fingerprint(targetAdt),
  });
  const legacyForm = r.out;
  const xml = encodeEnvelope(legacyForm);
  const resp = await call('POST', `${LEGACY}/api/goods`, xml, 'application/xml');
  return { legacyForm, xml, legacyResponse: resp.body, bridge: { ms: r.ms, healed: r.healed, degraded: r.degraded, drift: r.drift } };
}

// ---------------------------------------------------------------------------
// 静态资源
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(res, rel) {
  const file = path.join(ROOT, rel);
  if (!file.startsWith(path.join(ROOT, 'src/ui'))) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const sseClients = new Set();

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj, null, 2));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;
  try {
    if (p === '/' || p === '/index.html') return serveStatic(res, 'src/ui/index.html');
    if (p.startsWith('/ui/')) return serveStatic(res, `src/ui/${p.slice(4)}`);

    // ── SSE ───────────────────────────────────────────────────────────
    if (p === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*',
      });
      const since = Number(u.searchParams.get('since') || 0);
      // 历史回放必须打上 history 标记：晚加入的客户端（比如刷新页面的大屏）
      // 需要看到"当前拓扑长什么样"，但**不能**把这些历史事件计入实时计数器，
      // 否则自愈次数、求解次数会被重复累加，指标失真。
      for (const e of bus.recent(80)) {
        if (e.seq > since) res.write(`id: ${e.seq}\ndata: ${JSON.stringify({ ...e, history: true })}\n\n`);
      }
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 连接已断，等 close 事件清理 */ } }, 15000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    // ── 直连模式（不给 ZeroAPI，看看会发生什么）─────────────────────────
    if (p === '/api/products' && u.searchParams.get('mode') === 'direct') {
      await refreshLegacySchema();
      const raw = await call('GET', `${LEGACY}/api/goods`);
      const rows = decodeEnvelope(raw.body);
      bus.emit('request', { bridge: null, route: '/api/goods', mode: 'direct', rows: rows.length, totalMs: 0, degraded: true });
      return sendJson(res, 200, { mode: 'direct', rows, xml: raw.body, message: '原始报文直通：字段名/类型/单位全部未经对齐' });
    }

    // ── 桥接模式 ─────────────────────────────────────────────────────
    if (p === '/api/products') {
      const r = await readBridged({ withTrace: true });
      return sendJson(res, 200, {
        mode: 'bridge', rows: r.rows, rawXml: r.rawXml,
        metrics: { totalMs: r.totalMs, decodeMs: r.decodeMs, avgRowMs: r.perRow.reduce((a, x) => a + x.ms, 0) / Math.max(1, r.perRow.length) },
      });
    }

    if (p === '/api/sync' && req.method === 'POST') {
      const r = await readBridged({ withTrace: true });
      const feed = await call('POST', `${MODERN}/api/ingest`, JSON.stringify({ items: r.rows }));
      const crm = JSON.parse(feed.body);
      bus.emit('sync', {
        rows: r.rows.length, crmStatus: feed.status, crmOk: !!crm.ok,
        message: crm.message || (crm.detail && crm.detail[0] && crm.detail[0].errors && crm.detail[0].errors[0]) || 'CRM 拒收',
        totalMs: Math.round((r.totalMs) * 1000) / 1000,
      });
      return sendJson(res, 200, { ok: !!crm.ok, bridged: r.rows, crm, totalMs: r.totalMs });
    }

    if (p === '/api/order' && req.method === 'POST') {
      const dto = JSON.parse((await readBody(req)) || '{}');
      const r = await writeOrder(dto);
      await call('POST', `${MODERN}/api/orders`, JSON.stringify({ items: [dto] }));
      bus.emit('order', { orderNo: dto.orderNo, legacyForm: r.legacyForm, ms: r.bridge.ms });
      return sendJson(res, 200, r);
    }

    // ── 控制面 ───────────────────────────────────────────────────────
    if (p === '/api/status') {
      await refreshLegacySchema().catch(() => {});
      return sendJson(res, 200, {
        bridge: bridge.snapshot(),
        bridgeWrite: bridgeWrite.snapshot(),
        legacySchema,
        ddlCoverage,
        contract: { file: 'contracts/modern_crm.d.ts', ifaces: tsIfaces.map((i) => i.iface), strict: contractStrict },
        targetAdt: targetProductAdt.map((n) => ({ name: n.name, type: n.type, unit: n.unit, concept: n.concept, comment: n.comment, anchor: n.anchor })),
      });
    }

    if (p === '/api/adt') {
      const st = bridge.getRoute('/api/goods');
      return sendJson(res, 200, {
        target: targetProductAdt.map(serializeNode),
        source: (st.sourceAdt || []).map(serializeNode),
        fingerprint: st.fingerprint,
      });
    }

    if (p === '/api/glue') {
      const st = bridge.getRoute('/api/goods');
      if (!st.entry) return sendJson(res, 200, { ready: false, message: '桥接器尚未编译（先调用一次 /api/products）' });
      return sendJson(res, 200, {
        ready: true,
        fingerprint: st.entry.fingerprint,
        bytes: st.entry.bytes,
        compileMs: st.entry.compileMs,
        stats: st.entry.stats,
        source: st.entry.source,
        humanCodeLines: st.entry.source.split('\n').filter((l) => /out\[/.test(l)).length,
        // 把当前生效的映射计划一并返回：控制台在"没有事件流"（例如无头截图
        // 关掉 SSE）时也能画出拓扑连线，不必依赖实时事件重建画面状态。
        pairs: st.entry.meta.pairs,
        unmappedFrom: st.entry.meta.unmappedFrom,
        unmappedTo: st.entry.meta.unmappedTo,
      });
    }

    if (p === '/api/source') {
      await refreshLegacySchema();
      const raw = await call('GET', `${LEGACY}/api/goods`);
      return sendJson(res, 200, { xml: raw.body, parsed: decodeEnvelope(raw.body), schema: legacySchema });
    }

    if (p.startsWith('/api/chaos/') && req.method === 'POST') {
      const kind = p.slice('/api/chaos/'.length);
      const body = (await readBody(req)) || '{}';
      const r = await call('POST', `${LEGACY}/__chaos/${kind}`, body);
      const parsed = JSON.parse(r.body);
      if (parsed.ok) bus.emit('chaos', { kind, result: parsed.result, schema: parsed.schema });
      return sendJson(res, r.status, parsed);
    }

    if (p === '/api/contract/strict' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const strict = !!body.strict;
      // 契约归系统 A 所有：先让 CRM 改，网关再按**CRM 的声明**重建目标 ADT。
      // 顺序反了就会出现"网关与 CRM 对同一个字段的可选性认知不一致"。
      const crm = await call('POST', `${MODERN}/__contract/strict`, JSON.stringify({ strict }));
      const crmState = JSON.parse(crm.body);
      const nodes = setContractStrict(crmState.strict);
      return sendJson(res, 200, { ok: true, strict: crmState.strict, crmFields: crmState.fields, fields: nodes.map((n) => ({ name: n.name, optional: !!n.optional })) });
    }

    if (p === '/api/reset' && req.method === 'POST') {
      await call('POST', `${LEGACY}/__chaos/reset`, '{}');
      await call('POST', `${MODERN}/__reset`, '{}');
      bridge.reset();
      bridgeWrite.reset();
      bridge.resetMetrics();
      bridgeWrite.resetMetrics();
      setContractStrict(false);
      bus.emit('reset', {});
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/metrics') {
      return sendJson(res, 200, { read: bridge.snapshot(), write: bridgeWrite.snapshot() });
    }

    sendJson(res, 404, { ok: false, error: `zeroapi-gateway: 无此端点 ${p}` });
  } catch (e) {
    bus.emit('error', { route: p, message: e.message });
    sendJson(res, 500, { ok: false, error: e.message, stack: e.stack });
  }
});

function serializeNode(n) {
  return {
    name: n.name, type: n.type, unit: n.unit, concept: n.concept, comment: n.comment,
    anchor: n.anchor, declared: n.declared, staticSource: n.staticSource,
    sample: n.samples && n.samples.length ? n.samples[n.samples.length - 1] : null,
  };
}

bus.on('event', (evt) => {
  const payload = `id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const c of sseClients) { try { c.write(payload); } catch { /* 忽略已断开的客户端 */ } }
});

function start(port = PORT) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port, server })));
}

if (require.main === module) {
  start().then(({ port }) => {
    console.log(`[zeroapi] 巴别塔网关已启动 → http://127.0.0.1:${port}/`);
    console.log(`[zeroapi] 目标契约 ${tsIfaces.map((i) => i.iface).join(', ')} | DDL 表 ${ddlTable.table}`);
  });
}

module.exports = {
  start, server, bus, bridge, bridgeWrite, readBridged, writeOrder,
  decodeEnvelope, encodeEnvelope, refreshLegacySchema, targetProductAdt, targetOrderAdt, PORT,
};
