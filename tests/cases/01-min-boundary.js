'use strict';
/**
 * 红蓝对抗 · 第 1 类：最小边界
 * 攻击面：空集合 / 单元素 / null / 空字符串 / 零维度矩阵
 * 目的：证明"没有数据"不是崩溃，而是产出**合法的空结果**。
 */

const { suite, test, assert, assertEq, assertThrows } = require('../harness');
const { hungarian, solveIsomorphism } = require('../../src/core/solver');
const { findPath, applyOps, invertChain, stateKey } = require('../../src/core/operators');
const { resolve, segmentMorphemes, semanticSimilarity, tokenize } = require('../../src/core/lexicon');
const { parseDdl, parseTsInterfaces, inferFromSamples, buildAdt, fingerprint } = require('../../src/core/extractor');
const { decodeEnvelope } = require('../../src/servers/gateway');
const F = require('../fixtures');

module.exports = () => {
  suite('① 最小边界');

  test('hungarian: 0×0 矩阵返回空排列而不是抛错', () => {
    assertEq(hungarian([], 0), []);
  });

  test('hungarian: 维度不符立刻报错（前置条件 P1 显式化）', () => {
    // 两条不同的前条件分支都要被覆盖：
    //   (a) 行数 ≠ n  → "cost 维度不匹配"
    //   (b) 行数 = n 但某行长度 ≠ n → "代价矩阵必须为方阵"
    assertThrows(() => hungarian([[1, 2]], 2), /维度不匹配/);
    assertThrows(() => hungarian([[1, 2], [3, 4], [5, 6]], 3), /方阵/);
  });

  test('hungarian: NaN 代价立刻报错，绝不静默产出错误匹配', () => {
    assertThrows(() => hungarian([[0, NaN], [1, 1]], 2), /非有限值/);
  });

  test('hungarian: Infinity 代价同样被拒绝（避免势能运算产生 Infinity-Infinity=NaN）', () => {
    assertThrows(() => hungarian([[0, Infinity], [1, 1]], 2), /非有限值/);
  });

  test('solveIsomorphism: 空源码 × 空目标码 → 0 对，指标为 0', () => {
    const r = solveIsomorphism([], []);
    assertEq(r.pairs.length, 0);
    assertEq(r.unmappedFrom.length, 0);
    assertEq(r.unmappedTo.length, 0);
    assertEq(r.metrics.avgSim, 0);
    assertEq(r.metrics.matched, 0);
  });

  test('solveIsomorphism: 空源 → 所有目标字段进 unmappedTo', () => {
    const T = F.targetAdt();
    const r = solveIsomorphism([], T);
    assertEq(r.pairs.length, 0, '空源不应产生任何映射');
    assertEq(r.unmappedTo.length, T.length);
  });

  test('solveIsomorphism: 空目标 → 所有源字段进 unmappedFrom', () => {
    const S = F.sourceAdt();
    const r = solveIsomorphism(S, []);
    assertEq(r.pairs.length, 0);
    assertEq(r.unmappedFrom.length, S.length);
  });

  test('solveIsomorphism: 单元素且完全同名 → 1 对且代价为 0', () => {
    const s = [{ name: 'price', type: 'number', unit: null, concept: 'price', samples: [1] }];
    const t = [{ name: 'price', type: 'number', unit: null, concept: 'price', samples: [] }];
    const r = solveIsomorphism(s, t);
    assertEq(r.pairs.length, 1);
    assertEq(r.pairs[0].ops, []);
    assertEq(r.totalCost, 0);
  });

  test('空字符串字段名不崩溃，只是必然匹配不上', () => {
    const r = solveIsomorphism([{ name: '', type: 'string', unit: null }], F.targetAdt());
    assertEq(r.pairs.length, 0);
    assertEq(r.unmappedFrom, ['']);
  });

  test('resolve: null / undefined / 空串 一律安全返回 concept=null', () => {
    for (const v of [null, undefined, '', '   ']) {
      const r = resolve(v);
      assertEq(r.concept, null, `${JSON.stringify(v)} 不应锚定到任何概念`);
      assert(r.confidence === 0 || r.confidence > 0, '置信度必须是有限数');
    }
  });

  test('tokenize 对 null 返回空数组', () => {
    assertEq(tokenize(null), []);
  });

  test('segmentMorphemes: 空字符串覆盖度为 0 且无切分段', () => {
    const r = segmentMorphemes('');
    assertEq(r.cover, 0);
    assertEq(r.segs, []);
  });

  test('semanticSimilarity: 任一参数为空时相似度为 0（不产生"空即相同"的误判）', () => {
    assertEq(semanticSimilarity('', ''), 0);
    assertEq(semanticSimilarity(null, 'price'), 0);
    assertEq(semanticSimilarity('price', undefined), 0);
  });

  test('findPath: 自反（同一状态）返回空链且代价 0', () => {
    const r = findPath(stateKey('number', null), stateKey('number', null));
    assert(r.feasible);
    assertEq(r.ops, []);
    assertEq(r.cost, 0);
  });

  test('applyOps: 空算子链是恒等映射', () => {
    assertEq(applyOps(5, []), 5);
    assertEq(applyOps('x', []), 'x');
  });

  test('invertChain: 空链的逆还是空链', () => {
    assertEq(invertChain([]), []);
  });

  test('parseDdl: 空文本 → 空表列表（残缺输入必须降级而非抛错）', () => {
    assertEq(parseDdl('').length, 0);
    assertEq(parseDdl('CREATE TABLE t (', ).length, 0);
  });

  test('parseTsInterfaces: 空文本 → 空接口列表', () => {
    assertEq(parseTsInterfaces('').length, 0);
    assertEq(parseTsInterfaces('export interface A { } ').length, 0, '空接口体不产生字段');
  });

  test('inferFromSamples: 空样本数组 → 空字段列表', () => {
    assertEq(inferFromSamples([]).length, 0);
    assertEq(inferFromSamples(null).length, 0);
  });

  test('buildAdt: 两侧都为空 → 空图 + 指纹稳定', () => {
    const a = buildAdt([], []);
    const b = buildAdt([], []);
    assertEq(a.nodes.length, 0);
    assertEq(fingerprint(a.nodes), fingerprint(b.nodes));
  });

  test('decodeEnvelope: 空 XML → 空数组（信封解码的零输入情形）', () => {
    assertEq(decodeEnvelope(''), []);
    assertEq(decodeEnvelope('<response></response>'), []);
  });

  test('单字段 ADT 与 12 字段目标：不越界、不误配', () => {
    const r = solveIsomorphism(F.sourceAdt().slice(0, 1), F.targetAdt());
    assert(r.pairs.length <= 1, '单源字段最多产出 1 对');
    if (r.pairs.length === 1) assertEq(r.pairs[0].source.name, 'cjsj');
  });
};
