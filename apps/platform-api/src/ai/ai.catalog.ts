export const AI_PROVIDERS = ['ollama', 'openai', 'anthropic', 'openai_compat'] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

export type AiTransport = 'holmes' | 'openai' | 'anthropic' | 'openai_compat';

export type AiServiceDef = {
  id: string;
  label: string;
  transport: AiTransport;
  models: string[];
  defaultModel: string;
  baseUrl?: string;
  keyEnv: string[];
  hint: string;
};

export const AI_SERVICES: AiServiceDef[] = [
  {
    id: 'ollama',
    label: 'Ollama (local)',
    transport: 'holmes',
    models: ['qwen2.5:14b', 'qwen2.5:7b'],
    defaultModel: 'qwen2.5:14b',
    keyEnv: [],
    hint: 'Qwen en esta Mac. No requiere clave.',
  },
  {
    id: 'openai',
    label: 'OpenAI (ChatGPT API)',
    transport: 'openai',
    models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'],
    defaultModel: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: ['OPENAI_API_KEY'],
    hint: 'Pegue la clave sk- y elija el modelo.',
  },
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    transport: 'anthropic',
    models: ['claude-sonnet-4-5', 'claude-opus-4-5'],
    defaultModel: 'claude-sonnet-4-5',
    keyEnv: ['ANTHROPIC_API_KEY'],
    hint: 'Pegue la clave sk-ant- y elija el modelo.',
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    transport: 'openai_compat',
    models: ['kimi-k3', 'kimi-k2.5'],
    defaultModel: 'kimi-k3',
    baseUrl: 'https://api.moonshot.ai/v1',
    keyEnv: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    hint: 'Pegue la clave de Moonshot y elija el modelo.',
  },
  {
    id: 'grok',
    label: 'Grok (xAI)',
    transport: 'openai_compat',
    models: ['grok-4.6', 'grok-4'],
    defaultModel: 'grok-4.6',
    baseUrl: 'https://api.x.ai/v1',
    keyEnv: ['XAI_API_KEY'],
    hint: 'Pegue la clave de xAI y elija el modelo.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    transport: 'openai_compat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    keyEnv: ['DEEPSEEK_API_KEY'],
    hint: 'Pegue la clave de DeepSeek y elija el modelo.',
  },
  {
    id: 'openai_compat',
    label: 'Otro (OpenAI compatible)',
    transport: 'openai_compat',
    models: [],
    defaultModel: '',
    keyEnv: ['AI_COMPAT_API_KEY', 'AI_COMPAT_BASE_URL'],
    hint: 'OpenRouter, OpenClaw o Azure: URL base y clave.',
  },
];

export const HOLMES_MODEL_KEYS: Record<AiProvider, string> = {
  ollama: 'qwen2.5:14b',
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-sonnet-4-5',
  openai_compat: 'openai-compatible',
};

export function isAiProvider(value: string): value is AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

export function findService(id?: string): AiServiceDef | undefined {
  if (!id?.trim()) {
    return undefined;
  }
  return AI_SERVICES.find((item) => item.id === id.trim());
}
