'use strict';
/**
 * ZeroAPI · 第三层运行时：自愈桥接器 (Self-Healing Protocol Bridge)
 * ---------------------------------------------------------------------------
 * 状态机（这是整个原型里最值得推敲的部分）：
 *
 *   IDLE ──payload──▶ MATCH ──(结构一致)──▶ 直接转换，零求解开销
 *                        │
 *                        └─(结构偏离)──▶ DRIFT ──▶ REBUILD ──(验证通过)──▶ 热替换 ──▶ MATCH
 *                                                    │
 *                                                    └─(验证不通过)──▶ REJECT ──▶ 回退旧桥接器 + 降级标记
 *
 * 两条防呆纪律（都由 tests/cases/state-transition 覆盖）：
 *   ① 重编译预算 maxRebuild：单次请求内重建次数有上限，防止"重建永远失败 → 每请求
 *      重建 → 吞吐塌陷"的雪崩，也杜绝死循环；
 *   ② 载荷指纹备忘 triedShapes：同一个"畸形形状"在一次请求内不得重试第二次，
 *      因为重建的输入完全相同，结果必然相同 —— 重试是纯粹的算力浪费。
 *
 * 单位漂移采纳策略：结构偏离时**重置样本窗口**，只信任最新证据。
 *   理由：旧拓扑已被现网数据证伪，继续用旧样本做 median 会把漂移重新平均掉。
 *   代价：单个畸形包也可能触发重建 —— 由 ①② 两道闸门兜底。
 */

const {
  buildAdt, inferFromSamples, fingerprint, fnv1a, inferUnit,
} = require('./extractor');
const { solveIsomorphism } = require('./solver');
const { verifyPlan } = require('./verifier');
const { compilePlan } = require('./compiler');
const { stateKey } = require('./operators');
const { jsTypeOfSafe } = require('./util');

const DEFAULT_BRIDGE_OPTS = {
  sampleWindow: 6,
  maxRebuildPerCall: 3,
  maxOps: 4,
  wSem: 0.70,
  wOp: 1.00,
};

function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }

class Bridge {
  /**
   * @param {object} cfg {name, sourceLabel, targetLabel, bus, opts}
   */
  constructor(cfg = {}) {
    this.name = cfg.name || 'zeroapi-bridge';
    this.sourceLabel = cfg.sourceLabel || 'source';
    this.targetLabel = cfg.targetLabel || 'target';
    this.bus = cfg.bus || { emit() {} };
    this.opts = { ...DEFAULT_BRIDGE_OPTS, ...(cfg.opts || {}) };
    /** @type {Map<string, object>} route → 端点的拓扑状态 */
    this.routes = new Map();
    this.metrics = {
      requests: 0, matches: 0, heals: 0, healAborts: 0, rejections: 0,
      driftEvents: 0, totalSolveMs: 0, totalCompileMs: 0, totalConvertMs: 0,
      lastHealMs: 0, maxHealMs: 0, healMsSamples: [],
    };
  }

  // -------------------------------------------------------------------------
  // 拓扑状态
  // -------------------------------------------------------------------------
  getRoute(route) {
    if (!this.routes.has(route)) {
      this.routes.set(route, {
        route,
        samples: [],
        sourceAdt: null,
        entry: null,
        fingerprint: null,
        history: [],
        healCount: 0,
        lastReject: null,
      });
    }
    return this.routes.get(route);
  }

  reset(route) {
    if (route) this.routes.delete(route);
    else this.routes.clear();
  }

  /**
   * 清空累计指标。
   * 与 reset() 分开是有意的：reset() 只负责"忘掉拓扑"（用于演示里重新开始），
   * 而指标是**过程证据** —— 做基准测试时必须能单独归零，否则测出来的
   * 永远是"自进程启动以来的累计值"，无法回答"这一轮到底重建了几次"。
   */
  resetMetrics() {
    this.metrics = {
      requests: 0, matches: 0, heals: 0, healAborts: 0, rejections: 0,
      driftEvents: 0, totalSolveMs: 0, totalCompileMs: 0, totalConvertMs: 0,
      lastHealMs: 0, maxHealMs: 0, healMsSamples: [],
    };
  }

  pushSample(state, payload) {
    state.samples.push(payload);
    if (state.samples.length > this.opts.sampleWindow) state.samples.splice(0, state.samples.length - this.opts.sampleWindow);
  }

  // -------------------------------------------------------------------------
  // 结构一致性强校验
  // -------------------------------------------------------------------------
  /**
   * payload 的「实时结构」是否仍与已编译桥接器所依据的拓扑一致。
   * 检查三个维度：键集合、键的 JS 类型、数值字段的单位推断。
   *
   * ⚠ 单位漂移判定必须**至少看两个样本**（window + 当前载荷），不能只看当前值。
   * 实测教训：老 ERP 的价格列在单位翻转后会同时存在 399.99 与 1299 这类
   * "部分小数、部分整数"的值。若逐个样本单独判单位，1299 会被判成 cent、
   * 399.99 会被判成 yuan，于是在同一次请求里对 4 行数据反复横跳 ——
   * 8 轮突变本该产生 8 次重建，实测却产生了 21 次，吞吐被打掉一半。
   * 合并样本后，只要窗口里出现过小数，整列就稳定判为 yuan。
   *
   * @param {Array} sourceAdt 已编译桥接器所依据的源拓扑
   * @param {object} payload 当前载荷
   * @param {object} routeState 该路由的运行时状态（读 samples，写 unitSuspect）
   * @returns {{ok:boolean, drift:Array}}
   */
  structMatch(sourceAdt, payload, routeState = { samples: [] }) {
    const state = routeState;
    const window = routeState.samples || [];
    const drift = [];
    if (!sourceAdt || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, drift: [{ kind: 'payload-shape', field: null, detail: '载荷不是对象' }] };
    }
    const known = new Map(sourceAdt.map((n) => [n.name, n]));
    for (const [k, v] of Object.entries(payload)) {
      const node = known.get(k);
      if (!node) {
        drift.push({ kind: 'unplanned-key', field: k, detail: `现网出现静态拓扑未覆盖的新字段 (值类型 ${jsTypeOfSafe(v)})` });
        continue;
      }
      if (v === null || v === undefined) continue;
      const t = jsTypeOfSafe(v);
      if (t !== node.type && node.type !== 'any' && t !== 'any') {
        drift.push({ kind: 'type-drift', field: k, detail: `${node.type} → ${t}` });
        continue;
      }
      // ⚠ 这里**刻意不检查** "命名线索与实测单位不符"。
      // 曾经的实现把 node.anchor.unitHint(='cent') ≠ node.unit(='yuan') 当成漂移，
      // 结果是：一旦发生单位翻转，这个条件对**每一个**后续载荷都恒为真，
      // 而且重建永远无法修好它（名字和注释还是老样子）→ 无限抖动。
      // 正确语义是：'名字说分、数据说元' 属于**已裁决并固化进拓扑的事实**
      // （node.unit 已经是 yuan，unitDrift 标记与 warning 在重建时已上报一次），
      // 不是"观测到的结构又变了"。只有实测单位本身再次改变才算漂移。
      // 判断依据见下方 unit-drift 分支。
      // ── 单位漂移判定：单样本取证 + 量级跳变确认 ─────────────────────
      // 只用单样本判 → 在"部分小数、部分整数"的列上左右横跳（8 轮突变触发 21 次重建）；
      // 只用窗口判 → 对真正发生的单位回切反应迟钝（窗口里还留着一个旧的小数值）。
      // 折中方案：用**当前载荷**取证（反应快），再用**窗口量级**做确认（抗噪）。
      const instant = inferFromSamples([payload]).find((f) => f.name === k);
      if (instant) {
        const u = inferUnit({ ...instant, name: k, comment: node.comment, anchor: node.anchor });
        if (u.unit && u.unit !== node.unit) {
          const mag = magnitudeJump(window, k, payload[k]);
          if (mag.ok) {
            drift.push({ kind: 'unit-drift', field: k, detail: `${node.unit} → ${u.unit}（依据 ${u.evidence}；量级 ${mag.detail}）` });
          } else {
            // 证据不足：既不改拓扑、也不静默放过，而是记账等人工看
            state.unitSuspect = (state.unitSuspect || 0) + 1;
            state.lastSuspect = { field: k, at: Date.now(), from: node.unit, to: u.unit, detail: mag.detail };
          }
        }
      }
    }
    const expected = sourceAdt.filter((n) => !n.optional && n.type !== 'any');
    for (const n of expected) {
      if (!(n.name in payload)) {
        drift.push({ kind: 'missing-key', field: n.name, detail: '拓扑中存在的字段在本次载荷中缺失' });
      }
    }
    return { ok: drift.length === 0, drift };
  }

  // -------------------------------------------------------------------------
  // 完整重建流水线（嗅探 → 求解 → 验证 → 编译）
  // -------------------------------------------------------------------------
  /**
   * @param {string} route
   * @param {object} payload 触发本次重建的载荷
   * @param {Array} targetAdt 目标系统 ADT（由调用方从静态契约抽取，相对稳定）
   * @param {object} meta {targetLabel, staticSource}
   */
  rebuild(route, payload, targetAdt, meta = {}) {
    const state = this.getRoute(route);
    const marks = {};
    const tStart = nowMs();

    // ── 1. 嗅探（动态侧）──────────────────────────────────────────────
    const dynamicFields = inferFromSamples(state.samples);
    let staticFields = meta.staticSource ? meta.staticSource(payload) : [];
    const adt = buildAdt(staticFields, dynamicFields);
    marks.sniffMs = nowMs() - tStart;
    const sourceFp = fingerprint(adt.nodes);
    marks.sourceFp = sourceFp;

    this.bus.emit('topology', {
      bridge: this.name, route, phase: 'sniff',
      sourceFp, nodes: adt.nodes.map(serializeNode),
      warnings: adt.warnings, ms: round3(marks.sniffMs),
    });

    // ── 2. 求解 ───────────────────────────────────────────────────────
    const tSolve = nowMs();
    const plan = solveIsomorphism(adt.nodes, targetAdt, {
      wSem: this.opts.wSem, wOp: this.opts.wOp, maxOps: this.opts.maxOps,
    });
    marks.solveMs = nowMs() - tSolve;
    this.bus.emit('solve', {
      bridge: this.name, route, phase: 'solve',
      pairs: plan.pairs.map((p) => ({
        from: p.source.name, to: p.target.name, ops: p.ops, labels: p.labels,
        sim: round4(p.sim), cost: round4(p.cost), margin: Number.isFinite(p.margin) ? round4(p.margin) : null,
        sameConcept: p.sameConcept, anchor: p.anchor, risk: p.risk,
        fromState: stateKey(p.source.type, p.source.unit),
        toState: stateKey(p.target.type, p.target.unit),
      })),
      unmappedFrom: plan.unmappedFrom,
      unmappedTo: plan.unmappedTo,
      metrics: { ...plan.metrics, costBuildMs: round3(plan.metrics.costBuildMs), hungarianMs: round3(plan.metrics.hungarianMs), solveMs: round3(plan.metrics.solveMs) },
      ms: round3(marks.solveMs),
    });

    // ── 3. 验证（不变量闸门）──────────────────────────────────────────
    const tVerify = nowMs();
    const verification = verifyPlan(plan, state.samples);
    marks.verifyMs = nowMs() - tVerify;
    if (verification.rejected.length) {
      this.bus.emit('verify', {
        bridge: this.name, route, phase: 'verify',
        rejected: verification.rejected.map((r) => ({
          pair: `${r.pair.source.name}→${r.pair.target.name}`, problems: r.problems,
        })),
        summary: verification.summary, ms: round3(marks.verifyMs),
      });
    } else {
      this.bus.emit('verify', { bridge: this.name, route, phase: 'verify', summary: verification.summary, precision: verification.precision, ms: round3(marks.verifyMs) });
    }

    if (!verification.pairs.length) {
      return { ok: false, reason: 'verification-empty', adt, plan, verification, marks };
    }

    // ── 4. 编译（热替换产物）──────────────────────────────────────────
    const tCompile = nowMs();
    const compiled = compilePlan(
      { ...plan, pairs: verification.pairs },
      {
        sourceLabel: this.sourceLabel,
        targetLabel: meta.targetLabel || this.targetLabel,
        sourceFp,
        targetFp: meta.targetFp || fingerprint(targetAdt),
      },
    );
    marks.compileMs = nowMs() - tCompile;
    marks.totalMs = nowMs() - tStart;
    marks.compiled = compiled;

    return { ok: true, adt, plan, verification, marks };
  }

  // -------------------------------------------------------------------------
  // 热路径
  // -------------------------------------------------------------------------
  /**
   * 把一个源系统载荷转换成目标系统形态。
   *
   * 前置条件：payload 为普通对象；targetAdt 非空。
   * 后置保证：
   *   Q1 返回值的键集合 ⊇ 已匹配的目标字段（未匹配字段以 null 占位，不伪造默认值）
   *   Q2 若发生结构偏离，返回值附带 drift 列表，绝不静默吞掉
   *   Q3 单次调用的重建次数 ≤ maxRebuildPerCall
   *   Q4 任意路径下不抛异常：无法自愈时降级为直通并标记 degraded
   */
  convert(route, payload, targetAdt, meta = {}) {
    const t0 = nowMs();
    const state = this.getRoute(route);
    this.metrics.requests++;

    // ── 非对象载荷短路 ───────────────────────────────────────────────
    // 关键判断：一个 null / 数组 / 标量**不构成"契约突变"**，它只是"这不是一条记录"。
    // 若把它当成 drift 处理，会用垃圾输入触发一次毫无意义的 O(n³) 重建
    // —— 正确做法是原样透传，并且明确告诉调用方"这里什么都没做"。
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      this.bus.emit('passthrough', { bridge: this.name, route, payloadType: Array.isArray(payload) ? 'array' : typeof payload });
      return {
        out: payload, healed: false, degraded: false, passthrough: true,
        drift: [], entry: state.entry, ms: nowMs() - t0,
      };
    }

    let budget = this.opts.maxRebuildPerCall;
    const triedShapes = new Set();
    let lastDrift = [];
    let rebuilt = false;

    for (;;) {
      // ── 命中判定 ─────────────────────────────────────────────────
      if (state.entry) {
        const m = this.structMatch(state.sourceAdt, payload, state);
        if (m.ok) {
          const out = state.entry.convert(payload);
          this.metrics.matches++;
          this.metrics.totalConvertMs += nowMs() - t0;
          return { out, healed: rebuilt, drift: lastDrift, degraded: false, entry: state.entry, ms: nowMs() - t0 };
        }
        lastDrift = m.drift;
        this.metrics.driftEvents++;
        this.bus.emit('drift', {
          bridge: this.name, route, drifts: m.drift,
          field: m.drift[0] && m.drift[0].field,
          kind: m.drift[0] && m.drift[0].kind,
        });
      }

      // ── 重建预算 & 形状备忘（两道防呆闸门）────────────────────────
      // 顺序很关键：预算在前。maxRebuildPerCall 默认 3，实际运行中形状备忘录
      // 会先命中（同一形状二次重建的结果必然相同，属于纯算力浪费）；
      // 但当调用方把预算压到 1 时，预算闸门会成为**先**生效的那一道，
      // 保证"无论如何，单次请求的重建次数有硬上限"这条不变式恒成立。
      const shape = fnv1a(JSON.stringify(shapeOf(payload)));
      if (budget <= 0) {
        this.metrics.healAborts++;
        this.bus.emit('heal_abort', { bridge: this.name, route, reason: 'rebuild-budget-exhausted', shape, drift: lastDrift });
        return this.degrade(state, payload, 'rebuild-budget-exhausted', lastDrift, t0);
      }
      if (triedShapes.has(shape)) {
        this.metrics.healAborts++;
        this.bus.emit('heal_abort', { bridge: this.name, route, reason: 'shape-memo-hit', shape, drift: lastDrift });
        return this.degrade(state, payload, 'shape-memo-hit', lastDrift, t0);
      }
      triedShapes.add(shape);
      budget--;

      // ── 重建：重置窗口，只信任最新证据 ────────────────────────────
      const healStart = nowMs();
      this.pushSample(state, payload);
      if (!state.entry) { /* 首次即用完整窗口 */ }
      else { state.samples = [payload]; }

      let built;
      try {
        built = this.rebuild(route, payload, targetAdt, meta);
      } catch (e) {
        this.metrics.rejections++;
        this.bus.emit('heal_reject', { bridge: this.name, route, reason: 'exception', detail: e.message });
        return this.degrade(state, payload, `rebuild-threw: ${e.message}`, lastDrift, t0);
      }

      if (!built.ok) {
        this.metrics.rejections++;
        state.lastReject = built.reason;
        this.bus.emit('heal_reject', { bridge: this.name, route, reason: built.reason });
        // 不 return：继续循环 → 由 shape 备忘录在下一轮立刻拦下
        continue;
      }

      // ── 热替换 ───────────────────────────────────────────────────
      state.sourceAdt = built.adt.nodes;
      state.entry = built.marks.compiled;
      state.fingerprint = built.marks.sourceFp;
      state.entry.plan = built.plan;
      state.entry.verification = built.verification;
      state.entry.warnings = built.adt.warnings;
      state.healCount++;
      rebuilt = true;
      const healMs = nowMs() - healStart;
      this.metrics.heals++;
      this.metrics.lastHealMs = healMs;
      this.metrics.maxHealMs = Math.max(this.metrics.maxHealMs, healMs);
      this.metrics.healMsSamples.push(healMs);
      this.metrics.totalSolveMs += built.marks.solveMs;
      this.metrics.totalCompileMs += built.marks.compileMs;
      state.history.push({ at: Date.now(), fp: built.marks.sourceFp, healMs: round3(healMs), drift: lastDrift });
      if (state.history.length > 40) state.history.shift();

      this.bus.emit('healed', {
        bridge: this.name, route,
        ms: round3(healMs),
        sourceFp: built.marks.sourceFp,
        marks: { sniffMs: round3(built.marks.sniffMs), solveMs: round3(built.marks.solveMs), verifyMs: round3(built.marks.verifyMs), compileMs: round3(built.marks.compileMs) },
        pairs: built.plan.pairs.length,
        drift: lastDrift,
        stats: built.marks.compiled.stats,
      });

      const out = state.entry.convert(payload);
      this.metrics.totalConvertMs += nowMs() - t0;
      return { out, healed: true, drift: lastDrift, degraded: false, entry: state.entry, ms: nowMs() - t0, rebuiltMs: healMs };
    }
  }

  /**
   * 降级：拿旧桥接器硬跑（可能产出错值）或原样直通，并**显式标记 degraded**。
   * 设计取舍：宁可返回"带标记的可用结果 + 明确告警"，也不对上游抛 500 ——
   * 因为本项目的定位是"网关"，可用性优先；但降级绝不允许静默。
   */
  degrade(state, payload, reason, drift, t0) {
    let out = payload;
    let usedStale = false;
    if (state.entry) {
      try { out = state.entry.convert(payload); usedStale = true; } catch { /* 旧桥接器也跑不动，退回直通 */ }
    }
    return {
      out, healed: false, degraded: true, reason,
      usedStaleEntry: usedStale, drift, entry: state.entry,
      ms: nowMs() - t0,
    };
  }

  /** 反向：目标系统形态 → 源系统形态（写路径） */
  revert(route, payload) {
    const state = this.getRoute(route);
    if (!state.entry) throw new Error(`revert: 路由 ${route} 尚未建立桥接器`);
    return state.entry.revert(payload);
  }

  snapshot() {
    const m = this.metrics;
    const hs = [...m.healMsSamples].sort((a, b) => a - b);
    return {
      ...m,
      healMsSamples: undefined,
      healP50: hs.length ? round3(percentile(hs, 0.5)) : null,
      healP95: hs.length ? round3(percentile(hs, 0.95)) : null,
      routes: [...this.routes.values()].map((s) => ({
        route: s.route,
        fingerprint: s.fingerprint,
        samples: s.samples.length,
        healCount: s.healCount,
        hasEntry: !!s.entry,
        sourceNodes: s.sourceAdt ? s.sourceAdt.length : 0,
        pairs: s.entry ? s.entry.stats.pairs : 0,
        generatedBytes: s.entry ? s.entry.bytes : 0,
        unitSuspect: s.unitSuspect || 0,
        lastSuspect: s.lastSuspect || null,
      })),
    };
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[idx];
}
/**
 * 量级跳变确认器。
 *
 * 用于回答一个"数据本身答不了"的问题：一个新值（比如 39999）到底代表
 * 「39999 分」还是「39999 元」？单看这一个数无法区分。但把它和该字段最近的
 * 历史量级放在一起就能区分：如果量级整体跳了 ≥1.5 个数量级（≈30 倍以上），
 * 那就不是"业务数据正常波动"，而是"单位换了"。
 *
 * @returns {{ok:boolean, detail:string}} ok=true 表示确认发生量级跳变
 */
function magnitudeJump(window, key, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
    return { ok: false, detail: '当前值非有限数值，无法用标量量级比对' };
  }
  const hist = window
    .map((r) => (r && typeof r === 'object' ? r[key] : undefined))
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v !== 0)
    .map(Math.abs);
  if (!hist.length) return { ok: true, detail: '无历史样本可比对，采信当前证据' };
  const histMedian = median(hist);
  const ratio = Math.abs(value) / histMedian;
  const log = Math.log10(ratio);
  return {
    ok: Math.abs(log) >= 1.5,
    detail: `${histMedian} → ${Math.abs(value)} 相差 ×${ratio.toExponential(2)} (log10=${log.toFixed(2)})${Math.abs(log) >= 1.5 ? '' : '，未达 1.5 个数量级，判为正常波动'}`,
  };
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function shapeOf(o) {  // 非对象防御：形状备忘的输入必须永远可哈希，否则会在异常路径上二次抛错
  if (o === null || o === undefined) return { __nonObject: String(o) };
  if (typeof o !== 'object') return { __nonObject: typeof o };
  if (Array.isArray(o)) return { __array: o.length };
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = jsTypeOfSafe(o[k]);
  return out;
}
function serializeNode(n) {
  return {
    name: n.name, type: n.type, unit: n.unit, concept: n.concept,
    comment: n.comment, anchor: n.anchor, unitEvidence: n.unitEvidence,
    declared: n.declared, staticSource: n.staticSource, dynamicSource: n.dynamicSource,
    sample: n.samples && n.samples.length ? n.samples[n.samples.length - 1] : null,
  };
}
const round3 = (v) => Math.round(v * 1000) / 1000;
const round4 = (v) => Math.round(v * 10000) / 10000;

module.exports = { Bridge, DEFAULT_BRIDGE_OPTS, shapeOf, percentile };
