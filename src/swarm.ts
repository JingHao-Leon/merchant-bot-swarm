/**
 * Swarm 编排器：装配三个业务智能体，驱动全链路业务流。
 *
 * 联动拓扑（全部通过工具副作用产生的事件推进，无轮询、无硬编码调用链）：
 *   客户消息 → 销售岗(报价/下单) ──order.created──→ 报关岗(结构化申报)
 *   退单 → 销售岗补正(amend) ──order.amended──→ 报关岗重报
 *   高值布控 → 报关岗查验放行 ──declaration.accepted──→ 跟单岗(工厂生产单→头程出货)
 *   工厂拒单/海关退单 → 自动拉「业务对齐小群」三岗对齐
 */
import type { AppConfig } from "./config.ts";
import { createLlmRegistry, type LlmRegistry } from "./llm.ts";
import { Store } from "./store.ts";
import { Director } from "./agents/director.ts";
import { createBusinessAgent, type BusinessAgent } from "./agents/base.ts";
import { customsTools, fulfillmentTools, groupToolsFor, salesTools, type ToolDeps } from "./agents/tools.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { renderTask, type AgentTask } from "./agents/tasks.ts";
import { factoryQuote, nextTrackStep } from "./factoryService.ts";
import { caseOf } from "./cases.ts";
import type { AgentRole, BusEvent, GroupRoom } from "./types.ts";
import { seedSeq } from "./util.ts";

export const ROLE_NAMES: Record<AgentRole, string> = {
  sales: "Sally · 销售顾问",
  customs: "Leo · 报关专员",
  fulfillment: "Max · 跟单师",
};

const ROLES: AgentRole[] = ["sales", "customs", "fulfillment"];

const SYSTEM_PROMPTS: Record<AgentRole, string> = {
  sales: `你是海外商家机器人群的销售顾问 Sally，负责联系客户并促成订单。
职责：接待询价 → 用 search_catalog 查商品 → 用 create_quote 出正式报价 → 用 reply_customer 回复客户 →
客户确认价格并给出地址后用 create_order 创建订单（视为已收款）→ 海关/工厂退回时用 amend_order 修订订单。
规则：
1. 一次只调用一个动作工具，拿到结果后如需继续由系统推进；
2. 报价必须基于目录阶梯价，不虚报、不私下折扣；
3. 回复客户要一次给全信息（明细/运费/总额/有效期/下一步）；
4. 订单信息（SKU/数量/单价/目的国）是报关依据，必须与报价一致。`,
  customs: `你是海外商家机器人群的报关专员 Leo，负责把订单整理成结构化报关单并向海关申报。
职责：【报关任务】到达后先用 get_order 读取订单，再整理报关单并调用 submit_declaration 提交；
被布控查验时按提示调用 clear_inspection；退单时用 request_order_fix 通知销售岗补正。
申报口径（必须逐条满足，否则会被海关退单）：
1. 逐行 HS 编码（6-10 位数字，与商品品类匹配）、数量、单价与订单完全一致；
2. 申报总值 = 订单应收，币种、运抵国、贸易术语与订单一致；
3. 毛重与目录推算偏差 ≤ 15%；
4. 含锂电池货物必须在 notes 注明 UN38.3 测试摘要（订单备注里有 UN38.3 才视为客户已提供）；
5. 申报总值 ≥ 2000 USD 会被布控查验，属正常流程。`,
  fulfillment: `你是海外商家机器人群的跟单师 Max，负责联系工厂生产并安排出货。
职责：【出货任务】到达后先 get_declaration 确认海关放行，再 factory_quote 询产能，然后 place_factory_order 下生产单；
工厂排产后按【发货任务】调用 arrange_shipment（生成运单号并通知客户）。
规则：
1. 未放行的订单绝不能安排出运；
2. 工厂产能不足会拒单，此时订单转异常，必须在对齐群里升级协调；
3. 出货后同步客户运单号与预计时效。`,
};

export interface SwarmOptions {
  persistPath?: string | null;
  autoCustomer?: boolean;
  carrierTickMs?: number;
  meetingIntervalMs?: number;
}

export class Swarm {
  readonly store: Store;
  readonly llm: LlmRegistry;
  readonly director: Director;
  readonly agents: Record<AgentRole, BusinessAgent>;
  autoCustomer: boolean;

  private timers: NodeJS.Timeout[] = [];
  private customerTimers = new Map<string, NodeJS.Timeout>();
  /** 每单重报熔断计数：超过上限停止自动重试，转人工/对齐群协调 */
  private declareAttempts = new Map<string, number>();

  readonly cfg: AppConfig;
  constructor(cfg: AppConfig, options: SwarmOptions = {}) {
    this.cfg = cfg;
    this.store = new Store({ persistPath: options.persistPath ?? null });
    this.llm = createLlmRegistry(cfg);
    this.director = new Director(this.store);
    this.autoCustomer = options.autoCustomer ?? cfg.providerKind === "faux";

    seedSeq(1000);
    this.agents = {
      sales: this.makeAgent("sales", salesTools),
      customs: this.makeAgent("customs", customsTools),
      fulfillment: this.makeAgent("fulfillment", fulfillmentTools),
    };

    // 自动客户（演示模式）：销售回复后推进客户话术
    this.store.bus.subscribe((payload) => this.onStoreEvent(payload as BusEvent));
  }

  private makeAgent(role: AgentRole, tools: (deps: ToolDeps) => AgentTool[]): BusinessAgent {
    const llm = this.llm.llmByRole(role);
    return createBusinessAgent({
      role,
      name: ROLE_NAMES[role],
      systemPrompt: SYSTEM_PROMPTS[role],
      tools: [...tools({ store: this.store, notify: this.notify }), ...groupToolsFor(role, { store: this.store, notify: this.notify })],
      llm,
      sessionId: `merchant-${role}`,
    });
  }

  /** 工具副作用 → 下一环节派发（业务流的中枢） */
  notify = (event: string, data: Record<string, unknown>): void => {
    switch (event) {
      case "order.created": {
        this.submit("customs", { kind: "declare_order", orderId: String(data.orderId) });
        break;
      }
      case "declaration.rejected": {
        const orderId = String(data.orderId);
        const attempts = (this.declareAttempts.get(orderId) ?? 0) + 1;
        this.declareAttempts.set(orderId, attempts);
        if (attempts > 3) {
          this.store.postCustomerMessage(this.latestCustomerRoomId(orderId) ?? "", "system", `订单 ${orderId} 多次报关退回，已转人工协调。`, orderId).text = `订单 ${orderId} 多次报关退回，已转人工协调。`;
          break;
        }
        void this.runMeeting(
          `订单 ${orderId} 海关退单协调`,
          `订单 ${orderId} 申报被退回（${(data.issues as string[]).join("；")}），请销售岗立即补正、报关岗复核口径。`,
          "event",
        );
        this.submit("sales", { kind: "amend_order", orderId, issues: data.issues as string[] });
        break;
      }
      case "declaration.inspection": {
        this.submit("customs", {
          kind: "clear_inspection",
          orderId: String(data.orderId),
          declarationId: String(data.declarationId),
        });
        break;
      }
      case "order.amended": {
        const decl = this.store.declarationForOrder(String(data.orderId));
        this.submit("customs", {
          kind: "declare_order",
          orderId: String(data.orderId),
          retryOf: decl?.id,
        });
        break;
      }
      case "declaration.accepted": {
        const orderId = String(data.orderId);
        const declarationNo = String(data.declarationNo ?? "-");
        this.submit("fulfillment", {
          kind: "fulfill_order",
          orderId,
          declarationNo,
          customerRoomId: this.latestCustomerRoomId(orderId),
        });
        break;
      }
      case "factory.order_placed": {
        if (data.accepted) {
          const orderId = String(data.orderId);
          this.submit("fulfillment", {
            kind: "arrange_shipment",
            orderId,
            carrier: "DHL",
            customerRoomId: this.latestCustomerRoomId(orderId),
          });
        }
        break;
      }
      case "factory.rejected": {
        const orderId = String(data.orderId);
        const order = this.store.mustOrder(orderId);
        const item = order.items[0];
        const remark = String(data.remark ?? "");
        // 分批方案：第一批 = min(需求, 工厂 4 天产能)（真实大宗贸易常见的分批交货安排）
        const firstBatch = Math.min(item.qty, factoryQuote(item.sku, item.qty).capacityPerDay * 4);
        void this.runMeeting(
          `订单 ${orderId} 工厂产能告警`,
          `工厂拒单（${remark}），对齐结论：按第一批 ${firstBatch} 件分批交货，销售同步客户。`,
          "event",
        );
        this.submit("sales", {
          kind: "notify_split",
          orderId,
          roomId: this.latestCustomerRoomId(orderId) ?? "",
          firstBatchQty: firstBatch,
          remark: remark,
        });
        this.submit("fulfillment", {
          kind: "split_order",
          orderId,
          sku: item.sku,
          qty: firstBatch,
        });
        break;
      }
      default:
        break;
    }
  };

  private latestCustomerRoomId(orderId: string): string | undefined {
    const order = this.store.orders.get(orderId);
    if (!order) return undefined;
    for (const room of this.store.customerRooms.values()) {
      if (room.customerName === order.customer.name) return room.id;
    }
    return undefined;
  }

  /** 提交任务给某个岗位（faux 模式先武装脚本大脑），串行执行 */
  submit(role: AgentRole, task: AgentTask): Promise<void> {
    const ba = this.agents[role];
    const llm = this.llm.llmByRole(role);
    this.director.arm(llm.faux, role);
    ba.log(`📋 ${task.kind}`);
    return ba.enqueue(async () => {
      try {
        await ba.agent.prompt(renderTask(task));
      } catch (err) {
        ba.stats.errors += 1;
        ba.log(`⚠️ 任务失败：${(err as Error).message}`);
        console.error(`[${role}] task failed:`, err);
      }
    });
  }

  /** GUI/演示入口：客户发来一条消息 */
  async handleCustomerMessage(input: { customerName: string; country?: string; channel?: string; caseId?: string; text: string }): Promise<string> {
    const room = this.store.getOrCreateCustomerRoom(
      input.customerName,
      input.country ?? "US",
      input.channel ?? "whatsapp",
      input.caseId,
    );
    this.store.postCustomerMessage(room.id, "customer", input.text);
    await this.submit("sales", {
      kind: "customer_message",
      roomId: room.id,
      customerName: input.customerName,
      caseId: room.caseId,
      text: input.text,
    });
    return room.id;
  }

  // ---------------- 业务对齐小群 ----------------

  openMeeting(topic: string, agenda: string, trigger: GroupRoom["trigger"]): GroupRoom {
    return this.store.openGroupRoom(topic, agenda, ROLES, trigger);
  }

  /** 开一场对齐会：主持人发议程 → 三岗依次发言 → 生成会议纪要并关群 */
  async runMeeting(topic: string, agenda: string, trigger: GroupRoom["trigger"]): Promise<GroupRoom> {
    const room = this.openMeeting(topic, agenda, trigger);
    this.store.postGroupMessage(room.id, "coordinator", `【议程】${agenda}\n请各岗依次汇报状态、风险与需要的配合。`);
    for (const role of ROLES) {
      await this.submit(role, { kind: "meeting_reply", roomId: room.id, agenda, role });
    }
    const replies = room.messages
      .filter((m) => (ROLES as string[]).includes(m.from))
      .map((m) => ({ agent: m.from as AgentRole, text: m.text }));
    const k = this.store.kpis();
    const actionItems: string[] = [];
    for (const order of this.store.orders.values()) {
      if (order.status === "exception") actionItems.push(`订单 ${order.id} 处于异常，责任岗请跟进闭环`);
    }
    for (const s of this.store.shipments.values()) {
      if (s.status === "delayed") actionItems.push(`运单 ${s.id} 工厂延误，需要与客户沟通改期`);
    }
    if (actionItems.length === 0) actionItems.push("各环节正常，本周无待办风险项");
    this.store.closeGroupRoom(room.id, {
      summary: `三岗对齐完成：订单 ${k.totalOrders} 笔、营收 $${k.totalRevenueUsd}、待报关 ${k.pendingDeclaration}、在途 ${k.inTransit}、异常 ${k.exceptions}。`,
      replies,
      actionItems,
    });
    return room;
  }

  // ---------------- 承运商轨迹推进 ----------------

  /** 推进物流轨迹；传入 onlyOrderIds 时只推进这些订单的运单；定格案例（freezeInTransit）始终跳过 */
  tickCarrier(onlyOrderIds?: string[]): void {
    for (const shipment of this.store.shipments.values()) {
      if (onlyOrderIds && !onlyOrderIds.includes(shipment.orderId)) continue;
      const order = this.store.orders.get(shipment.orderId);
      if (order?.caseId && caseOf(order.caseId)?.freezeInTransit) continue;
      const last = shipment.events[shipment.events.length - 1];
      if (!last) continue;
      if (["arranging", "factory_confirmed", "delayed", "delivered"].includes(last.status)) continue;
      const step = nextTrackStep(shipment);
      if (!step) continue;
      this.store.setShipmentStatus(shipment.id, step.status, `${step.text}（${step.location}）`);
    }
  }

  // ---------------- 自动客户（演示用） ----------------

  private onStoreEvent(event: BusEvent): void {
    if (!this.autoCustomer) return;
    if (event.type === "agent.customer_reply") {
      const roomId = String(event.data?.roomId ?? "");
      this.scheduleCustomerFollowUp(roomId);
    }
  }

  /** 根据会话当前阶段，延迟推进下一句客户话术（自动客户状态机） */
  private scheduleCustomerFollowUp(roomId: string): void {
    const room = this.store.customerRooms.get(roomId);
    if (!room) return;
    const existing = this.customerTimers.get(roomId);
    if (existing) clearTimeout(existing);
    const lastSales = [...room.messages].reverse().find((m) => m.from === "sales");
    const customerConfirmed = room.messages.some((m) => m.from === "customer" && isConfirm(m.text));
    const orderCreated = room.messages.some((m) => m.from === "system" && m.text.includes("已创建"));

    let next: string | null = null;
    if (orderCreated) {
      if (!room.messages.some((m) => m.from === "customer" && /收到|thank/i.test(m.text))) {
        next = "收到，谢谢！请发货后把运单号发我。";
      }
    } else if (lastSales && /报价单/.test(lastSales.text)) {
      if (!customerConfirmed) {
        next = `OK 确认下单，就按这个价格来。地址：285 Fulton St, New York, NY 10007, US`;
      }
    } else if (lastSales) {
      const name = room.customerName;
      const demand = DEMAND_SCRIPT[name];
      if (demand && !room.messages.some((m) => m.from === "customer" && parseDemandSafe(m.text))) {
        next = demand;
      }
    }
    if (!next) return;
    const timer = setTimeout(() => {
      this.customerTimers.delete(roomId);
      void this.handleCustomerMessage({
        customerName: room.customerName,
        country: room.country,
        channel: room.channel,
        text: next,
      });
    }, 350);
    this.customerTimers.set(roomId, timer);
  }

  // ---------------- 生命周期 ----------------

  startTimers(): void {
    if (this.cfg.carrierTickMs > 0) {
      this.timers.push(setInterval(() => this.tickCarrier(), this.cfg.carrierTickMs));
    }
    if (this.cfg.meetingIntervalMs > 0) {
      this.timers.push(
        setInterval(() => {
          void this.runMeeting("例行业务对齐", "例行对齐：同步今日成单、报关、在途与风险。", "scheduled");
        }, this.cfg.meetingIntervalMs),
      );
    }
  }

  /** 重置全部业务状态（不含智能体对话上下文，那属于模型会话） */
  reset(): void {
    this.declareAttempts.clear();
    this.store.reset();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    for (const t of this.customerTimers.values()) clearTimeout(t);
    this.timers = [];
    this.customerTimers.clear();
  }

  describeAgents() {
    return ROLES.map((role) => {
      const ba = this.agents[role];
      return {
        role,
        name: ba.name,
        busy: ba.busy,
        stats: ba.stats,
        activity: ba.activity,
        model: this.llm.llmByRole(role).label,
      };
    });
  }

}

const DEMAND_SCRIPT: Record<string, string> = {
  "David Miller": "我想要 BH-100 无线蓝牙耳机 200 个，发到美国纽约，请报价。",
  "Lena Weber": "你好，我需要 KB-220 机械键盘 120 个，目的港汉堡（DE），请报价。",
  "Ken Tanaka": "请报 LT-310 智能 LED 台灯 80 个，运到日本东京（JP）。",
};

function isConfirm(text: string): boolean {
  return /(确认下单|place the order|确认，|OK 确认)/i.test(text);
}

function parseDemandSafe(text: string): boolean {
  return /([A-Z]{2,4}-\d{2,4})/.test(text) && /\d{1,5}\s*(个|件|台|只|pcs)/i.test(text);
}

