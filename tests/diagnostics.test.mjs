import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../workers/ai-chat.mjs';

const sessionId = 'a361ca80-77e1-4cb6-9125-9436a10d245c';
const clientId = 'cc4c93af-8fe7-4ab3-b592-cdcf897f66d3';
const origin = 'https://demo.clarkmerrick.com';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let events;
const original = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, console[level]]));
test.beforeEach(() => {
  events = [];
  for (const level of Object.keys(original)) console[level] = data => events.push({ level, data });
});
test.afterEach(() => Object.assign(console, original));

function request(messages = [{ role: 'user', content: 'PRIVATE_PROMPT' }], requestId = clientId) {
  return new Request(`${origin}/api/ai-chat?secret=PRIVATE_QUERY`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-request-id': requestId,
      authorization: 'Bearer PRIVATE_TOKEN', cookie: 'PRIVATE_COOKIE', 'cf-connecting-ip': '192.0.2.99', 'cf-ray': '0123456789abcdef-SJC' },
    body: JSON.stringify({ messages, sessionId }),
  });
}

function setup({ mode = 'ok', upstreamStatus = 200, reply = 'Answer', finishReason = 'stop' } = {}) {
  const calls = [];
  const env = {
    CHAT_LIMITER: { limit: async () => {
      if (mode === 'limiter') throw new Error('PRIVATE_LIMITER_DETAIL');
      return { success: true };
    } },
    AI: { run: async (...args) => {
      calls.push(args);
      if (mode === 'timeout') throw new DOMException('PRIVATE_TIMEOUT_DETAIL', 'TimeoutError');
      if (mode === 'aborted') throw new DOMException('PRIVATE_ABORT_DETAIL', 'AbortError');
      if (mode === 'transport') throw Object.assign(new Error('PRIVATE_UPSTREAM_DETAIL'), { internalCode: 3040, cause: { code: 'ECONNRESET', message: 'PRIVATE_CAUSE' } });
      const headers = { 'cf-aig-routed-model': '@cf/openai/gpt-oss-20b', 'cf-aig-log-id': 'gateway-log-123', 'cf-aig-routing-decision-id': 'decision-123', 'cf-aig-routing-reason': 'cost_optimal_within_pool' };
      if (mode === 'invalid_json') return new Response('PRIVATE_INVALID_JSON', { headers });
      return Response.json({ choices: [{ message: { content: reply }, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 4096 } }, { status: upstreamStatus, headers });
    } },
  };
  return { calls, env };
}

function failedEvent() {
  return events.find(entry => entry.data?.event === 'chat.failed')?.data;
}

function assertPrivate() {
  const logs = JSON.stringify(events);
  assert.ok(!logs.includes('PRIVATE_'));
  assert.ok(!logs.includes('192.0.2.99'));
  assert.ok(!logs.includes('"messages"'));
}

test('a client request ID correlates the response, Worker events, and gateway metadata', async () => {
  const { env, calls } = setup();
  const response = await worker.fetch(request(), env);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.requestId, clientId);
  assert.equal(response.headers.get('x-request-id'), clientId);
  assert.equal(calls[0][2].gateway.metadata.request_id, clientId);
  const start = events.find(entry => entry.data?.event === 'chat.started').data;
  const complete = events.find(entry => entry.data?.event === 'chat.completed').data;
  assert.equal(start.timeout_ms, 120000);
  assert.equal(complete.request_id, clientId);
  assert.equal(complete.session_id, sessionId);
  assert.equal(complete.gateway_log_id, 'gateway-log-123');
  assert.equal(complete.cf_ray, '0123456789abcdef-SJC');
  assert.equal(complete.tokens_out, 4096);
  assert.ok(complete.duration_ms >= 0);
  assertPrivate();
});

test('timeouts have a specific 504 response and searchable private diagnostics', async () => {
  const { env } = setup({ mode: 'timeout' });
  const response = await worker.fetch(request(), env);
  const result = await response.json();
  assert.equal(response.status, 504);
  assert.equal(result.errorCode, 'inference_timeout');
  assert.equal(result.retryable, true);
  assert.equal(failedEvent().retryable, true);
  assert.equal(result.requestId, clientId);
  assert.match(result.error, /120 seconds/);
  assert.equal(failedEvent().error_name, 'TimeoutError');
  assert.equal(failedEvent().error_kind, 'inference_timeout');
  assertPrivate();
});

test('transport errors preserve safe numeric error codes, not exception text', async () => {
  const { env } = setup({ mode: 'transport' });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).errorCode, 'upstream_unavailable');
  assert.equal(failedEvent().internal_code, 3040);
  assert.equal(failedEvent().cause_code, 'ECONNRESET');
  assertPrivate();
});

test('an upstream abort is not mislabeled as the app deadline expiring', async () => {
  const { env } = setup({ mode: 'aborted' });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).errorCode, 'upstream_aborted');
  assert.equal(failedEvent().error_name, 'AbortError');
  assertPrivate();
});

test('invalid upstream JSON is distinguishable from a timeout', async () => {
  const { env } = setup({ mode: 'invalid_json' });
  const response = await worker.fetch(request(), env);
  assert.equal((await response.json()).errorCode, 'invalid_upstream_response');
  assert.equal(failedEvent().stage, 'response_body');
  assert.equal(failedEvent().gateway_log_id, 'gateway-log-123');
  assertPrivate();
});

test('upstream HTTP failures retain their status in logs without exposing the body', async () => {
  const { env } = setup({ upstreamStatus: 503, reply: 'PRIVATE_RESPONSE' });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).errorCode, 'upstream_error');
  assert.equal(failedEvent().upstream_status, 503);
  assertPrivate();
});

test('empty answers caused by an output limit have their own error category', async () => {
  const { env } = setup({ reply: '', finishReason: 'length' });
  const response = await worker.fetch(request(), env);
  assert.equal((await response.json()).errorCode, 'output_limit');
  assert.equal(failedEvent().finish_reason, 'length');
  assert.equal(failedEvent().tokens_out, 4096);
  assertPrivate();
});

test('rejected requests and infrastructure exceptions can also be traced', async () => {
  const { env, calls } = setup();
  const response = await worker.fetch(request([]), env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).requestId, clientId);
  assert.equal(failedEvent().error_kind, 'invalid_request');
  assert.equal(calls.length, 0);
  events = [];
  const unavailable = setup({ mode: 'limiter' });
  const result = await worker.fetch(request(), unavailable.env);
  assert.equal(result.status, 503);
  assert.equal(failedEvent().stage, 'rate_limit');
  assertPrivate();
});

test('untrusted request IDs are replaced rather than logged or reflected', async () => {
  const { env } = setup();
  const response = await worker.fetch(request(undefined, 'PRIVATE_BAD_ID'), env);
  const result = await response.json();
  assert.match(result.requestId, uuid);
  assertPrivate();
});

test('only known temporary failures are marked retryable', async () => {
  for (const upstreamStatus of [408, 500, 502, 503, 504]) {
    const { env } = setup({ upstreamStatus });
    const result = await (await worker.fetch(request(), env)).json();
    assert.equal(result.retryable, true, String(upstreamStatus));
  }
  for (const upstreamStatus of [400, 401, 403, 404, 413, 429, 501]) {
    const { env } = setup({ upstreamStatus });
    const result = await (await worker.fetch(request(), env)).json();
    assert.equal(result.retryable, false, String(upstreamStatus));
  }
  for (const options of [{ reply: '' }, { reply: '', finishReason: 'length' }]) {
    const { env } = setup(options);
    assert.equal((await (await worker.fetch(request(), env)).json()).retryable, false);
  }
  const { env } = setup({ mode: 'transport' });
  assert.equal((await (await worker.fetch(request(), env)).json()).retryable, true);
});

test('a validated retry parent is correlated without pinning or expanding the model pool', async () => {
  const parentId = 'a2a4d6fc-4db4-4c58-9185-fb51b07e1a50';
  const { env, calls } = setup();
  const retry = request();
  retry.headers.set('x-retry-of', parentId);
  assert.equal((await worker.fetch(retry, env)).status, 200);
  assert.equal(calls[0][0], 'cloudflare/auto');
  assert.equal(calls[0][2].gateway.metadata.retry_of, parentId);
  assert.equal(Object.keys(calls[0][2].gateway.metadata).length, 5);
  assert.equal(calls[0][2].extraHeaders['cf-aig-no-session-affinity'], 'true');
  assert.equal(events.find(entry => entry.data?.event === 'chat.completed').data.retry_of, parentId);
  events = [];
  const invalid = request();
  invalid.headers.set('x-retry-of', 'PRIVATE_BAD_RETRY');
  await worker.fetch(invalid, env);
  assert.equal(calls[1][2].gateway.metadata.retry_of, undefined);
  assertPrivate();
});

test('Workers Logs persist diagnostics without raw HTTP invocation snapshots', () => {
  const config = JSON.parse(readFileSync(new URL('../.devin/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.observability.enabled, true);
  assert.equal(config.observability.head_sampling_rate, 1);
  assert.equal(config.observability.redact_query_string, true);
  assert.equal(config.observability.logs.enabled, true);
  assert.equal(config.observability.logs.invocation_logs, false);
  assert.equal(config.observability.logs.persist, true);
});
