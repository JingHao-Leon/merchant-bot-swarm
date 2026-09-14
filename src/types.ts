/**
 * 领域模型与共享类型：订单 / 报关单 / 运单 / 群聊 / 事件。
 * 所有跨模块传递的业务结构都在这里定义，报关单结构同时有 TypeBox schema（见 schemas.ts）。
 */

export type AgentRole = "sales" | "customs" | "fulfillment";

export type OrderStatus =
  | "inquiry" // 询价中
  | "quoted" // 已报价
  | "confirmed" // 已下单（已收款）
  | "declaring" // 报关中
  | "declared" // 已报关放行
  | "fulfilling" // 工厂备货中
  | "shipped" // 已发货
  | "delivered" // 已签收
  | "exception" // 异常挂起
  | "cancelled"; // 已取消

export interface OrderItem {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number; // 成交单价（成交币种）
}

export interface Order {
  id: string; // ORD-1001
  customer: {
    name: string;
    country: string; // 目的国 ISO 代码，如 US
    channel: string; // 来源渠道：whatsapp / email / web
    contact?: string;
  };
  items: OrderItem[];
  currency: string; // USD / EUR
  totalAmount: number;
  incoterm: string; // FOB / CIF / DAP / DDP / EXW
  shippingAddress: string;
  note?: string;
  caseId?: string; // 归属案例（案例库展示用）
  status: OrderStatus;
  timeline: TimelineEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface TimelineEntry {
  ts: number;
  event: string; // 机器可读：inquiry / quoted / confirmed ...
  text: string; // 人读中文描述
}

export type DeclarationStatus =
  | "draft" // 整理中
  | "submitted" // 已受理待审核（瞬态，与 accepted 合并展示）
  | "accepted" // 海关受理
  | "rejected" // 退单补正
  | "inspection" // 查验中
  | "cleared"; // 查验放行

/** 结构化报关单（向海关申报的核心结构化输出） */
export interface CustomsDeclaration {
  declarationId?: string; // 服务端生成
  orderId: string;
  exporterName: string;
  exporterCountry: string;
  consigneeName: string;
  consigneeCountry: string;
  destinationCountry: string;
  incoterm: string;
  currency: string;
  declaredValue: number;
  grossWeightKg: number;
  items: DeclarationItem[];
  notes?: string; // 附件说明，如 UN38.3 测试摘要
}

export interface DeclarationItem {
  sku: string;
  description: string;
  hsCode: string; // 6-10 位数字
  originCountry: string;
  qty: number;
  unitValue: number;
  totalValue: number;
}

export interface Declaration {
  id: string; // DEC-2001
  orderId: string;
  status: DeclarationStatus;
  payload: CustomsDeclaration;
  issues: string[]; // 最近一次退单原因（rejected 时）
  previousIssues: string[][]; // 历次退单原因（补正留痕）
  declarationNo?: string; // 海关受理号
  createdAt: number;
  updatedAt: number;
}

export type ShipmentStatus =
  | "arranging" // 安排中（等工厂）
  | "factory_confirmed" // 工厂已确认排产
  | "picked_up" // 已揽收
  | "in_transit" // 干线运输中
  | "export_cleared" // 出口放行/起运
  | "delivered" // 已签收
  | "delayed"; // 延误（工厂缺料等）

export interface ShipmentEvent {
  ts: number;
  status: ShipmentStatus;
  location?: string;
  text: string;
}

export interface Shipment {
  id: string; // SHP-3001
  orderId: string;
  status: ShipmentStatus;
  factoryId: string;
  factoryOrderNo?: string; // FAC-9001
  factoryEtd?: number; // 工厂承诺完工时间
  carrier?: string; // DHL / FedEx
  trackingNo?: string;
  cost?: number; // 头程运费（USD）
  events: ShipmentEvent[];
  factoryChat: FactoryMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface FactoryMessage {
  from: "fulfillment" | "factory";
  text: string;
  ts: number;
}

export type ChatFrom = AgentRole | "customer" | "coordinator" | "system";

export interface ChatMessage {
  from: ChatFrom;
  text: string;
  ts: number;
  orderId?: string;
}

/** 客户会话房间（sales ↔ customer） */
export interface CustomerRoom {
  id: string; // cust-david-miller
  customerName: string;
  country: string;
  channel: string;
  caseId?: string; // 归属案例（从会话贯通到订单）
  messages: ChatMessage[];
  createdAt: number;
}

/** 业务对齐小群（三智能体 + 主持人） */
export interface GroupRoom {
  id: string; // sync-4001
  topic: string;
  agenda: string;
  members: AgentRole[];
  status: "open" | "closed";
  messages: ChatMessage[];
  minutes?: MeetingMinutes;
  createdAt: number;
  closedAt?: number;
  trigger: "scheduled" | "event" | "manual";
}

export interface MeetingMinutes {
  summary: string;
  replies: { agent: AgentRole; text: string }[];
  actionItems: string[];
  closedAt: number;
}

export interface ProductItem {
  sku: string;
  name: string;
  category: string;
  unitPriceUsd: number; // 零档单价
  tiers: { minQty: number; discount: number }[]; // 阶梯折扣
  stock: number;
  weightKg: number; // 单件毛重
  battery: boolean; // 是否含锂电池（报关附加要求）
  hsCode: string; // 默认 HS 编码（前 6 位）
}

export interface QuoteLine {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Quote {
  id: string; // QT-5001
  customerName: string;
  customerCountry: string;
  lines: QuoteLine[];
  shippingUsd: number;
  totalUsd: number;
  currency: "USD";
  incoterm: string;
  validUntilDays: number;
  createdAt: number;
}

/** 事件总线消息（SSE 与内部联动都用它） */
export interface BusEvent {
  type: string; // order.created / declaration.accepted / shipment.created / meeting.closed ...
  orderId?: string;
  data?: Record<string, unknown>;
  ts: number;
}

export type BusListener = (event: BusEvent) => void;

/** KPI 汇总（GUI 顶部仪表盘） */
export interface KpiSnapshot {
  totalOrders: number;
  totalRevenueUsd: number;
  pendingDeclaration: number; // confirmed + declaring
  declaredOk: number; // declared + fulfilling
  inTransit: number; // shipped
  delivered: number;
  exceptions: number;
  openMeetings: number;
  activeAgents: AgentRole[];
  recentOrdersPerDay: { day: string; count: number }[];
}
