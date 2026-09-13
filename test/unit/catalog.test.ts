import { describe, expect, it } from "vitest";
import { buildQuote, CATALOG, findProduct, tierDiscount, unitPriceFor } from "../../src/catalog.ts";
import { parseAddress, parseDemand, computeDeclarationPayload } from "../../src/agents/director.ts";
import { isConfirmIntent, isTrackingIntent } from "../../src/agents/director.ts";

describe("商品目录与阶梯定价", () => {
  it("SKU 检索与关键字搜索", () => {
    expect(findProduct("BH-100")?.name).toBe("无线蓝牙头戴耳机 Pro");
    expect(findProduct("bh-100")?.sku).toBe("BH-100");
    expect(findProduct("XX-999")).toBeUndefined();
    expect(searchAll("耳机").map((p) => p.sku)).toContain("BH-100");
    expect(searchAll().length).toBe(CATALOG.length);
  });

  function searchAll(keyword?: string) {
    return CATALOG.filter((p) => !keyword || p.name.includes(keyword));
  }

  it("阶梯折扣取最高适用档", () => {
    const p = findProduct("BH-100")!;
    expect(tierDiscount(p, 10)).toBe(0);
    expect(tierDiscount(p, 50)).toBe(0.05);
    expect(tierDiscount(p, 200)).toBe(0.12);
    expect(tierDiscount(p, 999)).toBe(0.2);
    expect(unitPriceFor(p, 200)).toBeCloseTo(16.28, 2);
  });

  it("报价 = 阶梯货值 + 按毛重计费头程（可复现实测：200×BH-100 → $3648.80）", () => {
    const quote = buildQuote({
      customerName: "David Miller",
      customerCountry: "US",
      lines: [{ sku: "BH-100", qty: 200 }],
    });
    expect(quote.lines[0].unitPrice).toBe(16.28);
    expect(quote.lines[0].lineTotal).toBe(3256);
    // 运费 = 40 + 200×0.42kg×4.2 = 392.8
    expect(quote.shippingUsd).toBe(392.8);
    expect(quote.totalUsd).toBe(3648.8);
  });

  it("非法输入要明确报错", () => {
    expect(() => buildQuote({ customerName: "x", customerCountry: "US", lines: [{ sku: "NO-1", qty: 1 }] })).toThrow(/未知商品/);
    expect(() => buildQuote({ customerName: "x", customerCountry: "US", lines: [{ sku: "BH-100", qty: 0 }] })).toThrow(/正整数/);
    expect(() => buildQuote({ customerName: "x", customerCountry: "XX", lines: [{ sku: "BH-100", qty: 1 }] })).toThrow(/目的国/);
  });
});

describe("客户消息意图解析", () => {
  it("SKU+数量 双向语序", () => {
    expect(parseDemand("BH-100 蓝牙耳机 200 个")).toEqual({ sku: "BH-100", qty: 200 });
    expect(parseDemand("我要 80 个 LT-310 台灯")).toEqual({ sku: "LT-310", qty: 80 });
    expect(parseDemand("hello")).toBeNull();
    expect(parseDemand("XX-999 10 个")).toBeNull();
  });

  it("长商品名（智能 LED 台灯）也能解析", () => {
    expect(parseDemand("请报 LT-310 智能 LED 台灯 80 个")).toEqual({ sku: "LT-310", qty: 80 });
  });

  it("地址与确认/物流意图", () => {
    expect(parseAddress("确认下单。地址：285 Fulton St, NY")).toBe("285 Fulton St, NY");
    expect(parseAddress("confirm, address: 5th Ave")).toBe("5th Ave");
    expect(parseAddress("没有地址")).toBeNull();
    expect(isConfirmIntent("OK 确认下单")).toBe(true);
    expect(isConfirmIntent("帮我查下物流")).toBe(false);
    expect(isTrackingIntent("运单号多少？")).toBe(true);
    expect(isTrackingIntent("多少钱")).toBe(false);
  });
});

describe("结构化报关单整理（脚本大脑的业务规则）", () => {
  it("按订单推导申报要素，含锂电池时依赖订单备注提供 UN38.3", () => {
    const order = {
      id: "ORD-T1",
      customer: { name: "Test Buyer", country: "US", channel: "web" },
      items: [{ sku: "PB-80", name: "移动电源 20000mAh 65W", qty: 60, unitPrice: 12.16 }],
      currency: "USD",
      totalAmount: 800,
      incoterm: "DAP",
      shippingAddress: "somewhere",
      note: "客户随信提供 UN38.3 报告",
      status: "confirmed",
      timeline: [],
      createdAt: 0,
      updatedAt: 0,
    } as const;
    const decl = computeDeclarationPayload(order as never);
    expect(decl.exporterCountry).toBe("CN");
    expect(decl.destinationCountry).toBe("US");
    expect(decl.items[0].hsCode).toBe("850760");
    expect(decl.items[0].totalValue).toBeCloseTo(729.6, 2);
    expect(decl.grossWeightKg).toBeCloseTo(22.8, 2);
    expect(decl.notes).toMatch(/UN38\.3/);
  });

  it("订单备注没有 UN38.3 时不写随附单证（会被海关退单，触发补正流程）", () => {
    const order = {
      id: "ORD-T2",
      customer: { name: "B", country: "DE", channel: "web" },
      items: [{ sku: "BH-100", name: "耳机", qty: 10, unitPrice: 17.58 }],
      currency: "USD",
      totalAmount: 200,
      incoterm: "CIF",
      shippingAddress: "x",
      status: "confirmed",
      timeline: [],
      createdAt: 0,
      updatedAt: 0,
    };
    const decl = computeDeclarationPayload(order as never);
    expect(decl.notes).toBeUndefined();
  });
});
