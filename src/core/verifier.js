'use strict';
/**
 * ZeroAPI · 第二层收尾：业务不变量验证器 (Invariant Verifier)
 * ---------------------------------------------------------------------------
 * 承接 solver 的成本模型之外的最后一道闸门：
 * 「代价最小」不等于「语义正确」。凡是通过代价门槛的算子链，都必须再通过
 * 一组**可独立推导**的不变量断言，才允许被编译进桥接器。
 *
 * 不变量分三层：
 *   L1 类型域       —— 转换产物必须落在目标声明的类型域内
 *   L2 往返恒等     —— 逆链必须复原原值（数值型按相对误差容差）
 *   L3 业务守恒     —— 与领域语义绑定的守恒律（货币守恒、时间点恒等、布尔域收敛）
 *
 * 任何一条不通过 ⇒ 该 pair 被**降级为未匹配**并上报原因，
 * 绝不带着"看起来能跑"的转换函数上线。
 */

const { applyOps, invertChain, IMPL, OP_BY_ID } = require('./operators');

const TYPE_CHECK = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  any: () => true,
};

// ---------------------------------------------------------------------------
// L3 业务守恒律注册表
// ---------------------------------------------------------------------------
const INVARIANTS = {
  price: (src, out, pair) => {
    const su = pair.source.unit, tu = pair.target.unit;
    if (su === 'cent' && tu === 'yuan') {
      const back = out * 100;
      const eps = Math.max(1e-9, Math.abs(src) * 1e-12);
      return {
        name: '货币守恒(分→元)',
        ok: Math.abs(back - src) < eps,
        detail: `${src} 分 ⇒ ${out} 元 ⇒ ${back} 分 (|Δ|=${Math.abs(back - src).toExponential(2)})`,
      };
    }
    if (su === 'yuan' && tu === 'cent') {
      return { name: '货币守恒(元→分)', ok: Math.abs(out / 100 - src) < 1e-9, detail: `${src} 元 ⇒ ${out} 分` };
    }
    return { name: '货币单位一致', ok: su === tu, detail: `${su} → ${tu}` };
  },
  /**
   * 时间点恒等 —— 必须**方向无关**。
   * 早期版本只判定了「数值时间戳 → ISO 字符串」这一个方向，于是在反向桥接
   * （现代 OrderDTO 写回老 ERP：ISO → Unix 秒）时把合法映射误判为违规，
   * 结果是时间字段被静默剔除。这个缺陷正是被端到端反向用例抓出来的。
   */
  created_time: (src, out, pair) => {
    const su = pair.source.unit, tu = pair.target.unit;
    const toSeconds = (v, unit) => (unit === 'unix_ms' ? v / 1000 : unit === 'unix_s' ? v : null);
    if (tu === 'iso8601' && su !== 'iso8601') {
      const t = Date.parse(out);
      const sSrc = toSeconds(src, su);
      const ok = Number.isFinite(t) && sSrc !== null && Math.abs(t / 1000 - sSrc) < 1;
      return { name: '时间点恒等(→ISO)', ok, detail: `${src}(${su}) ⇒ ${out} ⇒ ${t / 1000}s` };
    }
    if (su === 'iso8601' && tu !== 'iso8601') {
      const t = Date.parse(src);
      const sOut = toSeconds(out, tu);
      const ok = Number.isFinite(t) && sOut !== null && Math.abs(t / 1000 - sOut) < 1;
      return { name: '时间点恒等(ISO→)', ok, detail: `${src} ⇒ ${out}(${tu})，期望 ${t / 1000}s` };
    }
    return { name: '时间单位一致', ok: su === tu, detail: `${su} → ${tu}` };
  },
  is_listed: (src, out) => ({
    name: '布尔域收敛',
    ok: typeof out === 'boolean',
    detail: `${JSON.stringify(src)} ⇒ ${JSON.stringify(out)} (${typeof out})`,
  }),
  stock_qty: (src, out) => ({
    name: '数量恒等',
    ok: out === src,
    detail: `${src} ⇒ ${out}`,
  }),
};

// ---------------------------------------------------------------------------
// 主校验
// ---------------------------------------------------------------------------
/**
 * @param {object} plan solveIsomorphism 的产物
 * @param {Array<object>} samples 真实/合成 payload 样本（源系统形态）
 * @returns {{pairs: Array, rejected: Array, checks: Array, precision: Array, passed: boolean}}
 */
function verifyPlan(plan, samples = []) {
  const checks = [];
  const rejected = [];
  const kept = [];
  const precision = [];
  const list = Array.isArray(samples) ? samples : [samples];
  const usable = list.filter((s) => s && typeof s === 'object');

  for (const pair of plan.pairs) {
    const problems = [];
    const srcSamples = usable
      .map((s) => s[pair.source.name])
      .filter((v) => v !== undefined && v !== null);
    const probe = srcSamples.length ? srcSamples : pair.source.samples || [];
    const isInv = invertChain(pair.ops);

    // L1 类型域
    const checker = TYPE_CHECK[pair.target.type] || TYPE_CHECK.any;
    let typeOk = true;
    const typeDetails = [];
    for (const v of probe.slice(0, 16)) {
      try {
        const out = applyOps(v, pair.ops);
        const ok = checker(out);
        typeDetails.push(`${JSON.stringify(v)} ⇒ ${JSON.stringify(out)} ${ok ? 'ok' : 'FAIL'}`);
        if (!ok) typeOk = false;
      } catch (e) {
        typeOk = false;
        typeDetails.push(`${JSON.stringify(v)} ⇒ 抛错: ${e.message}`);
      }
    }
    checks.push({
      pair: `${pair.source.name}→${pair.target.name}`, layer: 'L1-类型域',
      ok: typeOk, detail: typeDetails.slice(0, 3).join(' ; ') || '(无样本，跳过)',
    });
    if (!typeOk) problems.push('L1-类型域');

    // L2 往返恒等
    let rtOk = true;
    const rtDetails = [];
    if (isInv) {
      for (const v of probe.slice(0, 16)) {
        try {
          const fwd = applyOps(v, pair.ops);
          const back = applyOps(fwd, isInv);
          const same = typeof v === 'number' && typeof back === 'number'
            ? Math.abs(back - v) <= Math.max(1e-9, Math.abs(v) * 1e-12)
            : JSON.stringify(back) === JSON.stringify(v);
          if (!same) { rtOk = false; rtDetails.push(`${v} → ${fwd} → ${back}`); }
        } catch (e) {
          rtOk = false; rtDetails.push(`抛错: ${e.message}`);
        }
      }
    } else {
      rtOk = false;
      rtDetails.push('算子链不可逆（含 round 等有损算子），不满足函数式同构定义');
    }
    checks.push({
      pair: `${pair.source.name}→${pair.target.name}`, layer: 'L2-往返恒等',
      ok: rtOk, detail: rtOk ? `可逆链: ${pair.ops.join('∘') || 'identity'}` : rtDetails.slice(0, 2).join(' ; '),
    });
    if (!rtOk) problems.push('L2-往返恒等');

    // L3 业务守恒
    if (pair.target.concept && INVARIANTS[pair.target.concept] && probe.length) {
      let invOk = true;
      const invDetails = [];
      for (const v of probe.slice(0, 8)) {
        try {
          const out = applyOps(v, pair.ops);
          const r = INVARIANTS[pair.target.concept](v, out, pair);
          invDetails.push(`${r.name}: ${r.ok ? 'ok' : 'FAIL'} (${r.detail})`);
          if (!r.ok) invOk = false;
        } catch (e) {
          invOk = false; invDetails.push(`抛错: ${e.message}`);
        }
      }
      checks.push({ pair: `${pair.source.name}→${pair.target.name}`, layer: 'L3-业务守恒', ok: invOk, detail: invDetails.slice(0, 2).join(' ; ') });
      if (!invOk) problems.push('L3-业务守恒');
    }

    // 精度风险量化（针对声明了 float-precision 风险的链路）
    if (pair.risk && pair.risk.includes('float-precision') && probe.length) {
      let loss = 0, n = 0, worst = null;
      for (const v of probe) {
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        n++;
        const fwd = applyOps(v, pair.ops);
        const back = applyOps(fwd, isInv || []);
        if (back !== v) { loss++; if (!worst) worst = { in: v, mid: fwd, back }; }
      }
      precision.push({ pair: `${pair.source.name}→${pair.target.name}`, checked: n, lossCount: loss, lossRatio: n ? loss / n : 0, worst });
    }

    if (problems.length) {
      rejected.push({ pair, problems });
    } else {
      kept.push(pair);
    }
  }

  return {
    pairs: kept,
    rejected,
    checks,
    precision,
    passed: rejected.length === 0,
    summary: {
      total: plan.pairs.length,
      verified: kept.length,
      rejected: rejected.length,
      checkCount: checks.length,
      checkPassed: checks.filter((c) => c.ok).length,
    },
  };
}

module.exports = { verifyPlan, INVARIANTS, TYPE_CHECK };
