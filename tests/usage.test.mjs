import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../workers/ai-chat.mjs';

const origin = 'https://demo.clarkmerrick.com';
const hour = Math.floor(Date.now() / 3600000) * 3600000;
const model = '@cf/deepseek-ai/deepseek-v4-flash-0731';
const sessionId = 'a361ca80-77e1-4cb6-9125-9436a10d245c';

test.beforeEach(() => {
  for (const level of ['info', 'warn', 'error']) mock.method(console, level, () => {});
});
test.afterEach(() => mock.restoreAll());

function setup(rows = [], { readFails = false, writeFails = false, aiFails = false } = {}) {
  const writes = [];
  const env = {
    CHAT_LIMITER: { limit: async () => ({ success: true }) },
    AI: { run: async () => {
      if (aiFails) throw new Error('private upstream detail');
      return Response.json({ choices: [{ message: { content: 'An answer' } }] }, { headers: { 'cf-aig-routed-model': model } });
    } },
    USAGE_DB: { prepare: sql => ({ bind: (...params) => ({
      all: async () => {
        if (readFails) throw new Error('private database detail');
        assert.match(sql, /GROUP BY hour, model/);
        assert.equal(params.length, 2);
        return { results: rows };
      },
      run: async () => {
        writes.push({ sql, params });
        if (writeFails) throw new Error('private database detail');
        return { success: true };
      },
    }) }) },
  };
  return { env, writes };
}

function chat(messages = [{ role: 'user', content: 'Private document text' }]) {
  return new Request(`${origin}/api/ai-chat`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ messages, sessionId }),
  });
}

test('public statistics contain only model counts and hourly aggregates', async () => {
  const { env } = setup([
    { hour, model, requests: 6, prompt: 'PRIVATE_PROMPT', session_id: 'PRIVATE_SESSION' },
    { hour: hour - 3600000, model: '@cf/qwen/qwen3.8-27b', requests: 4 },
  ]);
  const response = await worker.fetch(new Request(`${origin}/api/ai-stats`), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /public.*max-age=60/);
  const text = await response.text();
  assert.ok(!text.includes('PRIVATE_'));
  const result = JSON.parse(text);
  assert.deepEqual(Object.keys(result).sort(), ['hours', 'models', 'totalRequests', 'updatedAt', 'windowEnd', 'windowStart']);
  assert.equal(result.totalRequests, 10);
  assert.equal(result.hours.length, 24);
  assert.equal(result.models.find(row => row.model === model).percentage, 60);
  assert.equal(result.models.find(row => row.model === '@cf/qwen/qwen3.8-27b').percentage, 40);
  assert.equal(result.hours.reduce((sum, row) => sum + row.requests, 0), 10);
});

test('empty statistics show zero rather than fake traffic', async () => {
  const { env } = setup();
  const result = await (await worker.fetch(new Request(`${origin}/api/ai-stats`), env)).json();
  assert.equal(result.totalRequests, 0);
  assert.equal(result.models.length, 7);
  assert.ok(result.models.every(row => row.percentage === 0));
});

test('unknown model identifiers are grouped without leaking their text', async () => {
  const { env } = setup([{ hour, model: 'PRIVATE_UNKNOWN_VALUE', requests: 2 }]);
  const response = await worker.fetch(new Request(`${origin}/api/ai-stats`), env);
  const text = await response.text();
  assert.ok(!text.includes('PRIVATE_UNKNOWN_VALUE'));
  assert.equal(JSON.parse(text).models.find(row => row.model === 'unreported').requests, 2);
});

test('statistics reject writes and fail safely when the database is unavailable', async () => {
  const { env } = setup([], { readFails: true });
  assert.equal((await worker.fetch(new Request(`${origin}/api/ai-stats`, { method: 'POST' }), env)).status, 405);
  const response = await worker.fetch(new Request(`${origin}/api/ai-stats`), env);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('private database detail'));
});

test('chat metrics write only the hour and selected model, never content or identifiers', async () => {
  const { env, writes } = setup();
  assert.equal((await worker.fetch(chat(), env)).status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].params[1], model);
  assert.equal(writes[0].params.length, 2);
  assert.match(writes[0].sql, /ON CONFLICT/);
  assert.ok(!JSON.stringify(writes).includes('Private document text'));
  assert.ok(!JSON.stringify(writes).includes(sessionId));
});

test('upstream failures count as unreported attempts; invalid requests do not count', async () => {
  const { env, writes } = setup([], { aiFails: true });
  assert.equal((await worker.fetch(chat(), env)).status, 502);
  assert.equal(writes[0].params[1], 'unreported');
  assert.equal((await worker.fetch(chat([]), env)).status, 400);
  assert.equal(writes.length, 1);
});

test('a metrics write failure cannot break a successful AI reply', async () => {
  const { env } = setup([], { writeFails: true });
  const original = console.error;
  const errors = [];
  console.error = message => errors.push(message);
  try {
    assert.equal((await worker.fetch(chat(), env)).status, 200);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].event, 'chat.metrics_failed');
    assert.ok(!JSON.stringify(errors[0]).includes('private database detail'));
  } finally {
    console.error = original;
  }
});
