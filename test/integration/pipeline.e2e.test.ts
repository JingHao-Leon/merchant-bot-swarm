import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config.ts";
import { Swarm } from "../../src/swarm.ts";
import type { Order } from "../../src/types.ts";

function testConfig(): AppConfig {
  return {
    ...loadConfig({} as NodeJS.ProcessEnv),
    providerKind: "faux",
    builtinProvider: null,
    modelId: "test-faux",
    meetingIntervalMs: 0,
    carrierTickMs: 0,
  };
}

async function waitFor(label: string, fn: () => false | string, timeoutMs = 20_000): Promise<string> {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const r = fn();
    if (r) return r;
    last = `仍未满足：${label}`;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待超时：${label}（${last}）`);
}

function tickUntil(swarm: Swarm, orderId: string, status: string): void {
  for (let i = 0; i < 60; i++) {
    swarm.tickCarrier();
    const s = swarm.store.shipmentForOrder(orderId);
    if (s?.status === status) return;
  }
  throw new Error(`运单未推进到 ${status}`);
}

describe("全链路集成：询价 → 报价 → 下单 → 报关 → 生产 → 发货 → 签收（faux 脚本模型）", () => {
  it("自动客户路径：UN38.3 退单 → 补正重报 → 查验放行 → 交付，并触发应急对齐会", async () => {
    const swarm = new Swarm(testConfig(), { persistPath: null, autoCustomer: true });
    await swarm.handleCustomerMessage({
      customerName: "David Miller",
      country: "US",
      channel: "whatsapp",
      text: "你好，我想要 BH-100 无线蓝牙耳机 200 个，发到美国纽约，请报价。",
    });

    const quoteId = await waitFor("报价", () =>
      [...swarm.store.quotes.values()].find((q) => q.customerName === "David Miller")?.id ?? false,
    );
    expect(quoteId).toMatch(/^QT-/);

    const order = await waitFor("自动成单", () =>
      [...swarm.store.orders.values()].find((o) => o.customer.name === "David Miller")?.id ?? false,
    );

    // 含锂电池但首单未附 UN38.3 → 海关退单 → 自动拉对齐会 → 销售补正 → 重报。
    // 退单/查验是瞬态（自动补正链路在毫秒级完成），断言以持久留痕为准。
    const decl = await waitFor("报关单出单", () => swarm.store.declarationForOrder(order)?.id ?? false);
    await waitFor("应急对齐会已召开", () => {
      const room = [...swarm.store.groupRooms.values()].find((r) => r.trigger === "event");
      return room?.status === "closed" && room.messages.length >= 4 ? room.id : false;
    });
    await waitFor("补正后放行", () => {
      const d = swarm.store.declarationForOrder(order)!;
      return d.status === "cleared" || d.status === "accepted" ? `${d.status} ${d.declarationNo}` : false;
    });
    const finalDecl = swarm.store.declarationForOrder(order)!;
    expect(finalDecl.previousIssues.length).toBeGreaterThan(0);
    expect(swarm.store.mustOrder(order).note).toMatch(/UN38\.3/);

    // 跟单：工厂排产 → 出货 → 轨迹推进到签收
    await waitFor("工厂排产", () => swarm.store.shipmentForOrder(order)?.factoryOrderNo ?? false);
    await waitFor("已发货", () => swarm.store.shipmentForOrder(order)!.trackingNo ?? false);
    tickUntil(swarm, order, "delivered");
    expect(swarm.store.mustOrder(order).status).toBe("delivered");

    // 客户会话里有发货通知与运单号
    const room = [...swarm.store.customerRooms.values()].find((r) => r.customerName === "David Miller")!;
    const hasTrackingNotice = room.messages.some(
      (m) => m.from === "sales" && m.text.includes("已发货") && m.text.includes(swarm.store.shipmentForOrder(order)!.trackingNo!),
    );
    expect(hasTrackingNotice).toBe(true);

    void decl;
    swarm.stop();
  });

  it("人工客户路径（autoCustomer 关闭）：高值键盘订单直接走查验布控支线", async () => {
    const swarm = new Swarm(testConfig(), { persistPath: null, autoCustomer: false });
    const name = "Lena Weber";
    await swarm.handleCustomerMessage({
      customerName: name,
      country: "DE",
      channel: "web",
      text: "你好，我需要 KB-220 机械键盘 120 个，目的港汉堡（DE），请报价。",
    });
    await swarm.handleCustomerMessage({
      customerName: name,
      country: "DE",
      channel: "web",
      text: "OK 确认下单，就按这个价格来。地址：Hafenstraße 1, Hamburg, DE",
    });

    const order: Order = await (async () => {
      const id = await waitFor("成单", () =>
        [...swarm.store.orders.values()].find((o) => o.customer.name === name)?.id ?? false,
      );
      return swarm.store.mustOrder(id);
    })();
    expect(order.items[0].sku).toBe("KB-220");
    expect(order.totalAmount).toBe(2706.6);

    // 非电池高值单：无需退单，直接布控查验 → 查验放行
    await waitFor("查验放行", () => {
      const d = swarm.store.declarationForOrder(order.id);
      return d?.status === "cleared" ? (d.declarationNo ?? "cleared") : false;
    });
    // 布控查验分支的持久留痕在订单时间线
    expect(order.timeline.some((t) => t.text.includes("布控查验"))).toBe(true);

    await waitFor("工厂排产", () => swarm.store.shipmentForOrder(order.id)?.factoryOrderNo ?? false);
    await waitFor("已发货", () => swarm.store.shipmentForOrder(order.id)?.trackingNo ?? false);
    tickUntil(swarm, order.id, "delivered");

    // 报关单无退单留痕（一次通过）
    expect(swarm.store.declarationForOrder(order.id)!.previousIssues).toHaveLength(0);
    swarm.stop();
  });

  it("闲聊兜底：无结构化需求的客户消息得到问候与推荐", async () => {
    const swarm = new Swarm(testConfig(), { persistPath: null, autoCustomer: false });
    await swarm.handleCustomerMessage({ customerName: "Walk-in 客户", country: "US", channel: "web", text: "hi" });
    await waitFor("销售回复", () => {
      const room = [...swarm.store.customerRooms.values()].find((r) => r.customerName === "Walk-in 客户");
      return room?.messages.some((m) => m.from === "sales" && m.text.includes("销售顾问")) ? "ok" : false;
    });
    expect(swarm.store.quotes.size).toBe(0);
    swarm.stop();
  });

  it("收尾对齐会：三岗发言 + 会议纪要归档", async () => {
    const swarm = new Swarm(testConfig(), { persistPath: null, autoCustomer: false });
    const room = await swarm.runMeeting("测试对齐", "同步状态。", "manual");
    expect(room.status).toBe("closed");
    expect(room.minutes?.replies.map((r) => r.agent).sort()).toEqual(["customs", "fulfillment", "sales"]);
    expect(room.minutes?.actionItems.length).toBeGreaterThan(0);
    expect(room.messages.length).toBeGreaterThanOrEqual(4);
    swarm.stop();
  });
});
