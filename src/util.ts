/** 通用小工具：ID 生成、金额比较、事件总线、安全 JSON 读写。 */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

let seq = 1000;
export function nextSeq(): number {
  seq += 1;
  return seq;
}

export function seedSeq(n: number): void {
  seq = Math.max(seq, n);
}

export function fmtMoney(n: number, currency = "USD"): string {
  return `${currency} ${n.toFixed(2)}`;
}

/** 金额比较允许 1 分钱浮点误差 */
export function moneyClose(a: number, b: number, eps = 0.011): boolean {
  return Math.abs(a - b) <= eps;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 进程内事件总线（GUI 的 SSE 与智能体联动都从这里走） */
export class EventBus {
  private listeners = new Set<(payload: unknown) => void>();

  subscribe(listener: (payload: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(payload: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch (err) {
        console.error("[bus] listener error:", err);
      }
    }
  }
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
