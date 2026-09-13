/**
 * 智能体业务工具集（pi AgentTool + TypeBox 强类型参数）。
 * 设计约定：
 *  - 查询类工具不终止回合，模型拿到信息后应继续调动作类工具；
 *  - 动作类工具（发消息/下单/申报/发货） terminate=true，一个回合干一件事，由编排器推进下一步；
 *  - 所有业务副作用都落在 store，自动产生事件（GUI 实时刷新 + 智能体联动）。
 */
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

/**
 * 工具定义助手：用 TypeBox schema 的静态类型驱动 execute 参数类型，
 * 对外仍以 AgentTool 形式注册进 pi Agent。
 */
function defineTool<T extends TSchema>(def: {
  name: string;
  label: string;
  description: string;
  parameters: T;
  execute: (toolCallId: string, params: Static<T>) => Promise<AgentToolResult<unknown>>;
}): AgentTool<T> {
  return def as unknown as AgentTool<T>;
}
import type { Store } from "../store.ts";
import { buildQuote, findProduct, searchCatalog } from "../catalog.ts";
import { buildDeclarationNo, validHsForCategory, validateDeclaration } from "../customsRules.ts";
import {
  createTrackingNo,
  factoryQuote,
  factoryReplyFor,
  headFreightQuote,
  placeFactoryOrder,
} from "../factoryService.ts";
import type { AgentRole, CustomsDeclaration } from "../types.ts";

export interface ToolDeps {
  store: Store;
  /** 下一步推进钩子：工具完成后通知编排器（如 order.created → 派发报关） */
  notify: (event: string, data: Record<string, unknown>) => void;
}

const json = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];

function weightOf(sku: string): number {
  return findProduct(sku)?.weightKg ?? 0;
}

// ---------------- 销售智能体工具 ----------------

export function salesTools(deps: ToolDeps): AgentTool<any>[] {
  const { store } = deps;

  const searchCatalogTool = defineTool({
    name: "search_catalog",
    label: "查询商品目录",
    description: "按关键词查询可出口商品（SKU、名称、阶梯价、库存、重量、含锂电池标记）",
    parameters: Type.Object({
      keyword: Type.Optional(Type.String({ description: "SKU/名称/品类关键词，可留空查全部" })),
    }),
    execute: async (_id, params) => {
      const items = searchCatalog(params.keyword).map((p) => ({
        sku: p.sku,
        name: p.name,
        unitPriceUsd: p.unitPriceUsd,
        tiers: p.tiers,
        stock: p.stock,
        weightKg: p.weightKg,
        battery: p.battery,
      }));
      return { content: json(items), details: { count: items.length } };
    },
  });;

  const createQuoteTool = defineTool({
    name: "create_quote",
    label: "生成报价单",
    description: "按阶梯价与头程物流生成正式报价（USD），并入库存档",
    parameters: Type.Object({
      roomId: Type.String({ description: "客户会话房间 ID" }),
      customerName: Type.String(),
      customerCountry: Type.String({ description: "目的国 ISO 代码，如 US/DE" }),
      lines: Type.Array(
        Type.Object({ sku: Type.String(), qty: Type.Integer({ minimum: 1 }) }),
        { minItems: 1 },
      ),
      incoterm: Type.Optional(Type.String({ description: "FOB/CIF/DAP/DDP/EXW，默认 DAP" })),
    }),
    execute: async (_id, params) => {
      const quote = buildQuote({
        customerName: params.customerName,
        customerCountry: params.customerCountry,
        lines: params.lines,
        incoterm: params.incoterm,
      });
      store.saveQuote(quote);
      const summary = quote.lines
        .map((l) => `${l.sku} ${l.name} ×${l.qty} @ ${l.unitPrice} = ${l.lineTotal}`)
        .join("；");
      return {
        content: json({
          quoteId: quote.id,
          summary,
          shippingUsd: quote.shippingUsd,
          totalUsd: quote.totalUsd,
          incoterm: quote.incoterm,
          validUntilDays: quote.validUntilDays,
        }),
        details: { quoteId: quote.id, total: quote.totalUsd },
      };
    },
  });;

  const replyCustomerTool = defineTool({
    name: "reply_customer",
    label: "回复客户",
    description: "在客户会话里回复消息。回复应包含客户下一步需要的全部信息（如报价明细），语气专业友好",
    parameters: Type.Object({
      roomId: Type.String(),
      text: Type.String({ description: "要发给客户的完整消息（中文或按客户语言）" }),
      quoteId: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      store.postCustomerMessage(params.roomId, "sales", params.text);
      return {
        content: json({ ok: true, repliedTo: params.roomId }),
        details: { roomId: params.roomId, len: params.text.length },
        terminate: true,
      };
    },
  });;

  const createOrderTool = defineTool({
    name: "create_order",
    label: "创建订单",
    description: "客户确认价格与地址后创建订单（视为已收款）。商品 SKU 必须存在且库存充足",
    parameters: Type.Object({
      roomId: Type.String(),
      customerName: Type.String(),
      country: Type.String(),
      channel: Type.String({ description: "来源渠道：whatsapp/email/web" }),
      contact: Type.Optional(Type.String()),
      items: Type.Array(
        Type.Object({
          sku: Type.String(),
          qty: Type.Integer({ minimum: 1 }),
          unitPrice: Type.Number({ description: "成交单价（与报价一致）" }),
        }),
        { minItems: 1 },
      ),
      totalAmount: Type.Number({ description: "订单总额（含运费），与报价单一致" }),
      incoterm: Type.String(),
      shippingAddress: Type.String(),
      note: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      const items = params.items.map((it) => {
        const product = findProduct(it.sku);
        if (!product) throw new Error(`未知 SKU：${it.sku}`);
        if (it.qty > product.stock) throw new Error(`${it.sku} 库存不足（现有 ${product.stock}）`);
        return { sku: product.sku, name: product.name, qty: it.qty, unitPrice: it.unitPrice };
      });
      const goods = items.reduce((s, it) => s + it.unitPrice * it.qty, 0);
      const shipping = params.totalAmount - goods;
      const order = store.createOrder({
        customerName: params.customerName,
        country: params.country,
        channel: params.channel,
        contact: params.contact,
        items,
        currency: "USD",
        totalAmount: params.totalAmount,
        incoterm: params.incoterm,
        shippingAddress: params.shippingAddress,
        note: params.note,
        roomId: params.roomId,
      });
      deps.notify("order.created", { orderId: order.id, roomId: params.roomId, goods, shipping });
      return {
        content: json({ orderId: order.id, totalAmount: order.totalAmount, status: order.status }),
        details: { orderId: order.id },
        terminate: true,
      };
    },
  });;

  const amendOrderTool = defineTool({
    name: "amend_order",
    label: "修订订单",
    description: "按海关/客户反馈修订订单备注（如补充 UN38.3 文件信息）或地址、贸易术语，修订后自动重推报关",
    parameters: Type.Object({
      orderId: Type.String(),
      note: Type.Optional(Type.String()),
      shippingAddress: Type.Optional(Type.String()),
      incoterm: Type.Optional(Type.String()),
      reason: Type.String(),
    }),
    execute: async (_id, params) => {
      const order = store.amendOrder(
        params.orderId,
        {
          note: params.note,
          shippingAddress: params.shippingAddress,
          incoterm: params.incoterm,
        },
        params.reason,
      );
      deps.notify("order.amended", { orderId: order.id });
      return { content: json({ ok: true, orderId: order.id, status: order.status }), details: { orderId: order.id }, terminate: true };
    },
  });;

  const handoverTool = defineTool({
    name: "handover_to_customs",
    label: "移交报关",
    description: "把订单移交给报关智能体，并在对齐群里留痕",
    parameters: Type.Object({
      orderId: Type.String(),
      note: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      const room = store.latestOpenGroupRoom();
      if (room) {
        store.postGroupMessage(room.id, "sales", `【移交】订单 ${params.orderId} 已收款，请报关同事跟进申报。${params.note ?? ""}`);
      }
      deps.notify("handover_to_customs", { orderId: params.orderId });
      return { content: json({ ok: true, orderId: params.orderId }), details: { orderId: params.orderId }, terminate: true };
    },
  });;

  return [searchCatalogTool, createQuoteTool, replyCustomerTool, createOrderTool, amendOrderTool, handoverTool];
}

// ---------------- 报关智能体工具 ----------------

const declarationItemSchema = Type.Object({
  sku: Type.String(),
  description: Type.String(),
  hsCode: Type.String({ description: "6-10 位数字 HS 编码" }),
  originCountry: Type.String({ description: "原产国，一般 CN" }),
  qty: Type.Integer({ minimum: 1 }),
  unitValue: Type.Number(),
  totalValue: Type.Number(),
});

const declarationSchema = Type.Object({
  orderId: Type.String(),
  exporterName: Type.String(),
  exporterCountry: Type.String(),
  consigneeName: Type.String(),
  consigneeCountry: Type.String(),
  destinationCountry: Type.String(),
  incoterm: Type.String(),
  currency: Type.String(),
  declaredValue: Type.Number(),
  grossWeightKg: Type.Number(),
  items: Type.Array(declarationItemSchema, { minItems: 1 }),
  notes: Type.Optional(Type.String({ description: "随附单证说明，含锂电池货物必须注明 UN38.3 测试摘要" })),
});

export function customsTools(deps: ToolDeps): AgentTool<any>[] {
  const { store } = deps;

  const getOrderTool = defineTool({
    name: "get_order",
    label: "查询订单",
    description: "获取订单完整信息（商品行、金额、目的国、收货地址等），是整理报关单的第一步",
    parameters: Type.Object({ orderId: Type.String() }),
    execute: async (_id, params) => {
      const order = store.mustOrder(params.orderId);
      return { content: json(order), details: { orderId: order.id } };
    },
  });;

  const getHsTool = defineTool({
    name: "get_hs_code",
    label: "查询 HS 编码",
    description: "按品类查询推荐的海关编码与锂电池附加要求",
    parameters: Type.Object({ sku: Type.String() }),
    execute: async (_id, params) => {
      const product = findProduct(params.sku);
      if (!product) throw new Error(`未知 SKU：${params.sku}`);
      return {
        content: json({
          sku: product.sku,
          category: product.category,
          hsCode: product.hsCode,
          hsPrefixOfCategory: validHsForCategory(product.category),
          battery: product.battery,
          batteryNote: product.battery ? "含锂电池：报关单 notes 必须注明 UN38.3 测试摘要" : null,
        }),
        details: { sku: product.sku },
      };
    },
  });;

  const submitDeclarationTool = defineTool({
    name: "submit_declaration",
    label: "提交海关申报",
    description:
      "把订单整理成结构化报关单并提交海关审单。申报数据必须与订单完全一致：逐行 HS 编码、数量、单价；含锂电池需注明 UN38.3",
    parameters: Type.Object({ declaration: declarationSchema }),
    execute: async (_id, params) => {
      const payload = params.declaration as CustomsDeclaration;
      const order = store.mustOrder(payload.orderId);
      if (order.status === "confirmed" || order.status === "exception") {
        store.updateOrderStatus(order.id, "declaring", "报关资料已递交海关审单");
      }
      const decl = store.upsertDeclaration(payload);
      const result = validateDeclaration(payload, order, weightOf);

      if (!result.ok) {
        store.markDeclaration(decl.id, { status: "rejected", issues: result.issues });
        store.updateOrderStatus(order.id, "exception", `海关退单：${result.issues.join("；")}`);
        deps.notify("declaration.rejected", { orderId: order.id, issues: result.issues });
        return {
          content: json({ accepted: false, issues: result.issues, declarationId: decl.id }),
          details: { declarationId: decl.id, accepted: false },
          terminate: true,
        };
      }

      if (result.requiresInspection) {
        store.markDeclaration(decl.id, { status: "inspection" });
        store.updateOrderStatus(order.id, "declaring", "申报总值 ≥ 2000 USD，海关布控查验，等待查验放行");
        deps.notify("declaration.inspection", { orderId: order.id, declarationId: decl.id });
        return {
          content: json({ accepted: true, status: "inspection", declarationId: decl.id, hint: "调用 clear_inspection 走查验放行" }),
          details: { declarationId: decl.id, status: "inspection" },
          terminate: true,
        };
      }

      const declarationNo = buildDeclarationNo(Number(decl.id.split("-")[1]), Date.now());
      store.markDeclaration(decl.id, { status: "accepted", declarationNo });
      store.updateOrderStatus(order.id, "declared", `海关受理放行，报关单号 ${declarationNo}`);
      deps.notify("declaration.accepted", { orderId: order.id, declarationNo });
      return {
        content: json({ accepted: true, status: "accepted", declarationNo, declarationId: decl.id }),
        details: { declarationId: decl.id, declarationNo },
        terminate: true,
      };
    },
  });;

  const clearInspectionTool = defineTool({
    name: "clear_inspection",
    label: "查验放行",
    description: "对布控查验的报关单完成查验并放行（模拟海关现场查验通过）",
    parameters: Type.Object({ declarationId: Type.String() }),
    execute: async (_id, params) => {
      const decl = store.declarations.get(params.declarationId);
      if (!decl) throw new Error(`报关单不存在：${params.declarationId}`);
      const declarationNo = decl.declarationNo ?? buildDeclarationNo(Number(decl.id.split("-")[1]), Date.now());
      store.markDeclaration(decl.id, { status: "cleared", declarationNo });
      store.updateOrderStatus(decl.orderId, "declared", `查验通过放行，报关单号 ${declarationNo}`);
      deps.notify("declaration.accepted", { orderId: decl.orderId, declarationNo });
      return {
        content: json({ ok: true, declarationNo, orderId: decl.orderId }),
        details: { declarationId: decl.id, declarationNo },
        terminate: true,
      };
    },
  });;

  const requestFixTool = defineTool({
    name: "request_order_fix",
    label: "退回补正",
    description: "把海关退单原因发到对齐群并通知销售智能体修订订单",
    parameters: Type.Object({
      orderId: Type.String(),
      roomId: Type.Optional(Type.String({ description: "对齐群房间 ID，缺省用最近一个在开的群" })),
      issues: Type.Array(Type.String(), { minItems: 1 }),
    }),
    execute: async (_id, params) => {
      const room = params.roomId ? store.groupRooms.get(params.roomId) : store.latestOpenGroupRoom();
      if (room) {
        store.postGroupMessage(
          room.id,
          "customs",
          `【退单补正】订单 ${params.orderId} 申报被退回：${params.issues.join("；")}。请销售同事修订订单后重推申报。`,
        );
      }
      deps.notify("request_order_fix", { orderId: params.orderId, issues: params.issues });
      return { content: json({ ok: true, notified: true }), details: { orderId: params.orderId }, terminate: true };
    },
  });;

  return [getOrderTool, getHsTool, submitDeclarationTool, clearInspectionTool, requestFixTool];
}

// ---------------- 跟单/发货智能体工具 ----------------

export function fulfillmentTools(deps: ToolDeps): AgentTool<any>[] {
  const { store } = deps;

  const getOrderTool = defineTool({
    name: "get_order",
    label: "查询订单",
    description: "获取订单完整信息（SKU、数量、目的国），安排生产前必看",
    parameters: Type.Object({ orderId: Type.String() }),
    execute: async (_id, params) => {
      const order = store.mustOrder(params.orderId);
      return { content: json(order), details: { orderId: order.id } };
    },
  });;

  const getDeclarationTool = defineTool({
    name: "get_declaration",
    label: "查询报关单",
    description: "确认订单是否已报关放行（未放行不能安排出运）",
    parameters: Type.Object({ orderId: Type.String() }),
    execute: async (_id, params) => {
      const decl = store.declarationForOrder(params.orderId);
      if (!decl) throw new Error(`订单 ${params.orderId} 还没有报关单`);
      return { content: json(decl), details: { declarationId: decl.id } };
    },
  });;

  const factoryQuoteTool = defineTool({
    name: "factory_quote",
    label: "工厂询价",
    description: "向对口工厂询问产能、代工单价与交期",
    parameters: Type.Object({ sku: Type.String(), qty: Type.Integer({ minimum: 1 }) }),
    execute: async (_id, params) => {
      const quote = factoryQuote(params.sku, params.qty);
      return { content: json(quote), details: { factoryId: quote.factoryId } };
    },
  });;

  const placeFactoryOrderTool = defineTool({
    name: "place_factory_order",
    label: "下达生产单",
    description: "向工厂下生产单。工厂产能不足会明确拒单（此时订单转异常，需要在对齐群协调）",
    parameters: Type.Object({
      orderId: Type.String(),
      sku: Type.String(),
      qty: Type.Integer({ minimum: 1 }),
      roomId: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      const fo = placeFactoryOrder({ orderId: params.orderId, sku: params.sku, qty: params.qty }, Date.now());
      const shipment = store.createShipment(params.orderId, fo.factoryId);
      shipment.factoryOrderNo = fo.factoryOrderNo;
      shipment.factoryEtd = fo.etdTs;
      store.postFactoryMessage(shipment.id, "fulfillment", `工厂你好，订单 ${params.orderId} 需要生产 ${params.sku} × ${params.qty}，请确认排产。`);
      store.postFactoryMessage(shipment.id, "factory", factoryReplyFor(fo));
      if (fo.accepted) {
        store.setShipmentStatus(shipment.id, "factory_confirmed", `工厂已排产（生产单 ${fo.factoryOrderNo}）`, {
          factoryOrderNo: fo.factoryOrderNo,
          factoryEtd: fo.etdTs,
        });
      } else {
        store.setShipmentStatus(shipment.id, "delayed", `工厂产能不足：${fo.remark}`);
        store.updateOrderStatus(params.orderId, "exception", `工厂产能不足，生产单被拒：${fo.remark}`);
        const room = params.roomId ? store.groupRooms.get(params.roomId) : store.latestOpenGroupRoom();
        if (room) {
          store.postGroupMessage(room.id, "fulfillment", `【产能告警】订单 ${params.orderId} 工厂拒单：${fo.remark}`);
        }
        deps.notify("factory.rejected", { orderId: params.orderId, remark: fo.remark });
      }
      deps.notify("factory.order_placed", { orderId: params.orderId, accepted: fo.accepted, shipmentId: shipment.id });
      return { content: json(fo), details: { factoryOrderNo: fo.factoryOrderNo, shipmentId: shipment.id }, terminate: true };
    },
  });;

  const arrangeShipmentTool = defineTool({
    name: "arrange_shipment",
    label: "安排出货",
    description: "工厂完工后安排头程承运：生成运单号并通知客户发货信息",
    parameters: Type.Object({
      orderId: Type.String(),
      carrier: Type.String({ description: "DHL / FedEx / UPS" }),
      roomId: Type.Optional(Type.String({ description: "客户会话房间 ID，用于同步发货通知" })),
    }),
    execute: async (_id, params) => {
      const shipment = store.shipmentForOrder(params.orderId);
      if (!shipment) throw new Error(`订单 ${params.orderId} 还没有生产单，无法安排出货`);
      const carrier = (["DHL", "FedEx", "UPS"] as const).find(
        (c) => c.toLowerCase() === params.carrier.toLowerCase(),
      );
      if (!carrier) throw new Error(`不支持的承运商：${params.carrier}`);
      const order = store.mustOrder(params.orderId);
      const firstItem = order.items[0];
      const cost = firstItem ? headFreightQuote(firstItem.sku, firstItem.qty, weightOf) : 0;
      const trackingNo = createTrackingNo(carrier);
      store.setShipmentStatus(shipment.id, "picked_up", `承运商 ${carrier} 揽收，运单号 ${trackingNo}`, {
        carrier,
        trackingNo,
        cost,
      });
      store.updateOrderStatus(params.orderId, "shipped", `${carrier} 已揽收，运单号 ${trackingNo}`);
      if (params.roomId) {
        const room = store.customerRooms.get(params.roomId);
        if (room) {
          store.postCustomerMessage(
            params.roomId,
            "sales",
            `您的订单 ${params.orderId} 已发货：${carrier} 运单号 ${trackingNo}，预计 5-8 个工作日送达，可在物流页跟踪。`,
            params.orderId,
          );
        }
      }
      deps.notify("shipment.arranged", { orderId: params.orderId, trackingNo, carrier });
      return {
        content: json({ ok: true, trackingNo, carrier, cost }),
        details: { shipmentId: shipment.id, trackingNo },
        terminate: true,
      };
    },
  });;

  return [getOrderTool, getDeclarationTool, factoryQuoteTool, placeFactoryOrderTool, arrangeShipmentTool];
}

// ---------------- 群聊通用工具（三角色共用构造） ----------------

export function groupToolsFor(role: AgentRole, deps: ToolDeps): AgentTool<any>[] {
  const { store } = deps;
  const tool = defineTool({
    name: "post_group_message",
    label: "群内发言",
    description: "在业务对齐群里发言，汇报本岗位状态与风险，需要配合时点名对应同事",
    parameters: Type.Object({
      roomId: Type.String(),
      text: Type.String(),
    }),
    execute: async (_id, params) => {
      store.postGroupMessage(params.roomId, role, params.text);
      return { content: json({ ok: true }), details: { roomId: params.roomId }, terminate: true };
    },
  });;
  return [tool];
}
