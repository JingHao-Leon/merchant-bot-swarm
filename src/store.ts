/**
 * 业务状态仓库：订单 / 报关单 / 运单 / 报价 / 会话 / 对齐群，统一从这里读写。
 * - 所有变更走 store 方法，自动写时间线、发总线事件、异步持久化 JSON。
 * - 事件是智能体联动与 GUI 实时刷新的唯一事实来源。
 */
import type {
  AgentRole,
  BusEvent,
  BusListener,
  ChatMessage,
  CustomerRoom,
  CustomsDeclaration,
  Declaration,
  FactoryMessage,
  GroupRoom,
  KpiSnapshot,
  MeetingMinutes,
  Order,
  OrderStatus,
  Quote,
  Shipment,
  ShipmentStatus,
  TimelineEntry,
} from "./types.ts";
import { EventBus, nextSeq, slugify } from "./util.ts";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StoreOptions {
  persistPath?: string | null; // null = 纯内存（测试默认）
  onEvent?: BusListener;
}

export class Store {
  bus = new EventBus();

  orders = new Map<string, Order>();
  declarations = new Map<string, Declaration>(); // key: declaration.id
  shipments = new Map<string, Shipment>(); // key: shipment.id
  quotes = new Map<string, Quote>();
  customerRooms = new Map<string, CustomerRoom>(); // key: room.id
  groupRooms = new Map<string, GroupRoom>();

  private persistPath: string | null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(options: StoreOptions = {}) {
    this.persistPath = options.persistPath ?? null;
    if (options.onEvent) this.bus.subscribe((payload) => options.onEvent?.(payload as BusEvent));
  }

  emit(type: string, data: Omit<BusEvent, "type" | "ts"> = {}): void {
    this.bus.emit({ type, orderId: data.orderId, data: data.data, ts: Date.now() });
    this.scheduleSave();
  }

  // ---------------- 会话 ----------------

  getOrCreateCustomerRoom(customerName: string, country: string, channel: string): CustomerRoom {
    const id = `cust-${slugify(customerName)}`;
    let room = this.customerRooms.get(id);
    if (!room) {
      room = { id, customerName, country, channel, messages: [], createdAt: Date.now() };
      this.customerRooms.set(id, room);
    }
    return room;
  }

  postCustomerMessage(roomId: string, from: ChatMessage["from"], text: string, orderId?: string): ChatMessage {
    const room = this.customerRooms.get(roomId);
    if (!room) throw new Error(`会话不存在：${roomId}`);
    const msg: ChatMessage = { from, text, ts: Date.now(), orderId };
    room.messages.push(msg);
    this.emit(from === "sales" ? "agent.customer_reply" : "customer.message", {
      data: { roomId, from, text },
    });
    return msg;
  }

  // ---------------- 报价 / 订单 ----------------

  saveQuote(quote: Quote): void {
    this.quotes.set(quote.id, quote);
    this.emit("quote.created", { data: { quoteId: quote.id } });
  }

  createOrder(input: {
    customerName: string;
    country: string;
    channel: string;
    contact?: string;
    items: Order["items"];
    currency: string;
    totalAmount: number;
    incoterm: string;
    shippingAddress: string;
    note?: string;
    roomId: string;
  }): Order {
    const now = Date.now();
    const order: Order = {
      id: `ORD-${nextSeq()}`,
      customer: {
        name: input.customerName,
        country: input.country,
        channel: input.channel,
        contact: input.contact,
      },
      items: input.items,
      currency: input.currency,
      totalAmount: input.totalAmount,
      incoterm: input.incoterm,
      shippingAddress: input.shippingAddress,
      note: input.note,
      status: "confirmed",
      timeline: [{ ts: now, event: "confirmed", text: `订单成立，应收 ${input.currency} ${input.totalAmount}` }],
      createdAt: now,
      updatedAt: now,
    };
    this.orders.set(order.id, order);
    this.postCustomerMessage(input.roomId, "system", `订单 ${order.id} 已创建并确认收款。`, order.id);
    this.emit("order.created", { orderId: order.id, data: { total: order.totalAmount } });
    return order;
  }

  updateOrderStatus(orderId: string, status: OrderStatus, text: string): Order {
    const order = this.mustOrder(orderId);
    const entry: TimelineEntry = { ts: Date.now(), event: status, text };
    order.status = status;
    order.timeline.push(entry);
    order.updatedAt = Date.now();
    this.emit(`order.${status === "exception" ? "exception" : status}`, { orderId });
    return order;
  }

  amendOrder(orderId: string, patch: Partial<Pick<Order, "note" | "shippingAddress" | "totalAmount" | "incoterm">>, text: string): Order {
    const order = this.mustOrder(orderId);
    // 只覆盖显式提供的字段；备注采用追加语义，避免补正时冲掉既有单证信息
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (key === "note") {
        order.note = order.note ? `${order.note}；补充：${value as string}` : (value as string);
      } else if (key === "shippingAddress") {
        order.shippingAddress = value as string;
      } else if (key === "incoterm") {
        order.incoterm = value as string;
      } else if (key === "totalAmount") {
        order.totalAmount = value as number;
      }
    }
    order.updatedAt = Date.now();
    order.timeline.push({ ts: Date.now(), event: "amended", text });
    this.emit("order.amended", { orderId });
    return order;
  }

  mustOrder(orderId: string): Order {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`订单不存在：${orderId}`);
    return order;
  }

  // ---------------- 报关 ----------------

  upsertDeclaration(payload: CustomsDeclaration): Declaration {
    const existing = [...this.declarations.values()].find((d) => d.orderId === payload.orderId);
    const now = Date.now();
    if (existing) {
      existing.payload = { ...payload, declarationId: existing.id };
      if (existing.status === "rejected" && existing.issues.length > 0) {
        existing.previousIssues.push(existing.issues);
      }
      existing.status = "draft";
      existing.issues = [];
      existing.updatedAt = now;
      return existing;
    }
    const decl: Declaration = {
      id: `DEC-${nextSeq()}`,
      orderId: payload.orderId,
      status: "draft",
      payload: { ...payload, declarationId: undefined },
      issues: [],
      previousIssues: [],
      createdAt: now,
      updatedAt: now,
    };
    decl.payload.declarationId = decl.id;
    this.declarations.set(decl.id, decl);
    return decl;
  }

  markDeclaration(declId: string, patch: Partial<Pick<Declaration, "status" | "issues" | "declarationNo">>): Declaration {
    const decl = this.declarations.get(declId);
    if (!decl) throw new Error(`报关单不存在：${declId}`);
    Object.assign(decl, patch);
    decl.updatedAt = Date.now();
    const orderId = decl.orderId;
    if (patch.status === "accepted" || patch.status === "cleared") {
      this.emit("declaration.accepted", { orderId, data: { declarationNo: decl.declarationNo } });
    } else if (patch.status === "rejected") {
      this.emit("declaration.rejected", { orderId, data: { issues: decl.issues } });
    } else if (patch.status === "inspection") {
      this.emit("declaration.inspection", { orderId });
    }
    return decl;
  }

  declarationForOrder(orderId: string): Declaration | undefined {
    return [...this.declarations.values()].find((d) => d.orderId === orderId);
  }

  // ---------------- 发货 ----------------

  createShipment(orderId: string, factoryId: string): Shipment {
    const now = Date.now();
    const shipment: Shipment = {
      id: `SHP-${nextSeq()}`,
      orderId,
      status: "arranging",
      factoryId,
      events: [{ ts: now, status: "arranging", text: "已向工厂下达生产单" }],
      factoryChat: [],
      createdAt: now,
      updatedAt: now,
    };
    this.shipments.set(shipment.id, shipment);
    this.emit("shipment.created", { orderId, data: { shipmentId: shipment.id } });
    return shipment;
  }

  shipmentForOrder(orderId: string): Shipment | undefined {
    return [...this.shipments.values()].find((s) => s.orderId === orderId);
  }

  setShipmentStatus(
    shipmentId: string,
    status: ShipmentStatus,
    text: string,
    extra: Partial<Pick<Shipment, "factoryOrderNo" | "factoryEtd" | "carrier" | "trackingNo" | "cost">> = {},
  ): Shipment {
    const shipment = this.shipments.get(shipmentId);
    if (!shipment) throw new Error(`运单不存在：${shipmentId}`);
    Object.assign(shipment, extra);
    shipment.status = status;
    shipment.updatedAt = Date.now();
    shipment.events.push({ ts: Date.now(), status, text });
    this.emit("shipment.updated", { orderId: shipment.orderId, data: { shipmentId, status } });
    if (status === "delivered") this.updateOrderStatus(shipment.orderId, "delivered", "客户已签收，订单闭环");
    return shipment;
  }

  postFactoryMessage(shipmentId: string, from: FactoryMessage["from"], text: string): FactoryMessage {
    const shipment = this.shipments.get(shipmentId);
    if (!shipment) throw new Error(`运单不存在：${shipmentId}`);
    const msg: FactoryMessage = { from, text, ts: Date.now() };
    shipment.factoryChat.push(msg);
    this.emit("factory.message", { orderId: shipment.orderId, data: { from, text } });
    return msg;
  }

  // ---------------- 业务对齐小群 ----------------

  openGroupRoom(topic: string, agenda: string, members: AgentRole[], trigger: GroupRoom["trigger"]): GroupRoom {
    const room: GroupRoom = {
      id: `sync-${nextSeq()}`,
      topic,
      agenda,
      members,
      status: "open",
      messages: [],
      createdAt: Date.now(),
      trigger,
    };
    this.groupRooms.set(room.id, room);
    this.emit("meeting.opened", { data: { roomId: room.id, topic } });
    return room;
  }

  postGroupMessage(roomId: string, from: ChatMessage["from"], text: string): ChatMessage {
    const room = this.groupRooms.get(roomId);
    if (!room) throw new Error(`群聊不存在：${roomId}`);
    const msg: ChatMessage = { from, text, ts: Date.now() };
    room.messages.push(msg);
    this.emit("group.message", { data: { roomId, from } });
    return msg;
  }

  closeGroupRoom(roomId: string, minutes: Omit<MeetingMinutes, "closedAt">): GroupRoom {
    const room = this.groupRooms.get(roomId);
    if (!room) throw new Error(`群聊不存在：${roomId}`);
    room.status = "closed";
    room.closedAt = Date.now();
    room.minutes = { ...minutes, closedAt: room.closedAt };
    this.emit("meeting.closed", { data: { roomId, actionItems: minutes.actionItems.length } });
    return room;
  }

  latestOpenGroupRoom(): GroupRoom | undefined {
    return [...this.groupRooms.values()].filter((r) => r.status === "open").sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  // ---------------- 查询 / KPI ----------------

  kpis(): KpiSnapshot {
    const orders = [...this.orders.values()];
    const byStatus = (statuses: OrderStatus[]) => orders.filter((o) => statuses.includes(o.status)).length;
    const dayFmt = (ts: number) => new Date(ts).toISOString().slice(5, 10);
    const perDay = new Map<string, number>();
    for (const order of orders) {
      const day = dayFmt(order.createdAt);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    return {
      totalOrders: orders.length,
      totalRevenueUsd: Math.round(orders.reduce((s, o) => s + o.totalAmount, 0) * 100) / 100,
      pendingDeclaration: byStatus(["confirmed", "declaring", "exception"]),
      declaredOk: byStatus(["declared", "fulfilling"]),
      inTransit: byStatus(["shipped"]),
      delivered: byStatus(["delivered"]),
      exceptions: byStatus(["exception"]),
      openMeetings: [...this.groupRooms.values()].filter((r) => r.status === "open").length,
      activeAgents: ["sales", "customs", "fulfillment"],
      recentOrdersPerDay: [...perDay.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(-7)
        .map(([day, count]) => ({ day, count })),
    };
  }

  /** 给 GUI 的全量快照（数据量小，直接整包） */
  snapshot() {
    return {
      kpis: this.kpis(),
      orders: [...this.orders.values()].sort((a, b) => b.createdAt - a.createdAt),
      declarations: [...this.declarations.values()].sort((a, b) => b.createdAt - a.createdAt),
      shipments: [...this.shipments.values()].sort((a, b) => b.createdAt - a.createdAt),
      quotes: [...this.quotes.values()].sort((a, b) => b.createdAt - a.createdAt),
      customerRooms: [...this.customerRooms.values()].sort((a, b) => b.createdAt - a.createdAt),
      groupRooms: [...this.groupRooms.values()].sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  /** 清空全部业务数据（GUI 重置按钮 / 测试夹具） */
  reset(): void {
    this.orders.clear();
    this.declarations.clear();
    this.shipments.clear();
    this.quotes.clear();
    this.customerRooms.clear();
    this.groupRooms.clear();
    this.emit("store.reset");
  }

  // ---------------- 持久化 ----------------

  scheduleSave(): void {
    if (!this.persistPath) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 300);
  }

  saveNow(): void {
    if (!this.persistPath) return;
    const data = {
      orders: [...this.orders.values()],
      declarations: [...this.declarations.values()],
      shipments: [...this.shipments.values()],
      quotes: [...this.quotes.values()],
      customerRooms: [...this.customerRooms.values()],
      groupRooms: [...this.groupRooms.values()],
      savedAt: Date.now(),
    };
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const tmp = `${this.persistPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, this.persistPath);
  }
}
