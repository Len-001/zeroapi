'use strict';
/**
 * 红蓝对抗 · 第 4 类：状态转移陷阱
 * 攻击面：缓存失效路径、自愈死循环、重建预算耗尽、结构高频振荡、降级语义
 * 目的：证明桥接器状态机在**病态输入**下依然满足三条硬不变式：
 *   I-A 单次 convert 的重建次数 ≤ maxRebuildPerCall（无雪崩）
 *   I-B 任意路径下不抛异常（可用性优先）
 *   I-C 无法自愈时必须显式 degraded=true（绝不静默返回错值）
 */

const { suite, test, assert, assertEq } = require('../harness');
const { Bridge } = require('../../src/core/bridge');
const { Bus } = require('../../src/core/bus');
const { buildAdt, inferFromSamples, fingerprint } = require('../../src/core/extractor');
const F = require('../fixtures');

/** 用给定行样本构造"老 ERP 静态契约（注释跟着列走）+ 动态样本" */
function ctxFor(rows, renamed) { return F.ctxFor(rows, renamed); }

class CountingBridge extends Bridge {
  constructor(cfg) {
    super(cfg);
    this.rebuildCalls = 0;
    this.failRebuild = false;
  }
  rebuild(...args) {
    this.rebuildCalls++;
    // 通过**标志位**注入失败，而不是替换方法 —— 后者会把计数器一起绕过，
    // 让"重建只尝试了 1 次"这类断言永远为 0（曾经真的踩过这个坑）。
    if (this.failRebuild) return { ok: false, reason: 'forced-failure' };
    return super.rebuild(...args);
  }
}

function makeBridge(opts = {}) {
  const bus = new Bus();
  const events = [];
  bus.on('event', (e) => events.push(e));
  const b = new CountingBridge({
    name: 'test', sourceLabel: 'legacy', targetLabel: 'ProductDTO', bus,
    opts: { sampleWindow: 6, maxRebuildPerCall: 3, ...opts },
  });
  return { b, bus, events };
}

/** 改名助手：{ 原字段名 → 现字段名 } */
const rename = (rows, from, to) => rows.map((r) => F.renameKeys(r, { [from]: to }));

module.exports = () => {
  suite('④ 状态转移陷阱');

  test('[提前退出] 结构未变时第二次 convert 必须走缓存：重建次数保持 1', () => {
    const { b } = makeBridge();
    const rows = F.legacyRows;
    const ctx = ctxFor(rows);
    const r1 = b.convert('/api/goods', rows[0], ctx.targetAdt, ctx.meta);
    assertEq(r1.healed, true, '首次必须触发一次完整重建');
    assertEq(b.rebuildCalls, 1);
    const r2 = b.convert('/api/goods', rows[1], ctx.targetAdt, ctx.meta);
    assertEq(r2.healed, false, '结构一致时必须命中缓存');
    assertEq(b.rebuildCalls, 1, '缓存命中路径上不允许再求解');
    assertEq(r2.out.priceYuan, 1299);
  });

  test('[提前退出] 幂等性：同一载荷连续 5 次转换，重建次数不随次数增长', () => {
    const { b } = makeBridge();
    const rows = F.legacyRows;
    const ctx = ctxFor(rows);
    const outs = [];
    for (let i = 0; i < 5; i++) outs.push(b.convert('/api/goods', rows[0], ctx.targetAdt, ctx.meta).out);
    assertEq(b.rebuildCalls, 1);
    assertEq(outs[4].priceYuan, outs[0].priceYuan);
    assertEq(outs[4].createdAt, outs[0].createdAt);
  });

  test('[死循环跳出] 重建持续失败 → 必须终止并降级，且重建只尝试 1 次', () => {
    const { b, events } = makeBridge();
    const rows = F.legacyRows;
    const ctx = ctxFor(rows);
    b.failRebuild = true;
    const t0 = Date.now();
    const r = b.convert('/api/goods', rows[0], ctx.targetAdt, ctx.meta);
    const elapsed = Date.now() - t0;
    assert(elapsed < 2000, `必须迅速终止，实际 ${elapsed}ms`);
    assertEq(r.degraded, true);
    assertEq(r.healed, false);
    assertEq(b.rebuildCalls, 1, '形状备忘录必须挡住第二次无意义重建');
    assertEq(r.reason, 'shape-memo-hit');
    const abort = events.find((e) => e.type === 'heal_abort');
    assert(abort, '必须发出 heal_abort 事件（不可静默）');
    assertEq(abort.data.reason, 'shape-memo-hit');
  });

  test('[重建预算] 预算压到 1 时，预算闸门先于形状备忘录生效', () => {
    const { b, events } = makeBridge({ maxRebuildPerCall: 1 });
    const rows = F.legacyRows;
    const ctx = ctxFor(rows);
    b.failRebuild = true;
    const r = b.convert('/api/goods', rows[0], ctx.targetAdt, ctx.meta);
    assertEq(r.degraded, true);
    assertEq(r.reason, 'rebuild-budget-exhausted', '预算=1 时第二次进入循环必须先被预算拦住');
    assertEq(b.rebuildCalls, 1, '不得超过预算上限');
    assertEq(events.filter((e) => e.type === 'heal_abort').length, 1);
  });

  test('[重建预算] 硬不变式 I-A：任意预算配置下重建次数 ≤ 预算', () => {
    for (const budget of [1, 2, 3, 5]) {
      const { b } = makeBridge({ maxRebuildPerCall: budget });
      const ctx = ctxFor(F.legacyRows);
      b.failRebuild = true;
      b.convert('/api/goods', F.legacyRows[0], ctx.targetAdt, ctx.meta);
      assert(b.rebuildCalls <= budget, `预算=${budget} 时重建了 ${b.rebuildCalls} 次`);
    }
  });

  test('[降级语义] 无旧桥接器时降级为直通，但 degraded 标记必须为真', () => {
    const { b } = makeBridge();
    const ctx = ctxFor(F.legacyRows);
    b.failRebuild = true;
    const r = b.convert('/api/goods', F.legacyRows[0], ctx.targetAdt, ctx.meta);
    assertEq(r.degraded, true);
    assertEq(r.usedStaleEntry, false, '此时还没有旧桥接器可用');
    assertEq(r.out, F.legacyRows[0], '降级必须是原样直通，不得部分转换');
  });

  test('[降级语义] 有旧桥接器时沿用旧产物，且显式标记 usedStaleEntry', () => {
    const { b } = makeBridge();
    const ctx = ctxFor(F.legacyRows);
    b.convert('/api/goods', F.legacyRows[0], ctx.targetAdt, ctx.meta); // 建立桥接器
    b.failRebuild = true;
    const mutated = { ...F.legacyRows[0], brand: 'Logitech' };
    const r = b.convert('/api/goods', mutated, ctx.targetAdt, ctx.meta);
    assertEq(r.degraded, true);
    assertEq(r.usedStaleEntry, true);
    assertEq(r.out.priceYuan, 399.99, '旧桥接器仍应产出可用结果');
  });

  test('[高频振荡] 单位 cent/yuan 交替 20 次：每次都必须自愈出正确金额', () => {
    const { b } = makeBridge();
    const ctx = ctxFor(F.legacyRows);
    let rows = F.legacyRows;
    const expectedYuan = 399.99;
    let heals = 0;
    let degraded = 0;
    for (let i = 0; i < 20; i++) {
      const toYuan = i % 2 === 0;
      rows = rows.map((r) => ({ ...r, jg_fen: toYuan ? r.jg_fen / 100 : Math.round(r.jg_fen * 100) }));
      const r = b.convert('/api/goods', rows[0], ctx.targetAdt, ctx.meta);
      if (r.healed) heals++;
      if (r.degraded) degraded++;
      assertEq(r.out.priceYuan, expectedYuan, `第 ${i + 1} 次振荡后金额错误（方向=${toYuan ? 'cent→yuan' : 'yuan→cent'}）`);
      assert(Number.isFinite(r.out.priceYuan), '不得产出 NaN');
    }
    console.log(`      · 20 次振荡：heals=${heals} degraded=${degraded} rebuildCalls=${b.rebuildCalls}`);
    assertEq(degraded, 0, '任何一次振荡都不允许降级');
    assert(heals >= 19, `每次都换了单位，理应几乎每次都要重新合成，实际 heals=${heals}`);
    assert(b.metrics.maxHealMs < 500, `单次自愈耗时 ${b.metrics.maxHealMs.toFixed(1)}ms 超出 500ms 预算`);
  });

  test('[混合小数/整数列] 单位翻转后同一次请求内多行数据不得反复横跳', () => {
    // 真实场景：价格列翻转单位后同时含 399.99 / 1299 / 2199 —— 单样本判单位会横跳。
    // 本用例锁死"整轮请求只重建 1 次"这条不变式。
    const { b } = makeBridge();
    const base = ctxFor(F.legacyRows);
    b.convert('/api/goods', F.legacyRows[0], base.targetAdt, base.meta);
    const before = b.rebuildCalls;
    const flipped = F.legacyRows.map((r) => ({ ...r, jg_fen: r.jg_fen / 100 }));
    const ctx = ctxFor(flipped);
    for (const row of flipped) {
      // 翻转后源单位已是「元」，与目标一致 → 退化为 identity，金额应原样透传
      const r = b.convert('/api/goods', row, ctx.targetAdt, ctx.meta);
      assertEq(r.out.priceYuan, row.jg_fen, `行数据 ${row.jg_fen} 转换错误`);
    }
    const delta = b.rebuildCalls - before;
    assertEq(delta, 1, `4 行混合小数/整数数据只应触发 1 次重建，实际 ${delta} 次（单位判定在横跳）`);
  });

  test('[结构突变] 字段改名 jg_fen→dj_fen：自愈后金额仍然正确', () => {
    const { b, events } = makeBridge();
    const ctx = ctxFor(F.legacyRows);
    b.convert('/api/goods', F.legacyRows[0], ctx.targetAdt, ctx.meta);
    const renamed = rename(F.legacyRows, 'jg_fen', 'dj_fen');
    // 注释仍然挂在"价格"这一列上（真实系统改字段名不会顺手改注释）
    const ctx2 = ctxFor(renamed, { jg_fen: 'dj_fen' });
    const r = b.convert('/api/goods', renamed[0], ctx2.targetAdt, ctx2.meta);
    assertEq(r.healed, true);
    assertEq(r.out.priceYuan, 399.99, '改名后金额必须依然正确（_fen 后缀仍在，单位线索未丢）');
    assert(events.some((e) => e.type === 'drift'), '必须记录 drift 事件');
    assert(events.some((e) => e.type === 'healed'), '必须记录 healed 事件');
  });

  test('[结构突变] 单位线索完全丢失（改名为无意义名）→ 宁可不上线错值', () => {
    const { b } = makeBridge();
    const ctx = ctxFor(F.legacyRows);
    b.convert('/api/goods', F.legacyRows[0], ctx.targetAdt, ctx.meta);
    const renamed = rename(F.legacyRows, 'jg_fen', 'v1');
    // 刻意不提供"原名映射"：模拟名字与注释**同时**丢失的最坏情况。
    // 此时唯一能阻止灾难的，就是求解器"没有算子链就不匹配"这条纪律。
    const ctx2 = ctxFor(renamed);
    const r = b.convert('/api/goods', renamed[0], ctx2.targetAdt, ctx2.meta);
    // 关键断言：不得把 39999 当成 39999 元直接塞进 priceYuan —— 那才是真正的灾难
    assert(r.out.priceYuan !== 39999, '绝不能把"分"当"元"直接放行（差 100 倍的资金事故）');
    assert(r.out.priceYuan === undefined || Number.isFinite(r.out.priceYuan), '产出必须是 undefined 或有限数，不得为 NaN');
  });

  test('[异常输入] 非对象载荷短路：不抛异常、不触发无意义重建、原样透传', () => {
    const { b, events } = makeBridge();
    const ctx = ctxFor(F.legacyRows);
    for (const bad of [null, undefined, [], 'abc', 42, true]) {
      const r = b.convert('/api/goods', bad, ctx.targetAdt, ctx.meta);
      assertEq(r.passthrough, true, `${JSON.stringify(bad)} 必须走直通短路`);
      assertEq(r.out, bad, '直通必须原样返回，不得做任何"看似合理"的转换');
    }
    assertEq(b.rebuildCalls, 0, '垃圾输入不应触发任何一次求解（这是防雪崩的关键）');
    assertEq(events.filter((e) => e.type === 'passthrough').length, 6);
  });

  test('[多路由隔离] 不同 route 的拓扑状态互不污染', () => {
    const { b } = makeBridge();
    const ctx = ctxFor(F.legacyRows);
    b.convert('/goods/v1', F.legacyRows[0], ctx.targetAdt, ctx.meta);
    const renamed = rename(F.legacyRows, 'jg_fen', 'dj_fen');
    const ctx2 = ctxFor(renamed);
    const r = b.convert('/goods/v2', renamed[0], ctx2.targetAdt, ctx2.meta);
    assertEq(r.healed, true, '第二条路由应独立建立桥接器，而不是复用第一条');
    assertEq(b.routes.size, 2);
    // 回到第一条路由，结构未变 → 必须命中缓存
    const r2 = b.convert('/goods/v1', F.legacyRows[0], ctx.targetAdt, ctx.meta);
    assertEq(r2.healed, false);
  });

  test('[指标一致性] snapshot 中 heals 与 history 长度一致', () => {
    const { b } = makeBridge();
    const ctx = ctxFor(F.legacyRows);
    b.convert('/api/goods', F.legacyRows[0], ctx.targetAdt, ctx.meta);
    const snap = b.snapshot();
    const route = snap.routes[0];
    assertEq(snap.heals, route.healCount, 'heals 计数器与路由自愈次数必须一致');
    assert(snap.healP50 !== null && snap.healP95 !== null, '自愈时延分位数必须可计算');
  });
};
