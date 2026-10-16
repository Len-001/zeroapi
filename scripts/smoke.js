'use strict';
/** 开发期冒烟：不起 HTTP，纯核心链路（嗅探 → 求解 → 验证 → 编译 → 转换） */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { parseDdl, parseTsInterfaces, buildAdt, inferFromSamples, fingerprint } = require('../src/core/extractor');
const { solveIsomorphism } = require('../src/core/solver');
const { verifyPlan } = require('../src/core/verifier');
const { compilePlan } = require('../src/core/compiler');

const ddl = parseDdl(fs.readFileSync(path.join(ROOT, 'contracts/legacy_erp.sql'), 'utf8'));
const ts = parseTsInterfaces(fs.readFileSync(path.join(ROOT, 'contracts/modern_crm.d.ts'), 'utf8'));
const legacyTable = ddl.find((t) => t.table === 'erp_goods');
const productIface = ts.find((i) => i.iface === 'ProductDTO');

const legacyRows = [
  { sp_mc: '机械键盘 K870', jg_fen: 39999, kc_sl: 42, cjsj: 1750000000, sf_sx: 1, fl_id: 'C-013', xq_ms: '87 键热插拔轴体' },
  { sp_mc: '人体工学椅 Pro', jg_fen: 129900, kc_sl: 7, cjsj: 1750100000, sf_sx: 1, fl_id: 'C-021', xq_ms: '四级腰托' },
];

const sourceAdt = buildAdt(legacyTable.fields, inferFromSamples(legacyRows)).nodes;
const targetAdt = buildAdt(productIface.fields, []).nodes;

console.log('─ 源 ADT (老 ERP) ─');
for (const n of sourceAdt) console.log(`  ${n.name.padEnd(9)} ${n.type.padEnd(7)} unit=${String(n.unit).padEnd(8)} concept=${String(n.concept).padEnd(14)} anchor=${n.anchor.via}`);
console.log('─ 目标 ADT (现代 CRM) ─');
for (const n of targetAdt) console.log(`  ${n.name.padEnd(13)} ${n.type.padEnd(8)} unit=${String(n.unit).padEnd(8)} concept=${String(n.concept).padEnd(14)} anchor=${n.anchor.via}`);

const plan = solveIsomorphism(sourceAdt, targetAdt);
console.log(`\n─ 求解结果 (pairs=${plan.pairs.length}, totalCost=${plan.totalCost.toFixed(4)}, ${plan.metrics.solveMs.toFixed(2)}ms) ─`);
for (const p of plan.pairs) {
  console.log(`  ${p.source.name.padEnd(9)} → ${p.target.name.padEnd(13)} ops=[${p.ops.join(',')}] sim=${p.sim.toFixed(3)} cost=${p.cost.toFixed(3)} margin=${Number.isFinite(p.margin) ? p.margin.toFixed(3) : '∞'}`);
}
console.log('  未匹配源:', plan.unmappedFrom, ' 未匹配目标:', plan.unmappedTo);

const v = verifyPlan(plan, legacyRows);
console.log(`\n─ 验证 (checks=${v.summary.checkCount}, passed=${v.summary.checkPassed}, rejected=${v.summary.rejected}) ─`);
for (const c of v.checks) console.log(`  [${c.ok ? '✔' : '✘'}] ${c.layer.padEnd(10)} ${c.pair.padEnd(30)} ${c.detail}`);

const compiled = compilePlan({ ...plan, pairs: v.pairs }, {
  sourceLabel: 'erp_goods', targetLabel: 'ProductDTO',
  sourceFp: fingerprint(sourceAdt), targetFp: fingerprint(targetAdt),
});
console.log(`\n─ 编译产物 (${compiled.bytes} bytes, ${compiled.compileMs.toFixed(2)}ms) ─`);
const out = legacyRows.map((r) => compiled.convert(r));
console.log(JSON.stringify(out, null, 2));
console.log('─ 反向还原 ─');
console.log(JSON.stringify(out.map((r) => compiled.revert(r)), null, 2));
console.log('\n─ 生成的源码（前 40 行）─');
console.log(compiled.source.split('\n').slice(0, 40).join('\n'));
