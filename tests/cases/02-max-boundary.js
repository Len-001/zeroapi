'use strict';
/**
 * 红蓝对抗 · 第 2 类：最大边界
 * 攻击面：规模极值（n=64 / n=128）、数值极值（MAX_SAFE_INTEGER）、
 *         时间极值（epoch=0 / 2100 年 / 负时间戳）、超长标识符
 * 目的：证明算法在规模与数值上都**有明确边界**，且越界时是"可度量的精度损失"
 *       而不是"静默的错值"。
 */

const { suite, test, assert, assertEq, assertClose, assertThrows } = require('../harness');
const { hungarian, solveIsomorphism } = require('../../src/core/solver');
const { applyOps, findPath, stateKey, measurePrecisionLoss } = require('../../src/core/operators');
const { resolve, semanticSimilarity } = require('../../src/core/lexicon');
const F = require('../fixtures');

/** 造一批带序号的可锚定字段：base_i —— base 必须能被词典锚定 */
const BASES = [
  { w: 'price', sType: 'number', sUnit: 'cent', tType: 'number', tUnit: 'yuan' },
  { w: 'unitPrice', sType: 'number', sUnit: 'cent', tType: 'number', tUnit: 'yuan' },
  { w: 'stock', sType: 'number', sUnit: null, tType: 'number', tUnit: null },
  { w: 'qty', sType: 'number', sUnit: null, tType: 'number', tUnit: null },
  { w: 'description', sType: 'string', sUnit: null, tType: 'string', tUnit: null },
  { w: 'listed', sType: 'number', sUnit: 'int01', tType: 'boolean', tUnit: null },
  { w: 'title', sType: 'string', sUnit: null, tType: 'string', tUnit: null },
  { w: 'brand', sType: 'string', sUnit: null, tType: 'string', tUnit: null },
];

function synth(nPerBase) {
  const S = [], T = [];
  for (const b of BASES) {
    for (let i = 0; i < nPerBase; i++) {
      S.push({ name: `${b.w}_${i}`, type: b.sType, unit: b.sUnit, concept: resolve(`${b.w}_${i}`).concept, samples: [1] });
      T.push({ name: `${b.w}_${i}`, type: b.tType, unit: b.tUnit, concept: resolve(`${b.w}_${i}`).concept, samples: [] });
    }
  }
  return { S, T };
}

module.exports = () => {
  suite('② 最大边界');

  test('合成字段全部能被词典锚定（规模用例本身的前提校验）', () => {
    const { S } = synth(1);
    const unresolved = S.filter((s) => !s.concept).map((s) => s.name);
    assertEq(unresolved, [], '若此项失败，后面的规模断言失去意义');
  });

  test('[规模 64×64] 产出合法排列 + 恒等配对 + 耗时归档', () => {
    const { S, T } = synth(8);
    assertEq(S.length, 64);
    const r = solveIsomorphism(S, T);
    assertEq(r.pairs.length, 64, '全可配对场景不应有遗漏');
    // 双射合法性（后置不变式 i）
    const srcSet = new Set(r.pairs.map((p) => p.source.name));
    const tgtSet = new Set(r.pairs.map((p) => p.target.name));
    assertEq(srcSet.size, 64);
    assertEq(tgtSet.size, 64);
    // 恒等配对：同名同序号的语义成本为 0，任何交叉配对都严格更差
    const wrong = r.pairs.filter((p) => p.source.name !== p.target.name);
    assertEq(wrong.map((p) => `${p.source.name}→${p.target.name}`), []);
    assert(r.metrics.solveMs < 3000, `64×64 求解耗时 ${r.metrics.solveMs.toFixed(1)}ms 超出 3000ms 预算`);
    console.log(`      · n=64: 代价矩阵 ${r.metrics.costBuildMs.toFixed(2)}ms / 匈牙利 ${r.metrics.hungarianMs.toFixed(2)}ms / 合计 ${r.metrics.solveMs.toFixed(2)}ms`);
  });

  test('[规模 128×128] 匈牙利算法 O(n³) 不退化，双射仍合法', () => {
    const { S, T } = synth(16);
    assertEq(S.length, 128);
    const r = solveIsomorphism(S, T);
    assertEq(r.pairs.length, 128);
    const tgtSet = new Set(r.pairs.map((p) => p.target.name));
    assertEq(tgtSet.size, 128, '128 规模下更易暴露排列冲突');
    assert(r.metrics.solveMs < 8000, `128×128 求解耗时 ${r.metrics.solveMs.toFixed(1)}ms 超出 8000ms 预算`);
    console.log(`      · n=128: 代价矩阵 ${r.metrics.costBuildMs.toFixed(2)}ms / 匈牙利 ${r.metrics.hungarianMs.toFixed(2)}ms / 合计 ${r.metrics.solveMs.toFixed(2)}ms`);
  });

  test('[规模] 非方阵 96×128 的补齐路径：pairs ≤ min(n,m) 且无幽灵配对', () => {
    const { S, T } = synth(16);
    const r = solveIsomorphism(S.slice(0, 96), T);
    assert(r.pairs.length <= 96);
    assertEq(r.pairs.length, 96, '源 96 个字段全可配对时应当全部匹配');
    // 补齐出来的虚拟节点绝不能出现在 pairs 里
    const inTargets = new Set(T.map((t) => t.name));
    for (const p of r.pairs) assert(inTargets.has(p.target.name), `幽灵目标字段 ${p.target.name}`);
  });

  test('[数值极值] 匈牙利算法在 1e9 量级代价上不溢出、不产生 Infinity', () => {
    const n = 12;
    const cost = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1e9 : 1e9 + Math.abs(i - j))));
    const assign = hungarian(cost, n);
    assertEq(assign, [...Array(n).keys()], '对角代价最小时应选中对角');
    // 独立核算总代价
    const total = assign.reduce((a, c, i) => a + cost[i][c], 0);
    assert(Number.isFinite(total), '总代价必须有限');
  });

  test('[数值极值] 分→元 在 MAX_SAFE_INTEGER 上的精度损失被量化而非静默吞掉', () => {
    const MAX = Number.MAX_SAFE_INTEGER; // 9007199254740991
    const ops = ['cent2yuan'];
    const fwd = applyOps(MAX, ops);
    const back = applyOps(fwd, ['yuan2cent']);
    // 独立推导期望：JS 双精度下 round(v/100*100) 是否等于 v
    const expectExact = Math.round(MAX / 100 * 100) === MAX;
    const actualExact = back === MAX;
    assertEq(actualExact, expectExact, '精度判定必须与独立推导一致（不能只靠"看起来对"）');
    const m = measurePrecisionLoss([MAX, 1, 100, 39999, 129900], ops);
    assertEq(m.checked, 5, '所有样本都应被计入检查');
    assert(m.lossRatio >= 0 && m.lossRatio <= 1, 'lossRatio 必须落在 [0,1]');
    console.log(`      · MAX_SAFE_INTEGER=${MAX}: 前向=${fwd} 回程=${back} 精确=${actualExact}; 5 样本 lossRatio=${m.lossRatio}`);
    if (!actualExact) assertEq(m.lossRatio > 0, true, '存在精度损失时 lossRatio 必须为正');
  });

  test('[时间极值] epoch 0 / 2100 年 / 负时间戳全部往返恒等', () => {
    const cases = [0, 1, -1, 946684800, 4102444800, 4294967295];
    for (const v of cases) {
      const iso = applyOps(v, ['unixS2Iso']);
      const back = applyOps(iso, ['iso2UnixS']);
      assertEq(back, v, `时间戳 ${v} 往返失败（iso=${iso}）`);
      assert(!Number.isNaN(Date.parse(iso)), `${v} → ${iso} 不是合法 ISO`);
    }
    assertEq(applyOps(0, ['unixS2Iso']), '1970-01-01T00:00:00.000Z');
    assertEq(applyOps(-1, ['unixS2Iso']), '1969-12-31T23:59:59.000Z');
  });

  test('[时间极值] 毫秒戳↔秒戳在 13 位量级上不丢整秒', () => {
    const ms = 1750000000123;
    const s = applyOps(ms, ['unixMs2S']);
    assertEq(s, 1750000000, '必须向下取整而不是四舍五入（否则会出现"未来一秒"）');
    assertEq(applyOps(s, ['unixS2Ms']), 1750000000000);
  });

  test('[标识符极值] 200 字符字段名不崩溃，且与自身相似度为 1', () => {
    const long = 'p'.repeat(100) + 'price' + 'X'.repeat(96);
    const r = resolve(long);
    assert(r !== null, 'resolve 对超长输入必须返回结果');
    assertEq(semanticSimilarity(long, long), 1, '自反性是最基本的一致性要求');
    const t2 = `${'p'.repeat(99)}qrice${'X'.repeat(96)}`;
    const s2 = semanticSimilarity(long, t2);
    assert(s2 >= 0 && s2 <= 1, `相似度必须落在 [0,1]，实际 ${s2}`);
  });

  test('[寻路极值] maxOps 上限被遵守：超过上限的组合判定为不可行', () => {
    // string|unix_ms → boolean|-  需要 strToNum∘unixMs2S∘unixS2Iso 之外再转 bool，
    // 现实中不存在这条链，必须返回不可行而不是硬凑
    const r = findPath(stateKey('string', 'unix_ms'), stateKey('boolean', null), { maxOps: 1 });
    assertEq(r.feasible, false);
    assertEq(r.ops, []);
  });

  test('[用例自身的负对照] 未锚定的长后缀字段不会被字面相似度误配', () => {
    // 两个独立的负对照，都必须落在 floorFree=0.68 之下 —— 这是"宁缺毋滥"纪律的可测形式。
    const s1 = semanticSimilarity('goodsCode', 'goodsName');          // 共享 goods 前缀
    const s2 = semanticSimilarity('priceYuan', 'priceYuanBackupSnapshotV2'); // 长后缀快照字段
    assert(s1 < 0.68, `未锚定的字面巧合必须低于 floorFree=0.68，实际 ${s1.toFixed(3)}`);
    assert(s2 < 0.68, `带长后缀的近名字段必须低于门槛，实际 ${s2.toFixed(3)}`);
    // 正面对照：两侧都被词典锚定到同一概念时，相似度**故意**保持高位。
    // 这不是缺陷而是设计选择：语义证据的权重必须压过形态证据。
    const anchored = semanticSimilarity('priceYuan', 'jg_fen');
    assert(anchored > 0.9, `同概念命中应保持高相似度，实际 ${anchored.toFixed(3)}`);
    console.log(`      · 负对照 goodsCode/goodsName=${s1.toFixed(3)}, priceYuan/长后缀=${s2.toFixed(3)}；正对照 priceYuan/jg_fen=${anchored.toFixed(3)}`);
  });
};
