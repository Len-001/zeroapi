'use strict';
/**
 * ZeroAPI · 第三层：热插拔桥接器编译器 (Hot-Swappable Bridge Compiler)
 * ---------------------------------------------------------------------------
 * 把求解器产出的「同构映射计划」编译成**真实可执行的 JavaScript 转换函数**。
 *
 * 两条硬规矩：
 *   1. 编译产物必须可读 —— 生成的源码会原样展示在演示大屏上，
 *      它是整个项目最直观的"我们在干什么"的证据，不能是黑盒字节码；
 *   2. 编译产物必须自带指纹 —— 运行时用指纹对比实现 O(1) 的"结构是否突变"判定，
 *      只有指纹不符才触发重求解，避免每请求都跑一遍 O(n³)。
 */

const { invertChain, IMPL, OP_BY_ID } = require('./operators');
const { fingerprint } = require('./extractor');

/**
 * 安全应用（编译产物里的 S）：`S(mapper, value)`。
 * null/undefined 直接透传为 null，避免 undefined 进入算子链产生 NaN 污染。
 * 这是"局部缺字段"场景下唯一的合法降级方式 —— 缺失就是缺失，不许伪造默认值。
 *
 * 注意参数顺序是 (mapper, value) 而非 (value, ops)：生成代码里写的是
 *   out['x'] = S(v => OPS.cent2yuan(v), src['jg_fen']);
 * 把算子链**内联进闭包**的原因是可读性 —— 大屏上要能一眼看懂每个字段被做了什么。
 */
function safeApply(mapper, v) {
  if (v === undefined || v === null) return null;
  return mapper(v);
}

const COMPILE_CTX = { OPS: IMPL, S: safeApply };

// ---------------------------------------------------------------------------
// 源码生成
// ---------------------------------------------------------------------------
function exprFor(ops, base) {
  let expr = base;
  for (const id of ops) {
    if (typeof IMPL[id] !== 'function') throw new Error(`编译器遇到未实现算子: ${id}`);
    expr = `OPS.${id}(${expr})`;
  }
  return expr;
}

function generateSource(plan, meta) {
  const stamp = new Date().toISOString();
  const lines = [];
  lines.push(`// ╔══════════════════════════════════════════════════════════════════════╗`);
  lines.push(`// ║  ZeroAPI 自动合成桥接器 (protocol bridge) — 由同构求解器生成          ║`);
  lines.push(`// ╚══════════════════════════════════════════════════════════════════════╝`);
  lines.push(`// 方向   : ${meta.sourceLabel} → ${meta.targetLabel}`);
  lines.push(`// 指纹   : ${meta.fingerprint}`);
  lines.push(`// 生成于 : ${stamp}`);
  lines.push(`// 匹配数 : ${plan.pairs.length}   未匹配: ${plan.unmappedFrom.length} 源 / ${plan.unmappedTo.length} 目标`);
  lines.push(`// 平均语义相似度: ${plan.metrics.avgSim.toFixed(4)}   总代价: ${plan.totalCost.toFixed(4)}`);

  const fwd = [];
  fwd.push(`function convert(src) {`);
  fwd.push(`  if (src === null || typeof src !== 'object') return src;`);
  fwd.push(`  const out = {};`);
  for (const p of plan.pairs) {
    const ops = p.ops.length ? p.ops.join('∘') : 'identity';
    fwd.push(`  // ${p.target.name.padEnd(14)} ← ${p.source.name.padEnd(12)} [${ops}] sim=${p.sim.toFixed(3)} cost=${p.cost.toFixed(3)}`);
    // 把算子的"人话解释"一并写进产物：这段代码是要在大屏上给人看的，
    // 光有 `OPS.cent2yuan` 不足以让评委在三秒内 understand 发生了什么。
    for (const id of p.ops) {
      const op = OP_BY_ID.get(id);
      if (op && op.note) fwd.push(`  //   · ${op.note}`);
    }
    const expr = exprFor(p.ops, 'v');
    fwd.push(`  out[${JSON.stringify(p.target.name)}] = S(v => ${expr}, src[${JSON.stringify(p.source.name)}]);`);
  }
  if (plan.unmappedTo.length) {
    fwd.push(`  // ── 契约缺口：以下目标字段在源系统中不存在对应数据 ──`);
    fwd.push(`  // 处理方式是**不产出该键**，而不是填 null / 空串 / 默认值：`);
    fwd.push(`  // 伪造数据比缺字段危险得多 —— 缺字段会在下游立刻炸出来，`);
    fwd.push(`  // 伪造的数据会静默流进数据库，几个月后才被人发现。`);
    for (const name of plan.unmappedTo) fwd.push(`  //   skip: ${name}`);
  }
  if (plan.unmappedFrom.length) {
    fwd.push(`  // ── 源系统独有、目标契约未声明的字段：留在源侧，不污染目标对象 ──`);
    for (const name of plan.unmappedFrom) fwd.push(`  //   skip: ${name}`);
  }
  fwd.push(`  return out;`);
  fwd.push(`}`);
  lines.push(fwd.join('\n'));

  // 反向：target → source（自然变换 η 的逆向分量）
  const bwd = [];
  bwd.push(`function revert(tgt) {`);
  bwd.push(`  if (tgt === null || typeof tgt !== 'object') return tgt;`);
  bwd.push(`  const out = {};`);
  for (const p of plan.pairs) {
    const inv = invertChain(p.ops);
    if (!inv) {
      bwd.push(`  // ${p.source.name.padEnd(12)} ← ${p.target.name}: 算子链含不可逆成分，反向定向放弃`);
      continue;
    }
    bwd.push(`  // ${p.source.name.padEnd(12)} ← ${p.target.name.padEnd(14)} [${inv.join('∘') || 'identity'}]`);
    const expr = exprFor(inv, 'v');
    bwd.push(`  out[${JSON.stringify(p.source.name)}] = S(v => ${expr}, tgt[${JSON.stringify(p.target.name)}]);`);
  }
  if (plan.unmappedTo.length) {
    bwd.push(`  // ── 目标侧独有字段（源系统不认）：反向时同样跳过，不臆造字段名 ──`);
    for (const name of plan.unmappedTo) bwd.push(`  //   skip: ${name}`);
  }
  bwd.push(`  return out;`);
  bwd.push(`}`);
  lines.push(bwd.join('\n'));

  lines.push(`return { convert, revert, meta: ${JSON.stringify({
    fingerprint: meta.fingerprint,
    pairs: plan.pairs.map((p) => ({
      from: p.source.name, to: p.target.name, ops: p.ops, labels: p.labels, sim: +p.sim.toFixed(4), cost: +p.cost.toFixed(4),
      margin: Number.isFinite(p.margin) ? +p.margin.toFixed(4) : null,
    })),
    unmappedFrom: plan.unmappedFrom, unmappedTo: plan.unmappedTo,
  })} };`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 编译
// ---------------------------------------------------------------------------
/**
 * @param {object} plan solveIsomorphism + verifier 过滤后的计划
 * @param {object} meta {sourceLabel, targetLabel, sourceFp, targetFp}
 */
function compilePlan(plan, meta) {
  const fp = `${meta.sourceFp}>${meta.targetFp}`;
  const fullMeta = { ...meta, fingerprint: fp };
  const src = generateSource(plan, fullMeta);
  const t0 = process.hrtime.bigint();
  // eslint-disable-next-line no-new-func
  const factory = new Function('OPS', 'S', src);
  const built = factory(COMPILE_CTX.OPS, COMPILE_CTX.S);
  const compileMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // 编译后自检：产物必须可调用，且双向都存在（不满足则视为编译失败）
  if (typeof built.convert !== 'function') throw new Error('compilePlan: convert 未生成');
  if (typeof built.revert !== 'function') throw new Error('compilePlan: revert 未生成');

  const opTally = new Map();
  for (const p of plan.pairs) for (const o of p.ops) opTally.set(o, (opTally.get(o) || 0) + 1);

  return {
    fingerprint: fp,
    sourceFp: meta.sourceFp,
    targetFp: meta.targetFp,
    source: src,
    convert: built.convert,
    revert: built.revert,
    meta: built.meta,
    bytes: Buffer.byteLength(src, 'utf8'),
    compileMs,
    stats: {
      pairs: plan.pairs.length,
      opCount: [...opTally.values()].reduce((a, b) => a + b, 0),
      opTally: [...opTally.entries()].map(([id, n]) => ({ id, label: OP_BY_ID.get(id)?.label || id, n })),
      avgSim: plan.metrics.avgSim,
      totalCost: plan.totalCost,
      solveMs: plan.metrics.solveMs,
      hungarianMs: plan.metrics.hungarianMs,
    },
  };
}

/** 仅由 ADT 图算出的结构指纹（不含求解结果），用于突变检测 */
function schemaFingerprint(nodes) {
  return fingerprint(nodes);
}

module.exports = { compilePlan, generateSource, safeApply, schemaFingerprint, COMPILE_CTX };
