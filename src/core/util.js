'use strict';
/** ZeroAPI · 极小的通用工具集（刻意保持无依赖、无状态） */

/** JS 值的粗粒度类型名。null/undefined 归为 'null'，便于与 ADT 的 type 域对齐。 */
function jsTypeOfSafe(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : 'any';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'object') return 'object';
  return 'any';
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = (v) => Math.round(v * 1000) / 1000;

/** 声明式规则匹配：{pattern: 'a_b', apply: (s, v) => ...} —— 供 chaos 场景使用 */
function applyRules(rules, value) {
  for (const r of rules) {
    if (r.test(value)) return r.apply(value);
  }
  return value;
}

module.exports = { jsTypeOfSafe, clamp, round3, applyRules };
