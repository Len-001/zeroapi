'use strict';
/**
 * ZeroAPI 演示控制台 · 交互与数据装配
 * ---------------------------------------------------------------------------
 * 这里刻意复刻了"一个真实前端"的渲染代码（见 renderProduct），
 * 因为在「直连模式」下要让它**真的崩一次** —— 演示的第一分钟就是要制造冲突。
 * 崩溃信息不是伪造的文案，是页面里真实抛出的 TypeError。
 */

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const DBG = params.has('dbg');

let topo = null;
let sourceNodes = [];
let targetNodes = [];
let lastPairs = [];
let lastFingerprint = '';
let dbgCounters = { events: 0, solves: 0, heals: 0, drifts: 0, frames: 0 };
let busy = false;

// ── 错误可见化：无头浏览器只认 DOM，不认控制台 ──────────────────────
window.onerror = (msg, src, line, col, err) => {
  showErr(`${msg}\n  at ${String(src).split('/').pop()}:${line}:${col}`);
};
window.addEventListener('unhandledrejection', (e) => showErr(`Promise 拒绝: ${e.reason && e.reason.message || e.reason}`));

function showErr(t) {
  const el = $('err');
  el.style.display = 'block';
  el.textContent = String(t).slice(0, 900);
  clearTimeout(showErr._t);
  showErr._t = setTimeout(() => { el.style.display = 'none'; }, 9000);
  console.error(t);
}

// ── 工具 ────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ms = (v) => (v == null ? '—' : `${Number(v).toFixed(v < 10 ? 3 : 1)} ms`);

function highlightXml(xml) {
  return esc(xml)
    .replace(/(&lt;\?[\s\S]*?\?&gt;)/g, '<span class="decl">$1</span>')
    .replace(/(&lt;\/?)([\w.\-]+)/g, '$1<span class="tg">$2</span>')
    .replace(/(&gt;)([^&<]+)(&lt;)/g, '$1<span class="tx">$2</span>$3');
}

function highlightGlue(src) {
  return esc(src)
    .replace(/^(\s*\/\/.*)$/gm, '<span class="c">$1</span>')
    .replace(/\b(function|const|return|if|new)\b/g, '<span class="k">$1</span>')
    .replace(/\b(OPS)\.(\w+)/g, '<span class="f">$1.$2</span>')
    .replace(/\b(\d+\.\d+)\b/g, '<span class="n">$1</span>');
}

function chip(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = text;
  el.className = 'chip' + (cls ? ` ${cls}` : '');
}

// ── 事件日志 ────────────────────────────────────────────────────────
function log(type, msg) {
  const el = $('eventlog');
  const at = new Date();
  const ts = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}.${String(at.getMilliseconds()).padStart(3, '0')}`;
  const div = document.createElement('div');
  div.className = `ev ${type}`;
  div.innerHTML = `<span class="ts">${ts}</span> <span class="k">${esc(type)}</span> <span class="msg">${esc(msg)}</span>`;
  el.appendChild(div);
  while (el.childElementCount > 160) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

// ── 拓扑与代码面板 ──────────────────────────────────────────────────
function applyPlan() {
  if (!topo) return;
  topo.setPlan({
    target: targetNodes.map((n) => ({ name: n.name, type: n.type, unit: n.unit, concept: n.concept, comment: n.comment, sample: n.sample })),
    source: sourceNodes.map((n) => ({ name: n.name, type: n.type, unit: n.unit, concept: n.concept, comment: n.comment, sample: n.sample })),
    pairs: lastPairs,
    fingerprint: lastFingerprint,
  });
  if (DEMO) topo.snap();
  $('sub-topo').textContent = `${targetNodes.length + sourceNodes.length} 节点 · ${lastPairs.length} 条同构映射 · 指纹 ${lastFingerprint || '—'}`;
  chip('c-pairs', `匹配 <b>${lastPairs.length}</b> / ${sourceNodes.length}`, lastPairs.length === sourceNodes.length ? 'ok' : 'warn');
}

async function refreshGlue() {
  try {
    const r = await fetch('/api/glue').then((x) => x.json());
    if (!r.ready) return;
    $('glueView').innerHTML = highlightGlue(r.source);
    $('sub-glue').textContent = `自动生成 ${r.source.split('\n').length} 行 / ${r.bytes} 字节 · 编译 ${ms(r.compileMs)} · 人手编写 0 行`;
    chip('c-fp', `指纹 <b>${String(r.fingerprint).split('>')[0]}</b>`, 'info');
    // 与服务端权威计划对齐。
    // 没有事件流时必须**每次都对齐**（而不是"只在计划为空时对齐一次"）：
    // 否则一旦发生结构突变并自愈，界面会拿旧计划去配新节点，
    // 结果就是"图上少画一条线，但没人发现" —— 比直接报错更危险。
    if ((!USE_SSE || !lastPairs.length) && Array.isArray(r.pairs) && r.pairs.length) {
      if (r.fingerprint !== lastPlanFp) {
        lastPairs = r.pairs;
        lastPlanFp = r.fingerprint;
        lastFingerprint = String(r.fingerprint).split('>')[0] || lastFingerprint;
        applyPlan();
      }
    }
  } catch (e) { /* 未编译时静默 */ }
}

async function refreshAdt() {
  const r = await fetch('/api/adt').then((x) => x.json());
  targetNodes = r.target || [];
  if (r.source && r.source.length) sourceNodes = r.source;
  lastFingerprint = r.fingerprint || lastFingerprint;
  applyPlan();
}

async function refreshStatus() {
  const s = await fetch('/api/status').then((x) => x.json());
  const f = s.legacySchema.fields.map((x) => x.name);
  $('k-schema').textContent = f.join(', ');
  $('k-schema').className = 'v hot';
  $('k-rows').textContent = `${s.legacySchema.rowCount} 行 · 命名风格 ${s.legacySchema.restyle}`;
  const cov = s.ddlCoverage;
  $('k-ddl').innerHTML = `${cov.matched}/${cov.total} = <b>${(cov.ratio * 100).toFixed(0)}%</b>`
    + (cov.missing.length ? ` （DDL 未覆盖: ${cov.missing.join(', ')}）` : '');
  $('k-ddl').className = 'v ' + (cov.ratio >= 0.99 ? 'good' : 'bad');
  chip('c-ddl', `文档覆盖 <b>${(cov.ratio * 100).toFixed(0)}%</b>`, cov.ratio >= 0.99 ? 'ok' : 'warn');
  const hs = s.bridge;
  chip('c-heal', `自愈 <b>${hs.heals}</b> 次${hs.lastHealMs ? ` · 最近 ${hs.lastHealMs.toFixed(1)}ms` : ''}`, hs.heals ? 'ok' : '');
  return s;
}

// ── 前端渲染（直连模式下这里会真的崩） ──────────────────────────────
function renderProduct(item, i) {
  // ↓↓↓ 这就是一个普通前端工程师写的渲染函数，没有任何防错
  const price = `¥${item.priceYuan.toFixed(2)}`;
  const created = new Date(item.createdAt).toISOString().slice(0, 19).replace('T', ' ');
  const onShelf = item.isListed ? '在售' : '已下架';
  return `
    <div class="card">
      <div class="t">${esc(item.productName)}</div>
      <div class="row"><span>priceYuan</span><span class="v price">${price}</span></div>
      <div class="row"><span>stockQty</span><span class="v">${item.stockQty}</span></div>
      <div class="row"><span>createdAt</span><span class="v">${created}</span></div>
      <div class="row"><span>isListed</span><span class="v">${onShelf}</span></div>
      <div class="row"><span>categoryId</span><span class="v">${esc(item.categoryId)}</span></div>
      <div class="row"><span>description</span><span class="v">${esc(item.description)}</span></div>
    </div>`;
}

function renderList(rows, mode) {
  const box = $('productList');
  box.innerHTML = '';
  const banner = $('modeBanner');
  let okCount = 0, firstError = null;

  const list = Array.isArray(rows) ? rows : [];
  const htmls = [];
  for (let i = 0; i < list.length; i++) {
    try {
      htmls.push(renderProduct(list[i], i));
      okCount++;
    } catch (e) {
      if (!firstError) firstError = e;
      // 真实世界的表现：整块列表渲染中断，用户看到白屏
      break;
    }
  }
  box.innerHTML = htmls.join('');

  if (firstError) {
    banner.className = 'mode-banner direct';
    banner.innerHTML = `<span class="tag">CRASH</span><span>前端渲染中断于第 ${okCount + 1} 条数据</span>`;
    const crash = document.createElement('div');
    crash.className = 'crash';
    crash.innerHTML = `<div class="hd">✘ Uncaught TypeError（真实抛出，非文案）</div>${esc(firstError.message)}
原始报文首条字段: ${esc(JSON.stringify(list[0] || {}).slice(0, 240))}
前端期望字段: productName / priceYuan / stockQty / createdAt / isListed / categoryId / description`;
    box.insertBefore(crash, box.firstChild);
    $('dot-modern').className = 'dot';
    chip('c-mode', '模式 <b>直连（未对齐）</b>', 'bad');
    $('sub-modern').textContent = '收到原始老 ERP 报文，未做任何字段/单位/编码对齐';
    log('request', `直连模式：${list.length} 条原始数据 → 前端在第 ${okCount + 1} 条崩溃`);
  } else {
    banner.className = 'mode-banner bridge';
    banner.innerHTML = `<span class="tag">OK</span><span>${mode === 'bridge' ? '经 ZeroAPI 桥接后' : 'CRM 已入库'}，${okCount} 条数据全部字段对齐，前端零改动</span>`;
    $('dot-modern').className = 'dot live';
    $('sub-modern').textContent = 'ProductDTO 契约已满足（字段名/类型/单位/编码全部对齐）';
    chip('c-mode', '模式 <b>ZeroAPI 桥接</b>', 'ok');
    log('request', `桥接模式：${okCount} 条数据全部通过前端渲染`);
  }
}

async function showXml() {
  const r = await fetch('/api/source').then((x) => x.json());
  $('xmlView').innerHTML = highlightXml(r.xml.split('\n').slice(0, 26).join('\n') + (r.xml.split('\n').length > 26 ? '\n  …（截断）' : ''));
  return r;
}

// ── 动作 ────────────────────────────────────────────────────────────
async function act(btn, fn) {
  if (busy) return;
  busy = true;
  const old = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
  try { await fn(); } catch (e) { showErr(e.message); } finally {
    busy = false;
    if (btn) { btn.disabled = false; btn.textContent = old; }
    if (DBG) updateDbg();
  }
}

async function doDirect(btn) {
  return act(btn, async () => {
    const r = await fetch('/api/products?mode=direct').then((x) => x.json());
    renderList(r.rows, 'direct');
    await showXml();
    await refreshStatus();
  });
}

async function doBridge(btn) {
  return act(btn, async () => {
    const t0 = performance.now();
    const r = await fetch('/api/products').then((x) => x.json());
    const wall = performance.now() - t0;
    renderList(r.rows, 'bridge');
    await showXml();
    await refreshAdt();
    await refreshStatus();
    await refreshGlue();
    chip('c-lat', `端到端 <b>${r.metrics.totalMs.toFixed(1)}ms</b>`, 'ok');
    chip('c-solve', `求解 <b>${(lastSolveMs || 0).toFixed(2)}ms</b>`, 'info');
    log('request', `HTTP 往返 ${wall.toFixed(1)}ms（其中服务端桥接管线 ${r.metrics.totalMs.toFixed(1)}ms，信封解码 ${r.metrics.decodeMs.toFixed(2)}ms）`);
  });
}

async function doSync(btn) {
  return act(btn, async () => {
    const r = await fetch('/api/sync', { method: 'POST' }).then(async (x) => ({ status: x.status, body: await x.json() }));
    if (r.body.ok) {
      renderList(r.body.bridged, 'sync');
      log('sync', `CRM 严格契约验收通过：${r.body.crm.accepted} 条 ProductDTO 入库，拒收 0 条`);
    } else {
      const msg = (r.body.crm && r.body.crm.detail && r.body.crm.detail[0] && r.body.crm.detail[0].errors || []).join(' | ') || r.body.crm.message || '未知拒收原因';
      log('sync', `CRM 拒收 → ${msg}`);
      showErr(`CRM 严格契约拒收：\n${msg}`);
      chip('c-mode', '模式 <b>CRM 拒收</b>', 'bad');
    }
    await refreshAdt(); await refreshStatus(); await refreshGlue();
  });
}

async function doChaos(btn, kind, args) {
  return act(btn, async () => {
    const r = await fetch(`/api/chaos/${kind}`, { method: 'POST', body: JSON.stringify(args) }).then((x) => x.json());
    if (!r.ok) { showErr(r.error); return; }
    log('chaos', `注入协议突变 ${kind}：${JSON.stringify(r.result)}`);
    topo && topo.flashFields([args.field || args.from || args.name || ''].filter(Boolean), true);
    await refreshStatus();
    await showXml();
  });
}

async function doStrict(btn) {
  return act(btn, async () => {
    const cur = await fetch('/api/status').then((x) => x.json());
    const next = !cur.contract.strict;
    const r = await fetch('/api/contract/strict', { method: 'POST', body: JSON.stringify({ strict: next }) }).then((x) => x.json());
    log('contract', `契约 ${next ? '收紧' : '放宽'}：brand 现在${next ? '为必填' : '可选'}（字段: ${r.fields.map((f) => f.name + (f.optional ? '?' : '')).join(', ')}）`);
    btn.textContent = next ? '放宽契约 brand 可选' : '收紧契约 brand 必填';
    if (next) {
      showErr('契约已收紧：老 ERP 根本没有 brand 字段，下一次同步 CRM 会精确拒收 —— 这就是"契约缺口"被暴露的瞬间，而不是被 null 掩盖。');
    }
  });
}

// ── SSE ─────────────────────────────────────────────────────────────
let lastSolveMs = 0;
let lastPlanFp = '';
let es = null;
const USE_SSE = params.get('sse') !== '0';
function connect() {
  es = new EventSource('/events');
  es.onmessage = (m) => {
    let evt;
    try { evt = JSON.parse(m.data); } catch { return; }
    dbgCounters.events++;
    handleEvent(evt);
  };
  es.onerror = () => { /* EventSource 自带重连，无需处理 */ };
  return es;
}

const OP_LABEL = { identity: '直通', unit: '单位换算', codec: '编解码', type: '类型提升' };

function handleEvent(evt) {
  const d = evt.data || {};
  // history=true 表示这是"晚加入客户端"的回放帧：允许它恢复画面状态，
  // 但不允许它污染实时计数器（否则自愈次数会随刷新次数倍增）。
  const live = !evt.history;
  switch (evt.type) {
    case 'topology':
      sourceNodes = d.nodes || [];
      lastFingerprint = d.sourceFp || '';
      if (live) dbgCounters.solves++;
      log('solve', `${live ? '' : '[回放] '}嗅探完成：${d.nodes.length} 个字段，静态指纹 ${d.sourceFp}${d.warnings && d.warnings.length ? `，告警 ${d.warnings.length} 条（${d.warnings.map((w) => w.code).join(',')}）` : ''}`);
      break;
    case 'solve':
      lastPairs = d.pairs || [];
      lastSolveMs = d.metrics ? d.metrics.solveMs : 0;
      if (live) dbgCounters.solves++;
      chip('c-solve', `求解 <b>${(lastSolveMs || 0).toFixed(2)}ms</b>`, 'info');
      log('solve', `${live ? '' : '[回放] '}匈牙利算法求最小代价双射：${d.pairs.length} 对（n=${d.metrics.nSource}×${d.metrics.nTarget}，构建代价矩阵 ${d.metrics.costBuildMs}ms，匹配 ${d.metrics.hungarianMs}ms，平均相似度 ${d.metrics.avgSim.toFixed(3)}）`);
      if (d.unmappedTo && d.unmappedTo.length) log('drift', `契约缺口：目标字段 ${d.unmappedTo.join(', ')} 在源系统中无对应数据（跳过而非伪造）`);
      applyPlan();
      break;
    case 'verify':
      log('verify', `不变量校验 ${d.summary.checkPassed}/${d.summary.checkCount} 通过${d.summary.rejected ? `，${d.summary.rejected} 对因不满足守恒律被降级` : ''}`);
      break;
    case 'drift': {
      if (!live) break; // 回放的突变不重新闪烁，避免页面一打开就满屏红光
      dbgCounters.drifts++;
      const t = (d.drifts || []).map((x) => `${x.field || '-'}:${x.kind}`).join(', ');
      log('drift', `检测到结构突变 → ${t}；冻结旧桥接器，启动重求解`);
      topo && topo.flashFields((d.drifts || []).map((x) => x.field).filter(Boolean), true);
      break;
    }
    case 'healed':
      log('healed', `${live ? '' : '[回放] '}同构函子重合成完成：${d.ms}ms 内热替换桥接器（嗅探 ${d.marks.sniffMs} / 求解 ${d.marks.solveMs} / 验证 ${d.marks.verifyMs} / 编译 ${d.marks.compileMs}），${d.pairs} 对映射，新指纹 ${d.sourceFp}`);
      if (live) {
        dbgCounters.heals++;
        topo && topo.healPulse();
        chip('c-heal', `自愈 <b>${dbgCounters.heals}</b> 次 · 最近 ${d.ms}ms`, 'ok');
      }
      refreshGlue();
      break;
    case 'heal_reject':
    case 'heal_abort':
      log('drift', `自愈未完成（${d.reason}）→ 按纪律降级：保留旧桥接器并显式标记，不静默返回错值`);
      break;
    case 'request':
      lastSolveMs = d.avgRowMs || lastSolveMs;
      log('request', `请求完成 route=${d.route} mode=${d.mode} rows=${d.rows ?? '-'} 耗时=${Number(d.totalMs || 0).toFixed(1)}ms${d.degraded ? ' [降级]' : ''}`);
      break;
    case 'sync':
      log('sync', `全链路：${d.rows} 条 → 网关 → CRM 回执 ${d.crmStatus} ${d.message}`);
      break;
    case 'chaos':
      log('chaos', `老 ERP 侧结构已变更：${JSON.stringify(d.schema)}`);
      break;
    case 'contract':
      log('contract', `契约变更：strict=${d.strict} (${d.fields.map((f) => f.name + (f.optional ? '?' : '')).join(', ')})`);
      break;
    case 'reset':
      log('reset', '全部状态已重置');
      break;
    case 'error':
      log('drift', `网关错误 ${d.route}: ${d.message}`);
      break;
    default:
      break;
  }
  if (DBG) updateDbg();
}

function updateDbg() {
  const el = $('dbg');
  el.style.display = 'block';
  const st = topo ? topo.stats() : { nodes: 0, edges: 0, revealed: 0, frames: 0, edgeLabels: [], matchedNodes: 0 };
  el.textContent = [
    `events=${dbgCounters.events} solves=${dbgCounters.solves} heals=${dbgCounters.heals} drifts=${dbgCounters.drifts}`,
    `nodes=${st.nodes} matched=${st.matchedNodes} edges=${st.edges} revealed=${st.revealed} frames=${st.frames}`,
    `pairs=${lastPairs.length} fp=${lastFingerprint}`,
    `glueLines=${(($('glueView').textContent || '').match(/out\[/g) || []).length}`,
    `edges=${(st.edgeLabels || []).join(' | ')}`,
  ].join('\n');
}

// ── 启动 ────────────────────────────────────────────────────────────
async function boot() {
  topo = new Topo($('topo'));
  // ?sse=0 用于无头截图：SSE 是长连接，会阻止 Chrome 的 virtual-time 预算耗尽，
  // 导致 --headless --screenshot 永远等不到出帧。正常浏览不受影响。
  if (USE_SSE) connect();
  for (const b of document.querySelectorAll('[data-chaos]')) {
    b.addEventListener('click', () => doChaos(b, b.dataset.chaos, JSON.parse(b.dataset.args)));
  }
  $('btn-direct').addEventListener('click', (e) => doDirect(e.currentTarget));
  $('btn-bridge').addEventListener('click', (e) => doBridge(e.currentTarget));
  $('btn-sync').addEventListener('click', (e) => doSync(e.currentTarget));
  $('btn-contract-strict').addEventListener('click', (e) => doStrict(e.currentTarget));
  $('btn-reset').addEventListener('click', () => act(null, async () => {
    await fetch('/api/reset', { method: 'POST' });
    $('productList').innerHTML = '';
    $('glueView').textContent = '（求解完成后自动生成）';
    $('btn-contract-strict').textContent = '收紧契约 brand 必填';
    lastPairs = []; sourceNodes = []; applyPlan();
    await refreshStatus(); await showXml();
  }));

  await refreshStatus();
  await showXml();
  log('reset', '控制台就绪。演示脚本：① 直连制造冲突 → ② 挂上网关见证自愈 → ③ 破坏性测试当场改字段');
  if (DBG) updateDbg();

  if (DEMO) {
    // 无头截图 / 自动演示：一镜到底跑完三分钟剧本。
    // 必须先 reset —— 自动演示要可重复执行，否则第二次跑的时候
    // 上一轮留下的重命名会让 "jg_fen → dj_fen" 这一步直接报"字段不存在"。
    const wait = (ms2) => new Promise((r) => setTimeout(r, ms2));
    await fetch('/api/reset', { method: 'POST' });
    await refreshStatus(); await showXml();
    await doDirect(); await wait(400);
    await doBridge(); await wait(500);
    await doSync(); await wait(400);
    await doChaos(null, 'rename', { from: 'jg_fen', to: 'dj_fen' }); await wait(300);
    await doBridge(); await wait(600);
    await refreshGlue();
    topo.snap();
    $('err').style.display = 'none';
    if (es) { es.close(); es = null; }
    if (DBG) updateDbg();
  }
}

document.addEventListener('DOMContentLoaded', boot);
