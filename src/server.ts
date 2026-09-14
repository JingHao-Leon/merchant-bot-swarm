/**
 * HTTP 服务：静态 GUI + REST API + SSE 实时事件流。
 * 路由一览：
 *   GET  /                    仪表盘页面
 *   GET  /api/state           全量业务快照（订单/报关/运单/会话/对齐群/KPI/智能体状态）
 *   GET  /api/events          SSE 事件流（所有业务事件实时推送）
 *   POST /api/customer        模拟客户发言 {customerName?, country?, text}
 *   POST /api/demo            启动自动演示场景
 *   POST /api/meeting         立即召开业务对齐会 {topic?, agenda?}
 *   POST /api/reset           清空业务数据
 *   GET  /healthz             健康检查
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { Swarm } from "./swarm.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

export interface ServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export function startServer(swarm: Swarm, publicDir: string, port: number): ServerHandle {
  const sseClients = new Set<ServerResponse>();
  let demoRunning = false;

  const unsubscribe = swarm.store.bus.subscribe((payload) => {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      res.write(data);
    }
  });

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1_000_000) throw new Error("请求体过大");
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf-8");
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/healthz") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && path === "/api/state") {
      const { CASES } = await import("./cases.ts");
      return json(res, 200, {
        ...swarm.store.snapshot(),
        cases: CASES,
        agents: swarm.describeAgents(),
        provider: swarm.llm.describe(),
        autoCustomer: swarm.autoCustomer,
        demoRunning,
      });
    }

    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":ok\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (req.method === "POST" && path === "/api/customer") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text 不能为空" });
      const customerName = String(body.customerName ?? "David Miller");
      const roomId = await swarm.handleCustomerMessage({
        customerName,
        country: body.country ? String(body.country) : undefined,
        channel: "web",
        text,
      });
      return json(res, 200, { roomId });
    }

    if (req.method === "POST" && path === "/api/demo") {
      if (demoRunning) return json(res, 409, { error: "演示进行中" });
      demoRunning = true;
      const log = (line: string) => swarm.store.bus.emit({ type: "demo.log", data: { line }, ts: Date.now() });
      void (async () => {
        try {
          const { runDemoScenario } = await import("./scenario.ts");
          await runDemoScenario(swarm, { log, tickDelayMs: 25 });
          log("🎉 演示完成");
        } catch (err) {
          log(`💥 演示失败：${(err as Error).message}`);
        } finally {
          demoRunning = false;
        }
      })();
      return json(res, 200, { started: true });
    }

    if (req.method === "POST" && path === "/api/meeting") {
      const body = await readBody(req);
      const room = await swarm.runMeeting(
        String(body.topic ?? "即时业务对齐"),
        String(body.agenda ?? "同步当前成单、报关、在途与风险，问题现场对齐。"),
        "manual",
      );
      return json(res, 200, { roomId: room.id, minutes: room.minutes });
    }

    if (req.method === "POST" && path === "/api/reset") {
      if (demoRunning) return json(res, 409, { error: "演示进行中，稍后再重置" });
      swarm.reset();
      return json(res, 200, { ok: true });
    }

    // 静态文件
    if (req.method === "GET") {
      const safePath = normalize(path).replace(/^(\.\.[/\\])+/, "");
      const filePath = join(publicDir, safePath === "/" || safePath === "\\" ? "index.html" : safePath);
      if (!filePath.startsWith(publicDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      try {
        const content = await readFile(filePath);
        res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
        res.end(content);
        return;
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
        return;
      }
    }

    res.writeHead(405);
    res.end("Method Not Allowed");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error("[server]", err);
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
      else res.end();
    });
  });

  server.listen(port);
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        unsubscribe();
        for (const res of sseClients) res.end();
        sseClients.clear();
        server.close(() => resolve());
      }),
  };
}
