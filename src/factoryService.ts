/**
 * 工厂侧模拟服务（跟单智能体的对接对象）与承运商轨迹模拟。
 * 规则确定性，便于测试；时间推进通过显式 tick，服务器模式下由定时器驱动。
 */
import type { FactoryMessage, Shipment, ShipmentStatus } from "./types.ts";
import { nextSeq, round2 } from "./util.ts";

export interface FactoryDef {
  id: string;
  name: string;
  skus: string[];
  capacityPerDay: number;
  /** 每件代工成本 USD */
  unitCostUsd: number;
  /** 标准生产周期（天） */
  leadTimeDays: number;
  contact: string;
}

export const FACTORIES: FactoryDef[] = [
  {
    id: "FAC-SZ-01",
    name: "深圳华声电子厂（耳机/电源）",
    skus: ["BH-100", "PB-80"],
    capacityPerDay: 300,
    unitCostUsd: 0.42,
    leadTimeDays: 3,
    contact: "+86-755-8899-xxxx",
  },
  {
    id: "FAC-DG-02",
    name: "东莞凯达数码厂（键盘/台灯）",
    skus: ["KB-220", "LT-310"],
    capacityPerDay: 200,
    unitCostUsd: 0.5,
    leadTimeDays: 4,
    contact: "+86-769-2233-xxxx",
  },
  {
    id: "FAC-QD-03",
    name: "青岛宏发箱包厂（背包）",
    skus: ["BP-450"],
    capacityPerDay: 500,
    unitCostUsd: 0.3,
    leadTimeDays: 5,
    contact: "+86-532-8111-xxxx",
  },
];

export function findFactoryForSku(sku: string): FactoryDef | undefined {
  return FACTORIES.find((f) => f.skus.includes(sku));
}

export interface FactoryQuote {
  factoryId: string;
  factoryName: string;
  sku: string;
  qty: number;
  unitCostUsd: number;
  leadTimeDays: number;
  capacityPerDay: number;
  /** 超过 5 天产能 → 需要拆单/排队 */
  withinCapacity: boolean;
  remark: string;
}

export function factoryQuote(sku: string, qty: number): FactoryQuote {
  const factory = findFactoryForSku(sku);
  if (!factory) throw new Error(`没有工厂可生产 SKU：${sku}`);
  const days = Math.ceil(qty / factory.capacityPerDay);
  const withinCapacity = days <= 5;
  return {
    factoryId: factory.id,
    factoryName: factory.name,
    sku,
    qty,
    unitCostUsd: factory.unitCostUsd,
    leadTimeDays: Math.max(factory.leadTimeDays, days),
    capacityPerDay: factory.capacityPerDay,
    withinCapacity,
    remark: withinCapacity
      ? `排产 ${days} 天，可按期交付`
      : `需求超出 5 天产能，建议拆单或排队（预计 ${factory.leadTimeDays + days} 天）`,
  };
}

export interface FactoryOrder {
  factoryOrderNo: string;
  factoryId: string;
  factoryName: string;
  orderId: string;
  sku: string;
  qty: number;
  accepted: boolean;
  remark: string;
  etdTs: number;
  createdAt: number;
}

/** 下生产单：接受或明确退回（产能不足退回，不静默吞掉） */
export function placeFactoryOrder(
  input: { orderId: string; sku: string; qty: number },
  now: number,
): FactoryOrder {
  const quote = factoryQuote(input.sku, input.qty);
  const accepted = quote.withinCapacity;
  const factory = findFactoryForSku(input.sku)!;
  return {
    factoryOrderNo: `FO-${nextSeq()}`,
    factoryId: factory.id,
    factoryName: factory.name,
    orderId: input.orderId,
    sku: input.sku,
    qty: input.qty,
    accepted,
    remark: accepted ? `已排产，${quote.leadTimeDays} 天后交货` : quote.remark,
    etdTs: now + quote.leadTimeDays * 86_400_000,
    createdAt: now,
  };
}

/** 工厂自动回复（放进运单的沟通记录里，GUI 可见） */
export function factoryReplyFor(fo: FactoryOrder): string {
  if (fo.accepted) {
    return `${fo.factoryName}：生产单 ${fo.factoryOrderNo} 已收到（${fo.sku} × ${fo.qty}），${
      Math.ceil((fo.etdTs - fo.createdAt) / 86_400_000)
    } 天后交仓，届时可安排提货。`;
  }
  return `${fo.factoryName}：产能不足，无法按期承接 ${fo.sku} × ${fo.qty}。${fo.remark}`;
}

// ---------------- 承运商模拟 ----------------

const CARRIERS = ["DHL", "FedEx", "UPS"] as const;
export type Carrier = (typeof CARRIERS)[number];

const TRACK_STEPS: { status: ShipmentStatus; location: string; text: string }[] = [
  { status: "picked_up", location: "深圳保税仓", text: "包裹已揽收" },
  { status: "in_transit", location: "香港转运中心", text: "干线运输中，离开香港枢纽" },
  { status: "in_transit", location: "安克雷奇转运中心", text: "国际航班到达中转枢纽" },
  { status: "export_cleared", location: "目的国口岸", text: "出口放行，末端派送中" },
  { status: "delivered", location: "目的地", text: "已签收" },
];

export function createTrackingNo(carrier: Carrier): string {
  const prefix = carrier === "DHL" ? "DHL" : carrier === "FedEx" ? "FDX" : "UPS";
  return `${prefix}${Math.floor(1e9 + Math.random() * 8e9)}`;
}

export function nextTrackStep(shipment: Shipment): { status: ShipmentStatus; location?: string; text: string } | null {
  const reached = shipment.events.filter((e) => e.status !== "arranging" && e.status !== "factory_confirmed").length;
  if (reached >= TRACK_STEPS.length) return null;
  const step = TRACK_STEPS[reached];
  return { status: step.status, location: step.location, text: step.text };
}

export function headFreightQuote(sku: string, qty: number, weightOf: (sku: string) => number): number {
  const weight = weightOf(sku) * qty;
  return round2(40 + weight * 4.2);
}
