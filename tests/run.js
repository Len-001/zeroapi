'use strict';
/**
 * ZeroAPI · 测试总入口
 *   node tests/run.js            # 跑全部（含真实 HTTP 端到端）
 *   node tests/run.js --core     # 只跑核心层（不起服务，纯函数级）
 *   node tests/run.js --e2e      # 只跑端到端
 *
 * 产出：reports/verification.json（机器可读）+ reports/SUMMARY.md（人可读）
 */

const fs = require('fs');
const path = require('path');
const harness = require('./harness');
const H = require('./harness');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const onlyE2E = args.includes('--e2e');
const onlyCore = args.includes('--core');

const CASES = [
  ['01-min-boundary.js', '最小边界'],
  ['02-max-boundary.js', '最大边界'],
  ['03-structural.js', '结构异常'],
  ['04-state-transition.js', '状态转移陷阱'],
  ['05-semantics.js', '正向验收（精度/算子/风格矩阵）'],
];

async function main() {
  const startedAt = new Date();
  const t0 = Date.now();

  if (!onlyE2E) {
    console.log('\n\x1b[1m══ ZeroAPI 核心层测试（红蓝对抗 4 类 + 正向验收）══\x1b[0m');
    for (const [file, label] of CASES) {
      console.log(`\n\x1b[36m▸ ${label}  (tests/cases/${file})\x1b[0m`);
      require(path.join(__dirname, 'cases', file))();
    }
  }

  let e2e = null;
  if (!onlyCore) {
    console.log('\n\x1b[1m══ 端到端测试（真实 HTTP / 三进程拓扑）══\x1b[0m');
    e2e = await require('./e2e')();
  }

  const sum = H.summary();
  const wallMs = Date.now() - t0;

  console.log('\n' + '═'.repeat(74));
  console.log('\x1b[1m  汇总\x1b[0m');
  console.log('═'.repeat(74));
  for (const s of sum.bySuite) {
    const bar = s.pass === s.total ? '\x1b[32m' : '\x1b[31m';
    console.log(`  ${bar}${String(s.pass).padStart(3)}/${String(s.total).padStart(3)}\x1b[0m  ${s.suite}`);
  }
  const ok = sum.failed === 0;
  console.log('─'.repeat(74));
  console.log(`  ${ok ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m${sum.failed} 项失败\x1b[0m`}  ·  共 ${sum.total} 条断言用例  ·  墙钟 ${(wallMs / 1000).toFixed(2)}s`);
  console.log('═'.repeat(74));

  // ── 产出报告 ──────────────────────────────────────────────────────
  const reportDir = path.join(ROOT, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const report = {
    project: 'ZeroAPI / 巴别塔协议 · 原型验证报告',
    generatedAt: startedAt.toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    wallMs,
    summary: { total: sum.total, passed: sum.passed, failed: sum.failed, bySuite: sum.bySuite },
    e2e: e2e || null,
    cases: sum.cases,
  };
  fs.writeFileSync(path.join(reportDir, 'verification.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(reportDir, 'SUMMARY.md'), renderMarkdown(report), 'utf8');
  console.log(`\n报告已写出：\n  · reports/verification.json\n  · reports/SUMMARY.md\n`);

  process.exit(ok ? 0 : 1);
}

function renderMarkdown(r) {
  const L = [];
  L.push('# ZeroAPI / 巴别塔协议 · 原型验证报告');
  L.push('');
  L.push(`> 自动生成于 ${r.generatedAt} · Node ${r.node} · ${r.platform} · 墙钟 ${(r.wallMs / 1000).toFixed(2)}s`);
  L.push('');
  L.push('## 总览');
  L.push('');
  L.push(`**${r.summary.passed} / ${r.summary.total} 条用例通过**${r.summary.failed ? `（${r.summary.failed} 条失败）` : ''}`);
  L.push('');
  L.push('| 分组 | 通过 | 合计 |');
  L.push('| --- | ---: | ---: |');
  for (const s of r.summary.bySuite) L.push(`| ${s.suite} | ${s.pass} | ${s.total} |`);
  L.push('');
  if (r.e2e) {
    L.push('## 端到端实测数据（真实 HTTP，三进程）');
    L.push('');
    L.push('| 指标 | 实测值 |');
    L.push('| --- | --- |');
    for (const [k, v] of Object.entries(r.e2e.metrics || {})) L.push(`| ${k} | ${v} |`);
    L.push('');
    L.push('| 端到端步骤 | 结果 |');
    L.push('| --- | --- |');
    for (const s of r.e2e.steps || []) L.push(`| ${s.name} | ${s.ok ? '✔' : '✘'} ${s.detail} |`);
    L.push('');
  }
  L.push('## 逐条用例');
  L.push('');
  let cur = '';
  for (const c of r.cases) {
    if (c.suite !== cur) { cur = c.suite; L.push(''); L.push(`### ${cur}`); L.push(''); }
    L.push(`- ${c.ok ? '✔' : '✘'} ${c.name}${c.ok ? '' : ` — ${c.detail}`} _(${c.ms.toFixed(2)}ms)_`);
  }
  L.push('');
  return L.join('\n');
}

main().catch((e) => {
  console.error('测试运行器自身崩溃：', e);
  process.exit(2);
});
