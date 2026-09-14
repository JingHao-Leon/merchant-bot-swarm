/**
 * 脚本大脑（faux 模式）：用 pi-ai 的 FauxProvider 响应工厂实现「确定性决策器」。
 * 它和真实 LLM 的行为同构：每个回合看一眼对话（上一条用户消息 / 工具结果），
 * 再决定调用哪个工具、用什么参数——只是决策完全确定，离线可跑、可回归测试。
 * 接入真实 API Key 后（AIHUBMIX/OPENAI/...），同一套系统提示词与工具直接换真模型。
 */
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { Context, Message } from "@earendil-works/pi-ai";
import type { Store } from "../store.ts";
import { findProduct } from "../catalog.ts";
import { EXPORTER } from "../customsRules.ts";
import type { AgentRole, CustomsDeclaration, Order, Quote } from "../types.ts";
import { parseTask, type AgentTask } from "./tasks.ts";

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return textOf(m.content);
  }
  return "";
}

interface LastToolResult {
  toolName: string;
  text: string;
  isError: boolean;
}

function lastToolResult(messages: Message[]): LastToolResult | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "toolResult")
      return { toolName: m.toolName, text: textOf(m.content), isError: Boolean(m.isError) };
    if (m.role === "user") break;
  }
  return null;
}

const toolMsg = (name: string, args: Record<string, unknown>): AssistantMessage =>
  fauxAssistantMessage(
    [fauxThinking(`脚本大脑：根据当前对话状态，调用 ${name}`), fauxToolCall(name, args)],
    { stopReason: "toolUse" },
  );

const doneMsg = (text = "（本轮任务完成）"): AssistantMessage =>
  fauxAssistantMessage([fauxText(text)], { stopReason: "stop" });

// ---------------- 客户意图解析（演示客户语言 → 结构化） ----------------

export interface ParsedDemand {
  sku: string;
  qty: number;
}

export function parseDemand(text: string): ParsedDemand | null {
  // 语序一：SKU 在前（如 "BH-100 蓝牙耳机 200 个"）；语序二：数量在前（如 "80 个 LT-310 台灯"）
  // (?<!\d)/(?!\d) 防止把 SKU 里的数字截断当成数量（如 "LT-310" 拆成 LT-31 + 0）
  const skuFirst = text.match(/(?<![A-Za-z0-9-])([A-Z]{2,4}-\d{2,4})(?!\d)\D{0,16}?(\d{1,5})(?!\d)\s*(?:个|件|台|只|套|pcs|PCS|units?)/i);
  const qtyFirst = text.match(/(?<![A-Za-z0-9-])(\d{1,5})(?!\d)\s*(?:个|件|台|只|套|pcs|PCS|units?)\D{0,16}?(?<![A-Za-z0-9-])([A-Z]{2,4}-\d{2,4})(?!\d)/i);
  const sku = skuFirst ? skuFirst[1] : qtyFirst?.[2];
  const qty = Number(skuFirst?.[2] ?? qtyFirst?.[1]);
  if (!sku || !findProduct(sku) || !Number.isFinite(qty) || qty <= 0) return null;
  return { sku: sku.toUpperCase(), qty };
}

export function parseAddress(text: string): string | null {
  const m = text.match(/(?:地址|address)[:：]\s*(.+)/i);
  return m ? m[1].trim() : null;
}

export function isConfirmIntent(text: string): boolean {
  return /(确认|下单|付款|可以|没问题|place the order|confirm|pay)/i.test(text);
}

export function isTrackingIntent(text: string): boolean {
  return /(物流|运单|跟踪|发货了|tracking|shipment|delivery)/i.test(text);
}

// ---------------- 报关单整理（确定性业务规则） ----------------

export function computeDeclarationPayload(order: Order): CustomsDeclaration {
  const items = order.items.map((it) => {
    const product = findProduct(it.sku);
    return {
      sku: it.sku,
      description: it.name,
      hsCode: product?.hsCode ?? "000000",
      originCountry: "CN",
      qty: it.qty,
      unitValue: it.unitPrice,
      totalValue: Math.round(it.unitPrice * it.qty * 100) / 100,
    };
  });
  const grossWeightKg =
    Math.round(order.items.reduce((s, it) => s + (findProduct(it.sku)?.weightKg ?? 0) * it.qty, 0) * 100) / 100;
  const battery = order.items.some((it) => findProduct(it.sku)?.battery);
  const hasDoc = typeof order.note === "string" && /UN38\.?3/i.test(order.note);
  return {
    orderId: order.id,
    exporterName: EXPORTER.name,
    exporterCountry: EXPORTER.country,
    consigneeName: order.customer.name,
    consigneeCountry: order.customer.country,
    destinationCountry: order.customer.country,
    incoterm: order.incoterm,
    currency: order.currency,
    declaredValue: order.totalAmount,
    grossWeightKg,
    items,
    notes: battery && hasDoc ? `UN38.3 测试摘要已随附（对应订单 ${order.id}）` : undefined,
  };
}

// ---------------- 角色大脑 ----------------

export class Director {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  /** 每个 prompt 前武装一批响应工厂；工厂按对话状态实时决策，剩余额度自动作废 */
  arm(handle: FauxProviderHandle | undefined, role: AgentRole): void {
    if (!handle) return;
    handle.setResponses(Array.from({ length: 12 }, () => this.brain(role)));
  }

  brain(role: AgentRole): FauxResponseFactory {
    switch (role) {
      case "sales":
        return (ctx) => this.salesTurn(ctx);
      case "customs":
        return (ctx) => this.customsTurn(ctx);
      case "fulfillment":
        return (ctx) => this.fulfillmentTurn(ctx);
    }
  }

  private plan(ctx: Context): { task: AgentTask | null; tool: LastToolResult | null } {
    const messages = ctx.messages;
    return { task: parseTask(lastUserText(messages)), tool: lastToolResult(messages) };
  }

  // ----- 销售岗 -----

  private salesTurn(ctx: Context): AssistantMessage {
    const { task, tool } = this.plan(ctx);

    if (tool?.isError) return doneMsg(`工具执行失败，本轮结束：${tool.text.slice(0, 200)}`);

    // 工具结果分支优先：拿到结果后决定下一步，避免重复执行同一动作
    if (tool?.toolName === "create_quote") {
      const quoteId = safeJson<{ quoteId?: string }>(tool.text)?.quoteId;
      const quote = quoteId ? this.store.quotes.get(quoteId) : undefined;
      if (!quote) return doneMsg("报价缺失，本轮结束");
      const lines = quote.lines
        .map((l) => `${l.name}（${l.sku}）× ${l.qty}：单价 $${l.unitPrice}，小计 $${l.lineTotal}`)
        .join("；");
      return toolMsg("reply_customer", {
        roomId: this.roomIdOfQuote(quote),
        text:
          `您好！根据您的需求，正式报价如下（报价单 ${quote.id}，7 天内有效）：\n${lines}\n` +
          `头程运费 $${quote.shippingUsd}（${quote.incoterm}），订单总额 $${quote.totalUsd}。\n` +
          `确认请回复"确认下单"，并附收货地址（格式：地址：...）。`,
      });
    }

    if (task?.kind === "meeting_reply") return this.meetingReply("sales", task.roomId);
    if (task?.kind === "amend_order") {
      const note = task.issues.some((i) => /UN38\.?3/i.test(i))
        ? `客户已补充提供 UN38.3 测试摘要报告（UN38.3 报告随货附送），见本单备注。`
        : `按海关意见补充材料：${task.issues.join("；")}`;
      return toolMsg("amend_order", {
        orderId: task.orderId,
        note,
        reason: `海关退单补正：${task.issues.join("；")}`,
      });
    }

    if (task?.kind === "notify_split") {
      return toolMsg("reply_customer", {
        roomId: task.roomId,
        text:
          `您好！关于订单 ${task.orderId}：您的需求量较大，工厂产能排满，为保证品质我们与工厂协调了**分批发货**方案——` +
          `第一批 ${task.firstBatchQty} 件即刻排产（工厂反馈：${task.remark}），第二批紧随其后。` +
          `第一批发货后我们会同步运单号，感谢理解与支持！`,
      });
    }

    if (task?.kind === "customer_message") {
      const room = this.store.customerRooms.get(task.roomId);
      const text = task.text;

      // 已在报价之后：客户确认 → 创建订单
      const quote = this.latestQuoteForRoom(task.roomId);
      const orderForCustomer = this.orderForCustomer(task.customerName);
      if (isConfirmIntent(text) && quote && !orderForCustomer) {
        const address = parseAddress(text) ?? `${task.customerName}, ${quote.customerCountry}`;
        return toolMsg("create_order", {
          roomId: task.roomId,
          customerName: task.customerName,
          country: quote.customerCountry,
          channel: room?.channel ?? "web",
          contact: undefined,
          items: quote.lines.map((l) => ({ sku: l.sku, qty: l.qty, unitPrice: l.unitPrice })),
          totalAmount: quote.totalUsd,
          incoterm: quote.incoterm,
          shippingAddress: address,
          note: /UN38\.?3/i.test(text) ? "客户随信提供 UN38.3 测试摘要" : undefined,
          caseId: task.caseId ?? room?.caseId,
        });
      }

      // 明确需求（sku + 数量）→ 生成报价
      const demand = parseDemand(text);
      if (demand) {
        return toolMsg("create_quote", {
          roomId: task.roomId,
          customerName: task.customerName,
          customerCountry: room?.country ?? "US",
          lines: [{ sku: demand.sku, qty: demand.qty }],
        });
      }

      // 物流查询
      if (isTrackingIntent(text)) {
        const order = orderForCustomer ?? this.latestOrder();
        const shipment = order ? this.store.shipmentForOrder(order.id) : undefined;
        const track = shipment?.trackingNo
          ? `${shipment.carrier} 运单号 ${shipment.trackingNo}，当前状态：${shipment.status}`
          : "您的订单还在备货中，发货后会第一时间同步运单号。";
        return toolMsg("reply_customer", {
          roomId: task.roomId,
          text: `您好！${order ? `订单 ${order.id} ` : ""}${track}`,
        });
      }

      // 默认：问候 + 推荐
      return toolMsg("reply_customer", {
        roomId: task.roomId,
        text:
          "您好，我是蓝鲸出海的销售顾问 Sally。我们主营消费电子与箱包类外贸直供（蓝牙耳机/移动电源/机械键盘/LED 台灯/双肩包），" +
          "支持阶梯批发价与 DHL/FedEx 头程直发。请告诉我您想要的商品和数量，我马上为您报价。",
      });
    }

    if (tool?.toolName === "create_order") {
      const parsed = safeJson<{ orderId?: string }>(tool.text);
      return doneMsg(`订单 ${parsed?.orderId ?? ""} 已创建，等待系统移交报关。`);
    }

    return doneMsg();
  }

  // ----- 报关岗 -----

  private customsTurn(ctx: Context): AssistantMessage {
    const { task, tool } = this.plan(ctx);
    if (tool?.isError) return doneMsg(`工具执行失败，本轮结束：${tool.text.slice(0, 200)}`);

    if (task?.kind === "meeting_reply") return this.meetingReply("customs", task.roomId);

    if (task?.kind === "declare_order") {
      if (!tool) return toolMsg("get_order", { orderId: task.orderId });
      if (tool.toolName === "get_order") {
        const order = safeJson<Order>(tool.text);
        if (!order) return doneMsg("订单读取失败");
        return toolMsg("submit_declaration", { declaration: computeDeclarationPayload(order) });
      }
      if (tool.toolName === "submit_declaration") {
        const result = safeJson<{ accepted: boolean; status?: string; issues?: string[]; declarationNo?: string }>(tool.text);
        if (result && !result.accepted) {
          return doneMsg(`申报被退回：${(result.issues ?? []).join("；")}。已转销售岗补正。`);
        }
        return doneMsg(`申报受理：${result?.declarationNo ?? result?.status ?? ""}`);
      }
    }

    if (task?.kind === "clear_inspection") {
      return toolMsg("clear_inspection", { declarationId: task.declarationId });
    }

    return doneMsg();
  }

  // ----- 跟单岗 -----

  private fulfillmentTurn(ctx: Context): AssistantMessage {
    const { task, tool } = this.plan(ctx);
    if (tool?.isError) return doneMsg(`工具执行失败，本轮结束：${tool.text.slice(0, 200)}`);

    if (task?.kind === "meeting_reply") return this.meetingReply("fulfillment", task.roomId);

    if (task?.kind === "fulfill_order") {
      if (!tool) return toolMsg("get_declaration", { orderId: task.orderId });
      if (tool.toolName === "get_declaration") {
        const decl = safeJson<{ orderId: string; status: string }>(tool.text);
        const order = decl ? this.store.mustOrder(decl.orderId) : undefined;
        if (!order) return doneMsg("订单不存在");
        const first = order.items[0];
        return toolMsg("factory_quote", { sku: first.sku, qty: first.qty });
      }
      if (tool.toolName === "factory_quote") {
        const q = safeJson<{ sku: string; qty: number; withinCapacity: boolean }>(tool.text);
        const task0 = task;
        if (!q) return doneMsg("询价失败");
        return toolMsg("place_factory_order", {
          orderId: task0.orderId,
          sku: q.sku,
          qty: q.qty,
          roomId: task0.groupRoomId,
        });
      }
    }

    if (task?.kind === "arrange_shipment") {
      return toolMsg("arrange_shipment", {
        orderId: task.orderId,
        carrier: task.carrier,
        roomId: task.customerRoomId,
      });
    }

    if (task?.kind === "split_order") {
      return toolMsg("place_factory_order", {
        orderId: task.orderId,
        sku: task.sku,
        qty: task.qty,
        roomId: task.groupRoomId,
      });
    }

    return doneMsg();
  }

  // ----- 对齐群汇报（三角色共用模板） -----

  private meetingReply(role: AgentRole, roomId: string): AssistantMessage {
    const k = this.store.kpis();
    let text: string;
    if (role === "sales") {
      text =
        `【销售岗】在谈客户会话 ${this.store.customerRooms.size} 个；今日成单 ${k.totalOrders} 笔、营收 $${k.totalRevenueUsd}。` +
        (k.exceptions > 0 ? ` ⚠️ 有 ${k.exceptions} 笔订单被海关/工厂退回，我正在补正材料。` : " 无积压风险。");
    } else if (role === "customs") {
      const decls = [...this.store.declarations.values()];
      const rejected = decls.filter((d) => d.status === "rejected").length;
      const inspection = decls.filter((d) => d.status === "inspection").length;
      text =
        `【报关岗】待申报 ${k.pendingDeclaration} 笔，已放行 ${k.declaredOk} 笔` +
        (inspection ? `，查验中 ${inspection} 笔` : "") +
        (rejected ? `，历史退单 ${rejected} 笔（已转销售补正后重报）` : "") +
        "。申报口径：逐行 HS + 单价与订单强一致，锂电池必附 UN38.3。";
    } else {
      const shipments = [...this.store.shipments.values()];
      const delayed = shipments.filter((s) => s.status === "delayed").length;
      text =
        `【跟单岗】在产 ${k.declaredOk} 笔，在途 ${k.inTransit} 笔，已签收 ${k.delivered} 笔` +
        (delayed ? `，⚠️ 工厂产能延误 ${delayed} 笔，需要销售与客户改期沟通` : "，工厂排产正常") +
        "。";
    }
    return toolMsg("post_group_message", { roomId, text });
  }

  // ----- 辅助查询 -----

  private latestQuoteForRoom(roomId: string): Quote | null {
    const room = this.store.customerRooms.get(roomId);
    if (!room) return null;
    const quotes = [...this.store.quotes.values()]
      .filter((q) => q.customerName === room.customerName)
      .sort((a, b) => b.createdAt - a.createdAt);
    return quotes[0] ?? null;
  }

  private roomIdOfQuote(quote: Quote): string {
    for (const room of this.store.customerRooms.values()) {
      if (room.customerName === quote.customerName) return room.id;
    }
    return `cust-${quote.customerName.toLowerCase().replace(/\s+/g, "-")}`;
  }

  private orderForCustomer(customerName: string): Order | null {
    const orders = [...this.store.orders.values()]
      .filter((o) => o.customer.name === customerName)
      .sort((a, b) => b.createdAt - a.createdAt);
    return orders[0] ?? null;
  }

  private latestOrder(): Order | null {
    const orders = [...this.store.orders.values()].sort((a, b) => b.createdAt - a.createdAt);
    return orders[0] ?? null;
  }
}

function safeJson<T>(text: string): T | null {
  try {
    const start = text.indexOf("{");
    if (start === -1) return null;
    return JSON.parse(text.slice(start)) as T;
  } catch {
    return null;
  }
}
