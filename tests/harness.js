'use strict';
/**
 * ZeroAPI · 极简测试台架（零依赖）
 * ---------------------------------------------------------------------------
 * 为什么不用 jest/mocha：本项目的硬约束是"拷到任何装了 Node 的机器上就能跑"，
 * 引入测试框架会破坏这一点。断言、用例登记、计时、报告全部自实现，约 120 行。
 */

const results = [];
let currentSuite = '未分组';

function suite(name) { currentSuite = name; }

function record(name, ok, detail, ms) {
  results.push({ suite: currentSuite, name, ok, detail: detail || '', ms: ms || 0 });
  const mark = ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  const timing = ms != null ? `\x1b[90m(${ms.toFixed(2)}ms)\x1b[0m` : '';
  console.log(`  ${mark} ${name} ${timing}${ok ? '' : `\n      └─ ${detail}`}`);
}

/** 同步用例 */
function test(name, fn) {
  const t0 = process.hrtime.bigint();
  try {
    fn();
    record(name, true, '', Number(process.hrtime.bigint() - t0) / 1e6);
  } catch (e) {
    record(name, false, `${e.message}${e.expected !== undefined ? ` | expected=${JSON.stringify(e.expected)} actual=${JSON.stringify(e.actual)}` : ''}`, Number(process.hrtime.bigint() - t0) / 1e6);
  }
}

/** 异步用例 */
async function testAsync(name, fn) {
  const t0 = process.hrtime.bigint();
  try {
    await fn();
    record(name, true, '', Number(process.hrtime.bigint() - t0) / 1e6);
  } catch (e) {
    record(name, false, e.message, Number(process.hrtime.bigint() - t0) / 1e6);
  }
}

// ── 断言 ────────────────────────────────────────────────────────────
function fail(msg, expected, actual) {
  const e = new Error(msg);
  if (expected !== undefined) { e.expected = expected; e.actual = actual; }
  throw e;
}
function assert(cond, msg, expected, actual) {
  if (!cond) fail(msg || '断言失败', expected, actual);
}
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) fail(msg || `值不相等: ${a} !== ${b}`, expected, actual);
}
function assertClose(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) fail(msg || `数值偏差超限: ${actual} vs ${expected} (tol=${tol})`, expected, actual);
}
function assertIn(actual, list, msg) {
  if (!list.includes(actual)) fail(msg || `${JSON.stringify(actual)} 不在 ${JSON.stringify(list)} 中`, list, actual);
}
function assertThrows(fn, matcher, msg) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  if (!threw) fail(msg || '期望抛出异常但没有');
  if (matcher && !matcher.test(threw.message)) fail(msg || `异常信息不匹配: ${threw.message}`, matcher, threw.message);
  return threw;
}
async function assertRejects(fn, matcher, msg) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  if (!threw) fail(msg || '期望拒绝但没有');
  if (matcher && !matcher.test(threw.message)) fail(msg || `异常信息不匹配: ${threw.message}`, matcher, threw.message);
  return threw;
}

function summary() {
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const bySuite = new Map();
  for (const r of results) {
    if (!bySuite.has(r.suite)) bySuite.set(r.suite, { total: 0, pass: 0 });
    const s = bySuite.get(r.suite);
    s.total++; if (r.ok) s.pass++;
  }
  return { total, passed, failed: total - passed, bySuite: [...bySuite.entries()].map(([k, v]) => ({ suite: k, ...v })), cases: results };
}

module.exports = { suite, test, testAsync, assert, assertEq, assertClose, assertIn, assertThrows, assertRejects, summary, results };
