'use strict';
/**
 * 命名风格映射表（共享数据模块）
 * ---------------------------------------------------------------------------
 * 被两处消费，刻意只保留一份：
 *   1. src/servers/legacy.js —— 突变注入器用它把线上字段"整表换风格"；
 *   2. tests/* —— 夹具用它复现同一操作。
 * 若两边各写一份，改了一边就会得到"测试全绿但线上翻车"的经典事故。
 */

const COLUMN_ORDER = ['商品名称', '价格', '库存数量', '创建时间', '是否上架', '分类编号', '详情描述'];

const NAME_STYLES = {
  abbr: ['sp_mc', 'jg_fen', 'kc_sl', 'cjsj', 'sf_sx', 'fl_id', 'xq_ms'],
  full: ['shangpin_mingcheng', 'jiage_fen', 'kucun_shuliang', 'chuangjian_shijian', 'shifou_shangjia', 'fenlei_bianhao', 'xiangqing_miaoshu'],
  upper: ['SP_MC', 'JG_FEN', 'KC_SL', 'CJSJ', 'SF_SX', 'FL_ID', 'XQ_MS'],
  camel: ['spMc', 'jgFen', 'kcSl', 'cjsj', 'sfSx', 'flId', 'xqMs'],
};

/** 风格名 → `{ 原字段名 → 该风格下的现字段名 }`，供测试构造重命名表 */
function styleMap(mode) {
  const target = NAME_STYLES[mode] || NAME_STYLES.abbr;
  const out = {};
  NAME_STYLES.abbr.forEach((n, i) => { out[n] = target[i]; });
  return out;
}

module.exports = { NAME_STYLES, COLUMN_ORDER, styleMap };
