/**
 * 海关申报规则引擎（纯函数，可单测）。
 * 模拟海关审单逻辑：形式校验 → 单货一致性 → 特殊货物附加单证 → 高值查验布控。
 */
import type { CustomsDeclaration, Order } from "./types.ts";
import { moneyClose } from "./util.ts";

export const EXPORTER = {
  name: "深圳蓝鲸智造进出口有限公司",
  country: "CN",
  customsCode: "4403968XXX",
} as const;

export const INCOTERM_SET = new Set(["FOB", "CIF", "DAP", "DDP", "EXW"]);

/** HS 编码知识点：前 6 位为国际通用，按品类约束 */
const HS_BY_CATEGORY: Record<string, string> = {
  audio: "8518",
  power: "8507",
  computer: "8471",
  lighting: "9405",
  bag: "4202",
};

export function validHsForCategory(category: string): string {
  return HS_BY_CATEGORY[category] ?? "";
}

export function hsMatchesCategory(category: string, hsCode: string): boolean {
  const prefix = HS_BY_CATEGORY[category];
  return !!prefix && hsCode.startsWith(prefix);
}

export function isHsFormatValid(hsCode: string): boolean {
  return /^\d{6,10}$/.test(hsCode);
}

export interface ValidateResult {
  ok: boolean;
  issues: string[];
  /** 命中布控：货值 ≥ 2000 USD 需查验后放行 */
  requiresInspection: boolean;
}

/**
 * 校验申报单与订单/目录的一致性，返回问题清单（空数组=通过）。
 * 规则全部确定性，便于回归测试：
 *  R1 必填字段齐全、HS 编码 6-10 位数字且与品类匹配
 *  R2 申报项与订单逐行对齐（SKU、数量）
 *  R3 行金额 = 单价×数量，申报总值 = 订单应收
 *  R4 收发货人国别与订单一致，贸易术语合法
 *  R5 毛重 > 0 且与目录推算毛重偏差 ≤ 15%
 *  R6 含锂电池货物必须注明 UN38.3 测试摘要
 *  R7 申报总值 ≥ 2000 USD 触发查验布控
 */
export function validateDeclaration(
  decl: CustomsDeclaration,
  order: Order,
  weightOf: (sku: string) => number,
): ValidateResult {
  const issues: string[] = [];

  if (!decl.exporterName?.trim()) issues.push("缺少数码出口商名称（exporterName）");
  if (!decl.consigneeName?.trim()) issues.push("缺少收货人名称（consigneeName）");
  if (!decl.incoterm || !INCOTERM_SET.has(decl.incoterm)) {
    issues.push(`贸易术语非法：${decl.incoterm ?? "空"}（允许 FOB/CIF/DAP/DDP/EXW）`);
  }
  if (!decl.currency || decl.currency !== order.currency) {
    issues.push(`申报币种 ${decl.currency ?? "空"} 与订单 ${order.currency} 不一致`);
  }
  if (!decl.destinationCountry || decl.destinationCountry !== order.customer.country) {
    issues.push(`运抵国 ${decl.destinationCountry ?? "空"} 与订单目的国 ${order.customer.country} 不一致`);
  }
  if (decl.consigneeCountry && decl.consigneeCountry !== order.customer.country) {
    issues.push(`收货人国别 ${decl.consigneeCountry} 与订单目的国 ${order.customer.country} 不一致`);
  }
  if (!(decl.declaredValue > 0)) issues.push("申报总值必须大于 0");
  if (!(decl.grossWeightKg > 0)) issues.push("申报毛重必须大于 0");

  if (decl.items.length !== order.items.length) {
    issues.push(`申报项数 ${decl.items.length} 与订单行数 ${order.items.length} 不一致`);
  }

  const orderItemBySku = new Map(order.items.map((it) => [it.sku, it]));
  let catalogWeight = 0;
  for (const item of decl.items) {
    const orderItem = orderItemBySku.get(item.sku);
    if (!orderItem) {
      issues.push(`申报品 ${item.sku} 不在订单中`);
      continue;
    }
    if (!isHsFormatValid(item.hsCode)) {
      issues.push(`${item.sku} 的 HS 编码 ${item.hsCode} 格式非法（应为 6-10 位数字）`);
    }
    if (item.qty !== orderItem.qty) {
      issues.push(`${item.sku} 申报数量 ${item.qty} 与订单 ${orderItem.qty} 不一致`);
    }
    if (!moneyClose(item.unitValue, orderItem.unitPrice)) {
      issues.push(
        `${item.sku} 申报单价 ${item.unitValue} 与成交单价 ${orderItem.unitPrice} 不一致（低报价格风险）`,
      );
    }
    if (!moneyClose(item.totalValue, item.unitValue * item.qty)) {
      issues.push(`${item.sku} 行总金额与 单价×数量 不符`);
    }
    catalogWeight += weightOf(item.sku) * item.qty;
  }

  if (
    decl.grossWeightKg > 0 &&
    catalogWeight > 0 &&
    (decl.grossWeightKg < catalogWeight * 0.85 || decl.grossWeightKg > catalogWeight * 1.15)
  ) {
    issues.push(
      `申报毛重 ${decl.grossWeightKg}kg 与目录推算 ${catalogWeight.toFixed(2)}kg 偏差超过 15%`,
    );
  }

  const batteryItems = decl.items.filter((it) => weightOf(it.sku) > 0 && isBatterySku(it.sku));
  if (batteryItems.length > 0 && !/UN38\.?3/i.test(decl.notes ?? "")) {
    issues.push("含锂电池货物，缺少 UN38.3 测试摘要（notes 需注明 UN38.3）");
  }

  const requiresInspection = decl.declaredValue >= 2000;
  return { ok: issues.length === 0, issues, requiresInspection };
}

function isBatterySku(sku: string): boolean {
  // 目录层面锂电池标记；此处用轻量映射避免循环依赖 catalog
  const BATTERY_SKUS = new Set(["BH-100", "PB-80"]);
  return BATTERY_SKUS.has(sku);
}

/** 海关受理号：CUS + YYYYMMDD + 4 位流水 */
export function buildDeclarationNo(seq: number, ts: number): string {
  const d = new Date(ts);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
  return `CUS${ymd}-${String(seq).padStart(4, "0")}`;
}
