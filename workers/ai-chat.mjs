const GATEWAY_ID = 'demo-auto-router';
const LIMITS = { messageChars: 200000, contextChars: 240000, requestBytes: 1000000 };
const MODELS = [
  '@cf/openai/gpt-oss-20b',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
  '@cf/deepseek-ai/deepseek-v4-pro-0813',
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/qwen/qwen3.8-27b',
  '@cf/zai-org/glm-5.2',
];
const ORIGINS = new Set(['https://demo.clarkmerrick.com', 'https://clarkdemo-com.pages.dev']);

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(status === 429 ? { 'retry-after': '60' } : {}),
      ...headers,
    },
  });
}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LIMITS.requestBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function modelId(value) {
  const model = typeof value === 'string' ? value.replace(/^workers-ai\//, '') : '';
  return MODELS.includes(model) ? model : 'unreported';
}

async function recordUsage(env, model) {
  if (!env.USAGE_DB) return;
  const hour = Math.floor(Date.now() / 3600000) * 3600000;
  await env.USAGE_DB.prepare(
    "INSERT INTO model_usage (hour, model, source, requests) VALUES (?, ?, 'live', 1) " +
    'ON CONFLICT (hour, model, source) DO UPDATE SET requests = requests + 1'
  ).bind(hour, model).run();
}

async function usageStats(request, env, context) {
  if (request.method !== 'GET') return json({ error: 'Use GET to read aggregate statistics.' }, 405);
  try {
    const cache = globalThis.caches?.default;
    const key = new Request(new URL('/api/ai-stats', request.url));
    const cached = await cache?.match(key);
    if (cached) return cached;
    const now = Date.now();
    const lastHour = Math.floor(now / 3600000) * 3600000;
    const firstHour = lastHour - 23 * 3600000;
    const { results } = await env.USAGE_DB.prepare(
      'SELECT hour, model, SUM(requests) AS requests FROM model_usage ' +
      'WHERE hour >= ? AND hour <= ? GROUP BY hour, model ORDER BY hour, model'
    ).bind(firstHour, lastHour).all();
    const hours = Array.from({ length: 24 }, (_, index) => ({ hour: new Date(firstHour + index * 3600000).toISOString(), requests: 0 }));
    const counts = new Map(MODELS.map(model => [model, 0]));
    let totalRequests = 0;
    for (const row of results) {
      const index = (Number(row.hour) - firstHour) / 3600000;
      const count = Number(row.requests);
      if (!Number.isInteger(index) || index < 0 || index >= 24 || !Number.isSafeInteger(count) || count < 0) continue;
      const model = modelId(row.model);
      counts.set(model, (counts.get(model) || 0) + count);
      hours[index].requests += count;
      totalRequests += count;
    }
    const models = Array.from(counts, ([model, requests]) => ({
      model, requests, percentage: totalRequests ? Math.round(requests / totalRequests * 1000) / 10 : 0,
    })).sort((a, b) => b.requests - a.requests);
    const response = json({ totalRequests, hours, models, windowStart: new Date(firstHour).toISOString(), windowEnd: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }, 200, { 'cache-control': 'public, max-age=60' });
    if (cache) {
      const update = cache.put(key, response.clone());
      if (context?.waitUntil) context.waitUntil(update);
      else await update;
    }
    return response;
  } catch {
    return json({ error: 'Usage statistics are temporarily unavailable.' }, 503);
  }
}

function validMessages(body) {
  if (!body || Object.keys(body).some(key => !['messages', 'sessionId'].includes(key)) || !Array.isArray(body.messages)) return false;
  if (body.sessionId !== undefined && (typeof body.sessionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.sessionId))) return false;
  const { messages } = body;
  return messages.length > 0 && messages.length <= 20 &&
    messages.at(-1)?.role === 'user' &&
    messages.every(message => message && ['user', 'assistant'].includes(message.role) &&
      typeof message.content === 'string' && message.content.trim().length > 0 && message.content.length <= LIMITS.messageChars) &&
    messages.reduce((total, message) => total + message.content.length, 0) <= LIMITS.contextChars;
}

export default {
  async fetch(request, env, context) {
    if (new URL(request.url).pathname === '/api/ai-stats') return usageStats(request, env, context);
    if (new URL(request.url).pathname !== '/api/ai-chat') return json({ error: 'Not found.' }, 404);
    if (request.method !== 'POST') return json({ error: 'Use POST to send a chat message.' }, 405);
    if (!ORIGINS.has(request.headers.get('origin'))) return json({ error: 'Please use the chat on the demo website.' }, 403);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return json({ error: 'Send a JSON request.' }, 415);
    }
    const { success } = await env.CHAT_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
    if (!success) return json({ error: 'Please wait a minute before sending another message.' }, 429);
    const text = await readBody(request);
    if (text === null) return json({ error: 'The encoded request exceeds 1 MB. Shorten the document or start a new chat.' }, 413);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'Send a valid JSON request.' }, 400);
    }
    if (!validMessages(body)) return json({ error: 'Send valid messages and a session ID. Each message can contain up to 200,000 characters, with 240,000 characters of conversation context.' }, 400);
    const sessionId = body.sessionId || crypto.randomUUID();
    let selectedModel = 'unreported';

    try {
      const response = await env.AI.run('cloudflare/auto', {
        messages: [
          { role: 'system', content: 'You are a helpful assistant in a public Cloudflare AI Gateway demo. Answer questions clearly and concisely. You have no live browsing or tools. Do not claim to access private accounts or perform actions. Keep answers under 1,500 characters.' },
          ...body.messages.map(({ role, content }) => ({ role, content })),
        ],
        max_tokens: 4096,
      }, {
        gateway: { id: GATEWAY_ID, skipCache: true, collectLog: true, metadata: { demo: 'website-auto-router', session_id: sessionId, usage_tracking: 'v1' } },
        extraHeaders: {
          'cf-aig-session-id': sessionId,
          'cf-aig-allowed-providers': 'workers-ai',
          'cf-aig-allowed-models': MODELS.join(','),
          'cf-aig-no-session-affinity': 'true',
        },
        returnRawResponse: true,
        signal: AbortSignal.timeout(60000),
      });
      selectedModel = modelId(response.headers.get('cf-aig-routed-model'));
      if (!response.ok) {
        await response.body?.cancel();
        return response.status === 429
          ? json({ error: 'The demo has reached a request or spending limit. Please try again later.' }, 429)
          : json({ error: 'AI Gateway could not complete this request. Please try again.' }, 502);
      }
      const result = await response.json();
      if (selectedModel === 'unreported') selectedModel = modelId(result.model);
      const reply = result.choices?.[0]?.message?.content || result.response;
      if (typeof reply !== 'string' || !reply.trim()) return json({ error: 'The model returned no answer. Please try a shorter question.' }, 502);
      return json({
        reply,
        sessionId,
        model: selectedModel === 'unreported' ? null : selectedModel,
        routingReason: response.headers.get('cf-aig-routing-reason'),
        decisionId: response.headers.get('cf-aig-routing-decision-id'),
        logId: response.headers.get('cf-aig-log-id') || response.headers.get('cf-aig-request-id') || null,
      });
    } catch {
      return json({ error: 'AI Gateway is taking too long or is unavailable. Please try again.' }, 502);
    } finally {
      const update = recordUsage(env, selectedModel).catch(() => console.error('Could not record aggregate chat usage.'));
      if (context?.waitUntil) context.waitUntil(update);
      else await update;
    }
  },
};
