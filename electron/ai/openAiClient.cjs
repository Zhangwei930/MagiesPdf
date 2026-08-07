'use strict';

class AiError extends Error {
  constructor(code, message, userMessage) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.userMessage = userMessage || {
      zh: 'AI 请求失败。',
      en: 'The AI request failed.',
    };
  }
}

function chatCompletionsUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl).trim());
  } catch {
    throw new AiError('AI_CONFIG_INVALID', 'AI base URL must be a valid HTTP(S) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AiError('AI_CONFIG_INVALID', 'AI base URL must use HTTP or HTTPS');
  }
  const normalized = parsed.href.replace(/\/+$/, '');
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

function isLoopbackUrl(value) {
  const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function mergeToolCall(target, delta) {
  if (typeof delta.id === 'string') target.id = delta.id;
  if (typeof delta.type === 'string') target.type = delta.type;
  if (delta.function) {
    if (typeof delta.function.name === 'string') {
      target.function.name += delta.function.name;
    }
    if (typeof delta.function.arguments === 'string') {
      target.function.arguments += delta.function.arguments;
    }
  }
}

async function parseEventStream(response, onTextDelta = () => {}) {
  if (!response.body) {
    throw new AiError('AI_PROVIDER_ERROR', 'AI provider returned an empty response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = new Map();

  const consumeFrame = (frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') return;

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new AiError('AI_PROVIDER_ERROR', 'AI provider returned malformed event-stream JSON');
    }
    if (payload.error) {
      throw new AiError('AI_PROVIDER_ERROR', payload.error.message || 'AI provider returned an error');
    }

    const delta = payload.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string') {
      content += delta.content;
      onTextDelta(delta.content);
    }
    for (const callDelta of delta.tool_calls || []) {
      const index = Number.isInteger(callDelta.index) ? callDelta.index : 0;
      const current = toolCalls.get(index) || {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      };
      mergeToolCall(current, callDelta);
      toolCalls.set(index, current);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) consumeFrame(frame);
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);

  return { content, tool_calls: [...toolCalls.values()] };
}

async function providerError(response) {
  const text = (await response.text()).slice(0, 4096);
  let message = text || `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text);
    message = parsed.error?.message || parsed.message || message;
  } catch {
    // Plain-text provider errors are already useful.
  }
  return new AiError('AI_PROVIDER_ERROR', `AI provider rejected the request: ${message}`, {
    zh: `模型服务请求失败（HTTP ${response.status}）。`,
    en: `The model provider rejected the request (HTTP ${response.status}).`,
  });
}

class OpenAiCompatibleClient {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  async streamMessage({
    baseUrl,
    apiKey,
    model,
    messages,
    tools = [],
    reasoningEffort = '',
    signal,
    onTextDelta,
  }) {
    const url = chatCompletionsUrl(baseUrl);
    if (!String(model || '').trim()) {
      throw new AiError('AI_CONFIG_INVALID', 'AI model is required');
    }
    if (!apiKey && !isLoopbackUrl(url)) {
      throw new AiError('AI_CONFIG_INVALID', 'An API key is required for a remote AI endpoint', {
        zh: '远程模型服务需要 API Key。',
        en: 'An API key is required for a remote model provider.',
      });
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: String(model).trim(),
          messages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? 'auto' : undefined,
          // Omitted unless chosen: a provider that does not know the field
          // rejects the whole request rather than ignoring it.
          reasoning_effort: reasoningEffort || undefined,
          stream: true,
        }),
        signal,
      });
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      throw new AiError(
        'AI_PROVIDER_ERROR',
        `Could not reach AI provider: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!response.ok) throw await providerError(response);

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      if (payload.error) throw new AiError('AI_PROVIDER_ERROR', payload.error.message || 'AI provider error');
      const message = payload.choices?.[0]?.message;
      if (!message) throw new AiError('AI_PROVIDER_ERROR', 'AI provider returned no message');
      if (message.content) onTextDelta?.(message.content);
      return { content: message.content || '', tool_calls: message.tool_calls || [] };
    }
    return parseEventStream(response, onTextDelta);
  }
}

module.exports = {
  AiError,
  OpenAiCompatibleClient,
  chatCompletionsUrl,
  isLoopbackUrl,
  parseEventStream,
};
