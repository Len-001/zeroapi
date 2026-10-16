'use strict';
/**
 * ZeroAPI · 第二层：神经符号同构搜索引擎 (Neuro-Symbolic Isomorphism Solver)
 * ---------------------------------------------------------------------------
 * 问题形式化（与 BP 里的数学表述一一对应）：
 *
 *   给定两个 ADT 图 G_A（目标系统）、G_B（源系统），求一个**部分双射**
 *     σ : Fields_B → Fields_A
 *   使总代价最小，其中单项代价
 *     c(b, a) = w_sem · (1 − sim(b, a)) + w_op · cost(Transform(b → a)) + 偏置项
 *   约束：
 *     (i)  σ 是单射（一个源字段不得同时喂给两个目标字段）
 *     (ii) 每条边 b→a 必须存在**可行的**算子链（单位/类型/编码可对齐）
 *     (iii) 未匹配字段以虚拟节点 ∅ 承接，代价为常量 PAD
 *
 * 理论对应关系（可写进论文的映射）：
 *   Obj(C_B) = ADT 节点        Hom(C_B, C_A) = 可行算子链集合
 *   交换图条件  F(g∘f) = F(g)∘F(f)  ⇔  算子链可组合（见 operators.findPath 的后置保证 b）
 *   保不变量     ⇔  verifier 的业务不变量校验（往返一致性 / 货币守恒 / 类型域约束）
 *
 * 求解算法：最小代价二分图匹配 = 匈牙利算法（Kuhn–Munkres，O(n³)）
 *   之所以不用贪心：贪心在"一个源字段同时是多个目标字段的最优解"时会
 *   产生非最优甚至非法（非单射）的匹配，见 tests/cases 中的对抗用例。
 */

const { semanticSimilarity, resolve } = require('./lexicon');
const { stateKey, findPath, OP_BY_ID } = require('./operators');

const DEFAULT_OPTS = {
  wSem: 0.70,          // 语义距离权重
  wOp: 1.00,           // 算子链代价权重
  pad: 10.0,           // 虚拟空配代价（必须远大于任何真实匹配代价）
  floorAnchored: 0.45, // 双方都被词典锚定的最低相似度门槛
  floorFree: 0.68,     // 至少一方未锚定时的高门槛（宁缺毋滥）
  maxOps: 4,
  anchorBonus: 0.05,   // 同概念命中奖励
  commentBonus: 0.03,  // 中文注释证据奖励
};

// ---------------------------------------------------------------------------
// 匈牙利算法（O(n³)，e-maxx 势能写法）
// ---------------------------------------------------------------------------
/**
 * 求解方形代价矩阵的最小代价完美匹配。
 *
 * 前置条件：
 *   P1  cost 为 n×n，n ≥ 0，所有元素为**有限实数**（不可为 Infinity / NaN）
 *   P2  n = 0 时直接返回空数组
 * 后置保证：
 *   Q1  返回 assign，长度 n，assign[i] 为与第 i 行配对的列，且是 0..n-1 的排列
 *   Q2  Σ cost[i][assign[i]] 在所有排列中最小
 *   Q3  结果对输入顺序确定（严格小于号比较 + 列升序扫描 ⇒ 唯一确定性）
 *
 * 复杂度：时间 O(n³)，空间 O(n)
 */
function hungarian(cost, n) {
  if (!Array.isArray(cost) || cost.length !== n) throw new TypeError('hungarian: cost 维度不匹配');
  if (n === 0) return [];
  for (let i = 0; i < n; i++) {
    if (cost[i].length !== n) throw new TypeError('hungarian: 代价矩阵必须为方阵');
    for (let j = 0; j < n; j++) {
      const v = cost[i][j];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        // 违反 P1 时立刻出声，绝不带着 NaN/Infinity 静默产出错误匹配
        throw new RangeError(`hungarian: cost[${i}][${j}] 非有限值 (${v})`);
      }
    }
  }
  const INF = Number.MAX_SAFE_INTEGER / 4;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      if (j1 === -1) throw new Error('hungarian: 增广失败（代价矩阵可能存在数值退化）');
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else { minv[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const assign = new Array(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] > 0) assign[p[j] - 1] = j - 1;
  for (let i = 0; i < n; i++) if (assign[i] < 0) throw new Error('hungarian: 产出非排列（内部不变式被破坏）');
  return assign;
}

// ---------------------------------------------------------------------------
// 单对代价
// ---------------------------------------------------------------------------
function pairCost(sourceNode, targetNode, opts) {
  const sim = semanticSimilarity(sourceNode.name, targetNode.name);
  const anchoredThis = !!(sourceNode.concept && targetNode.concept);
  const sameConcept = anchoredThis && sourceNode.concept === targetNode.concept;
  const floor = sameConcept ? opts.floorAnchored
    : anchoredThis ? opts.floorAnchored
    : opts.floorFree;

  if (sim < floor) {
    return { feasible: false, reason: 'semantic-below-floor', sim, cost: opts.pad, floor };
  }
  const fromKey = stateKey(sourceNode.type, sourceNode.unit);
  const toKey = stateKey(targetNode.type, targetNode.unit);
  const path = findPath(fromKey, toKey, { maxOps: opts.maxOps });
  if (!path.feasible) {
    return { feasible: false, reason: 'no-transform-path', sim, cost: opts.pad, floor, fromKey, toKey };
  }
  let cost = opts.wSem * (1 - sim) + opts.wOp * path.cost;
  if (sameConcept) cost -= opts.anchorBonus;
  cost -= opts.commentBonus * (targetNode.commentEvidence || 0);
  return {
    feasible: true,
    sim,
    cost: Math.max(0, cost),
    floor,
    ops: path.ops,
    labels: path.labels,
    opCost: path.cost,
    risk: path.risk,
    fromKey,
    toKey,
    sameConcept,
  };
}

// ---------------------------------------------------------------------------
// 主求解入口
// ---------------------------------------------------------------------------
/**
 * @param {Array} sourceNodes ADT 节点数组（源系统，payload 的形态）
 * @param {Array} targetNodes ADT 节点数组（目标系统，期望的形态）
 * @returns 同构映射计划
 */
function solveIsomorphism(sourceNodes, targetNodes, optsIn = {}) {
  const opts = { ...DEFAULT_OPTS, ...optsIn };
  const t0 = process.hrtime.bigint();
  const S = [...sourceNodes].sort((a, b) => a.name.localeCompare(b.name));
  const T = [...targetNodes].sort((a, b) => a.name.localeCompare(b.name));
  const n = Math.max(S.length, T.length);

  // --- 1. 代价矩阵 ---
  const tc0 = process.hrtime.bigint();
  const details = [];
  const raw = Array.from({ length: n }, () => new Array(n).fill(opts.pad));
  for (let i = 0; i < S.length; i++) {
    details.push([]);
    for (let j = 0; j < T.length; j++) {
      const d = pairCost(S[i], T[j], opts);
      details[i].push(d);
      raw[i][j] = d.feasible ? d.cost : opts.pad;
    }
    for (let j = T.length; j < n; j++) details[i].push({ feasible: false, reason: 'padding', cost: opts.pad, sim: 0 });
  }
  for (let i = S.length; i < n; i++) {
    details.push(new Array(n).fill({ feasible: false, reason: 'padding', cost: opts.pad, sim: 0 }));
  }
  const costBuildMs = Number(process.hrtime.bigint() - tc0) / 1e6;

  // --- 2. 匈牙利求解 ---
  const th0 = process.hrtime.bigint();
  const assign = hungarian(raw, n);
  const hungarianMs = Number(process.hrtime.bigint() - th0) / 1e6;

  // --- 3. 后置过滤：代价 ≥ pad 的槽位是"虚拟空配"，还原为未匹配 ---
  const pairs = [];
  const unmappedFrom = [];
  const unmappedTo = [...T.map((t) => t.name)];
  let totalCost = 0;
  for (let i = 0; i < S.length; i++) {
    const j = assign[i];
    const d = details[i][j];
    if (j >= T.length || !d.feasible) {
      unmappedFrom.push(S[i].name);
      continue;
    }
    const t = T[j];
    // 置信边际：同一源字段的次优可行解与最优解之差
    let alt = Infinity;
    for (let k = 0; k < T.length; k++) {
      if (k === j) continue;
      const dd = details[i][k];
      if (dd.feasible) alt = Math.min(alt, dd.cost);
    }
    const margin = alt === Infinity ? Infinity : alt - d.cost;
    pairs.push({
      source: { name: S[i].name, type: S[i].type, unit: S[i].unit, concept: S[i].concept, samples: S[i].samples || [] },
      target: { name: t.name, type: t.type, unit: t.unit, concept: t.concept, comment: t.comment || '' },
      sim: d.sim,
      cost: d.cost,
      margin,
      ops: d.ops,
      labels: d.labels,
      opCost: d.opCost,
      risk: d.risk,
      sameConcept: d.sameConcept,
      anchor: {
        source: resolve(S[i].name).via,
        target: resolve(t.name).via,
      },
    });
    totalCost += d.cost;
    const idx = unmappedTo.indexOf(t.name);
    if (idx >= 0) unmappedTo.splice(idx, 1);
  }
  // 后置不变式 (i)：单射
  const srcSeen = new Set();
  const tgtSeen = new Set();
  for (const p of pairs) {
    if (srcSeen.has(p.source.name) || tgtSeen.has(p.target.name)) {
      throw new Error('solveIsomorphism: 产出非单射，算法不变式被破坏');
    }
    srcSeen.add(p.source.name);
    tgtSeen.add(p.target.name);
  }

  const avgSim = pairs.length ? pairs.reduce((a, p) => a + p.sim, 0) / pairs.length : 0;
  const solveMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    pairs,
    unmappedFrom,
    unmappedTo,
    totalCost,
    opts,
    metrics: {
      nSource: S.length,
      nTarget: T.length,
      matched: pairs.length,
      avgSim,
      totalCost,
      costBuildMs,
      hungarianMs,
      solveMs,
      paddedTo: n,
    },
  };
}

module.exports = { solveIsomorphism, hungarian, pairCost, DEFAULT_OPTS, OP_BY_ID };
