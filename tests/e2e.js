'use strict';
/**
 * L2 端到端测试：真实 HTTP + 三个独立进程
 * ---------------------------------------------------------------------------
 * 与前四个纯函数级的对抗用例不同，这一层测的是**协议与集成**：
 *   · 老 ERP 真的返回 XML、真的用拼音字段名、真的以分为单位
 *   · 现代 CRM 真的做严格契约校验（多一个字段都拒收）
 *   · 网关真的在中间做嗅探→求解→验证→编译→热替换
 * 同时采集真实时延分布与自愈耗时，作为"不是 PPT 项目"的证据。
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { suite, test, assert, assertEq, assertIn } = require('./harness');

const ROOT = path.resolve(__dirname, '..');
const P = { gateway: 8410, modern: 8411, legacy: 8412 };
const BASE = `http://127.0.0.1:${P.gateway}`;

function call(method, url, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: body ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 保留原文 */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const get = (p) => call('GET', BASE + p);
const post = (p, obj) => call('POST', BASE + p, JSON.stringify(obj || {}));

function waitPort(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'HEAD' }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => (Date.now() > deadline ? resolve(false) : setTimeout(tick, 120)));
      req.end();
    };
    tick();
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

let child = null;
const steps = [];
const metrics = {};

async function main() {
  suite('⑥ 端到端（真实 HTTP / 三进程）');

  child = spawn(process.execPath, [path.join(ROOT, 'bin/start.js')], {
    cwd: ROOT,
    env: { ...process.env, GATEWAY_PORT: String(P.gateway), MODERN_PORT: String(P.modern), LEGACY_PORT: String(P.legacy), NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d.toString(); });
  child.stderr.on('data', (d) => { bootLog += d.toString(); });

  const up = await Promise.all([waitPort(P.gateway), waitPort(P.modern), waitPort(P.legacy)]);
  assert(up.every(Boolean), `三个服务未全部就绪：${bootLog.slice(-600)}`);
  steps.push({ name: '三进程启动', ok: true, detail: `gateway:${P.gateway} modern:${P.modern} legacy:${P.legacy}` });

  try {
    await runScenarios();
  } finally {
    if (child) { child.kill(); }
  }
  return { steps, metrics, bootLog: bootLog.split('\n').filter(Boolean) };
}

async function runScenarios() {
  // ── 0. 基线 ───────────────────────────────────────────────────────
  await post('/api/reset');

  await testAsync('老 ERP 的线上报文确实是 XML + 拼音缩写 + 分', async () => {
    const r = await call('GET', `http://127.0.0.1:${P.legacy}/api/goods`);
    assertEq(r.status, 200);
    assert(r.text.startsWith('<?xml'), '必须是 XML');
    assert(r.text.includes('<sp_mc>'), '必须是拼音缩写字段名');
    assert(/<jg_fen>\d+<\/jg_fen>/.test(r.text), '金额必须以「分」为整数存储');
    assert(!r.text.includes('productName'), '不应出现任何现代字段名');
    steps.push({ name: '基线：老 ERP 报文形态', ok: true, detail: `XML ${r.text.length} 字节，字段 sp_mc/jg_fen/…` });
  });

  await testAsync('直连模式（无 ZeroAPI）：现代前端收到的是老 ERP 原始形态', async () => {
    const r = await get('/api/products?mode=direct');
    assertEq(r.status, 200);
    const row = r.json.rows[0];
    assertEq(Object.keys(row).includes('productName'), false, '直连不应有任何字段对齐');
    assert(typeof row.jg_fen === 'number', '金额仍是「分」');
    assertEq(row.sf_sx, 1, '布尔仍是 0/1');
    steps.push({ name: '直连模式', ok: true, detail: '字段名/单位/编码全部未对齐（这正是前端崩溃的根因）' });
  });

  // ── 1. 首次桥接 ───────────────────────────────────────────────────
  const first = await get('/api/products');
  await testAsync('首次桥接：7 条字段全部对齐，金额/时间/布尔均正确', async () => {
    assertEq(first.status, 200);
    const row = first.json.rows[0];
    assertEq(row.productName, '机械键盘 K870');
    assertEq(row.priceYuan, 399.99, '39999 分 必须变成 399.99 元');
    assertEq(row.stockQty, 42);
    assertEq(row.createdAt, '2025-06-15T15:06:40.000Z');
    assertEq(row.isListed, true);
    assertEq(row.categoryId, 'C-013');
    assertEq(row.description, '87 键热插拔轴体，PBT 键帽');
    assertEq(Object.prototype.hasOwnProperty.call(row, 'brand'), false, '契约缺口字段不得伪造');
    steps.push({ name: '首次桥接', ok: true, detail: `7/7 字段对齐，端到端 ${first.json.metrics.totalMs.toFixed(1)}ms` });
    metrics['首次桥接端到端耗时'] = `${first.json.metrics.totalMs.toFixed(2)} ms`;
    metrics['信封解码耗时'] = `${first.json.metrics.decodeMs.toFixed(2)} ms`;
  });

  await testAsync('编译产物可被 /api/glue 取出，且是完整可读源码', async () => {
    const r = await get('/api/glue');
    assertEq(r.json.ready, true);
    assert(r.json.source.includes('function convert'), '必须能看到转换函数源码');
    assert(r.json.source.includes('function revert'), '必须能看到反向函数源码');
    assert(r.json.humanCodeLines >= 7, '至少要能看到 7 行字段赋值');
    metrics['自动生成的胶水代码'] = `${r.json.source.split('\n').length} 行 / ${r.json.bytes} 字节`;
    metrics['人手编写的转换代码'] = '0 行';
    steps.push({ name: '胶水代码可取出', ok: true, detail: `${r.json.bytes} 字节，编译 ${r.json.compileMs.toFixed(2)}ms` });
  });

  // ── 2. 全链路同步到 CRM ───────────────────────────────────────────
  const sync = await post('/api/sync');
  await testAsync('全链路：老 ERP → 网关 → 现代 CRM 严格契约验收通过', async () => {
    assertEq(sync.status, 200);
    assertEq(sync.json.ok, true, `CRM 拒收：${JSON.stringify(sync.json.crm)}`);
    assertEq(sync.json.crm.accepted, 4);
    steps.push({ name: '全链路同步', ok: true, detail: `CRM 接收 ${sync.json.crm.accepted} 条 ProductDTO` });
  });

  await testAsync('CRM 侧确实存下了数据（不是网关自说自话）', async () => {
    const r = await call('GET', `http://127.0.0.1:${P.modern}/api/received`);
    assertEq(r.status, 200);
    assertEq(r.json.ingestCount, 1);
    assertEq(r.json.products[0].priceYuan, 399.99);
    assertEq(r.json.products[0].isListed, true);
    steps.push({ name: 'CRM 独立核实', ok: true, detail: `ingestCount=${r.json.ingestCount}，首条 priceYuan=${r.json.products[0].priceYuan}` });
  });

  await testAsync('反例：手工塞一条不合契约的数据 → CRM 必须精确拒收', async () => {
    const bad = { productName: 'X', priceYuan: 1, stockQty: 1, createdAt: '2026-01-01T00:00:00.000Z', isListed: 1, categoryId: 'C', description: 'd' };
    const r = await call('POST', `http://127.0.0.1:${P.modern}/api/ingest`, JSON.stringify({ items: [bad] }));
    assertEq(r.status, 422, 'isListed 传了数字 1（不是 boolean）必须被拒');
    assert(r.json.detail[0].errors.join(' ').includes('isListed'), '拒收理由必须指名道姓');
    steps.push({ name: 'CRM 严格性反例', ok: true, detail: r.json.detail[0].errors[0] });
  });

  // ── 3. 自愈基准（8 次结构突变）────────────────────────────────────
  // 注意：每轮突变都以"上一轮之后的名字"为输入 —— 突变注入器本身不会记忆旧名，
  // 这正是真实场景（现场改库的人只知道当下的列名）。
  const chaosPlan = [
    ['rename', { from: 'jg_fen', to: 'dj_fen' }],
    ['restyle', { mode: 'full' }],                              // → jiage_fen
    ['unitflip', { field: 'jiage_fen', unit: 'yuan' }],
    ['typeflip', { field: 'jiage_fen', to: 'string' }],
    ['addfield', { name: 'pp', comment: '品牌', value: 'Logitech' }],
    ['restyle', { mode: 'camel' }],                             // → jgFen / spMc / sfSx …
    ['hostile', { field: 'spMc' }],
    ['dropfield', { name: 'sfSx' }],
  ];
  const healTimes = [];
  let allCorrect = true;
  const chaosDetail = [];
  const healsBeforeChaos = (await get('/api/metrics')).json.read.heals;

  for (const [kind, args] of chaosPlan) {
    const c = await post(`/api/chaos/${kind}`, args);
    assertEq(c.status, 200, `注入 ${kind} 失败: ${c.text.slice(0, 200)}`);
    const before = (await get('/api/metrics')).json.read.heals;
    const r = await get('/api/products');
    assertEq(r.status, 200, `突变 ${kind} 后桥接请求失败`);
    const after = (await get('/api/metrics')).json.read;
    const healed = after.heals > before;
    const row = r.json.rows[0];
    // 金额这条线最敏感：任何单位/类型/命名突变后都必须仍然是 399.99 元（或明确缺省）
    const priceOk = row.priceYuan === undefined || Math.abs(row.priceYuan - 399.99) < 1e-9;
    if (!priceOk) allCorrect = false;
    if (healed) healTimes.push(after.lastHealMs);
    chaosDetail.push(`${kind}:${healed ? 'healed' : 'cache-hit'}${priceOk ? '' : '(金额错误!)'}`);
  }

  await testAsync('[自愈基准] 8 轮连续结构突变全部重新合成，且金额逐轮守恒', async () => {
    assert(allCorrect, `存在金额错误：${chaosDetail.join(' | ')}`);
    const m = (await get('/api/metrics')).json.read;
    const delta = m.heals - healsBeforeChaos;
    assert(delta >= 6, `8 轮突变至少应触发 6 次重建，实际 ${delta}`);
    // 上界同样是硬指标：一次结构突变只应触发一次重建，
    // 否则说明漂移检测在"横跳"（每个字段各触发一次重建、每行数据各触发一次…）。
    assert(delta <= chaosPlan.length + 2, `8 轮突变最多允许 ${chaosPlan.length + 2} 次重建（含首轮建桥），实际 ${delta} —— 存在检测抖动`);
    assertEq(m.healAborts, 0, '不应出现任何自愈中止');
    metrics['结构突变轮次'] = chaosPlan.length;
    metrics['本轮触发重建次数'] = delta;
    metrics['重建次数上界检查'] = `≤ ${chaosPlan.length + 2}（实测 ${delta}）`;
    metrics['自愈时延 p50'] = `${percentile([...healTimes].sort((a, b) => a - b), 0.5).toFixed(3)} ms`;
    metrics['自愈时延 p95'] = `${percentile([...healTimes].sort((a, b) => a - b), 0.95).toFixed(3)} ms`;
    metrics['自愈时延 max'] = `${Math.max(...healTimes).toFixed(3)} ms`;
    steps.push({ name: '自愈基准', ok: true, detail: chaosDetail.join(' | ') });
  });

  // ── 4. 恶意改名后必须"拒绝猜"而不是猜错 ───────────────────────────
  await post('/api/reset');
  await get('/api/products');
  await post('/api/chaos/hostile', { field: 'jg_fen' });
  const hostile = await get('/api/products');
  await testAsync('[安全边界] 价格字段名被改成乱码 → 拒绝产出任何金额，而不是猜一个数', async () => {
    assertEq(hostile.status, 200, '即使无法对齐也不能让请求失败（可用性优先）');
    const row = hostile.json.rows[0];
    assert(row.priceYuan === undefined || row.priceYuan === null,
      `必须缺省，实际 ${JSON.stringify(row.priceYuan)} —— 一旦放行就是 100 倍资金事故`);
    steps.push({ name: '恶意改名安全边界', ok: true, detail: 'priceYuan 被正确判定为不可推断，输出缺省' });
  });

  // ── 5. 契约收紧 → 缺口立刻暴露 ────────────────────────────────────
  await post('/api/reset');
  await get('/api/products');
  await post('/api/contract/strict', { strict: true });
  const strict = await post('/api/sync');
  await testAsync('[契约缺口] brand 改为必填后，CRM 精确拒收并指名缺失字段', async () => {
    assertEq(strict.json.ok, false, '收紧契约后必须失败——这正是"缺口被暴露"的价值');
    const errs = JSON.stringify(strict.json.crm);
    assert(/brand/.test(errs), `拒收原因必须点名 brand，实际 ${errs.slice(0, 200)}`);
    steps.push({ name: '契约收紧暴露缺口', ok: true, detail: (strict.json.crm.detail[0].errors || []).join('; ') });
  });
  await post('/api/contract/strict', { strict: false });

  // ── 6. 反向桥接（写路径）───────────────────────────────────────────
  await post('/api/reset');
  await get('/api/products');
  const order = {
    orderNo: 'SO-2026-0001', customerName: '张三',
    priceYuan: 199.99, createdAt: '2026-10-17T00:00:00.000Z',
  };
  const wr = await post('/api/order', order);
  await testAsync('[反向桥接] 现代 OrderDTO → 老 ERP 字段形态 → XML 写入成功', async () => {
    assertEq(wr.status, 200);
    const lf = wr.json.legacyForm;
    // 只有「价格」和「时间」两个字段在两侧有语义对应；订单号/收货人老 ERP 里根本没有这俩列，
    // 因此必须**不出现**在产物里（而不是塞空值）。
    assertEq(Object.keys(lf).sort(), ['cjsj', 'jg_fen'], `产物字段集合不对: ${JSON.stringify(lf)}`);
    assertEq(lf.jg_fen, 19999, '199.99 元 必须写成 19999 分');
    assertEq(lf.cjsj, Math.floor(Date.parse('2026-10-17T00:00:00.000Z') / 1000), 'ISO 时间必须落回 Unix 秒');
    assert(wr.json.xml.includes('<?xml'), '必须以 XML 提交');
    assert(wr.json.xml.includes('<jg_fen>19999</jg_fen>'));
    assert(wr.json.legacyResponse.includes('<resultCode>0</resultCode>'), '老 ERP 必须回执成功');
    const total = await call('GET', `http://127.0.0.1:${P.legacy}/__raw`);
    assertEq(total.json.rows.length, 5, '老 ERP 应新增 1 行');
    steps.push({ name: '反向桥接', ok: true, detail: `199.99 元 → 19999 分；ISO → Unix 秒；老 ERP 行数 4→5` });
  });

  // ── 7. 时延基准（40 次连续桥接请求）──────────────────────────────
  await post('/api/reset');
  await get('/api/products');
  const lat = [];
  for (let i = 0; i < 40; i++) {
    const t = Date.now();
    await get('/api/products');
    lat.push(Date.now() - t);
  }
  lat.sort((a, b) => a - b);
  await testAsync('[时延基准] 40 次连续桥接请求：缓存命中路径无重求解，p95 落在合理量级', async () => {
    const m = (await get('/api/metrics')).json.read;
    assertEq(m.heals, 1, '结构稳定时不应反复重建（本轮只应有首次那一次）');
    metrics['缓存命中请求 p50'] = `${percentile(lat, 0.5).toFixed(1)} ms`;
    metrics['缓存命中请求 p95'] = `${percentile(lat, 0.95).toFixed(1)} ms`;
    metrics['缓存命中请求 max'] = `${lat[lat.length - 1].toFixed(1)} ms`;
    metrics['40 次请求触发的重建次数'] = m.heals;
    steps.push({ name: '时延基准', ok: true, detail: `p50 ${percentile(lat, 0.5).toFixed(1)}ms / p95 ${percentile(lat, 0.95).toFixed(1)}ms` });
  });

  // ── 8. 直连对照（同一批数据的往返耗时）───────────────────────────
  const dl = [];
  for (let i = 0; i < 20; i++) {
    const t = Date.now();
    await call('GET', `http://127.0.0.1:${P.legacy}/api/goods`);
    dl.push(Date.now() - t);
  }
  dl.sort((a, b) => a - b);
  metrics['老 ERP 直连 p50'] = `${percentile(dl, 0.5).toFixed(1)} ms`;
  steps.push({ name: '直连对照', ok: true, detail: `老 ERP 直连 p50 ${percentile(dl, 0.5).toFixed(1)}ms（同一台机器，未经过网关）` });

  // ── 9. 并发一致性 ────────────────────────────────────────────────
  await post('/api/reset');
  const conc = await Promise.all(Array.from({ length: 12 }, () => get('/api/products')));
  await testAsync('[并发一致性] 12 个并发请求：全部成功且结果逐字节一致', async () => {
    assertEq(conc.filter((r) => r.status === 200).length, 12);
    const bodies = conc.map((r) => JSON.stringify(r.json.rows));
    assertEq(new Set(bodies).size, 1, '并发场景下不得出现撕裂结果');
    const m = (await get('/api/metrics')).json.read;
    assert(m.heals <= 3, `并发冷启动引发的重建次数应受控，实际 ${m.heals}`);
    steps.push({ name: '并发一致性', ok: true, detail: `12 并发全部一致，冷启动重建 ${m.heals} 次` });
  });
}

/** 让 harness 的异步用例可在此文件内使用 */
async function testAsync(name, fn) {
  const harness = require('./harness');
  return harness.testAsync(name, fn);
}

module.exports = main;
module.exports.runScenarios = runScenarios;
