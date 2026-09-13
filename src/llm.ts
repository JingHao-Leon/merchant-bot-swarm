/**
 * 模型接入层：为每个业务智能体装配 pi-ai 的模型与 streamFn。
 * - faux 模式（默认，无任何 API Key 时）：三个智能体各自挂一个独立 Faux 假模型
 *   （pi-ai 官方测试/演示 Provider），由 director.ts 的脚本大脑驱动，全程离线可跑。
 * - 真实模式：AIHUBMIX_API_KEY 走 OpenAI 兼容网关；OPENAI/ANTHROPIC/GEMINI/... 走内置 Provider。
 *   凭据只从环境变量解析（pi-ai 的 envApiKeyAuth / 内置凭证链），不落代码。
 */
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxProvider,
  type FauxProviderHandle,
  type Models,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentRole } from "./types.ts";
import type { AppConfig } from "./config.ts";

export interface AgentLlm {
  streamFn: StreamFn;
  model: Model<string>;
  /** GUI 徽标用 */
  label: string;
  /** faux 模式下返回该角色的假模型句柄（脚本大脑往里写响应） */
  faux?: FauxProviderHandle;
}

export interface LlmRegistry {
  llmByRole(role: AgentRole): AgentLlm;
  describe(): string;
}

const ROLE_IDS: Record<AgentRole, string> = {
  sales: "faux-sales",
  customs: "faux-customs",
  fulfillment: "faux-fulfillment",
};

export function createLlmRegistry(cfg: AppConfig): LlmRegistry {
  if (cfg.providerKind === "faux") {
    const models = createModels();
    const fauxByRole = new Map<AgentRole, FauxProviderHandle>();
    for (const role of Object.keys(ROLE_IDS) as AgentRole[]) {
      const handle = fauxProvider({
        provider: ROLE_IDS[role],
        models: [{ id: cfg.modelId, name: `Faux · ${role}` }],
      });
      models.setProvider(handle.provider);
      fauxByRole.set(role, handle);
    }
    return {
      llmByRole(role) {
        const handle = fauxByRole.get(role)!;
        return { streamFn: models.streamSimple.bind(models), model: handle.getModel(), label: `faux:${role}`, faux: handle };
      },
      describe: () => "faux 脚本模型（离线演示/测试模式，接真实 Key 后自动切换）",
    };
  }

  if (cfg.providerKind === "aihubmix") {
    const models = createModels();
    const model: Model<"openai-completions"> = {
      id: cfg.modelId,
      name: `${cfg.modelId}（AIHubMix）`,
      api: "openai-completions",
      provider: "aihubmix",
      baseUrl: cfg.aihubmixBaseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    };
    models.setProvider(
      createProvider({
        id: "aihubmix",
        name: "AIHubMix",
        baseUrl: cfg.aihubmixBaseUrl,
        auth: { apiKey: envApiKeyAuth("AIHubMix", ["AIHUBMIX_API_KEY"]) },
        models: [model],
        api: openAICompletionsApi(),
      }),
    );
    const resolved = models.getModel("aihubmix", cfg.modelId);
    if (!resolved) throw new Error(`AIHubMix 模型不可用：${cfg.modelId}`);
    return {
      llmByRole: () => ({ streamFn: models.streamSimple.bind(models), model: resolved, label: `aihubmix:${cfg.modelId}` }),
      describe: () => `AIHubMix · ${cfg.modelId}`,
    };
  }

  // 内置 Provider（openai / anthropic / google / deepseek / openrouter / zai ...）
  const models: Models = builtinModels();
  const provider = cfg.builtinProvider!;
  const resolved = models.getModel(provider, cfg.modelId);
  if (!resolved) {
    throw new Error(
      `内置 Provider「${provider}」没有模型「${cfg.modelId}」，请用 MERCHANT_LLM_MODEL 指定可用模型 ID`,
    );
  }
  return {
    llmByRole: () => ({ streamFn: models.streamSimple.bind(models), model: resolved, label: `${provider}:${cfg.modelId}` }),
    describe: () => `${provider} · ${cfg.modelId}`,
  };
}
