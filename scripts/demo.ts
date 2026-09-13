/**
 * 脚本化演示的 CLI 入口：node scripts/demo.ts
 * 业务流程本体在 src/scenario.ts（CLI 与 GUI 演示按钮共用）。
 */
import { loadConfig } from "../src/config.ts";
import { Swarm } from "../src/swarm.ts";
import { runDemoScenario } from "../src/scenario.ts";

async function main(): Promise<number> {
  const cfg = loadConfig();
  const swarm = new Swarm(cfg, { persistPath: null, autoCustomer: cfg.providerKind === "faux" });
  console.log(`模型：${swarm.llm.describe()}\n`);

  const orders = await runDemoScenario(swarm, { log: (l) => console.log(l) });

  // ---- 结果断言（演示即测试） ----
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`断言失败：${msg}`);
    console.log(`  ✓ ${msg}`);
  };
  console.log("\n───── 结果断言 ─────");
  const fresh = orders.map((o) => swarm.store.orders.get(o.id)!);
  assert(fresh.every((o) => o.status === "delivered"), `${fresh.length} 笔订单全部 delivered`);
  assert(fresh.every((o) => o.timeline.length >= 5), "订单时间线完整（≥5 条事件）");
  const decls = fresh.map((o) => swarm.store.declarationForOrder(o.id)!);
  assert(decls.every((d) => d.status === "accepted" || d.status === "cleared"), "报关单全部放行");
  assert(
    decls[0].previousIssues.some((issues) => issues.some((i) => /UN38\.?3/i.test(i))),
    "退单补正（UN38.3）留痕完整",
  );
  assert(fresh.some((o) => o.totalAmount >= 2000), "高值订单触发查验布控支线");
  const groupRooms = [...swarm.store.groupRooms.values()];
  assert(groupRooms.length >= 2, `业务对齐群 ≥ 2 场（实际 ${groupRooms.length}）`);
  assert(groupRooms.every((r) => r.minutes && r.messages.length >= 4), "每场对齐群都有议程、三岗发言与纪要");
  const agents = swarm.describeAgents();
  assert(agents.every((a) => a.stats.tasks >= 2), "三个智能体都真实执行了多轮任务");

  console.log("\n───── KPI ─────");
  const kpi = swarm.store.kpis();
  console.log(
    `订单 ${kpi.totalOrders} 笔 | 营收 $${kpi.totalRevenueUsd} | 已交付 ${kpi.delivered} | 对齐会 ${groupRooms.length} 场 | 智能体任务 ${agents.reduce(
      (s, a) => s + a.stats.tasks,
      0,
    )} 次`,
  );
  swarm.stop();
  console.log("\n🎉 演示完成：全链路（询价→报价→下单→报关→生产→发货→签收→对齐会）全部走通");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("\n💥 演示失败：", err);
    process.exit(1);
  });
