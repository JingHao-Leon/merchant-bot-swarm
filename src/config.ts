/**
 * 运行配置：模型 Provider 选择、演示节奏、持久化路径。
 * 模型接入规则：
 *  - MERCHANT_LLM_PROVIDER 显式指定：faux | openai | anthropic | google | aihubmix | zai | openrouter ...
 *  - 未指定时自动探测环境变量：AIHUBMIX_API_KEY > OPENAI_API_KEY > ANTHROPIC_API_KEY > GEMINI_API_KEY > ZAI_API_KEY > faux
 *  - MERCHANT_LLM_MODEL 覆盖默认模型 ID；aihubmix 走 OpenAI 兼容协议（网关 base url）。
 * 凭据只从环境变量读取，代码与配置文件中不落任何密钥。
 */

export type ProviderKind = "faux" | "aihubmix" | "builtin";

export interface AppConfig {
  providerKind: ProviderKind;
  /** builtin 时的 provider id（如 openai / anthropic / google / zai / openrouter） */
  builtinProvider: string | null;
  modelId: string;
  /** aihubmix 网关地址（OpenAI 兼容） */
  aihubmixBaseUrl: string;
  dataDir: string;
  port: number;
  /** 定时对齐会议间隔（毫秒），0 = 关闭定时只留事件触发 */
  meetingIntervalMs: number;
  /** 物流轨迹推进间隔（毫秒） */
  carrierTickMs: number;
  demoScenario: "full" | "none";
}

function detectBuiltinProvider(): string | null {
  if (process.env.AIHUBMIX_API_KEY) return "aihubmix";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY) return "google";
  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.ZAI_API_KEY) return "zai";
  return null;
}

const DEFAULT_MODELS: Record<string, string> = {
  aihubmix: "gpt-4o-mini",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-2.5-flash",
  deepseek: "deepseek-chat",
  openrouter: "openai/gpt-4o-mini",
  zai: "glm-4.7",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const explicit = env.MERCHANT_LLM_PROVIDER?.trim().toLowerCase();
  let builtinProvider: string | null = null;
  let providerKind: ProviderKind;

  if (explicit === "faux" || explicit === undefined || explicit === "") {
    const detected = detectBuiltinProvider();
    if (explicit === "faux" || !detected) {
      providerKind = "faux";
      builtinProvider = null;
    } else {
      providerKind = detected === "aihubmix" ? "aihubmix" : "builtin";
      builtinProvider = detected;
    }
  } else if (explicit === "aihubmix") {
    providerKind = "aihubmix";
    builtinProvider = "aihubmix";
  } else {
    providerKind = "builtin";
    builtinProvider = explicit;
  }

  const modelId =
    env.MERCHANT_LLM_MODEL?.trim() ||
    (builtinProvider ? (DEFAULT_MODELS[builtinProvider] ?? "gpt-4o-mini") : "faux-agent");

  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };

  return {
    providerKind,
    builtinProvider,
    modelId,
    aihubmixBaseUrl: env.AIHUBMIX_BASE_URL?.trim() || "https://aihubmix.com/v1",
    dataDir: env.MERCHANT_DATA_DIR?.trim() || "data",
    port: num(env.MERCHANT_PORT, 8799),
    meetingIntervalMs: num(env.MERCHANT_MEETING_INTERVAL_MS, 180_000),
    carrierTickMs: num(env.MERCHANT_CARRIER_TICK_MS, 4_000),
    demoScenario: env.MERCHANT_DEMO === "none" ? "none" : "full",
  };
}

export function describeProvider(cfg: AppConfig): string {
  if (cfg.providerKind === "faux") return "faux（离线脚本模型，适合演示与测试）";
  if (cfg.providerKind === "aihubmix") return `aihubmix · ${cfg.modelId}`;
  return `${cfg.builtinProvider} · ${cfg.modelId}`;
}
