'use strict';
/**
 * 红蓝对抗 · 第 3 类：结构异常
 * 攻击面：逆序输入、重复语义键、首尾重合、两侧规模悬殊、大小写/分隔符等价体、
 *         以及"看起来很像但不是同一个东西"的诱饵字段
 * 目的：证明匈牙利算法给出的**是双射而不是贪心**，
 *       且输出对输入的排列顺序不敏感（determinism / order-independence）。
 */

const { suite, test, assert, assertEq } = require('../harness');
const { solveIsomorphism, pairCost, DEFAULT_OPTS } = require('../../src/core/solver');
const { buildAdt, inferFromSamples } = require('../../src/core/extractor');
const F = require('../fixtures');

const norm = (r) => r.pairs.map((p) => `${p.source.name}→${p.target.name}`).sort();

module.exports = () => {
  suite('③ 结构异常');

  test('逆序输入 → 映射结果逐条相同（顺序无关性）', () => {
    const S = F.sourceAdt();
    const T = F.targetAdt();
    const forward = norm(solveIsomorphism(S, T));
    const reversed = norm(solveIsomorphism([...S].reverse(), [...T].reverse()));
    assertEq(reversed, forward, '求解结果必须与输入排列无关');
    assertEq(forward.length, 7);
  });

  test('打乱输入 → 仍得到同一个双射（含代价一致性）', () => {
    const S = F.sourceAdt();
    const T = F.targetAdt();
    const base = solveIsomorphism(S, T);
    // 确定性重排：整体旋转 3 位，等价于"乱序输入"但不引入随机性
    const rot = (a, k) => a.slice(k).concat(a.slice(0, k));
    const shuffled = solveIsomorphism(rot(S, 3), rot(T, 5));
    assertEq(norm(shuffled), norm(base));
    assertEq(Number(shuffled.totalCost.toFixed(9)), Number(base.totalCost.toFixed(9)));
  });

  test('重复语义键：两个源字段都表示"价格"，目标只有一个 → 恰好匹配 1 个', () => {
    const S = [
      ...F.sourceAdt(),
      { name: 'dj_fen', type: 'number', unit: 'cent', concept: 'price', samples: [100] },
    ];
    const r = solveIsomorphism(S, F.targetAdt());
    const pricePairs = r.pairs.filter((p) => p.sim > 0.9 && /price/i.test(p.target.name));
    assertEq(pricePairs.length, 1, `同一目标字段被重复占用（${pricePairs.map((p) => p.source.name)}）`);
    // 未被选中的那个必须出现在 unmappedFrom 里，而不是被悄悄丢掉
    const losers = ['jg_fen', 'dj_fen'].filter((n) => !pricePairs.some((p) => p.source.name === n));
    assertEq(losers.length, 1, '必须恰好有一个"价格"字段落选');
    assert(r.unmappedFrom.includes(losers[0]), '落选字段必须显式出现在 unmappedFrom');
  });

  test('首尾重合：源首字段与目标末字段同概念时仍能正确配对', () => {
    const T = F.targetAdt();
    const moved = [T.find((n) => n.name === 'priceYuan'), ...T.filter((n) => n.name !== 'priceYuan')];
    const r = solveIsomorphism(F.sourceAdt(), moved);
    assertEq(r.pairs.length, 7);
    assert(r.pairs.some((p) => p.source.name === 'jg_fen' && p.target.name === 'priceYuan'), '首尾位置不该影响语义配对');
  });

  test('两侧规模悬殊（7 vs 20）：不越界、不产生幽灵配对', () => {
    const T = F.targetAdt();
    const padded = T.concat(Array.from({ length: 12 }, (_, i) => ({
      name: `extra_${i}`, type: 'string', unit: null, concept: null, samples: [],
    })));
    const r = solveIsomorphism(F.sourceAdt(), padded);
    assert(r.pairs.length <= 7, '配对数不得超过较小子集规模');
    assertEq(new Set(r.pairs.map((p) => p.target.name)).size, r.pairs.length, '目标侧不得重复占用');
    for (const p of r.pairs) assert(T.some((t) => t.name === p.target.name), `幽灵目标 ${p.target.name}`);
    assertEq(r.unmappedTo.length, 13, '7 个已匹配之外，剩余 13 个目标字段必须显式列为未匹配');
  });

  test('大小写/分隔符等价体（SP_MC 与 sp_mc）在同一 schema 内共存 → 不误配到同一目标', () => {
    const S = [
      { name: 'sp_mc', type: 'string', unit: null, concept: 'product_name', samples: ['A'] },
      { name: 'SP_MC', type: 'string', unit: null, concept: 'product_name', samples: ['B'] },
    ];
    const T = [{ name: 'productName', type: 'string', unit: null, concept: 'product_name', samples: [] }];
    const r = solveIsomorphism(S, T);
    assertEq(r.pairs.length, 1, '一个目标字段只能被一个源字段占用');
    assertEq(r.unmappedFrom.length, 1, '两个源字段必有其一落选并显式上报');
  });

  test('诱饵字段：字面相似但语义不同 → 拒绝匹配（precision 纪律）', () => {
    const S = [{ name: 'goodsCode', type: 'string', unit: null, concept: null, samples: ['X'] }];
    const T = [{ name: 'goodsName', type: 'string', unit: null, concept: null, samples: [] }];
    const r = solveIsomorphism(S, T);
    assertEq(r.pairs.length, 0, '字面相似度 0.55 低于 floorFree=0.68，不得匹配');
    assertEq(r.unmappedFrom, ['goodsCode']);
    assertEq(r.unmappedTo, ['goodsName']);
  });

  test('诱饵字段（有锚定方）：一个锚定一个不锚定时门槛抬到 0.68', () => {
    const S = [{ name: 'jg_fen', type: 'number', unit: 'cent', concept: 'price', samples: [1] }];
    const T = [{ name: 'jgyuan', type: 'number', unit: 'yuan', concept: null, samples: [] }];
    const c = pairCost(S[0], T[0], DEFAULT_OPTS);
    assertEq(c.feasible, false, '只有一侧锚定时必须走高门槛');
    assertEq(c.floor, DEFAULT_OPTS.floorFree);
  });

  test('自环陷阱：语义完全对得上，但没有算子链（object → number）→ 判定不可行', () => {
    // 刻意让两侧都锚定到同一概念，从而**绕过语义门槛**，
    // 逼着求解器只能靠"算子链是否存在"来做拒绝决策 —— 否则这条用例测不到真正想测的东西。
    const S = [{ name: 'jg_fen', type: 'object', unit: 'cent', concept: 'price', samples: [{}] }];
    const T = [{ name: 'priceYuan', type: 'number', unit: 'yuan', concept: 'price', samples: [] }];
    const c = pairCost(S[0], T[0], DEFAULT_OPTS);
    assertEq(c.feasible, false);
    assertEq(c.reason, 'no-transform-path', `拒绝原因必须是算子链缺失，实际 ${c.reason}`);
    assertEq(c.sim >= 0.9, true, '前置校验：语义门槛必须已经通过');
  });

  test('ADT 构建对列序不敏感：同一批字段不同排列 → 同一指纹', () => {
    const rows = F.legacyRows;
    const a = buildAdt(F.legacyTable.fields, inferFromSamples(rows)).nodes;
    const b = buildAdt([...F.legacyTable.fields].reverse(), inferFromSamples(rows)).nodes;
    assertEq(F.fingerprint(b), F.fingerprint(a));
  });

  test('同字段名在动态证据中类型漂移 → 采信值证据并留下 type_mismatch 痕迹', () => {
    const statics = [{ name: 'jg_fen', declared: 'INT', type: 'number', comment: '价格（以分为单位）', source: 'sql-ddl' }];
    const dynamics = inferFromSamples([{ jg_fen: '39999' }]);
    const adt = buildAdt(statics, dynamics);
    assertEq(adt.nodes[0].type, 'string', '值证据优先于静态声明');
    assert(adt.warnings.some((w) => w.code === 'type_mismatch'), '类型冲突必须留痕');
  });

  test('混合类型列（部分数值部分字符串）不被静默当作单一类型', () => {
    const f = inferFromSamples([{ v: 1 }, { v: '2' }, { v: null }]);
    assertEq(f[0].type, 'any', '混合类型必须落到 any 而不是随机选一个');
    assertEq(f[0].nullRatio > 0, true, '空值比例必须被量化');
  });
};
