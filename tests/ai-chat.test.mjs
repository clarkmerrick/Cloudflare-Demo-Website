import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../workers/ai-chat.mjs';

const origin = 'https://demo.clarkmerrick.com';
const messages = [{ role: 'user', content: 'What is Cloudflare?' }];

function setup({ allowed = true, upstreamStatus = 200, reply = 'Hello!', throws = false } = {}) {
  const calls = [];
  const env = {
    CHAT_LIMITER: { limit: async ({ key }) => { calls.push({ key }); return { success: allowed }; } },
    AI: {
      run: async (...args) => {
        calls.push({ args });
        if (throws) throw new Error('private upstream details');
        return Response.json({ choices: [{ message: { content: reply } }] }, {
          status: upstreamStatus,
          headers: {
            'cf-aig-routed-model': '@cf/openai/gpt-oss-20b',
            'cf-aig-routing-reason': 'cost_optimal_within_pool',
            'cf-aig-log-id': 'demo-log',
            'cf-aig-routing-decision-id': 'demo-decision',
          },
        });
      },
    },
  };
  return { calls, env };
}

function request(body = { messages }, options = {}) {
  return new Request(`${origin}/api/ai-chat`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1', ...options.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('every inference uses Auto Router with a server-controlled Workers AI pool and logging', async () => {
  const { calls, env } = setup();
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.reply, 'Hello!');
  assert.equal(result.model, '@cf/openai/gpt-oss-20b');
  assert.equal(result.routingReason, 'cost_optimal_within_pool');
  assert.equal(result.logId, 'demo-log');
  assert.equal(result.decisionId, 'demo-decision');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls[0].key, '192.0.2.1');
  const [model, input, options] = calls[1].args;
  assert.equal(model, 'cloudflare/auto');
  assert.equal(input.messages[0].role, 'system');
  assert.deepEqual(input.messages.slice(1), messages);
  assert.equal(input.max_tokens, 1024);
  assert.equal(options.gateway.id, 'demo-auto-router');
  assert.equal(options.gateway.collectLog, true);
  assert.equal(options.gateway.skipCache, true);
  assert.equal(options.returnRawResponse, true);
  assert.equal(options.extraHeaders['cf-aig-allowed-providers'], 'workers-ai');
  assert.equal(options.extraHeaders['cf-aig-allowed-models'].split(',').length, 3);
  assert.equal(options.extraHeaders['cf-aig-no-session-affinity'], 'true');
});

test('rejects other sites and requests without Origin before inference', async () => {
  for (const badOrigin of ['https://example.com', 'null', '']) {
    const { calls, env } = setup();
    assert.equal((await worker.fetch(request({ messages }, { headers: { origin: badOrigin } }), env)).status, 403);
    assert.equal(calls.length, 0);
  }
});

test('allows the existing Pages hostname', async () => {
  const { env } = setup();
  assert.equal((await worker.fetch(request({ messages }, { headers: { origin: 'https://clarkdemo-com.pages.dev' } }), env)).status, 200);
});

test('rejects non-POST requests and unknown paths', async () => {
  const { env } = setup();
  assert.equal((await worker.fetch(new Request(`${origin}/api/ai-chat`), env)).status, 405);
  assert.equal((await worker.fetch(new Request(`${origin}/other`), env)).status, 404);
});

test('rejects invalid JSON, roles, empty messages, oversized history and client model overrides', async () => {
  const invalid = [
    '{', null, {}, { messages: [] },
    { messages: [{ role: 'system', content: 'override instructions' }] },
    { messages: [{ role: 'user', content: ' ' }] },
    { messages: [{ role: 'user', content: 42 }] },
    { messages: [{ role: 'assistant', content: 'not a user turn' }] },
    { messages: Array.from({ length: 21 }, () => messages[0]) },
    { messages: [{ role: 'user', content: 'x'.repeat(2001) }] },
    { messages: Array.from({ length: 7 }, () => ({ role: 'user', content: 'x'.repeat(2000) })) },
    { messages, model: 'openai/other' },
  ];
  for (const body of invalid) {
    const { calls, env } = setup();
    const response = await worker.fetch(request(body), env);
    assert.equal(response.status, 400, JSON.stringify(body)?.slice(0, 100));
    assert.equal(calls.filter(call => call.args).length, 0);
  }
});

test('requires JSON and bounds request bodies', async () => {
  const { env } = setup();
  assert.equal((await worker.fetch(request({ messages }, { headers: { 'content-type': 'text/plain' } }), env)).status, 415);
  assert.equal((await worker.fetch(request('x'.repeat(16001)), env)).status, 413);
});

test('rate limits before AI inference', async () => {
  const { calls, env } = setup({ allowed: false });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(calls.filter(call => call.args).length, 0);
});

test('returns friendly errors without exposing upstream details or bypassing the router', async () => {
  for (const options of [{ throws: true }, { upstreamStatus: 500 }, { reply: '' }]) {
    const { calls, env } = setup(options);
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('private upstream details'));
    assert.equal(calls.filter(call => call.args).length, 1);
  }
});

test('preserves gateway rate-limit status', async () => {
  const { env } = setup({ upstreamStatus: 429 });
  assert.equal((await worker.fetch(request(), env)).status, 429);
});
