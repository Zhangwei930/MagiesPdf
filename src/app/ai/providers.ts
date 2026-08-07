import type { AiProvider } from '../bridge.ts';

/**
 * Vendor presets and the connection status the settings pane reports.
 *
 * A preset is only a template for a new provider: the user picks a vendor, then
 * edits the endpoint, the model and the key on the provider itself. The stored
 * list is the source of truth, which is why nothing here is keyed by URL.
 *
 * Pure so it can be tested without a DOM. `connectionState` mirrors what the
 * runtime enforces in `electron/ai/openAiClient.cjs` — a remote endpoint with
 * no key fails there, so the pane says so before a turn is ever sent.
 */

export type ProviderTone = 'indigo' | 'sky' | 'emerald' | 'violet' | 'amber' | 'slate';

export interface ProviderPreset {
  /** Vendor key, stored on the provider as `providerId`. */
  id: string;
  name: string;
  baseUrl: string;
  /** Suggested models; the first is used when a provider is created. */
  models: string[];
  hint: { zh: string; en: string };
  tone: ProviderTone;
  /** Short mark drawn in the plate — no third-party logos are bundled. */
  mark: string;
  requiresApiKey: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    hint: { zh: '通用对话，性价比高', en: 'General chat, low cost' },
    tone: 'indigo',
    mark: 'DS',
    requiresApiKey: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6', 'gpt-5.5', 'gpt-5.1', 'o4-mini', 'o3'],
    hint: { zh: '工具调用稳定', en: 'Reliable tool calling' },
    tone: 'emerald',
    mark: 'AI',
    requiresApiKey: true,
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: [
      'deepseek-ai/deepseek-v3.2',
      'meta/llama-3.3-70b-instruct',
      'qwen/qwen3-235b-a22b',
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    ],
    hint: { zh: '托管推理，模型很多', en: 'Hosted inference, many models' },
    tone: 'emerald',
    mark: 'NV',
    requiresApiKey: true,
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4.5', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-build-0.1'],
    hint: { zh: 'xAI 官方接口', en: "xAI's own endpoint" },
    tone: 'slate',
    mark: 'XA',
    requiresApiKey: true,
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen3-coder-plus', 'qwen-plus-latest'],
    hint: { zh: '阿里云百炼兼容接口', en: 'Aliyun DashScope compatible mode' },
    tone: 'sky',
    mark: 'QW',
    requiresApiKey: true,
  },
  {
    id: 'moonshot',
    name: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k2.6', 'kimi-k2.5', 'moonshot-v1-128k', 'moonshot-v1-32k'],
    hint: { zh: '长文档理解', en: 'Long-document understanding' },
    tone: 'amber',
    mark: 'KM',
    requiresApiKey: true,
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flash', 'glm-4.6'],
    hint: { zh: '国内直连', en: 'Mainland endpoint' },
    tone: 'indigo',
    mark: 'GL',
    requiresApiKey: true,
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3-235B-A22B'],
    hint: { zh: '聚合多家开源模型', en: 'Aggregates open-weight models' },
    tone: 'violet',
    mark: 'SF',
    requiresApiKey: true,
  },
  {
    id: 'volces',
    name: '火山方舟 豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      'doubao-seed-2-0-pro-260215',
      'doubao-seed-2-0-lite-260215',
      'doubao-seed-2-0-code-preview-260215',
    ],
    hint: { zh: '模型名填你的接入点 ID', en: 'Use your endpoint id as the model' },
    tone: 'sky',
    mark: 'DB',
    requiresApiKey: true,
  },
  {
    id: 'mimo',
    name: '小米 MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    hint: { zh: '小米开放接口', en: "Xiaomi's endpoint" },
    tone: 'amber',
    mark: 'MI',
    requiresApiKey: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-5.6', 'anthropic/claude-sonnet-4.5', 'deepseek/deepseek-v4-pro'],
    hint: { zh: '一个 key 调多家', en: 'One key, many vendors' },
    tone: 'violet',
    mark: 'OR',
    requiresApiKey: true,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen3:8b', 'llama3.1:8b'],
    hint: { zh: '本机运行，无需 API Key', en: 'Runs locally, no API key' },
    tone: 'slate',
    mark: 'OL',
    requiresApiKey: false,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: ['local-model'],
    hint: { zh: '本机运行，无需 API Key', en: 'Runs locally, no API key' },
    tone: 'slate',
    mark: 'LM',
    requiresApiKey: false,
  },
  {
    id: 'custom',
    name: '自定义 / Custom',
    baseUrl: '',
    models: [],
    hint: { zh: '任何 OpenAI 兼容接口', en: 'Any OpenAI-compatible endpoint' },
    tone: 'slate',
    mark: '＋',
    requiresApiKey: true,
  },
];

export function presetFor(providerId: string): ProviderPreset | null {
  if (!providerId) return null;
  return PROVIDER_PRESETS.find((preset) => preset.id === providerId) ?? null;
}

/** A new provider seeded from a vendor. `newId` is injected so this stays pure. */
export function createProviderFromPreset(
  preset: ProviderPreset,
  newId: () => string,
): AiProvider {
  return {
    id: newId(),
    providerId: preset.id,
    name: preset.name,
    baseUrl: preset.baseUrl,
    model: preset.models[0] ?? '',
    enabled: true,
  };
}

/** Loopback endpoints are the ones the runtime lets through without a key. */
export function isLoopbackEndpoint(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl.trim()).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Splits the configured providers into the ones that run on this machine and
 * the ones that do not.
 *
 * The test is where the endpoint points, not which vendor it came from: a
 * custom provider aimed at localhost is local, and it is the same rule the
 * runtime uses to decide whether a key is required. An endpoint that does not
 * parse counts as remote — the safer of the two, since it is the side that
 * demands a key.
 */
export function groupProviders<T extends { baseUrl: string }>(
  providers: T[],
): { local: T[]; remote: T[] } {
  const local: T[] = [];
  const remote: T[] = [];
  for (const provider of providers) {
    (isLoopbackEndpoint(provider.baseUrl) ? local : remote).push(provider);
  }
  return { local, remote };
}

export type ConnectionState =
  | 'noProvider'
  | 'unconfigured'
  | 'invalidUrl'
  | 'needsModel'
  | 'needsKey'
  | 'ready';

export function connectionState(
  provider: { baseUrl: string; model: string; apiKeyConfigured: boolean } | null,
): ConnectionState {
  if (!provider) return 'noProvider';

  const url = provider.baseUrl.trim();
  if (!url) return 'unconfigured';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalidUrl';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'invalidUrl';

  if (!provider.model.trim()) return 'needsModel';
  if (!provider.apiKeyConfigured && !isLoopbackEndpoint(url)) return 'needsKey';
  return 'ready';
}
