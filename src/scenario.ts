/**
 * 自动演示场景：三位海外客户依次走完 询价→报价→下单→报关→生产→发货→签收 全流程。
 * 供 `npm run demo`（CLI）与 GUI 的「开始自动演示」按钮共用。
 * 覆盖业务支线：UN38.3 退单补正、高值查验布控、工厂排产、头程物流轨迹、业务对齐小群。
 */
import type { Swarm } from "./swarm.ts";
import { sleep } from "./util.ts";
import type { Order } from "./types.ts";

export interface ScenarioOptions {
  tickDelayMs?: number;
  log?: (line: string) => void;
}

const STORIES: { name: string; country: string; demand: string }[] = [
  { name: "David Miller", country: "US", demand: "你好，我想要 BH-100 无线蓝牙耳机 200 个，发到美国纽约，请报价。" },
  { name: "Lena Weber", country: "DE", demand: "你好，我需要 KB-220 机械键盘 120 个，目的港汉堡（DE），请报价。" },
  { name: "Ken Tanaka", country: "JP", demand: "请报 LT-310 智能 LED 台灯 80 个，运到日本东京（JP）。" },
];

async function waitFor(label: string, fn: () => false | string, timeoutMs = 30_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const result = fn();
    if (result) return result;
    await sleep(40);
  }
  throw new Error(`等待超时：${label}`);
}

async function runStory(swarm: Swarm, story: (typeof STORIES)[number], log: (l: string) => void): Promise<Order> {
  const { name, country, demand } = story;
  log(`👤 客户 ${name}（${country}）发来询盘`);
  await swarm.handleCustomerMessage({ customerName: name, country, channel: "whatsapp", text: demand });

  const orderOf = () => [...swarm.store.orders.values()].find((o) => o.customer.name === name);

  const quoteId = await waitFor(`${name} 报价`, () =>
    [...swarm.store.quotes.values()].find((q) => q.customerName === name)?.id ?? false,
  );
  log(`💬 销售完成报价：${quoteId}`);

  const order = await waitFor(`${name} 成单`, () => {
    const o = orderOf();
    return o ? o.id : false;
  });
  const ord = orderOf()!;
  log(`🧾 订单成立：${order}（${ord.currency} ${ord.totalAmount}）`);

  await waitFor(`${name} 报关放行`, () => {
    const d = swarm.store.declarationForOrder(ord.id);
    return d && (d.status === "accepted" || d.status === "cleared")
      ? `${d.id} / ${d.declarationNo ?? d.status}`
      : false;
  });
  log(`🛃 报关放行：${swarm.store.declarationForOrder(ord.id)!.declarationNo}`);

  await waitFor(`${name} 工厂排产`, () => swarm.store.shipmentForOrder(ord.id)?.factoryOrderNo ?? false);
  log(`🏭 工厂排产：${swarm.store.shipmentForOrder(ord.id)!.factoryOrderNo}`);

  await waitFor(`${name} 发货`, () => swarm.store.shipmentForOrder(ord.id)!.trackingNo ?? false);
  const ship = swarm.store.shipmentForOrder(ord.id)!;
  log(`📦 已发货：${ship.carrier} ${ship.trackingNo}`);
  return ord;
}

/** 跑完整演示，返回成单列表 */
export async function runDemoScenario(swarm: Swarm, options: ScenarioOptions = {}): Promise<Order[]> {
  const log = options.log ?? ((l: string) => console.log(l));
  const orders: Order[] = [];
  for (const story of STORIES) {
    orders.push(await runStory(swarm, story, log));
  }

  log("🚚 推进物流轨迹…");
  for (let i = 0; i < 300; i++) {
    swarm.tickCarrier();
    const shipments = [...swarm.store.shipments.values()];
    if (shipments.length > 0 && shipments.every((s) => s.status === "delivered")) break;
    await sleep(options.tickDelayMs ?? 25);
  }
  for (const o of orders) {
    await waitFor(`${o.id} 签收`, () =>
      swarm.store.shipmentForOrder(o.id)!.status === "delivered" ? "已签收" : false,
    );
  }
  log("✅ 全部运单已签收");

  const room = await swarm.runMeeting("日结对齐", "三笔订单日结：同步成单、报关、在途与风险。", "manual");
  log(`👥 业务对齐小群「${room.topic}」完成，纪要已归档`);
  return orders;
}
