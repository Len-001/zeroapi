'use strict';
/**
 * ZeroAPI 一键启动器
 * ---------------------------------------------------------------------------
 * 以**三个独立进程**拉起完整拓扑（刻意不用同进程多端口，
 * 这样"跨进程 / 跨语言栈的系统集成"这件事才是真的）：
 *
 *   [系统 B] legacy-wms   127.0.0.1:8312   XML  / 拼音缩写 / 分
 *   [系统 A] modern-crm   127.0.0.1:8311   JSON / camelCase / 元
 *   [中间]   zeroapi      127.0.0.1:8310   巴别塔网关 + 演示控制台
 *
 * 用法：
 *   node bin/start.js                # 常驻
 *   node bin/start.js --check        # 只做启动自检然后退出（CI/回归用）
 */

const { fork } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');

const services = [
  { name: 'legacy-wms', file: 'src/servers/legacy.js', port: Number(process.env.LEGACY_PORT || 8312), tag: '系统 B' },
  { name: 'modern-crm', file: 'src/servers/modern.js', port: Number(process.env.MODERN_PORT || 8311), tag: '系统 A' },
  { name: 'zeroapi', file: 'src/servers/gateway.js', port: Number(process.env.GATEWAY_PORT || 8310), tag: '巴别塔网关' },
];

const children = [];

function waitPort(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'HEAD' }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 120);
      });
      req.end();
    };
    tick();
  });
}

function shutdown(code = 0) {
  for (const c of children) { try { c.kill(); } catch { /* 已退出 */ } }
  setTimeout(() => process.exit(code), 120);
}

async function main() {
  console.log('═'.repeat(78));
  console.log('  ZeroAPI · 巴别塔协议 —— 零接口文档软件自组装总线（原型）');
  console.log('═'.repeat(78));

  for (const s of services) {
    const child = fork(path.join(ROOT, s.file), [], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.__svc = s;
    children.push(child);
  }

  // 串行探活：网关依赖另外两个的 schema 接口，但每个服务自身都能独立启动
  const results = [];
  for (const s of services) {
    const ok = await waitPort(s.port);
    results.push({ ...s, ok });
    console.log(`${ok ? '✔' : '✘'} [${s.tag}] ${s.name.padEnd(12)} http://127.0.0.1:${s.port}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n启动失败：${failed.map((f) => f.name).join(', ')}`);
    shutdown(1);
    return;
  }

  // 端到端自检：老 ERP → 网关桥接 → 归一化产物。
  // 刻意用 **只读** 路径：早期版本用 POST /api/sync 做自检，那会把数据真的写进
  // 下游 CRM —— 一个"健康检查"不该产生业务副作用（启动即污染 CRM 的收件箱）。
  // 只读探针同样覆盖了完整链路（嗅探 → 求解 → 验证 → 编译 → 转换）。
  const probe = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: services[2].port, path: '/api/products', method: 'GET',
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end();
  });
  let parsed = {};
  try { parsed = JSON.parse(probe.body); } catch { /* 自检失败时保留原文 */ }
  const row = parsed.rows && parsed.rows[0];
  const e2eOk = probe.status === 200
    && Array.isArray(parsed.rows)
    && parsed.rows.length > 0
    && typeof row.priceYuan === 'number'
    && typeof row.isListed === 'boolean'
    && typeof row.createdAt === 'string'
    && typeof row.productName === 'string'
    && !Object.prototype.hasOwnProperty.call(row, 'brand'); // 契约缺口不得被伪造
  console.log(`\n${e2eOk ? '✔' : '✘'} 端到端自检：老 ERP(XML/拼音/分) → ZeroAPI 桥接 → ProductDTO 形态 ${e2eOk ? '通过' : '未通过'}`);
  if (e2eOk) {
    console.log(`   样本: priceYuan=${row.priceYuan} (源 39999 分) · createdAt=${row.createdAt} · isListed=${row.isListed} · 7/7 字段对齐`);
  } else {
    console.log(`  回执: ${probe.body.slice(0, 400)}`);
  }

  console.log('\n演示控制台  → http://127.0.0.1:8310/');
  console.log('老 ERP 原始 → http://127.0.0.1:8312/api/goods');
  console.log('CRM 已收数据 → http://127.0.0.1:8311/api/received\n');

  if (CHECK) {
    shutdown(e2eOk ? 0 : 1);
    return;
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  for (const c of children) c.on('exit', (code) => { if (code !== 0 && code !== null) { console.error(`子进程退出 code=${code}`); shutdown(code); } });
}

main();
