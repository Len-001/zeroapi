'use strict';
/**
 * 系统 A · 现代 CRM 服务端 (Modern CRM) —— 2026 年的新系统
 * ---------------------------------------------------------------------------
 * 它的作用不是"被转换"，而是当一个**严格的验收方**：
 *   /api/ingest 只接受与 contracts/modern_crm.d.ts **逐字段严格一致**的 ProductDTO：
 *     · 多一个字段 → 拒收（老前端多传个 _v 都会被打回）
 *     · 少一个字段 → 拒收
 *     · 类型不符   → 拒收（boolean 传了 0 也不行，0 不是 false）
 *   因此"CRM 成功接收"这件事本身，就是"ZeroAPI 真的零胶水对齐了契约"的硬证据。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseTsInterfaces } = require('../core/extractor');
const { jsTypeOfSafe } = require('../core/util');

const PORT = Number(process.env.MODERN_PORT || 8311);
const CONTRACT = path.resolve(__dirname, '../../contracts/modern_crm.d.ts');

const received = { products: [], orders: [], ingestCount: 0, rejectCount: 0, lastRejected: null };

// ---------------------------------------------------------------------------
// 启动时解析自己的契约（新系统把 TS 类型当唯一真源，没有 OpenAPI 文档）
// ---------------------------------------------------------------------------
function loadContract() {
  const src = fs.readFileSync(CONTRACT, 'utf8');
  const ifaces = parseTsInterfaces(src);
  const byName = Object.fromEntries(ifaces.map((i) => [i.iface, i.fields]));
  return { ifaces, byName };
}

/**
 * 契约由**系统 A 自己**持有 —— 这是架构上的硬规矩。
 * 网关侧的 /api/contract/strict 只是把请求转发到这里，再去重新拉取本接口；
 * 早期版本让网关自己私改一份目标 ADT，结果"网关认为 brand 必填、CRM 认为可选"，
 * 两边认知不一致，端到端测试直接把这个问题抓了出来。
 */
let contractStrict = false;
let contract = loadContract();

const TYPE_OK = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  any: () => true,
};

/** 严格契约校验：返回违规清单（空数组 = 完全合规） */
function validateDto(item, ifaceName) {
  const fields = contract.byName[ifaceName];
  if (!fields) return [`内部错误：契约 ${ifaceName} 不存在`];
  const errors = [];
  const declared = new Set(fields.map((f) => f.name));
  for (const f of fields) {
    const has = Object.prototype.hasOwnProperty.call(item, f.name);
    if (!has) {
      if (!f.optional) errors.push(`缺少必填字段 ${f.name}`);
      continue;
    }
    const v = item[f.name];
    if (v === null) {
      if (!f.optional) errors.push(`${f.name} 为 null（契约未声明可空）`);
      continue;
    }
    const expect = TYPE_OK[f.type] ? f.type : 'any';
    if (!TYPE_OK[expect](v)) {
      errors.push(`字段 ${f.name} 期望 ${f.type}，实际 ${jsTypeOfSafe(v)}（值 ${JSON.stringify(v)}）`);
    }
  }
  for (const k of Object.keys(item)) {
    if (!declared.has(k)) errors.push(`契约外字段 ${k}（严格模式拒收）`);
  }
  return errors;
}

/**
 * 切换契约严格度：把 ProductDTO 里的可选字段改为必填。
 * 每次都从**磁盘上的真源**重新解析，然后施加覆盖 —— 保证任意次切换都不会
 * 把上一轮的修改累积进契约（幂等，可反复调用）。
 */
function setContractStrict(strict) {
  contractStrict = !!strict;
  contract = loadContract();
  if (contractStrict) {
    for (const f of contract.byName.ProductDTO || []) f.optional = false;
  }
  return {
    strict: contractStrict,
    fields: (contract.byName.ProductDTO || []).map((f) => ({ name: f.name, optional: !!f.optional })),
  };
}

// ---------------------------------------------------------------------------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/received') {
      return send(res, 200, {
        ingestCount: received.ingestCount,
        rejectCount: received.rejectCount,
        lastRejected: received.lastRejected,
        products: received.products,
        orders: received.orders,
      });
    }
    if (req.method === 'GET' && p === '/__schema') {
      return send(res, 200, {
        ifaces: contract.ifaces,
        strict: contractStrict,
        source: path.relative(path.resolve(__dirname, '../..'), CONTRACT),
      });
    }
    if (req.method === 'POST' && p === '/__contract/strict') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return send(res, 200, { ok: true, ...setContractStrict(!!body.strict) });
    }
    if (req.method === 'POST' && p === '/api/ingest') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const items = Array.isArray(body.items) ? body.items : [body.items].filter(Boolean);
      if (!items.length) return send(res, 400, { ok: false, error: '没有待接收的数据' });
      const all = [];
      let bad = 0;
      for (const it of items) {
        const errs = validateDto(it, 'ProductDTO');
        if (errs.length) { bad++; all.push({ ok: false, errors: errs, item: it }); }
        else all.push({ ok: true });
      }
      if (bad) {
        received.rejectCount++;
        received.lastRejected = { at: Date.now(), errors: all.filter((x) => !x.ok)[0].errors, item: all.filter((x) => !x.ok)[0].item };
        return send(res, 422, {
          ok: false,
          accepted: 0,
          rejected: bad,
          detail: all.filter((x) => !x.ok).slice(0, 3),
          message: '严格契约校验未通过：CRM 拒绝接收非 ProductDTO 形态的数据',
        });
      }
      received.ingestCount++;
      received.products = items;
      return send(res, 200, { ok: true, accepted: items.length, message: `${items.length} 条 ProductDTO 已入库，字段逐一匹配契约` });
    }
    if (req.method === 'POST' && p === '/api/orders') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const items = Array.isArray(body.items) ? body.items : [body.items].filter(Boolean);
      const all = [];
      let bad = 0;
      for (const it of items) {
        const errs = validateDto(it, 'OrderDTO');
        if (errs.length) { bad++; all.push({ ok: false, errors: errs }); } else all.push({ ok: true });
      }
      if (bad) return send(res, 422, { ok: false, rejected: bad, detail: all.filter((x) => !x.ok).slice(0, 3) });
      received.orders = received.orders.concat(items);
      return send(res, 200, { ok: true, accepted: items.length, total: received.orders.length });
    }
    if (req.method === 'POST' && p === '/__reset') {
      received.products = []; received.orders = []; received.ingestCount = 0; received.rejectCount = 0; received.lastRejected = null;
      setContractStrict(false);
      return send(res, 200, { ok: true, strict: contractStrict });
    }
    send(res, 404, { ok: false, error: `modern-crm: 无此端点 ${p}` });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

function start(port = PORT) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port, server })));
}

if (require.main === module) {
  start().then(({ port }) => {
    console.log(`[modern-crm] 系统 A 已启动 → http://127.0.0.1:${port}/api/received (JSON / camelCase / 元)`);
    console.log(`[modern-crm] 契约来源: ${path.relative(process.cwd(), CONTRACT)}`);
  });
}

module.exports = { start, server, get contract() { return contract; }, validateDto, received, loadContract, setContractStrict, get contractStrict() { return contractStrict; }, PORT };
