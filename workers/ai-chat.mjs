const GATEWAY_ID = 'demo-auto-router';
const LIMITS = { messageChars: 200000, contextChars: 240000, requestBytes: 1000000 };
const INFERENCE_TIMEOUT_MS = 120000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

function correlationId(value) {
  return typeof value === 'string' && /^[a-z0-9._-]{1,128}$/i.test(value) ? value : null;
}

function safeError(error) {
  const names = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'AbortError', 'InferenceUpstreamError', 'AiInternalError'];
  const code = error?.internalCode ?? error?.errors?.[0]?.code;
  const causeCode = error?.cause?.code ?? error?.code;
  const networkCodes = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'];
  return {
    error_name: names.includes(error?.name) ? error.name : 'Error',
    ...(Number.isSafeInteger(code) ? { internal_code: code } : {}),
    ...(networkCodes.includes(causeCode) ? { cause_code: causeCode } : {}),
  };
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
  } catch (error) {
    console.error({ event: 'stats.failed', stage: 'usage_stats', ...safeError(error) });
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
    const path = new URL(request.url).pathname;
    if (path === '/api/ai-stats') return usageStats(request, env, context);
    if (path !== '/api/ai-chat') return json({ error: 'Not found.' }, 404);
    const started = Date.now();
    const incomingId = request.headers.get('x-request-id');
    const requestId = UUID.test(incomingId || '') ? incomingId.toLowerCase() : crypto.randomUUID();
    const incomingParent = request.headers.get('x-retry-of');
    const retryOf = UUID.test(incomingParent || '') && incomingParent.toLowerCase() !== requestId ? incomingParent.toLowerCase() : null;
    const diagnostics = { request_id: requestId, gateway_id: GATEWAY_ID, cf_ray: correlationId(request.headers.get('cf-ray')), stage: 'request', timeout_ms: INFERENCE_TIMEOUT_MS, ...(retryOf ? { retry_of: retryOf } : {}) };
    const respond = (body, status = 200) => json({ ...body, requestId }, status, { 'x-request-id': requestId });
    const fail = (errorCode, error, status, extra = {}) => {
      const retryable = ['inference_timeout', 'upstream_timeout', 'upstream_aborted'].includes(errorCode) ||
        (errorCode === 'upstream_error' && [500, 502, 503, 504].includes(diagnostics.upstream_status)) ||
        (errorCode === 'upstream_unavailable' && (extra.internal_code === 3040 || Boolean(extra.cause_code)));
      console[status >= 500 ? 'error' : 'warn']({ ...diagnostics, ...extra, event: 'chat.failed', error_kind: errorCode, retryable, status, duration_ms: Date.now() - started });
      return respond({ error, errorCode, retryable }, status);
    };
    if (request.method !== 'POST') return fail('method_not_allowed', 'Use POST to send a chat message.', 405);
    if (!ORIGINS.has(request.headers.get('origin'))) return fail('origin_rejected', 'Please use the chat on the demo website.', 403);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return fail('unsupported_content_type', 'Send a JSON request.', 415);
    }
    let body;
    try {
      diagnostics.stage = 'rate_limit';
      const { success } = await env.CHAT_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
      if (!success) return fail('client_rate_limited', 'Please wait a minute before sending another message.', 429);
      diagnostics.stage = 'request_body';
      const text = await readBody(request);
      if (text === null) return fail('request_too_large', 'The encoded request exceeds 1 MB. Shorten the document or start a new chat.', 413);
      diagnostics.request_bytes = new TextEncoder().encode(text).byteLength;
      try {
        body = JSON.parse(text);
      } catch (error) {
        return fail('invalid_json', 'Send a valid JSON request.', 400, safeError(error));
      }
      diagnostics.stage = 'validation';
      if (!validMessages(body)) return fail('invalid_request', 'Send valid messages and a session ID. Each message can contain up to 200,000 characters, with 240,000 characters of conversation context.', 400);
    } catch (error) {
      return fail('request_processing_error', 'The chat service is temporarily unavailable. Please try again.', 503, safeError(error));
    }
    const sessionId = body.sessionId || crypto.randomUUID();
    let selectedModel = 'unreported';
    Object.assign(diagnostics, { session_id: sessionId, input_chars: body.messages.reduce((total, message) => total + message.content.length, 0), message_count: body.messages.length, stage: 'inference' });
    console.info({ ...diagnostics, event: 'chat.started' });
    let signal;

    try {
      signal = AbortSignal.timeout(INFERENCE_TIMEOUT_MS);
      const response = await env.AI.run('cloudflare/auto', {
        messages: [
          { role: 'system', content: 'You are a helpful assistant in a public Cloudflare AI Gateway demo. Answer questions clearly and concisely. You have no live browsing or tools. Do not claim to access private accounts or perform actions. Keep answers under 1,500 characters.' },
          ...body.messages.map(({ role, content }) => ({ role, content })),
        ],
        max_tokens: 4096,
      }, {
        gateway: { id: GATEWAY_ID, skipCache: true, collectLog: true, metadata: { demo: 'website-auto-router', app_conversation: sessionId, usage_tracking: 'v1', request_id: requestId, ...(retryOf ? { retry_of: retryOf } : {}) } },
        extraHeaders: {
          'cf-aig-allowed-providers': 'workers-ai',
          'cf-aig-allowed-models': MODELS.join(','),
          'cf-aig-no-session-affinity': 'true',
        },
        returnRawResponse: true,
        signal,
      });
      selectedModel = modelId(response.headers.get('cf-aig-routed-model'));
      Object.assign(diagnostics, {
        stage: 'upstream_response', model: selectedModel, upstream_status: response.status,
        gateway_log_id: correlationId(response.headers.get('cf-aig-log-id') || response.headers.get('cf-aig-request-id')),
        routing_decision_id: correlationId(response.headers.get('cf-aig-routing-decision-id')),
        routing_reason: correlationId(response.headers.get('cf-aig-routing-reason')),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) return fail('upstream_rate_limited', 'The demo has reached a request or spending limit. Please try again later.', 429);
        if ([408, 504].includes(response.status)) return fail('upstream_timeout', 'AI Gateway or the selected model timed out. Please try again.', 504);
        if ([400, 413].includes(response.status)) return fail('upstream_rejected', 'The model could not accept this request. Try a shorter conversation or start a new chat.', 400);
        return fail('upstream_error', 'AI Gateway could not complete this request. Please try again.', 502);
      }
      diagnostics.stage = 'response_body';
      const result = await response.json();
      if (selectedModel === 'unreported') selectedModel = modelId(result.model);
      const choice = result.choices?.[0];
      Object.assign(diagnostics, {
        model: selectedModel, stage: 'response_validation',
        finish_reason: ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(choice?.finish_reason) ? choice.finish_reason : null,
        tokens_in: Number.isSafeInteger(result.usage?.prompt_tokens) ? result.usage.prompt_tokens : null,
        tokens_out: Number.isSafeInteger(result.usage?.completion_tokens) ? result.usage.completion_tokens : null,
      });
      const reply = choice?.message?.content || result.response;
      if (typeof reply !== 'string' || !reply.trim()) {
        return diagnostics.finish_reason === 'length'
          ? fail('output_limit', 'The model exhausted its output budget before answering. Try a more focused question.', 502)
          : fail('empty_response', 'The model returned no answer. Please try a shorter question.', 502);
      }
      console.info({ ...diagnostics, event: 'chat.completed', stage: 'complete', status: 200, duration_ms: Date.now() - started, output_chars: reply.length });
      return respond({
        reply, sessionId,
        model: selectedModel === 'unreported' ? null : selectedModel,
        routingReason: diagnostics.routing_reason,
        decisionId: diagnostics.routing_decision_id,
        logId: diagnostics.gateway_log_id,
      });
    } catch (error) {
      const details = safeError(error);
      if (signal?.aborted || error?.name === 'TimeoutError') {
        return fail('inference_timeout', 'The AI request timed out. The app allows up to 120 seconds; please try again or shorten the question.', 504, details);
      }
      if (error?.name === 'AbortError') return fail('upstream_aborted', 'The upstream request was interrupted. Please try again.', 502, details);
      return diagnostics.stage === 'response_body'
        ? fail('invalid_upstream_response', 'AI Gateway returned an incomplete or invalid response. Please try again.', 502, details)
        : fail('upstream_unavailable', 'AI Gateway is temporarily unavailable. Please try again.', 502, details);
    } finally {
      const update = recordUsage(env, selectedModel).catch(error => console.error({ request_id: requestId, gateway_id: GATEWAY_ID, event: 'chat.metrics_failed', stage: 'usage_metrics', ...safeError(error) }));
      if (context?.waitUntil) context.waitUntil(update);
      else await update;
    }
  },
};
