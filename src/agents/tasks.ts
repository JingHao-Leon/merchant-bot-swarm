/**
 * 任务信封：编排器 → 智能体 的统一指令格式（同时是真实 LLM 与脚本大脑的输入）。
 * 构造与解析集中在这里，保证两个模式看到同一套协议。
 */
import type { AgentRole } from "../types.ts";

export interface CustomerTask {
  kind: "customer_message";
  roomId: string;
  customerName: string;
  text: string;
}

export interface DeclareTask {
  kind: "declare_order";
  orderId: string;
  groupRoomId?: string;
  retryOf?: string; // 退单重报时指向上一张报关单
}

export interface InspectTask {
  kind: "clear_inspection";
  orderId: string;
  declarationId: string;
}

export interface AmendTask {
  kind: "amend_order";
  orderId: string;
  issues: string[];
  roomId?: string;
}

export interface FulfillTask {
  kind: "fulfill_order";
  orderId: string;
  declarationNo: string;
  customerRoomId?: string;
  groupRoomId?: string;
}

export interface ShipTask {
  kind: "arrange_shipment";
  orderId: string;
  carrier: string;
  customerRoomId?: string;
  groupRoomId?: string;
}

export interface MeetingTask {
  kind: "meeting_reply";
  roomId: string;
  agenda: string;
  role: AgentRole;
}

export type AgentTask =
  | CustomerTask
  | DeclareTask
  | InspectTask
  | AmendTask
  | FulfillTask
  | ShipTask
  | MeetingTask;

export function renderTask(task: AgentTask): string {
  switch (task.kind) {
    case "customer_message":
      return `【客户消息】房间 ${task.roomId} | 客户 ${task.customerName}：${task.text}`;
    case "declare_order":
      return `【报关任务】订单 ${task.orderId} | 对齐群 ${task.groupRoomId ?? "-"}${
        task.retryOf ? ` | 重报（上一单 ${task.retryOf} 被退回）` : ""
      }：请查询订单，整理结构化报关单并调用 submit_declaration 提交申报。`;
    case "clear_inspection":
      return `【查验任务】订单 ${task.orderId} | 报关单 ${task.declarationId}：海关布控查验，请调用 clear_inspection 完成查验放行。`;
    case "amend_order":
      return `【修订任务】订单 ${task.orderId} | 对齐群 ${task.roomId ?? "-"}：海关退单（${
        task.issues.join("；")
      }），请调用 amend_order 修订订单（补充相应单证/信息）。`;
    case "fulfill_order":
      return `【出货任务】订单 ${task.orderId} | 报关单号 ${task.declarationNo} | 客户房间 ${
        task.customerRoomId ?? "-"
      } | 对齐群 ${task.groupRoomId ?? "-"}：请确认报关放行后向工厂询价、下生产单。`;
    case "arrange_shipment":
      return `【发货任务】订单 ${task.orderId} | 指定承运商 ${task.carrier} | 客户房间 ${
        task.customerRoomId ?? "-"
      }：工厂已排产，请调用 arrange_shipment 安排出货并通知客户。`;
    case "meeting_reply":
      return `【业务对齐群】房间 ${task.roomId} | 议程：${task.agenda}\n你是 ${
        task.role
      } 岗位，请调用 post_group_message 汇报你手头的业务状态、风险与需要的配合（一次发言说完）。`;
  }
}

export function parseTask(text: string): AgentTask | null {
  let m: RegExpMatchArray | null;
  if ((m = text.match(/^【客户消息】房间 (\S+) \| 客户 (.+?)：([\s\S]+)$/))) {
    return { kind: "customer_message", roomId: m[1], customerName: m[2], text: m[3] };
  }
  if (
    (m = text.match(
      /^【报关任务】订单 ([A-Z]+-\d+) \| 对齐群 ([A-Za-z]+-\d+|-)( \| 重报（上一单 [A-Za-z]+-\d+ 被退回）)?/,
    ))
  ) {
    return {
      kind: "declare_order",
      orderId: m[1],
      groupRoomId: m[2] === "-" ? undefined : m[2],
      retryOf: m[3]?.match(/上一单 (\S+)/)?.[1],
    };
  }
  if ((m = text.match(/^【查验任务】订单 ([A-Z]+-\d+) \| 报关单 ([A-Z]+-\d+)/))) {
    return { kind: "clear_inspection", orderId: m[1], declarationId: m[2] };
  }
  if (
    (m = text.match(/^【修订任务】订单 ([A-Z]+-\d+) \| 对齐群 ([A-Za-z]+-\d+|-)：海关退单（([\s\S]+?)）/))
  ) {
    return {
      kind: "amend_order",
      orderId: m[1],
      roomId: m[2] === "-" ? undefined : m[2],
      issues: m[3].split("；"),
    };
  }
  if (
    (m = text.match(
      /^【出货任务】订单 ([A-Z]+-\d+) \| 报关单号 (\S+) \| 客户房间 (\S+) \| 对齐群 ([A-Za-z]+-\d+|-)/,
    ))
  ) {
    return {
      kind: "fulfill_order",
      orderId: m[1],
      declarationNo: m[2],
      customerRoomId: m[3] === "-" ? undefined : m[3],
      groupRoomId: m[4] === "-" ? undefined : m[4],
    };
  }
  if (
    (m = text.match(/^【发货任务】订单 ([A-Za-z]+-\d+) \| 指定承运商 (\S+) \| 客户房间 ([A-Za-z]+-[\w-]*)/))
  ) {
    return {
      kind: "arrange_shipment",
      orderId: m[1],
      carrier: m[2],
      customerRoomId: m[3] === "-" ? undefined : m[3],
    };
  }
  if ((m = text.match(/^【业务对齐群】房间 (\S+) \| 议程：([\s\S]+)\n你是 (\S+) 岗位/))) {
    return { kind: "meeting_reply", roomId: m[1], agenda: m[2], role: m[3] as AgentRole };
  }
  return null;
}
