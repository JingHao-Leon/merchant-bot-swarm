/**
 * 智能体基座：把 pi Agent 包上「串行任务队列 + 活动日志」，一个岗位一个实例。
 * GUI 的智能体状态卡（在忙什么/最近动作/任务计数）数据来源就在这里。
 */
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentLlm } from "../llm.ts";
import type { AgentRole } from "../types.ts";

export interface ActivityEntry {
  ts: number;
  text: string;
}

export interface BusinessAgent {
  role: AgentRole;
  name: string;
  agent: Agent;
  busy: boolean;
  stats: { tasks: number; errors: number; lastActiveAt: number };
  activity: ActivityEntry[];
  /** 同岗位任务串行化的队列尾 */
  queue: Promise<void>;
  /** 串行执行一个任务体，保证同岗位一次只跑一个 prompt */
  enqueue<T>(job: () => Promise<T>): Promise<T>;
  log(text: string): void;
}

export function createBusinessAgent(input: {
  role: AgentRole;
  name: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  llm: AgentLlm;
  sessionId: string;
}): BusinessAgent {
  const { role, name, llm } = input;

  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model: llm.model,
      tools: input.tools,
      messages: [],
    },
    streamFn: llm.streamFn,
    sessionId: input.sessionId,
  });

  const state: BusinessAgent = {
    role,
    name,
    agent,
    busy: false,
    stats: { tasks: 0, errors: 0, lastActiveAt: 0 },
    activity: [],
    queue: Promise.resolve(),
    enqueue<T>(job: () => Promise<T>): Promise<T> {
      const run = state.queue.then(job);
      state.queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    log(text: string) {
      state.activity.unshift({ ts: Date.now(), text });
      if (state.activity.length > 30) state.activity.pop();
      state.stats.lastActiveAt = Date.now();
    },
  };

  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      state.log(`🔧 ${event.toolName}`);
    } else if (event.type === "tool_execution_end" && event.isError) {
      state.stats.errors += 1;
      state.log(`⚠️ ${event.toolName} 执行失败`);
    } else if (event.type === "agent_start") {
      state.busy = true;
    } else if (event.type === "agent_end") {
      state.stats.tasks += 1;
      state.busy = false;
      state.stats.lastActiveAt = Date.now();
    }
  });

  return state;
}
