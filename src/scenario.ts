/**
 * 真实案例执行器：驱动 5 个基于真实跨境合规规则的业务案例走完（或走到定格节点）全流程。
 * 案例数据全部来自系统实际运行（事件/单证/轨迹），供 CLI 演示、GUI 演示按钮与案例库共用。
 */
import type { Swarm } from "./swarm.ts";
import { sleep } from "./util.ts";
import { caseOf } from "./cases.ts";
import type { Order } from "./types.ts";

export interface CaseRun {
  caseId: string;
  customerName: string;
  country: string;
  demand: string;
}

export const CASE_RUNS: CaseRun[] = [
  {
    caseId: "CASE-US-AUDIO",
    customerName: "David Miller",
    country: "US",
    demand: "你好，我想要 BH-100 无线蓝牙耳机 200 个，发到美国纽约，请报价。",
  },
  {
    caseId: "CASE-DE-KB",
    customerName: "Lena Weber",
    country: "DE",
    demand: "你好，我需要 KB-220 机械键盘 120 个，目的港汉堡（DE），请报价。",
  },
  {
    caseId: "CASE-JP-LAMP",
    customerName: "Ken Tanaka",
    country: "JP",
    demand: "请报 LT-310 智能 LED 台灯 80 个，运到日本东京（JP）。",
  },
  {
    caseId: "CASE-GB-BAG",
    customerName: "Oliver Grant",
    country: "GB",
    demand: "你好，我们是英国户外品牌，需要订购 3000 只 BP-450 户外双肩包，发到费利克斯托港（GB），请报最优惠价格。",
  },
  {
    caseId: "CASE-CA-KB",
    customerName: "Emily Chen",
    country: "CA",
    demand: "Hi, 请报 KB-220 机械键盘 80 套，运到加拿大多伦多（CA），新客首单先小批量试单。",
  },
];

export interface ScenarioOptions {
  tickDelayMs?: number;
  log?: (line: string) => void;
}

async function waitFor(label: string, fn: () => false | string, timeoutMs = 30_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const result = fn();
    if (result) return result;
    await sleep(40);
  }
  throw new Error(`等待超时：${label}`);
}

async function runCase(swarm: Swarm, run: CaseRun, log: (l: string) => void): Promise<Order> {
  const { caseId, name, country, demand } = { caseId: run.caseId, name: run.customerName, country: run.country, demand: run.demand };
  log(`👤 ${caseId} · 客户 ${name}（${country}）发来询盘`);
  await swarm.handleCustomerMessage({ customerName: name, country, channel: "whatsapp", caseId, text: demand });

  const orderOf = () => [...swarm.store.orders.values()].find((o) => o.customer.name === name);

  const quoteId = await waitFor(`${name} 报价`, () =>
    [...swarm.store.quotes.values()].find((q) => q.customerName === name)?.id ?? false,
  );
  log(`💬 报价完成：${quoteId}`);

  const orderId = await waitFor(`${name} 成单`, () => orderOf()?.id ?? false);
  const ord = orderOf()!;
  log(`🧾 订单成立：${orderId}（${ord.currency} ${ord.totalAmount}）`);

  await waitFor(`${name} 报关放行`, () => {
    const d = swarm.store.declarationForOrder(ord.id);
    return d && (d.status === "accepted" || d.status === "cleared")
      ? `${d.id} / ${d.declarationNo ?? d.status}`
      : false;
  });
  log(`🛃 报关放行：${swarm.store.declarationForOrder(ord.id)!.declarationNo}`);

  await waitFor(`${name} 工厂排产`, () => swarm.store.shipmentForOrder(ord.id)?.factoryOrderNo ?? false);
  log(`🏭 工厂排产：${swarm.store.shipmentForOrder(ord.id)!.factoryOrderNo}`);

  await waitFor(`${name} 发货`, () => swarm.store.shipmentForOrder(ord.id)?.trackingNo ?? false);
  const ship = swarm.store.shipmentForOrder(ord.id)!;
  log(`📦 已发货：${ship.carrier} ${ship.trackingNo}${caseOf(caseId)?.freezeInTransit ? "（案例定格：在途跟踪）" : ""}`);
  return ord;
}

/**
 * 跑全部案例：4 个案例推到签收闭环，1 个（加拿大新客）定格在在途。
 * 返回订单列表（按案例顺序）。
 */
export async function runDemoScenario(swarm: Swarm, options: ScenarioOptions = {}): Promise<Order[]> {
  const log = options.log ?? ((l: string) => console.log(l));
  const orders: Order[] = [];
  for (const run of CASE_RUNS) {
    orders.push(await runCase(swarm, run, log));
  }

  log("🚚 推进物流轨迹…");
  const frozenOrderIds = new Set(orders.filter((o) => caseOf(o.caseId)?.freezeInTransit).map((o) => o.id));
  const tickTargets = orders.filter((o) => !frozenOrderIds.has(o.id)).map((o) => o.id);
  for (let i = 0; i < 400; i++) {
    swarm.tickCarrier(tickTargets);
    const pending = tickTargets.filter((id) => swarm.store.shipmentForOrder(id)!.status !== "delivered");
    if (pending.length === 0) break;
    await sleep(options.tickDelayMs ?? 25);
  }
  for (const o of orders) {
    if (caseOf(o.caseId)?.freezeInTransit) continue;
    await waitFor(`${o.id} 签收`, () =>
      swarm.store.shipmentForOrder(o.id)!.status === "delivered" ? "已签收" : false,
    );
  }
  log("✅ 闭环案例全部签收（在途案例按设定定格）");

  const room = await swarm.runMeeting("日结对齐", "五个案例日结：同步成单、报关、在途与风险。", "manual");
  log(`👥 业务对齐小群「${room.topic}」完成，纪要已归档`);
  return orders;
}
