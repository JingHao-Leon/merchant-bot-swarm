/**
 * 产品目录与阶梯报价（销售智能体的商品数据库）。
 * 价格全部 USD；阶梯折扣按单 SKU 数量取最高适用档。
 */
import type { ProductItem, Quote, QuoteLine } from "./types.ts";
import { nextSeq, round2 } from "./util.ts";

export const CATALOG: ProductItem[] = [
  {
    sku: "BH-100",
    name: "无线蓝牙头戴耳机 Pro",
    category: "audio",
    unitPriceUsd: 18.5,
    tiers: [
      { minQty: 50, discount: 0.05 },
      { minQty: 200, discount: 0.12 },
      { minQty: 500, discount: 0.2 },
    ],
    stock: 4200,
    weightKg: 0.42,
    battery: true,
    hsCode: "851830",
  },
  {
    sku: "PB-80",
    name: "移动电源 20000mAh 65W",
    category: "power",
    unitPriceUsd: 12.8,
    tiers: [
      { minQty: 50, discount: 0.05 },
      { minQty: 200, discount: 0.1 },
    ],
    stock: 2600,
    weightKg: 0.38,
    battery: true,
    hsCode: "850760",
  },
  {
    sku: "KB-220",
    name: "机械键盘 87 键热插拔",
    category: "computer",
    unitPriceUsd: 21.0,
    tiers: [
      { minQty: 30, discount: 0.06 },
      { minQty: 100, discount: 0.13 },
    ],
    stock: 1500,
    weightKg: 0.85,
    battery: false,
    hsCode: "847160",
  },
  {
    sku: "LT-310",
    name: "智能 LED 台灯（护眼）",
    category: "lighting",
    unitPriceUsd: 9.6,
    tiers: [
      { minQty: 100, discount: 0.08 },
      { minQty: 300, discount: 0.15 },
    ],
    stock: 5200,
    weightKg: 0.6,
    battery: false,
    hsCode: "940542",
  },
  {
    sku: "BP-450",
    name: "防泼水商务双肩包",
    category: "bag",
    unitPriceUsd: 11.2,
    tiers: [
      { minQty: 50, discount: 0.07 },
      { minQty: 200, discount: 0.14 },
    ],
    stock: 3100,
    weightKg: 0.75,
    battery: false,
    hsCode: "420212",
  },
];

export const COUNTRIES = ["US", "DE", "GB", "FR", "AU", "CA", "JP", "SG"] as const;
export const INCOTERMS = ["FOB", "CIF", "DAP", "DDP", "EXW"] as const;

/** 目的国头程物流报价（USD/kg，含操作费），演示数据 */
const SHIPPING_USD_PER_KG: Record<string, { perKg: number; base: number }> = {
  US: { perKg: 4.2, base: 40 },
  DE: { perKg: 4.6, base: 45 },
  GB: { perKg: 4.4, base: 42 },
  FR: { perKg: 4.6, base: 45 },
  AU: { perKg: 4.9, base: 48 },
  CA: { perKg: 4.7, base: 46 },
  JP: { perKg: 3.2, base: 30 },
  SG: { perKg: 2.4, base: 25 },
};

export function findProduct(sku: string): ProductItem | undefined {
  return CATALOG.find((p) => p.sku.toUpperCase() === sku.toUpperCase());
}

export function unitPriceFor(product: ProductItem, qty: number): number {
  const price = product.unitPriceUsd * (1 - tierDiscount(product, qty));
  return round2(price);
}

export function tierDiscount(product: ProductItem, qty: number): number {
  let discount = 0;
  for (const tier of product.tiers) {
    if (qty >= tier.minQty) discount = tier.discount;
  }
  return discount;
}

export function searchCatalog(keyword?: string): ProductItem[] {
  if (!keyword) return CATALOG;
  const k = keyword.toLowerCase();
  return CATALOG.filter(
    (p) =>
      p.sku.toLowerCase().includes(k) ||
      p.name.toLowerCase().includes(k) ||
      p.category.toLowerCase().includes(k),
  );
}

/** 生成整单报价：货值阶梯价 + 头程物流费（毛重计费） */
export function buildQuote(input: {
  customerName: string;
  customerCountry: string;
  lines: { sku: string; qty: number }[];
  incoterm?: string;
}): Quote {
  const lines: QuoteLine[] = [];
  let goodsTotal = 0;
  let grossWeight = 0;
  for (const line of input.lines) {
    const product = findProduct(line.sku);
    if (!product) throw new Error(`未知商品 SKU：${line.sku}`);
    if (!Number.isInteger(line.qty) || line.qty <= 0) {
      throw new Error(`数量必须为正整数：${line.sku} × ${line.qty}`);
    }
    const unitPrice = unitPriceFor(product, line.qty);
    const lineTotal = round2(unitPrice * line.qty);
    lines.push({ sku: product.sku, name: product.name, qty: line.qty, unitPrice, lineTotal });
    goodsTotal += lineTotal;
    grossWeight += product.weightKg * line.qty;
  }
  const rate = SHIPPING_USD_PER_KG[input.customerCountry];
  if (!rate) throw new Error(`暂不支持目的国物流报价：${input.customerCountry}`);
  const shipping = input.incoterm === "EXW" ? 0 : round2(rate.base + grossWeight * rate.perKg);
  return {
    id: `QT-${nextSeq()}`,
    customerName: input.customerName,
    customerCountry: input.customerCountry,
    lines,
    shippingUsd: shipping,
    totalUsd: round2(goodsTotal + shipping),
    currency: "USD",
    incoterm: input.incoterm ?? "DAP",
    validUntilDays: 7,
    createdAt: Date.now(),
  };
}
