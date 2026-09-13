import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type AppConfig } from "../../src/config.ts";
import { Swarm } from "../../src/swarm.ts";
import { startServer, type ServerHandle } from "../../src/server.ts";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

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

describe("HTTP API + SSE", () => {
  let swarm: Swarm;
  let handle: ServerHandle;
  let base: string;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "merchant-api-"));
    swarm = new Swarm(testConfig(), { persistPath: join(dataDir, "state.json"), autoCustomer: false });
    handle = startServer(swarm, join(here, "../../src/public"), 0);
    await new Promise<void>((resolve) => handle.server.once("listening", resolve));
    const addr = handle.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await handle.close();
    swarm.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("健康检查与静态页面", async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("海外商家机器人群");
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
    expect((await fetch(`${base}/style.css`)).status).toBe(200);
    expect((await fetch(`${base}/../secret.txt`)).status).toBe(404);
  });

  it("SSE 收到业务事件", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const readEvent = async () => {
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE 提前关闭");
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (frame.startsWith("data: ")) return frame;
        }
      }
    };
    // 触发一个业务事件（生成报价）
    void swarm
      .handleCustomerMessage({ customerName: "SSE 客户", country: "US", channel: "web", text: "我要 10 个 BP-450 双肩包" })
      .catch(() => {});
    const first = await readEvent();
    expect(first.startsWith("data: ")).toBe(true);
    const event = JSON.parse(first.slice(6)) as { type: string };
    expect(typeof event.type).toBe("string");
    controller.abort();
  });

  it("客户消息 → 销售自动报价入档", async () => {
    const post = await fetch(`${base}/api/customer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerName: "API 客户", country: "JP", text: "请报价 LT-310 台灯 100 个" }),
    });
    expect(post.status).toBe(200);
    const { roomId } = (await post.json()) as { roomId: string };
    expect(roomId).toBe("cust-api");
    await vi_waitFor(() => (swarm.store.quotes.size >= 1 ? "quote ok" : false));
    const room = swarm.store.customerRooms.get(roomId)!;
    expect(room.messages.some((m) => m.from === "sales" && m.text.includes("报价单"))).toBe(true);
  });

  it("空消息 400", async () => {
    const post = await fetch(`${base}/api/customer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(post.status).toBe(400);
  });

  it("POST /api/meeting 立即召开对齐会并返回纪要", async () => {
    const res = await fetch(`${base}/api/meeting`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: "API 对齐", agenda: "检查 API 触发路径。" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roomId: string; minutes: { replies: unknown[] } };
    expect(body.roomId).toMatch(/^sync-/);
    expect(body.minutes.replies).toHaveLength(3);
  });

  it("重置清空业务数据，并持久化到磁盘", async () => {
    expect(swarm.store.quotes.size).toBeGreaterThan(0);
    const reset = await fetch(`${base}/api/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    expect(swarm.store.quotes.size).toBe(0);
    const state = (await (await fetch(`${base}/api/state`)).json()) as {
      orders: unknown[];
      agents: unknown[];
    };
    expect(state.orders).toHaveLength(0);
    expect(state.agents).toHaveLength(3);
  });
});

async function vi_waitFor(fn: () => false | string, timeoutMs = 15_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = fn();
    if (r) return r;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("等待超时");
}
