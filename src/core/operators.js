'use strict';
/**
 * ZeroAPI · 第二层支撑件：算子库与状态空间寻路
 * ---------------------------------------------------------------------------
 * 「同构函子」在代码层面落地的样子就是：一条从源状态 (type, unit) 走到
 * 目标状态 (type, unit) 的最短算子链。单位换算、编解码、类型提升都被
 * 建模为**带权有向图上的边**，函数式求解退化为图论最短路。
 *
 * 状态表示：`<type>|<unit>`，unit 用 '-' 表示无单位。
 * 通配：op 的两端 unit 可写 '*'，表示"保持该维度不变"。
 */

const NONE = '-';

const stateKey = (type, unit) => `${type}|${unit || NONE}`;
const parseState = (k) => {
  const [type, unit] = String(k).split('|');
  return { type, unit: unit === NONE ? null : unit };
};

// ---------------------------------------------------------------------------
// 算子实现表（纯函数，无外部依赖，可被序列化进桥接器源码）
// ---------------------------------------------------------------------------
const IMPL = {
  identity: (v) => v,
  cent2yuan: (v) => v / 100,
  yuan2cent: (v) => Math.round(v * 100),
  unixS2Iso: (v) => new Date(v * 1000).toISOString(),
  iso2UnixS: (v) => Math.floor(new Date(v).getTime() / 1000),
  unixMs2Iso: (v) => new Date(v).toISOString(),
  iso2UnixMs: (v) => new Date(v).getTime(),
  unixS2Ms: (v) => v * 1000,
  unixMs2S: (v) => Math.floor(v / 1000),
  int01ToBool: (v) => v === 1 || v === true || v === '1',
  boolToInt01: (v) => (v ? 1 : 0),
  strToNum: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new TypeError(`strToNum: 无法解析为数值 -> ${JSON.stringify(v)}`);
    return n;
  },
  numToStr: (v) => String(v),
  roundInt: (v) => Math.round(v),
};

// ---------------------------------------------------------------------------
// 算子注册表
//   cost 反映"语义风险"而非计算开销：单位换算类必须高于纯类型提升，
//   以便求解器在存在多条等价路径时优先选择语义扰动更小的那条。
// ---------------------------------------------------------------------------
const OPERATORS = [
  {
    id: 'cent2yuan', from: { type: 'number', unit: 'cent' }, to: { type: 'number', unit: 'yuan' },
    label: '÷100', glyph: '÷', kind: 'unit', cost: 0.05, inv: 'yuan2cent',
    risk: 'float-precision', note: '分 → 元：浮点除法，大数可能丢精度（由验证器量化）',
  },
  {
    id: 'yuan2cent', from: { type: 'number', unit: 'yuan' }, to: { type: 'number', unit: 'cent' },
    label: '×100', glyph: '×', kind: 'unit', cost: 0.05, inv: 'cent2yuan', risk: null,
  },
  {
    id: 'unixS2Iso', from: { type: 'number', unit: 'unix_s' }, to: { type: 'string', unit: 'iso8601' },
    label: '⏱→ISO', glyph: '⏱', kind: 'codec', cost: 0.06, inv: 'iso2UnixS', risk: 'timezone',
  },
  {
    id: 'iso2UnixS', from: { type: 'string', unit: 'iso8601' }, to: { type: 'number', unit: 'unix_s' },
    label: 'ISO→⏱', glyph: '⏱', kind: 'codec', cost: 0.06, inv: 'unixS2Iso', risk: 'timezone',
  },
  {
    id: 'unixMs2Iso', from: { type: 'number', unit: 'unix_ms' }, to: { type: 'string', unit: 'iso8601' },
    label: '⏱ms→ISO', glyph: '⏱', kind: 'codec', cost: 0.06, inv: 'iso2UnixMs', risk: 'timezone',
  },
  {
    id: 'iso2UnixMs', from: { type: 'string', unit: 'iso8601' }, to: { type: 'number', unit: 'unix_ms' },
    label: 'ISO→⏱ms', glyph: '⏱', kind: 'codec', cost: 0.06, inv: 'unixMs2Iso', risk: 'timezone',
  },
  {
    id: 'unixS2Ms', from: { type: 'number', unit: 'unix_s' }, to: { type: 'number', unit: 'unix_ms' },
    label: '⏱×1000', glyph: '⏱', kind: 'unit', cost: 0.04, inv: 'unixMs2S', risk: 'epoch-overflow',
  },
  {
    id: 'unixMs2S', from: { type: 'number', unit: 'unix_ms' }, to: { type: 'number', unit: 'unix_s' },
    label: '⏱÷1000', glyph: '⏱', kind: 'unit', cost: 0.04, inv: 'unixS2Ms', risk: 'truncation',
  },
  {
    id: 'int01ToBool', from: { type: 'number', unit: 'int01' }, to: { type: 'boolean', unit: null },
    label: '0/1→✓', glyph: '✓', kind: 'codec', cost: 0.04, inv: 'boolToInt01', risk: null,
  },
  {
    id: 'boolToInt01', from: { type: 'boolean', unit: null }, to: { type: 'number', unit: 'int01' },
    label: '✓→0/1', glyph: '✓', kind: 'codec', cost: 0.04, inv: 'int01ToBool', risk: null,
  },
  {
    id: 'strToNum', from: { type: 'string', unit: '*' }, to: { type: 'number', unit: '*' },
    label: 'parseF', glyph: '↦', kind: 'type', cost: 0.08, inv: 'numToStr', risk: 'parse-failure',
  },
  {
    id: 'numToStr', from: { type: 'number', unit: '*' }, to: { type: 'string', unit: '*' },
    label: 'fmt', glyph: '↦', kind: 'type', cost: 0.06, inv: 'strToNum', risk: null,
  },
  {
    id: 'roundInt', from: { type: 'number', unit: '*' }, to: { type: 'number', unit: '*' },
    label: 'round', glyph: '⌈', kind: 'type', cost: 0.09, inv: 'identity', risk: 'truncation',
  },
];

const OP_BY_ID = new Map(OPERATORS.map((o) => [o.id, o]));

// ---------------------------------------------------------------------------
// Dijkstra 最短路
// ---------------------------------------------------------------------------
/**
 * 在状态空间里寻找 from → to 的最小代价算子链。
 *
 * 前置条件：from / to 均为合法状态键；OPERATORS 中每条边的 cost > 0。
 * 后置保证：返回值满足
 *   (a) 若 from === to，返回空链且 cost = 0；
 *   (b) 否则链中每条边的终点等于下一条边的起点（状态连续性）；
 *   (c) 最后一条边的终点严格等于 to；
 *   (d) 在所有满足 (b)(c) 的链中，总代价最小（Dijkstra 最优性）。
 */
/**
 * 寻路结果记忆化。
 * 理由：代价矩阵构建阶段会对 n² 个字段对调用 findPath，而状态空间里
 * 不同的 (type,unit) 组合数量极小（本原型 ≤ 40），绝大多数调用是重复的。
 * 缓存把"每次重新跑一遍 Dijkstra"降为 O(1) 查表，实测收益见
 * reports/verification.json 中「规模」分组的 costBuildMs。
 * 容量上限防止病态输入把内存打爆。
 *
 * 返回值一律冻结：缓存共享同一对象，任何调用方若试图就地修改算子链，
 * 会在严格模式下立刻抛错（而不是静默污染后续所有匹配）。
 */
const PATH_CACHE = new Map();
const PATH_CACHE_MAX = 4096;

function findPath(fromKey, toKey, opts = {}) {
  const maxOps = opts.maxOps || 4;
  const cacheKey = `${fromKey}>${toKey}>${maxOps}`;
  const hit = PATH_CACHE.get(cacheKey);
  if (hit) return hit;
  const out = Object.freeze(findPathUncached(fromKey, toKey, maxOps));
  if (PATH_CACHE.size >= PATH_CACHE_MAX) PATH_CACHE.clear();
  PATH_CACHE.set(cacheKey, out);
  return out;
}

function findPathUncached(fromKey, toKey, maxOps) {
  if (fromKey === toKey) {
    return { ops: [], cost: 0, labels: [], risk: [], feasible: true };
  }
  const dist = new Map([[fromKey, 0]]);
  const prev = new Map();
  const visited = new Set();
  // 朴素 Dijkstra：状态数 < 40、边数 < 200，不必引入优先队列
  for (;;) {
    let cur = null, best = Infinity;
    for (const [k, d] of dist) {
      if (!visited.has(k) && d < best) { best = d; cur = k; }
    }
    if (cur === null) break;
    if (cur === toKey) break;
    visited.add(cur);
    const { type, unit } = parseState(cur);
    for (const op of OPERATORS) {
      if (!matchHalf(op.from, type, unit)) continue;
      const nextKey = applyHalf(op.to, type, unit);
      if (!nextKey || visited.has(nextKey)) continue;
      const chainLen = chainLength(prev, cur) + 1;
      if (chainLen > maxOps) continue;
      const nd = best + op.cost;
      if (!dist.has(nextKey) || nd < dist.get(nextKey)) {
        dist.set(nextKey, nd);
        prev.set(nextKey, { from: cur, op: op.id });
      }
    }
  }
  if (!dist.has(toKey)) return { ops: [], cost: Infinity, labels: [], risk: [], feasible: false };

  const chain = [];
  let k = toKey;
  const guard = new Set();
  while (prev.has(k)) {
    if (guard.has(k)) return { ops: [], cost: Infinity, labels: [], risk: [], feasible: false }; // 环保护
    guard.add(k);
    const { from, op } = prev.get(k);
    chain.unshift(op);
    k = from;
    if (chain.length > maxOps + 1) break;
  }
  // 后置校验 (c)：必须真的走到目标
  if (k !== fromKey) return { ops: [], cost: Infinity, labels: [], risk: [], feasible: false };
  const labels = chain.map((id) => OP_BY_ID.get(id).label);
  const risk = [...new Set(chain.map((id) => OP_BY_ID.get(id).risk).filter(Boolean))];
  return { ops: chain, cost: dist.get(toKey), labels, risk, feasible: true };
}

function matchHalf(half, type, unit) {
  if (half.type !== type) return false;
  if (half.unit === '*') return true;
  return (half.unit || null) === (unit || null);
}

function applyHalf(half, type, unit) {
  const nextUnit = half.unit === '*' ? (unit || null) : (half.unit || null);
  return stateKey(half.type, nextUnit);
}

function chainLength(prev, node) {
  let n = 0, k = node;
  const seen = new Set();
  while (prev.has(k) && n <= 8) {
    if (seen.has(k)) break;
    seen.add(k);
    k = prev.get(k).from;
    n++;
  }
  return n;
}

/** 反向链：把 from→to 的算子链翻转为 to→from（每个算子必须有逆） */
function invertChain(ops) {
  const out = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = OP_BY_ID.get(ops[i]);
    if (!op) return null;
    if (op.inv === 'identity') return null; // 有损算子不可逆，明确拒绝而非静默降级
    const inv = OP_BY_ID.get(op.inv);
    if (!inv) return null;
    out.push(inv.id);
  }
  return out;
}

/** 执行算子链 */
function applyOps(value, ops) {
  let v = value;
  for (const id of ops) {
    const fn = IMPL[id];
    if (typeof fn !== 'function') throw new Error(`未知算子: ${id}`);
    v = fn(v);
  }
  return v;
}

/**
 * 精度风险量化：对整型金额样本做 cent→yuan→cent 往返，
 * 返回发生不可逆损失的样本比例。0 表示该算子链在当前数据分布上无损。
 */
function measurePrecisionLoss(samples, ops) {
  if (!samples || !samples.length) return { lossRatio: 0, checked: 0, examples: [] };
  const examples = [];
  let bad = 0, checked = 0;
  for (const s of samples) {
    if (typeof s !== 'number' || !Number.isFinite(s)) continue;
    checked++;
    try {
      let v = s;
      for (const id of ops) v = IMPL[id](v);
      let back = v;
      for (const id of invertChain(ops) || []) back = IMPL[id](back);
      if (back !== s) { bad++; if (examples.length < 3) examples.push({ in: s, out: v, back }); }
    } catch {
      bad++; checked--; // 执行异常单独计入，不污染精度统计
      throw new Error(`算子链在样本 ${s} 上执行失败`);
    }
  }
  return { lossRatio: checked ? bad / checked : 0, checked, examples };
}

module.exports = {
  NONE,
  stateKey,
  parseState,
  OPERATORS,
  OP_BY_ID,
  IMPL,
  findPath,
  invertChain,
  applyOps,
  measurePrecisionLoss,
};
