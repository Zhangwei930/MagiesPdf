const assert = require('node:assert/strict');
const { ReadableStream } = require('node:stream/web');
const { describe, it } = require('node:test');

const {
  OpenAiCompatibleClient,
  chatCompletionsUrl,
  parseEventStream,
} = require('./openAiClient.cjs');

function responseFromChunks(chunks, init = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new globalThis.Response(stream, { status: 200, ...init });
}

describe('OpenAI-compatible streaming client', () => {
  it('sends reasoning_effort only when one is chosen', async () => {
    const bodies = [];
    const client = new OpenAiCompatibleClient({
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return responseFromChunks(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
      },
    });

    const call = { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'local', messages: [] };
    await client.streamMessage(call);
    await client.streamMessage({ ...call, reasoningEffort: 'high' });

    // A provider that does not know the field rejects the whole request, so it
    // must be absent rather than null when the user has not chosen one.
    assert.equal('reasoning_effort' in bodies[0], false);
    assert.equal(bodies[1].reasoning_effort, 'high');
  });

  it('normalizes base URLs without duplicating the endpoint', () => {
    assert.equal(chatCompletionsUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
    assert.equal(
      chatCompletionsUrl('https://api.example.com/v1/chat/completions'),
      'https://api.example.com/v1/chat/completions',
    );
  });

  it('parses split SSE frames and reconstructs streamed tool calls', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"正在"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"处理","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"convert__pdf-to-text","arguments":"{\\"input_"}}]}}]}\n',
      '\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"file_ids\\":[\\"file-1\\"]}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const deltas = [];
    const message = await parseEventStream(responseFromChunks(chunks), (delta) => deltas.push(delta));

    assert.equal(message.content, '正在处理');
    assert.deepEqual(deltas, ['正在', '处理']);
    assert.deepEqual(message.tool_calls, [
      {
        id: 'call-1',
        type: 'function',
        function: {
          name: 'convert__pdf-to-text',
          arguments: '{"input_file_ids":["file-1"]}',
        },
      },
    ]);
  });

  it('requires an API key for a remote endpoint but permits loopback models', async () => {
    const remote = new OpenAiCompatibleClient({
      fetchImpl: async () => responseFromChunks(['data: [DONE]\n\n']),
    });
    await assert.rejects(
      remote.streamMessage({ baseUrl: 'https://api.example.com/v1', apiKey: '', model: 'model', messages: [] }),
      (error) => error.code === 'AI_CONFIG_INVALID',
    );

    let authorization = 'unset';
    const local = new OpenAiCompatibleClient({
      fetchImpl: async (_url, init) => {
        authorization = init.headers.Authorization;
        return responseFromChunks(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n']);
      },
    });
    const result = await local.streamMessage({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'local',
      messages: [],
    });
    assert.equal(result.content, 'ok');
    assert.equal(authorization, undefined);
  });

  it('surfaces provider errors with a typed code', async () => {
    const client = new OpenAiCompatibleClient({
      fetchImpl: async () => new globalThis.Response('{"error":{"message":"bad key"}}', { status: 401 }),
    });
    await assert.rejects(
      client.streamMessage({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret',
        model: 'model',
        messages: [],
      }),
      (error) => error.code === 'AI_PROVIDER_ERROR' && /bad key/.test(error.message),
    );
  });
});
