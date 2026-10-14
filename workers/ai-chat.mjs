const GATEWAY_ID = 'demo-auto-router';
const MODELS = [
  '@cf/openai/gpt-oss-20b',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
];
const ORIGINS = new Set(['https://demo.clarkmerrick.com', 'https://clarkdemo-com.pages.dev']);

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(status === 429 ? { 'retry-after': '60' } : {}),
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
    if (size > 16000) {
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

function validMessages(body) {
  if (!body || Object.keys(body).some(key => !['messages', 'sessionId'].includes(key)) || !Array.isArray(body.messages)) return false;
  if (body.sessionId !== undefined && (typeof body.sessionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.sessionId))) return false;
  const { messages } = body;
  return messages.length > 0 && messages.length <= 20 &&
    messages.at(-1)?.role === 'user' &&
    messages.every(message => message && ['user', 'assistant'].includes(message.role) &&
      typeof message.content === 'string' && message.content.trim().length > 0 && message.content.length <= 2000) &&
    messages.reduce((total, message) => total + message.content.length, 0) <= 12000;
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/api/ai-chat') return json({ error: 'Not found.' }, 404);
    if (request.method !== 'POST') return json({ error: 'Use POST to send a chat message.' }, 405);
    if (!ORIGINS.has(request.headers.get('origin'))) return json({ error: 'Please use the chat on the demo website.' }, 403);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return json({ error: 'Send a JSON request.' }, 415);
    }
    const { success } = await env.CHAT_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
    if (!success) return json({ error: 'Please wait a minute before sending another message.' }, 429);
    const text = await readBody(request);
    if (text === null) return json({ error: 'This conversation is too long. Start a new chat.' }, 413);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'Send a valid JSON request.' }, 400);
    }
    if (!validMessages(body)) return json({ error: 'Send valid messages and a session ID. Use messages of up to 2,000 characters and start a new chat if the conversation gets too long.' }, 400);
    const sessionId = body.sessionId || crypto.randomUUID();

    try {
      const response = await env.AI.run('cloudflare/auto', {
        messages: [
          { role: 'system', content: 'You are a helpful assistant in a public Cloudflare AI Gateway demo. Answer questions clearly and concisely. You have no live browsing or tools. Do not claim to access private accounts or perform actions. Keep answers under 1,500 characters.' },
          ...body.messages.map(({ role, content }) => ({ role, content })),
        ],
        max_tokens: 4096,
      }, {
        gateway: { id: GATEWAY_ID, skipCache: true, collectLog: true, metadata: { demo: 'website-auto-router', session_id: sessionId } },
        extraHeaders: {
          'cf-aig-session-id': sessionId,
          'cf-aig-allowed-providers': 'workers-ai',
          'cf-aig-allowed-models': MODELS.join(','),
          'cf-aig-no-session-affinity': 'true',
        },
        returnRawResponse: true,
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return response.status === 429
          ? json({ error: 'The demo has reached a request or spending limit. Please try again later.' }, 429)
          : json({ error: 'AI Gateway could not complete this request. Please try again.' }, 502);
      }
      const result = await response.json();
      const reply = result.choices?.[0]?.message?.content || result.response;
      if (typeof reply !== 'string' || !reply.trim()) return json({ error: 'The model returned no answer. Please try a shorter question.' }, 502);
      return json({
        reply,
        sessionId,
        model: response.headers.get('cf-aig-routed-model') || result.model || null,
        routingReason: response.headers.get('cf-aig-routing-reason'),
        decisionId: response.headers.get('cf-aig-routing-decision-id'),
        logId: response.headers.get('cf-aig-log-id') || response.headers.get('cf-aig-request-id') || null,
      });
    } catch {
      return json({ error: 'AI Gateway is taking too long or is unavailable. Please try again.' }, 502);
    }
  },
};
