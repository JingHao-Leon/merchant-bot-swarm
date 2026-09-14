import { describe, expect, it } from "vitest";
import { factoryQuote, placeFactoryOrder, factoryReplyFor, nextTrackStep, createTrackingNo, headFreightQuote, FACTORIES } from "../../src/factoryService.ts";
import { findProduct } from "../../src/catalog.ts";
import { Store } from "../../src/store.ts";
import { parseTask, renderTask } from "../../src/agents/tasks.ts";
import type { Shipment } from "../../src/types.ts";

describe("工厂产能服务", () => {
  it("SKU 路由到对口工厂", () => {
    const q = factoryQuote("BH-100", 200);
    expect(q.factoryId).toBe("FAC-SZ-01");
    expect(q.withinCapacity).toBe(true);
    expect(q.remark).toMatch(/排产 1 天/);
  });

  it("超过 5 天产能 → 明确拒单（不静默吞掉）", () => {
    const q = factoryQuote("BP-450", 500 * 6);
    expect(q.withinCapacity).toBe(false);
    expect(q.remark).toMatch(/产能/);
  });

  it("下生产单：接受时给出生产单号与交期，拒绝时订单可转异常", () => {
    const now = Date.now();
    const ok = placeFactoryOrder({ orderId: "ORD-1", sku: "BH-100", qty: 200 }, now);
    expect(ok.accepted).toBe(true);
    expect(ok.factoryOrderNo).toMatch(/^FO-\d+$/);
    expect(ok.etdTs).toBeGreaterThan(now);

    const bad = placeFactoryOrder({ orderId: "ORD-2", sku: "BP-450", qty: 6000 }, now);
    expect(bad.accepted).toBe(false);
    expect(factoryReplyFor(bad)).toMatch(/产能不足/);
    expect(factoryReplyFor(ok)).toMatch(/已收到/);
  });

  it("所有 SKU 都有对口工厂", () => {
    for (const sku of ["BH-100", "PB-80", "KB-220", "LT-310", "BP-450"]) {
      expect(FACTORIES.find((f) => f.skus.includes(sku))).toBeDefined();
    }
  });
});

describe("承运商轨迹模拟", () => {
  it("运单号按承运商前缀生成", () => {
    expect(createTrackingNo("DHL")).toMatch(/^DHL\d{10}$/);
    expect(createTrackingNo("FedEx")).toMatch(/^FDX\d{10}$/);
    expect(createTrackingNo("UPS")).toMatch(/^UPS\d{10}$/);
  });

  it("轨迹按固定节奏推进到签收为止", () => {
    const store = new Store();
    const room = store.getOrCreateCustomerRoom("T", "US", "web");
    const order = store.createOrder({
      customerName: "T", country: "US", channel: "web",
      items: [{ sku: "BH-100", name: "耳机", qty: 1, unitPrice: 18.5 }],
      currency: "USD", totalAmount: 100, incoterm: "DAP", shippingAddress: "x", roomId: room.id,
    });
    const shipment: Shipment = store.createShipment(order.id, "FAC-SZ-01");
    const steps: string[] = [shipment.status];
    for (let i = 0; i < 6; i++) {
      const step = nextTrackStep(shipment);
      if (!step) break;
      store.setShipmentStatus(shipment.id, step.status, step.text);
      steps.push(shipment.status);
    }
    expect(steps).toEqual(["arranging", "picked_up", "in_transit", "in_transit", "export_cleared", "delivered"]);
    expect(nextTrackStep(shipment)).toBeNull();
  });

  it("头程运费按毛重计费", () => {
    const weight = findProduct("BH-100")!.weightKg * 200;
    expect(headFreightQuote("BH-100", 200, (s) => findProduct(s)!.weightKg)).toBeCloseTo(40 + weight * 4.2, 2);
  });
});

describe("Store 订单状态机与修订语义", () => {
  it("订单创建 → 状态推进 → 时间线留痕 → KPI 汇总", () => {
    const store = new Store();
    const room = store.getOrCreateCustomerRoom("Test Buyer", "US", "web");
    const order = store.createOrder({
      customerName: "Test Buyer",
      country: "US",
      channel: "web",
      items: [{ sku: "BH-100", name: "耳机", qty: 10, unitPrice: 16.28 }],
      currency: "USD",
      totalAmount: 202.8,
      incoterm: "DAP",
      shippingAddress: "NY",
      roomId: room.id,
    });
    expect(order.status).toBe("confirmed");
    store.updateOrderStatus(order.id, "declaring", "递交海关");
    expect(store.mustOrder(order.id).timeline.map((t) => t.event)).toEqual(["confirmed", "declaring"]);
    const kpi = store.kpis();
    expect(kpi.totalOrders).toBe(1);
    expect(kpi.pendingDeclaration).toBe(1);
    expect(kpi.totalRevenueUsd).toBe(202.8);
  });

  it("amendOrder 只覆盖显式字段，note 追加不覆盖（退单补正不丢单证记录）", () => {
    const store = new Store();
    const room = store.getOrCreateCustomerRoom("B", "US", "web");
    const order = store.createOrder({
      customerName: "B",
      country: "US",
      channel: "web",
      items: [{ sku: "BH-100", name: "耳机", qty: 10, unitPrice: 16.28 }],
      currency: "USD",
      totalAmount: 202.8,
      incoterm: "DAP",
      shippingAddress: "NY",
      note: "UN38.3 报告已随附",
      roomId: room.id,
    });
    // 模拟销售岗补正：只带 note，不带 incoterm/address（此前 bug 会把 incoterm 冲掉）
    store.amendOrder(order.id, { note: "贸易术语修正为 CIF" }, "海关退单补正：贸易术语非法");
    const amended = store.mustOrder(order.id);
    expect(amended.incoterm).toBe("DAP");
    expect(amended.shippingAddress).toBe("NY");
    expect(amended.note).toContain("UN38.3 报告已随附");
    expect(amended.note).toContain("贸易术语修正为 CIF");
  });

  it("群聊：开群 → 发言 → 关群生成纪要", () => {
    const store = new Store();
    const room = store.openGroupRoom("测试对齐", "议程", ["sales", "customs", "fulfillment"], "manual");
    store.postGroupMessage(room.id, "coordinator", "【议程】测试");
    store.postGroupMessage(room.id, "sales", "销售汇报");
    const closed = store.closeGroupRoom(room.id, { summary: "完成", replies: [{ agent: "sales", text: "销售汇报" }], actionItems: [] });
    expect(closed.status).toBe("closed");
    expect(closed.minutes?.replies).toHaveLength(1);
    expect(closed.closedAt).toBeGreaterThan(0);
  });

  it("运单 delivered 时自动推进订单到 delivered", () => {
    const store = new Store();
    const room = store.getOrCreateCustomerRoom("C", "US", "web");
    const order = store.createOrder({
      customerName: "C", country: "US", channel: "web",
      items: [{ sku: "BH-100", name: "耳机", qty: 1, unitPrice: 18.5 }],
      currency: "USD", totalAmount: 100, incoterm: "DAP", shippingAddress: "x", roomId: room.id,
    });
    const shipment = store.createShipment(order.id, "FAC-SZ-01");
    store.setShipmentStatus(shipment.id, "delivered", "签收");
    expect(store.mustOrder(order.id).status).toBe("delivered");
  });
});

describe("任务信封协议：渲染与解析互逆", () => {
  const cases = [
    { kind: "customer_message" as const, roomId: "cust-a", customerName: "David", text: "我要报价 BH-100 200 个" },
    { kind: "declare_order" as const, orderId: "ORD-1", groupRoomId: "sync-1" },
    { kind: "declare_order" as const, orderId: "ORD-1", groupRoomId: "sync-1", retryOf: "DEC-1" },
    { kind: "clear_inspection" as const, orderId: "ORD-2", declarationId: "DEC-2" },
    { kind: "amend_order" as const, orderId: "ORD-3", issues: ["贸易术语非法：X"], roomId: "sync-3" },
    { kind: "fulfill_order" as const, orderId: "ORD-4", declarationNo: "CUS20260101-0001", customerRoomId: "cust-b", groupRoomId: "sync-4" },
    { kind: "arrange_shipment" as const, orderId: "ORD-5", carrier: "DHL", customerRoomId: "cust-c" },
    { kind: "split_order" as const, orderId: "ORD-6", sku: "BP-450", qty: 2000, groupRoomId: "sync-6" },
    { kind: "split_order" as const, orderId: "ORD-6", sku: "BP-450", qty: 2000 },
    { kind: "notify_split" as const, orderId: "ORD-7", roomId: "cust-d", firstBatchQty: 2000, remark: "工厂产能不足 需分批" },
    { kind: "customer_message" as const, roomId: "cust-e", customerName: "Oliver", caseId: "CASE-GB-BAG", text: "我要下单" },
    { kind: "meeting_reply" as const, roomId: "sync-6", agenda: "例行对齐", role: "sales" as const },
  ];
  for (const task of cases) {
    it(`${task.kind} 信封可无损解析`, () => {
      const parsed = parseTask(renderTask(task));
      expect(parsed).toEqual(task);
    });
  }

  it("无关文本解析为 null", () => {
    expect(parseTask("今天天气不错")).toBeNull();
  });
});
