// ===========================================================================
//  现代 CRM 前端 DTO 契约 (TypeScript)
//  说明：这是 2026 年的新系统。命名是英文驼峰；金额以「元」为单位的浮点数；
//        时间用 ISO 8601 字符串；布尔用真正的 boolean。
//  ZeroAPI 嗅探器会解析本文件作为目标侧的「静态契约」证据。
// ===========================================================================

export interface ProductDTO {
  productName: string;      // 商品名称
  priceYuan: number;        // 价格，单位为元
  stockQty: number;         // 库存数量
  createdAt: string;        // 创建时间，ISO 8601
  isListed: boolean;        // 是否上架
  categoryId: string;       // 分类编号
  description: string;      // 详情描述
  brand?: string;           // 品牌：新系统声明为可选 —— 数据源侧（老 ERP）尚无此列，
                            // 桥接器会把它记为"契约缺口"并跳过，绝不填 null 冒充有值
}

// 下单请求：由前端发起，经 ZeroAPI 反向桥接回老 ERP 的写接口
export interface OrderDTO {
  orderNo: string;          // 订单编号
  customerName: string;     // 收货人
  priceYuan: number;        // 订单金额，单位为元
  createdAt: string;        // 下单时间，ISO 8601
}
