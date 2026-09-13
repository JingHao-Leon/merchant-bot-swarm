import { describe, expect, it } from "vitest";
import { buildDeclarationNo, hsMatchesCategory, isHsFormatValid, validHsForCategory, validateDeclaration, EXPORTER } from "../../src/customsRules.ts";
import { findProduct } from "../../src/catalog.ts";
import type { CustomsDeclaration, Order } from "../../src/types.ts";

const weightOf = (sku: string) => findProduct(sku)?.weightKg ?? 0;

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "ORD-9001",
    customer: { name: "Acme LLC", country: "US", channel: "web" },
    items: [{ sku: "BH-100", name: "无线蓝牙头戴耳机 Pro", qty: 200, unitPrice: 16.28 }],
    currency: "USD",
    totalAmount: 3648.8,
    incoterm: "DAP",
    shippingAddress: "285 Fulton St",
    status: "confirmed",
    timeline: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeDecl(overrides: Partial<CustomsDeclaration> = {}): CustomsDeclaration {
  return {
    orderId: "ORD-9001",
    exporterName: EXPORTER.name,
    exporterCountry: "CN",
    consigneeName: "Acme LLC",
    consigneeCountry: "US",
    destinationCountry: "US",
    incoterm: "DAP",
    currency: "USD",
    declaredValue: 3648.8,
    grossWeightKg: 84,
    items: [
      { sku: "BH-100", description: "耳机", hsCode: "851830", originCountry: "CN", qty: 200, unitValue: 16.28, totalValue: 3256 },
    ],
    notes: "UN38.3 测试摘要已随附",
    ...overrides,
  };
}

describe("海关申报规则引擎", () => {
  it("合法申报单通过校验，且高值（≥2000）触发查验布控", () => {
    const result = validateDeclaration(makeDecl(), makeOrder(), weightOf);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.requiresInspection).toBe(true);
  });

  it("低值订单不触发布控", () => {
    const order = makeOrder({ totalAmount: 500 });
    const decl = makeDecl({
      declaredValue: 500,
      items: [{ sku: "BH-100", description: "x", hsCode: "851830", originCountry: "CN", qty: 10, unitValue: 46.75, totalValue: 467.5 }],
    });
    expect(validateDeclaration(decl, order, weightOf).requiresInspection).toBe(false);
  });

  it("R1 HS 编码：格式与品类匹配", () => {
    expect(isHsFormatValid("851830")).toBe(true);
    expect(isHsFormatValid("85183")).toBe(false);
    expect(isHsFormatValid("85183A")).toBe(false);
    expect(validHsForCategory("audio")).toBe("8518");
    expect(hsMatchesCategory("audio", "851830")).toBe(true);
    expect(hsMatchesCategory("audio", "420212")).toBe(false);
  });

  it("R2 申报行数与订单不一致 → 退单", () => {
    const decl = makeDecl({ items: [] });
    const result = validateDeclaration(decl, makeOrder(), weightOf);
    expect(result.ok).toBe(false);
    expect(result.issues.join()).toMatch(/申报项数 0 与订单行数 1 不一致/);
  });

  it("R3 数量/单价与订单不符 → 低报价格风险退单", () => {
    const decl = makeDecl({
      items: [{ sku: "BH-100", description: "耳机", hsCode: "851830", originCountry: "CN", qty: 100, unitValue: 10, totalValue: 1000 }],
    });
    const issues = validateDeclaration(decl, makeOrder(), weightOf).issues;
    expect(issues.join()).toMatch(/申报数量 100 与订单 200 不一致/);
    expect(issues.join()).toMatch(/低报价格风险/);
  });

  it("R4 币种/运抵国/贸易术语必须与订单一致", () => {
    const issues = validateDeclaration(makeDecl({ currency: "EUR", destinationCountry: "DE", incoterm: "XYZ" }), makeOrder(), weightOf).issues;
    expect(issues.join()).toMatch(/币种 EUR 与订单 USD 不一致/);
    expect(issues.join()).toMatch(/运抵国 DE 与订单目的国 US 不一致/);
    expect(issues.join()).toMatch(/贸易术语非法/);
  });

  it("R5 毛重偏差超 15% 退单", () => {
    const issues = validateDeclaration(makeDecl({ grossWeightKg: 10 }), makeOrder(), weightOf).issues;
    expect(issues.join()).toMatch(/偏差超过 15%/);
  });

  it("R6 含锂电池但缺少 UN38.3 说明 → 退单；备注补上后通过（退单补正业务流的基础）", () => {
    const noNote = makeDecl({ notes: undefined });
    const r1 = validateDeclaration(noNote, makeOrder(), weightOf);
    expect(r1.ok).toBe(false);
    expect(r1.issues.join()).toMatch(/UN38\.3/);
    const fixed = makeDecl({ notes: "UN38.3 测试摘要（编号 UN38.3-2026-001）" });
    expect(validateDeclaration(fixed, makeOrder(), weightOf).ok).toBe(true);
  });

  it("非电池商品不需要 UN38.3", () => {
    const order = makeOrder({
      items: [{ sku: "KB-220", name: "机械键盘", qty: 120, unitPrice: 18.27 }],
      totalAmount: 2706.6,
    });
    const decl = makeDecl({
      grossWeightKg: 102,
      declaredValue: 2706.6,
      notes: undefined,
      items: [{ sku: "KB-220", description: "键盘", hsCode: "847160", originCountry: "CN", qty: 120, unitValue: 18.27, totalValue: 2192.4 }],
    });
    expect(validateDeclaration(decl, order, weightOf).ok).toBe(true);
  });

  it("海关受理号格式：CUS+日期+流水", () => {
    expect(buildDeclarationNo(42, Date.UTC(2026, 8, 14))).toMatch(/^CUS\d{8}-0042$/);
  });
});
