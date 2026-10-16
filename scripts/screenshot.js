'use strict';
/**
 * 无头截图 / 页面状态断言
 * ---------------------------------------------------------------------------
 * 用系统自带的 Edge（或 Chrome）命令行截图，不装 playwright/puppeteer。
 *
 * 用法：
 *   node scripts/screenshot.js                 # 截首页（需先 node bin/start.js）
 *   node scripts/screenshot.js --demo          # 跑完整的自动演示剧本后截图
 *   node scripts/screenshot.js --assert        # 只做 DOM 断言，不出图（CI 友好）
 *
 * 两条踩过的坑（都写进代码里了）：
 *   1. URL 必须带 `sse=0` —— SSE 是长连接，会阻止 Chrome 的 virtual-time 预算耗尽，
 *      导致 --screenshot 永远等不到出帧（表现为进程挂死）。
 *   2. 必须给独立 --user-data-dir，否则会去连已有 Edge 实例、拿到空窗口。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'shots');
const PROFILE = path.join(ROOT, '.edge-profile');
const PORT = Number(process.env.GATEWAY_PORT || 8310);
const BASE = `http://127.0.0.1:${PORT}`;

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findBrowser() {
  for (const p of BROWSERS) if (fs.existsSync(p)) return p;
  return null;
}

function ping() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', method: 'HEAD' }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function run(bin, args) {
  return spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 150000 });
}

function baseArgs() {
  return [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-proxy-server',
    '--disable-extensions', '--no-first-run', '--disable-sync', '--hide-scrollbars',
    `--user-data-dir=${PROFILE}`,
  ];
}

(async () => {
  const browser = findBrowser();
  if (!browser) {
    console.error('✘ 未找到 Edge / Chrome。请手动指定，或改用 `node tests/run.js --core`（不依赖浏览器）。');
    process.exit(2);
  }
  if (!(await ping())) {
    console.error(`✘ 网关未就绪（${BASE}）。请先运行：node bin/start.js`);
    process.exit(2);
  }

  const demo = process.argv.includes('--demo');
  const assertOnly = process.argv.includes('--assert');
  const url = `${BASE}/?dbg=1&sse=0${demo ? '&demo=1' : ''}`;
  console.log(`浏览器: ${browser}\n目标  : ${url}\n`);

  if (!assertOnly) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.rmSync(PROFILE, { recursive: true, force: true });
    const out = path.join(OUT_DIR, demo ? '01-zeroapi-demo.png' : '00-zeroapi-idle.png');
    const r = run(browser, [...baseArgs(), '--window-size=1680,945', '--virtual-time-budget=9000', `--screenshot=${out}`, url]);
    if (!fs.existsSync(out)) {
      console.error(`✘ 截图失败（exit=${r.status}）\n${(r.stderr || '').slice(-600)}`);
      process.exit(1);
    }
    console.log(`✔ 截图: ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
  }

  // ── DOM 断言：canvas 里的东西无法用 dump-dom 看到，所以页面通过 #dbg 导出内部计数 ──
  const r = run(browser, [...baseArgs(), '--window-size=1680,945', '--virtual-time-budget=9000', '--dump-dom', url]);
  const dom = r.stdout || '';
  const dbg = (dom.match(/<pre id="dbg"[^>]*>([\s\S]*?)<\/pre>/) || [])[1] || '';
  const err = ((dom.match(/<div id="err"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '').trim();

  console.log('\n--- 页面内部状态 (#dbg) ---');
  console.log(dbg.trim() || '(空)');

  // 只截取"商品列表"这一段来判断前端渲染结果。
  // 早期版本直接在整页里搜商品名 —— 结果命中的是右栏那段原始 XML 报文，
  // 于是"前端渲染成功"这条断言在列表其实是空的时候也会变绿（假阳性）。
  const listSection = (dom.split('id="productList"')[1] || '').split('</section>')[0];
  const hasCard = /class="card"/.test(listSection) && /机械键盘|人体工学椅/.test(listSection);
  const hasCrash = /class="crash"/.test(listSection);

  const checks = [
    ['页面无未捕获异常', err === '' && !/Uncaught TypeError/.test(dom), err.slice(0, 200)],
    ['右栏已拉取到老 ERP 原始报文', /<pre class="xml"/.test(dom) && /sp_mc|jg_fen/.test(dom), '未找到 XML 面板内容'],
  ];
  if (demo) {
    checks.push(['左栏渲染出商品卡（且无崩溃横幅）', hasCard && !hasCrash, listSection.slice(0, 200)]);
    checks.push(['拓扑连线已建立（含算子徽章）', /edges=\S+\[/.test(dbg), dbg]);
    checks.push(['7 条同构映射全部对齐', /pairs=7/.test(dbg), dbg]);
    checks.push(['画布节点数 > 0', !/nodes=0\b/.test(dbg), dbg]);
  } else {
    checks.push(['空载状态下画布无残留节点', /nodes=0\b/.test(dbg), dbg]);
    checks.push(['左栏处于未请求状态（不应有商品卡）', !hasCard, listSection.slice(0, 160)]);
  }

  let bad = 0;
  console.log('\n--- DOM 断言 ---');
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '✔' : '✘'} ${name}${ok ? '' : `  ← ${String(detail).replace(/\s+/g, ' ').slice(0, 160)}`}`);
    if (!ok) bad++;
  }
  process.exit(bad ? 1 : 0);
})();
