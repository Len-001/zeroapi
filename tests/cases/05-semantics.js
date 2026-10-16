'use strict';
/**
 * 正向验收 · 匹配精度与算子合成正确性
 * ---------------------------------------------------------------------------
 * 对抗类用例证明"不会崩坏"，本组证明"真的干对了活"：
 *   · 对照人工标注的 Ground Truth 计算 Precision / Recall / F1
 *   · 逐条核对算子链是否与人工推导一致（不是"能跑就行"）
 *   · 覆盖 4 种命名风格 × 6 类结构突变 的完整矩阵
 */

const { suite, test, assert, assertEq, assertClose } = require('../harness');
const { solveIsomorphism } = require('../../src/core/solver');
const { verifyPlan } = require('../../src/core/verifier');
const { compilePlan } = require('../../src/core/compiler');
const { Bridge } = require('../../src/core/bridge');
const { Bus } = require('../../src/core/bus');
const { decodeEnvelope, encodeEnvelope } = require('../../src/servers/gateway');
const F = require('../fixtures');

const KEY = (s, t) => `${s}→${t}`;

function compileBase(planOverride) {
  const S = F.sourceAdt();
  const T = F.targetAdt();
  const plan = planOverride || solveIsomorphism(S, T);
  const v = verifyPlan(plan, F.legacyRows);
  const compiled = compilePlan({ ...plan, pairs: v.pairs }, {
    sourceLabel: 'erp_goods', targetLabel: 'ProductDTO',
    sourceFp: F.fingerprint(S), targetFp: F.fingerprint(T),
  });
  return { plan, v, compiled, S, T };
}

module.exports = () => {
  suite('⑤ 匹配精度与算子合成');

  test('[Ground Truth] Precision / Recall / F1 全部为 1.000', () => {
    const plan = solveIsomorphism(F.sourceAdt(), F.targetAdt());
    const sc = F.scoreMapping(plan.pairs);
    assertEq(sc.precision, 1, `误配: ${sc.spurious.join(', ')}`);
    assertEq(sc.recall, 1, `漏配: ${sc.missing.join(', ')}`);
    assertEq(sc.f1, 1);
    assertEq(plan.pairs.length, 7);
    console.log(`      · TP=${sc.tp} FP=${sc.fp} FN=${sc.fn} → P=${sc.precision.toFixed(3)} R=${sc.recall.toFixed(3)} F1=${sc.f1.toFixed(3)}`);
  });

  test('[算子合成] 7 条映射的算子链逐条与人工推导一致', () => {
    const plan = solveIsomorphism(F.sourceAdt(), F.targetAdt());
    const got = {};
    for (const p of plan.pairs) got[KEY(p.source.name, p.target.name)] = p.ops;
    for (const [k, want] of Object.entries(F.EXPECTED_OPS)) {
      assertEq(got[k], want, `算子链不符：${k}`);
    }
    assertEq(Object.keys(got).length, Object.keys(F.EXPECTED_OPS).length);
  });

  test('[算子合成] 相似度与边际被量化，且同概念配对相似度显著高于门槛', () => {
    const plan = solveIsomorphism(F.sourceAdt(), F.targetAdt());
    for (const p of plan.pairs) {
      assert(p.sim >= 0.45, `${KEY(p.source.name, p.target.name)} 相似度 ${p.sim} 低于锚定门槛`);
    }
    const avg = plan.metrics.avgSim;
    assert(avg > 0.98, `平均相似度应接近 1，实际 ${avg.toFixed(4)}`);
    console.log(`      · 平均相似度 ${avg.toFixed(4)}，总代价 ${plan.totalCost.toFixed(6)}`);
  });

  test('[不变量闸门] 故意注入反向算子（÷100 写成 ×100）→ 必须被 L3 守恒律拦下', () => {
    const plan = solveIsomorphism(F.sourceAdt(), F.targetAdt());
    const tampered = {
      ...plan,
      pairs: plan.pairs.map((p) => (p.source.name === 'jg_fen' ? { ...p, ops: ['yuan2cent'], labels: ['×100'] } : p)),
    };
    const v = verifyPlan(tampered, F.legacyRows);
    assertEq(v.passed, false, '错误算子必须被拒绝，否则验证器形同虚设');
    const rej = v.rejected.find((r) => r.pair.source.name === 'jg_fen');
    assert(rej, 'jg_fen 这一对必须出现在 rejected 中');
    assert(rej.problems.includes('L3-业务守恒'), `拒绝原因应为业务守恒失败，实际 ${rej.problems.join(',')}`);
    assertEq(v.pairs.length, 6, '被拒绝的映射不得进入可用集合');
  });

  test('[不变量闸门] 故意注入有损算子 round → 因不可逆被 L2 拦下', () => {
    const plan = solveIsomorphism(F.sourceAdt(), F.targetAdt());
    const tampered = {
      ...plan,
      pairs: plan.pairs.map((p) => (p.source.name === 'kc_sl' ? { ...p, ops: ['roundInt'], labels: ['round'] } : p)),
    };
    const v = verifyPlan(tampered, F.legacyRows);
    assertEq(v.passed, false);
    assert(v.rejected[0].problems.includes('L2-往返恒等'));
  });

  test('[命名风格矩阵] abbr / full / upper / camel 四种风格全部 7/7 正确', () => {
    const summary = [];
    for (const mode of ['abbr', 'full', 'upper', 'camel']) {
      const map = F.styleMap(mode);
      const rows = F.legacyRows.map((r) => F.renameKeys(r, map));
      const b = new Bridge({ name: `style-${mode}`, bus: new Bus(), opts: { maxRebuildPerCall: 3 } });
      const ctx = F.ctxFor(rows, map);
      const r = b.convert('/api/goods', rows[0], ctx.targetAdt, ctx.meta);
      const pairs = r.entry.stats.pairs;
      assertEq(pairs, 7, `${mode} 风格下只匹配到 ${pairs} 对`);
      assertEq(r.out.priceYuan, 399.99, `${mode} 风格下金额错误`);
      assertEq(r.out.isListed, true, `${mode} 风格下布尔值错误`);
      assertEq(r.out.createdAt, '2025-06-15T15:06:40.000Z', `${mode} 风格下时间错误`);
      assertEq(r.out.productName, '机械键盘 K870', `${mode} 风格下名称错误`);
      assertEq(r.out.categoryId, 'C-013');
      summary.push(`${mode}:7/7`);
    }
    console.log(`      · 命名风格矩阵 ${summary.join('  ')}`);
  });

  test('[突变矩阵 · 改字段名] jg_fen→dj_fen：自愈后金额仍为 399.99', () => {
    const bus = new Bus();
    const b = new Bridge({ name: 'chaos-rename', bus });
    const base = F.ctxFor(F.legacyRows);
    b.convert('/api/goods', F.legacyRows[0], base.targetAdt, base.meta);
    const rows = F.legacyRows.map((r) => F.renameKeys(r, { jg_fen: 'dj_fen' }));
    const ctx = F.ctxFor(rows, { jg_fen: 'dj_fen' });
    const r = b.convert('/api/goods', rows[0], ctx.targetAdt, ctx.meta);
    assertEq(r.healed, true);
    assertEq(r.out.priceYuan, 399.99);
  });

  test('[突变矩阵 · 单位翻转] 分→元：桥接器把 ÷100 换成 ×1，金额不变', () => {
    const bus = new Bus();
    const b = new Bridge({ name: 'chaos-unit', bus });
    const base = F.ctxFor(F.legacyRows);
    b.convert('/api/goods', F.legacyRows[0], base.targetAdt, base.meta);
    const flipped = F.legacyRows.map((r) => ({ ...r, jg_fen: r.jg_fen / 100 }));
    const ctx = F.ctxFor(flipped);
    const r = b.convert('/api/goods', flipped[0], ctx.targetAdt, ctx.meta);
    assertEq(r.healed, true);
    assertEq(r.out.priceYuan, 399.99, '单位翻转后不得出现 100 倍偏差');
    const pair = r.entry.meta.pairs.find((p) => p.to === 'priceYuan');
    assertEq(pair.ops, [], '单位一致后应退化为 identity（而不是继续 ÷100）');
  });

  test('[突变矩阵 · 类型翻转] int→string：自动插入 parse 算子', () => {
    const bus = new Bus();
    const b = new Bridge({ name: 'chaos-type', bus });
    const base = F.ctxFor(F.legacyRows);
    b.convert('/api/goods', F.legacyRows[0], base.targetAdt, base.meta);
    const flipped = F.legacyRows.map((r) => ({ ...r, jg_fen: String(r.jg_fen) }));
    const ctx = F.ctxFor(flipped);
    const r = b.convert('/api/goods', flipped[0], ctx.targetAdt, ctx.meta);
    assertEq(r.healed, true);
    assertEq(r.out.priceYuan, 399.99, '字符串型金额必须被解析后再换算');
    assertEq(typeof r.out.priceYuan, 'number');
    assertEq(r.entry.meta.pairs.find((p) => p.to === 'priceYuan').ops, ['strToNum', 'cent2yuan']);
  });

  test('[突变矩阵 · 新增字段] 老 ERP 新增"品牌"列 → 自动接入目标契约', () => {
    const bus = new Bus();
    const b = new Bridge({ name: 'chaos-add', bus });
    const base = F.ctxFor(F.legacyRows);
    b.convert('/api/goods', F.legacyRows[0], base.targetAdt, base.meta);
    const withBrand = F.legacyRows.map((r) => ({ ...r, pp: 'Logitech' }));
    const ctx = F.ctxFor(withBrand);
    const r = b.convert('/api/goods', withBrand[0], ctx.targetAdt, ctx.meta);
    assertEq(r.healed, true);
    assertEq(r.entry.stats.pairs, 8, '新增列必须被自动接入（7+1）');
    assertEq(r.out.brand, 'Logitech');
  });

  test('[突变矩阵 · 恶意改名] 字段名与注释同时丢失 → 拒绝对接，且不伪造值', () => {
    const bus = new Bus();
    const b = new Bridge({ name: 'chaos-hostile', bus });
    const base = F.ctxFor(F.legacyRows);
    b.convert('/api/goods', F.legacyRows[0], base.targetAdt, base.meta);
    const rows = F.legacyRows.map((r) => {
      const o = { ...r, zz_qw_5: r.sp_mc };
      delete o.sp_mc;
      return o;
    });
    const ctx = F.ctxFor(rows);
    const r = b.convert('/api/goods', rows[0], ctx.targetAdt, ctx.meta);
    assertEq(r.entry.stats.pairs, 6, '应当只匹配 6 对（商品名无法锚定）');
    assertEq(r.out.productName, undefined, '未匹配的目标字段必须缺省，不得填 null 冒充有值');
    assertEq(Object.prototype.hasOwnProperty.call(r.out, 'productName'), false, '键都不应该存在');
  });

  test('[突变矩阵 · 删字段] 删除"是否上架" → 契约缺口被显式上报', () => {
    const bus = new Bus();
    const b = new Bridge({ name: 'chaos-drop', bus });
    const base = F.ctxFor(F.legacyRows);
    b.convert('/api/goods', F.legacyRows[0], base.targetAdt, base.meta);
    const rows = F.legacyRows.map((r) => { const o = { ...r }; delete o.sf_sx; return o; });
    const ctx = F.ctxFor(rows);
    const r = b.convert('/api/goods', rows[0], ctx.targetAdt, ctx.meta);
    assertEq(r.entry.stats.pairs, 6);
    assert(r.entry.plan.unmappedTo.includes('isListed'), '缺口必须出现在 unmappedTo 中');
    assertEq(Object.prototype.hasOwnProperty.call(r.out, 'isListed'), false);
  });

  test('[双向同构] 往返转换对全部样本逐字段还原', () => {
    const { compiled } = compileBase();
    for (const row of F.legacyRows) {
      const fwd = compiled.convert(row);
      const back = compiled.revert(fwd);
      for (const [k, v] of Object.entries(row)) {
        assertEq(back[k], v, `字段 ${k} 往返后不一致（${v} → ${back[k]}）`);
      }
    }
  });

  test('[产物形态] 编译出的源码包含全部 7 条映射且可读（不是压缩黑盒）', () => {
    const { compiled } = compileBase();
    const [fwdPart, bwdPart] = compiled.source.split('function revert');
    const fwdOuts = fwdPart.match(/out\["/g) || [];
    const bwdOuts = (bwdPart || '').match(/out\["/g) || [];
    assertEq(fwdOuts.length, 7, '正向每条映射都应产出一行 out[...] 赋值');
    assertEq(bwdOuts.length, 7, '反向同样应产出 7 行');
    assert(compiled.source.includes('分 → 元'), '关键换算必须在注释里说明（大屏可读性）');
    assert(compiled.source.includes('契约缺口'), '契约缺口必须被注释出来');
    assert(compiled.bytes > 2000, `产物过小(${compiled.bytes}B)，疑似被压缩成黑盒`);
    console.log(`      · 胶水代码 ${compiled.bytes} 字节 / ${compiled.source.split('\n').length} 行 / 编译 ${compiled.compileMs.toFixed(2)}ms`);
  });

  test('[信封编解码] XML 实体转义可逆 + 数值型文本强制转型', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<response service="wms.QueryGoods" version="1.0">',
      '  <resultCode>0</resultCode>',
      '  <goodsList>',
      '    <goods>',
      '      <sp_mc>测试&amp;商品</sp_mc>',
      '      <jg_fen>1999</jg_fen>',
      '      <sf_sx>1</sf_sx>',
      '      <xq_ms>&lt;含尖括号&gt;</xq_ms>',
      '      <kc_sl>0</kc_sl>',
      '    </goods>',
      '  </goodsList>',
      '</response>',
    ].join('\n');
    const rows = decodeEnvelope(xml);
    assertEq(rows.length, 1, 'records 解析必须只吃 <goods> 内的字段，不受 <resultCode> 干扰');
    assertEq(rows[0].sp_mc, '测试&商品', 'XML 实体转义必须可逆');
    assertEq(rows[0].jg_fen, 1999, '数值型文本必须被强制转型，否则单位推断全线失效');
    assertEq(rows[0].sf_sx, 1);
    assertEq(rows[0].kc_sl, 0, '0 不能被误判为空值');
    assertEq(rows[0].xq_ms, '<含尖括号>');
    assertEq(Object.keys(rows[0]).length, 5, '不得把信封字段混进记录体');
  });

  test('[信封编解码] 写出方向的 XML 必须正确转义特殊字符', () => {
    const xml = encodeEnvelope({ sp_mc: 'A&B<C>', jg_fen: 1999 });
    assert(xml.includes('A&amp;B&lt;C&gt;'), '特殊字符必须转义，否则老 ERP 的 XML 解析器会直接崩');
    assert(xml.includes('<jg_fen>1999</jg_fen>'));
    assert(xml.includes('service="wms.InsertGoods"'));
  });

  test('[指标] 首轮构建耗时分解全部落在合理量级', () => {
    const S = F.sourceAdt();
    const T = F.targetAdt();
    const plan = solveIsomorphism(S, T);
    assert(plan.metrics.costBuildMs < 100, `代价矩阵构建 ${plan.metrics.costBuildMs}ms 过慢`);
    assert(plan.metrics.hungarianMs < 50, `匈牙利匹配 ${plan.metrics.hungarianMs}ms 过慢`);
    console.log(`      · 7×8 求解: 代价矩阵 ${plan.metrics.costBuildMs.toFixed(3)}ms / 匈牙利 ${plan.metrics.hungarianMs.toFixed(3)}ms / 合计 ${plan.metrics.solveMs.toFixed(3)}ms`);
  });

  test('[数值保真] 全部样本的元金额与原始分值严格守恒', () => {
    const { compiled } = compileBase();
    for (const row of F.legacyRows) {
      const out = compiled.convert(row);
      assertClose(out.priceYuan * 100, row.jg_fen, 1e-9, `金额守恒失败: ${row.jg_fen} 分 → ${out.priceYuan} 元`);
    }
  });
};
