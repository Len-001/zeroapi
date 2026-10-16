-- ===========================================================================
--  遗留仓库管理系统 (Legacy WMS) · 表结构
--  说明：这是 2009 年上线的老系统。命名沿用当时的开发习惯 ——
--        拼音首字母缩写 + 下划线分隔；金额一律以「分」存储（避免浮点误差）；
--        时间一律存 Unix 秒级时间戳；布尔用 0/1 表示。
--  ZeroAPI 嗅探器会直接读取本文件作为「静态契约」证据。
-- ===========================================================================

CREATE TABLE erp_goods (
    sp_mc    VARCHAR(64)  NOT NULL COMMENT '商品名称',
    jg_fen   INT          NOT NULL COMMENT '价格（以分为单位）',
    kc_sl    INT          NOT NULL COMMENT '库存数量',
    cjsj     BIGINT       NOT NULL COMMENT '创建时间，Unix 秒级时间戳',
    sf_sx    TINYINT      NOT NULL COMMENT '是否上架：1=上架，0=下架',
    fl_id    VARCHAR(16)  NOT NULL COMMENT '分类编号',
    xq_ms    VARCHAR(512)          COMMENT '详情描述',
    PRIMARY KEY (id)
);

-- 历史包袱：系统里还存在一张从未被清理的备份表，字段与主表不完全一致。
-- （演示用：ZeroAPI 应当忽略它，只处理被显式声明的表）
CREATE TABLE erp_goods_bak_2009 (
    sp_mc    VARCHAR(64)  COMMENT '商品名称',
    jg_fen   INT          COMMENT '价格（以分为单位）'
);
