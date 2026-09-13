/**
 * 服务入口：node src/main.ts
 * 环境变量见 src/config.ts（默认 faux 离线模式，端口 8787）。
 */
import { loadConfig, describeProvider } from "./config.ts";
import { Swarm } from "./swarm.ts";
import { startServer } from "./server.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");

async function main(): Promise<void> {
  const cfg = loadConfig();
  const swarm = new Swarm(cfg, {
    persistPath: join(process.cwd(), cfg.dataDir, "state.json"),
    autoCustomer: cfg.providerKind === "faux",
  });
  swarm.startTimers();
  const handle = startServer(swarm, publicDir, cfg.port);

  console.log(`
╔══════════════════════════════════════════════════════════╗
║   海外商家机器人群 · Merchant Bot Swarm                     ║
║   销售出单 ⇄ 海关报关 ⇄ 工厂出货 · 三智能体协作             ║
╟──────────────────────────────────────────────────────────╢
║   仪表盘   http://localhost:${String(handle.port).padEnd(28)}║
║   模型     ${describeProvider(cfg).padEnd(44)}║
║   定时对齐会 ${cfg.meetingIntervalMs > 0 ? `每 ${Math.round(cfg.meetingIntervalMs / 1000)} 秒` : "已关闭（保留事件触发）".padEnd(20)}                       ║
╚══════════════════════════════════════════════════════════╝
  打开仪表盘后点「开始自动演示」即可观看全流程。
`);
}

main().catch((err) => {
  console.error("启动失败：", err);
  process.exit(1);
});
