'use strict';
/**
 * ZeroAPI · 第一层支撑件：语义锚定词典（Symbolic Semantic Anchor）
 * ---------------------------------------------------------------------------
 * 职责：把任意来源的字段名（英文驼峰 / 下划线拼音缩写 / 全拼 / 中文别名）
 *       解析到统一的「概念 ID」，为同构求解器提供语义距离。
 *
 * 设计说明（为何不是直接调 LLM）：
 *   1. 离线可运行是硬约束 —— 本模块零网络、零第三方依赖、纯符号推理，确定性可复现；
 *   2. 符号先验 + 可选神经后验：本模块输出的 concept/confidence 可直接作为
 *      LLM 提示词的结构化先验（见 resolveSemantic 的 hook 注释），
 *      即论文口径里的「神经符号（Neuro-Symbolic）」中"符号"那一半。
 *
 * 三级解析策略（逐级降级）：
 *   L1 精确索引：name 命中 CONCEPTS 的 en / zh / pyf / abbr 任一同义词表
 *   L2 音节切分：用 MORPHEMES 对未登录缩写做 DP 最大覆盖切分，得到概念同义词集合
 *   L3 字面相似：二阶 Dice 系数 + 归一化编辑距离（仅做兜底，不产生概念）
 */

// ---------------------------------------------------------------------------
// 概念表：key = 概念 ID，value = 该概念在各命名体系下的观测形态
// ---------------------------------------------------------------------------
const CONCEPTS = {
  product_name: {
    zh: ['商品名称', '货品名称', '品名', '商品名', '名称'],
    en: ['productName', 'product_name', 'goodsName', 'goods_name', 'itemName', 'item_name', 'name', 'title', 'productTitle'],
    pyf: ['shangpinmingcheng', 'huopinmingcheng', 'pinming'],
    abbr: ['spmc', 'spmch', 'hpmc', 'spm'],
  },
  price: {
    zh: ['价格', '单价', '售价', '金额', '商品价格'],
    en: ['price', 'unitPrice', 'unit_price', 'amount', 'salePrice', 'sale_price', 'payAmt', 'pay_amt', 'totalPrice', 'total_price'],
    pyf: ['jiage', 'danjia', 'shoujia', 'jine'],
    abbr: ['jg', 'dj', 'sj', 'je', 'jgje'],
  },
  stock_qty: {
    zh: ['库存', '库存数量', '数量', '存量'],
    en: ['stockQty', 'stock_qty', 'stock', 'quantity', 'qty', 'inventory', 'stockCount'],
    pyf: ['kucun', 'kucunshuliang', 'shuliang'],
    abbr: ['kc', 'kcsl', 'sl', 'kcl'],
  },
  created_time: {
    zh: ['创建时间', '建立时间', '入库时间', '时间'],
    en: ['createdAt', 'created_at', 'createTime', 'create_time', 'ctime', 'gmtCreate', 'timestamp', 'ts'],
    pyf: ['chuangjianshijian', 'jianlishijian', 'rukushijian'],
    abbr: ['cjsj', 'jlsj', 'rksj', 'cjs'],
  },
  is_listed: {
    zh: ['是否上架', '上架状态', '上下架', '是否启用'],
    en: ['isListed', 'is_listed', 'listed', 'onShelf', 'on_shelf', 'isActive', 'enabled', 'active'],
    pyf: ['shifoushangjia', 'shangjiazhuangtai'],
    abbr: ['sfsx', 'sx', 'sfqy', 'qy'],
  },
  category_id: {
    zh: ['分类ID', '分类编号', '类目编号', '分类', '品类编码'],
    en: ['categoryId', 'category_id', 'categoryCode', 'category_code', 'catId', 'cat_id', 'classId'],
    pyf: ['fenleibianhao', 'fenleibianma', 'leimubianhao'],
    abbr: ['flid', 'flbh', 'flbm', 'lmbh'],
  },
  description: {
    zh: ['详情描述', '商品详情', '描述', '备注', '简介'],
    en: ['description', 'desc', 'detail', 'details', 'remark', 'comment', 'intro', 'summary'],
    pyf: ['xiangqingmiaoshu', 'shangpinxiangqing', 'miaoshu'],
    abbr: ['xqms', 'ms', 'bz', 'xq'],
  },
  brand: {
    zh: ['品牌', '品牌名称'],
    en: ['brand', 'brandName', 'brand_name', 'vendor', 'manufacturer'],
    pyf: ['pinpai', 'pinpaimingcheng'],
    abbr: ['pp', 'ppmc'],
  },
  owner_name: {
    zh: ['用户名称', '会员姓名', '客户名称', '收货人'],
    en: ['customerName', 'customer_name', 'userName', 'user_name', 'memberName', 'receiver'],
    pyf: ['yonghumingsheng', 'huiyuanxingming', 'kehumingcheng'],
    abbr: ['yhmc', 'hymc', 'khmc', 'shr'],
  },
  order_no: {
    zh: ['订单号', '订单编号', '单号'],
    en: ['orderNo', 'order_no', 'orderId', 'order_id', 'orderSn', 'billNo'],
    pyf: ['dingdanhao', 'dingdanbianhao', 'danhao'],
    abbr: ['ddh', 'ddbh', 'dh'],
  },
  unit_hint_cent: {
    zh: ['分', '以分为单位'],
    en: ['cents', 'inCents', 'cent'],
    pyf: ['fen'],
    abbr: ['fen', 'f'],
  },
  unit_hint_yuan: {
    zh: ['元', '人民币'],
    en: ['yuan', 'cny', 'rmb'],
    pyf: ['yuan'],
    abbr: ['yuan'],
  },
};

// ---------------------------------------------------------------------------
// 音节/词素表：用于对未登录缩写做 DP 切分
// key 同时收录缩写（sp）与全拼（shangpin）两种观测形态
// ---------------------------------------------------------------------------
const MORPHEMES = {
  sp: ['商品', 'product', 'goods', 'item'],
  shangpin: ['商品', 'product', 'goods', 'item'],
  mc: ['名称', 'name', 'title'],
  mingcheng: ['名称', 'name', 'title'],
  huo: ['货', 'goods'],
  pin: ['品', 'product'],
  jg: ['价格', 'price'],
  jiage: ['价格', 'price'],
  dj: ['单价', 'price', 'unitprice'],
  danjia: ['单价', 'price', 'unitprice'],
  je: ['金额', 'price', 'amount'],
  jine: ['金额', 'price', 'amount'],
  kc: ['库存', 'stock', 'inventory'],
  kucun: ['库存', 'stock', 'inventory'],
  sl: ['数量', 'quantity', 'qty'],
  shuliang: ['数量', 'quantity', 'qty'],
  cj: ['创建', 'create', 'created'],
  chuangjian: ['创建', 'create', 'created'],
  sj: ['时间', 'time', 'timestamp'],
  shijian: ['时间', 'time', 'timestamp'],
  rk: ['入库', 'create', 'inbound'],
  sf: ['是否', 'is', 'flag'],
  shifou: ['是否', 'is', 'flag'],
  sx: ['上架', 'listed', 'onshelf'],
  shangjia: ['上架', 'listed', 'onshelf'],
  fl: ['分类', 'category', 'class'],
  fenlei: ['分类', 'category', 'class'],
  bh: ['编号', 'id', 'code', 'no'],
  bianhao: ['编号', 'id', 'code', 'no'],
  bm: ['编码', 'id', 'code'],
  bianma: ['编码', 'id', 'code'],
  xq: ['详情', 'detail', 'description'],
  xiangqing: ['详情', 'detail', 'description'],
  ms: ['描述', 'description', 'desc'],
  miaoshu: ['描述', 'description', 'desc'],
  bz: ['备注', 'remark', 'comment'],
  beizhu: ['备注', 'remark', 'comment'],
  pp: ['品牌', 'brand'],
  pinpai: ['品牌', 'brand'],
  yh: ['用户', 'user', 'customer'],
  yonghu: ['用户', 'user', 'customer'],
  hy: ['会员', 'member', 'customer'],
  huiyuan: ['会员', 'member', 'customer'],
  kh: ['客户', 'customer', 'client'],
  kehu: ['客户', 'customer', 'client'],
  dd: ['订单', 'order'],
  dingdan: ['订单', 'order'],
  fen: ['分', 'cent', 'cents'],
  yuan: ['元', 'yuan', 'cny'],
};

// 概念 → 复合检索索引（en/zh/pyf/abbr 全部小写化）
const INDEX = new Map();
function addIndex(key, concept) {
  if (!key) return;
  const k = key.toLowerCase();
  // 冲突时保留先注册者，保证确定性
  if (!INDEX.has(k)) INDEX.set(k, concept);
}
for (const [concept, spec] of Object.entries(CONCEPTS)) {
  for (const bucket of ['zh', 'en', 'pyf', 'abbr']) {
    for (const w of spec[bucket] || []) addIndex(w, concept);
  }
}

// 概念 → 该概念的「词素语义指纹」（所有同义词拆词后的小写集合）
const FINGERPRINT = new Map();
function buildFingerprint(concept, spec) {
  const set = new Set();
  for (const bucket of ['zh', 'en', 'pyf', 'abbr']) {
    for (const w of spec[bucket] || []) {
      for (const tok of tokenize(w)) set.add(tok.toLowerCase());
    }
    for (const w of spec[bucket] || []) set.add(String(w).toLowerCase());
  }
  FINGERPRINT.set(concept, set);
}
for (const [c, s] of Object.entries(CONCEPTS)) buildFingerprint(c, s);

/**
 * 词素集合 → 概念支持度打分。
 * 注意：不能用「唯一候选」判定，因为 'name' 这类高频词素会同时出现在
 * product_name 与 owner_name 的指纹里。此处改为统计**支持词素数**，
 * 并要求与次优候选存在可观测的领先量，否则判为 ambiguous 不强行锚定。
 */
const MIN_SUPPORT_MARGIN = 2;
function scoreMorphemeCandidates(words) {
  const score = new Map();
  for (const [c] of Object.entries(CONCEPTS)) {
    if (c.startsWith('unit_hint_')) continue; // 单位词素只作提示，不参与概念竞争
    const fp = FINGERPRINT.get(c);
    let support = 0;
    for (const w of words) {
      const lw = String(w).toLowerCase();
      if (lw.length < 2) continue;
      for (const t of fp) {
        if (t.length < 2) continue;
        if (t === lw || t.includes(lw) || lw.includes(t)) { support++; break; }
      }
    }
    if (support > 0) score.set(c, support);
  }
  return score;
}

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------
/** 把 camelCase / snake_case / kebab-case / 全大写 拆成小写 token 数组 */
function tokenize(raw) {
  if (raw == null) return [];
  let s = String(raw);
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');       // camelCase → camel Case
  s = s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');    // HTTPServer → HTTP Server
  s = s.replace(/[_\-./\\:]+/g, ' ');
  return s.split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

/** 归一化：小写并去掉所有分隔符，得到连续字符流 */
function squash(raw) {
  return tokenize(raw).join('').toLowerCase();
}

/** 二阶 Dice 系数（bigram 集合重叠度），对字段名这类短串表现稳定 */
function diceBigram(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : a[0] === b[0] ? 0.4 : 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ma = grams(a), mb = grams(b);
  let inter = 0, sa = 0, sb = 0;
  for (const v of ma.values()) sa += v;
  for (const v of mb.values()) sb += v;
  for (const [g, v] of ma) if (mb.has(g)) inter += Math.min(v, mb.get(g));
  return (2 * inter) / (sa + sb);
}

/** 归一化编辑距离相似度 = 1 - lev / max(len) */
function levenshteinRatio(a, b) {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** token 集合 Jaccard */
function jaccardTokens(a, b) {
  const ta = new Set(tokenize(a).map((x) => x.toLowerCase()));
  const tb = new Set(tokenize(b).map((x) => x.toLowerCase()));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** 保守的纯字面相似度（不含任何词典知识） */
function lexicalSim(a, b) {
  const sa = squash(a), sb = squash(b);
  if (!sa || !sb) return 0;
  const d = diceBigram(sa, sb);
  const l = levenshteinRatio(sa, sb);
  const j = jaccardTokens(a, b);
  return Math.max(d, l * 0.95, j);
}

// ---------------------------------------------------------------------------
// L2：DP 最大覆盖切分
// ---------------------------------------------------------------------------
/**
 * 把未登录的连续字符串切分成已知词素序列。
 * 目标函数：最大化「被覆盖字符数」，同分时取切分段数更少者（更短路径），
 * 再同分取字典序更小的切分（保证确定性）。
 * 复杂度 O(L * M * maxLen)，L=字符串长度（字段名通常 < 32），可忽略。
 */
function segmentMorphemes(s, opts = {}) {
  const maxSeg = opts.maxSeg || 4;
  const n = s.length;
  // dp[i] = { cover, segs } 表示前 i 个字符的最优切分
  const dp = new Array(n + 1).fill(null);
  dp[0] = { cover: 0, segs: [] };
  for (let i = 0; i < n; i++) {
    if (!dp[i]) continue;
    for (let len = 2; len <= 12 && i + len <= n; len++) {
      const piece = s.slice(i, i + len);
      if (!MORPHEMES[piece]) continue;
      const next = i + len;
      const cand = { cover: dp[i].cover + len, segs: dp[i].segs.concat([piece]) };
      if (cand.segs.length > maxSeg) continue;
      const best = dp[next];
      if (
        !best ||
        cand.cover > best.cover ||
        (cand.cover === best.cover && cand.segs.length < best.segs.length) ||
        (cand.cover === best.cover && cand.segs.length === best.segs.length &&
          cand.segs.join('').localeCompare(best.segs.join('')) < 0)
      ) {
        dp[next] = cand;
      }
    }
  }
  let best = null;
  for (let i = n; i >= 0; i--) {
    if (dp[i] && (!best || dp[i].cover > best.cover)) { best = dp[i]; break; }
  }
  return best || { cover: 0, segs: [] };
}

// ---------------------------------------------------------------------------
// 对外主接口
// ---------------------------------------------------------------------------
/**
 * 解析字段名 → 概念。
 * @returns {{concept: string|null, confidence: number, via: string, words: string[]}}
 */
function resolve(name) {
  if (name == null || String(name).trim() === '') {
    return { concept: null, confidence: 0, via: 'empty', words: [] };
  }
  const raw = String(name);
  const flat = squash(raw);
  const toks = tokenize(raw);
  const hints = { unitHint: null };

  // 单位词素提示（分/元/fen/yuan/cents/cny…）在解析阶段就被剔除出概念竞争
  for (const t of toks) {
    const c = INDEX.get(t.toLowerCase());
    if (c === 'unit_hint_cent') hints.unitHint = 'cent';
    if (c === 'unit_hint_yuan') hints.unitHint = 'yuan';
  }

  // L1-a 全名精确索引
  if (INDEX.has(flat)) {
    const c = INDEX.get(flat);
    return { concept: c, confidence: 1.0, via: 'index:full', words: toks, hints };
  }
  // L1-b 单 token 精确索引（如 goods_name → goods / name 其中 name 命中）
  const tokenHits = toks
    .map((t) => INDEX.get(t.toLowerCase()))
    .filter((c) => c && !c.startsWith('unit_hint_'));
  // 纯数字 token（address_line_2 / price_1）不携带语义，必须从分母里剔除，
  // 否则 "命中 1 个 token 且占总 token 数 n-1 以上" 这条门槛会对带序号字段失效。
  const meaningful = toks.filter((t) => !/^\d+$/.test(t));
  if (meaningful.length >= 1 && tokenHits.length) {
    // 组合优先：把 token 按已知概念聚类，取出现最多的概念
    const tally = new Map();
    for (const hit of tokenHits) tally.set(hit, (tally.get(hit) || 0) + 1);
    const ranked = [...tally.entries()].sort((x, y) => (y[1] - x[1]) || x[0].localeCompare(y[0]));
    const [bestC, bestN] = ranked[0];
    const secondN = ranked[1] ? ranked[1][1] : 0;
    if (bestN >= Math.max(1, meaningful.length - 1) && bestN > secondN) {
      return { concept: bestC, confidence: 0.82, via: 'index:tokens', words: toks, hints };
    }
  }

  // L2 音节切分
  const seg = segmentMorphemes(flat);
  if (seg.cover >= 2 && seg.segs.length) {
    const words = [];
    for (const p of seg.segs) words.push(...MORPHEMES[p]);
    const score = scoreMorphemeCandidates(words);
    const ranked = [...score.entries()].sort((x, y) => (y[1] - x[1]) || x[0].localeCompare(y[0]));
    if (ranked.length) {
      const [bestC, bestN] = ranked[0];
      const secondN = ranked[1] ? ranked[1][1] : 0;
      const coverage = seg.cover / Math.max(1, flat.length);
      if (bestN - secondN >= MIN_SUPPORT_MARGIN || bestN >= 4) {
        return { concept: bestC, confidence: 0.5 + 0.35 * coverage, via: 'morpheme:dp', words: seg.segs, hints };
      }
      return { concept: null, confidence: 0.35, via: 'morpheme:ambiguous', words: seg.segs.concat(ranked.map((r) => r[0])), hints };
    }
    return { concept: null, confidence: 0.2, via: 'morpheme:noConcept', words: seg.segs, hints };
  }

  // L3 兜底
  return { concept: null, confidence: 0, via: 'lexical-only', words: toks, hints };
}

/**
 * 语义相似度 ∈ [0,1]。
 * 同概念 → 1.0；跨概念 → 被强压到低位（保证「宁缺毋滥」的匹配纪律）。
 */
function semanticSimilarity(nameA, nameB) {
  if (nameA == null || nameB == null) return 0;
  const ra = resolve(nameA);
  const rb = resolve(nameB);
  if (ra.concept && rb.concept) {
    if (ra.concept === rb.concept) {
      // 同为锚定命中，再按字面/证据强度区分（用于同概念内部消歧，如价格 vs 单价）
      return 0.9 + 0.1 * Math.max(lexicalSim(nameA, nameB), confidenceScore(ra, rb));
    }
    return Math.min(0.18, 0.2 * lexicalSim(nameA, nameB));
  }
  // 一方未锚定：允许字面证据，但设置天花板，避免拼写巧合被当成语义
  const lex = lexicalSim(nameA, nameB);
  const ceiling = ra.concept || rb.concept ? 0.55 : 0.62;
  return Math.min(ceiling, lex);
}

function confidenceScore(ra, rb) {
  return Math.min(ra.confidence, rb.confidence);
}

/** 供注释/中文说明做证据加分的粗匹配 */
function commentEvidence(comment, targetName) {
  if (!comment) return 0;
  const c = String(comment);
  const rt = resolve(targetName);
  if (rt.concept) {
    const spec = CONCEPTS[rt.concept];
    for (const w of spec.zh || []) if (c.includes(w)) return 1;
  }
  const ct = squash(c);
  const st = squash(targetName);
  if (!ct || !st) return 0;
  return diceBigram(ct, st) > 0.5 ? 0.5 : 0;
}

module.exports = {
  CONCEPTS,
  MORPHEMES,
  INDEX,
  MIN_SUPPORT_MARGIN,
  resolve,
  semanticSimilarity,
  scoreMorphemeCandidates,
  lexicalSim,
  tokenize,
  squash,
  diceBigram,
  levenshteinRatio,
  jaccardTokens,
  segmentMorphemes,
  commentEvidence,
};
