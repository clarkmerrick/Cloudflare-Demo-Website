import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { delimiter, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const bin = process.env.PATH.split(delimiter).find(path => path.includes('_npx') && path.endsWith('node_modules/.bin'));
const { chromium } = require(bin ? resolve(bin, '..', 'playwright') : 'playwright');
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
  headless: true,
});
const url = process.argv[2] || 'http://127.0.0.1:8765/autorouter.html';
const markdown = [
  'The bug is a **race condition**, not an *atomic* operation.',
  '',
  '### Prevent overselling',
  '1. Use `UPDATE inventory SET stock = stock - 1`.',
  '2. Retry idempotently.',
  '',
  '- Keep a transaction boundary.',
  '- Check affected rows.',
  '',
  '> A retry should not charge twice.',
  '',
  '```sql',
  'UPDATE inventory SET stock = stock - 1 WHERE item_id = 123 AND stock > 0;',
  '```',
  '',
  '| Check | Result |',
  '| --- | --- |',
  '| Stock | Safe |',
  '',
  '[Documentation](https://developers.cloudflare.com/ai-gateway/)',
  '[Unsafe](javascript:alert%281%29)',
  '[Data](data:text/html,unsafe)',
  '',
  '![Tracking image](https://example.com/tracking.png)',
  '<img src="https://example.com/tracking.png" onerror="window.__markdownXss = true">',
  '<script>window.__markdownXss = true</script>',
  '<svg onload="window.__markdownXss = true"></svg>',
  '<iframe srcdoc="unsafe"></iframe>',
  '<form id="chat-form"><input name="prompt"></form>',
].join('\n');

async function mockChat(page) {
  const requests = [];
  await page.route('**/api/ai-chat', async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const requestId = route.request().headers()['x-request-id'];
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    await route.fulfill({ json: {
      requestId,
      reply: markdown,
      sessionId: body.sessionId,
      model: '@cf/openai/gpt-oss-20b',
      routingReason: 'cost_optimal_within_pool',
      logId: '<img src=x onerror=alert(1)>',
    } });
  });
  return requests;
}

async function send(page, content) {
  await page.locator('#prompt').fill(content);
  await page.locator('#send').click();
  await page.waitForFunction(() => document.getElementById('chat-status').textContent.startsWith('Reply received'));
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  const tracking = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('example.com/tracking')) tracking.push(request.url()); });
  const requests = await mockChat(page);
  await page.goto(url, { waitUntil: 'networkidle' });
  await send(page, '<img src=x onerror=alert(1)> **User text stays literal**');
  const reply = page.locator('.chat-assistant .chat-content').last();
  assert.equal(await reply.locator('strong').count(), 1);
  assert.equal(await reply.locator('strong').innerText(), 'race condition');
  assert.equal(await reply.locator('em').innerText(), 'atomic');
  assert.equal(await reply.locator('h3').innerText(), 'Prevent overselling');
  assert.equal(await reply.locator('ol > li').count(), 2);
  assert.equal(await reply.locator('ul > li').count(), 2);
  assert.match(await reply.locator('pre code').innerText(), /UPDATE inventory/);
  assert.equal(await reply.locator('table tbody tr').count(), 1);
  assert.match(await reply.locator('blockquote').innerText(), /retry/);
  assert.equal(await reply.locator('script, img, svg, iframe, form, input').count(), 0);
  assert.equal(await reply.locator('a[href^="javascript:"], a[href^="data:"]').count(), 0);
  const link = reply.getByRole('link', { name: 'Documentation', exact: true });
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await page.locator('.chat-user strong, .chat-user img, .chat-details img').count(), 0);
  assert.equal(await page.locator('#chat-form').count(), 1);
  assert.equal(await page.evaluate(() => Boolean(window.__markdownXss)), false);
  await send(page, 'A follow-up');
  assert.equal(requests[1].messages[1].content, markdown.slice(0, 2000));
  assert.equal(requests[0].sessionId, requests[1].sessionId);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.chat-assistant pre').last().evaluate(pre => {
    pre.firstElementChild.textContent = 'x'.repeat(500);
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(tracking, []);
  assert.deepEqual(errors, []);

  const documents = await browser.newPage();
  const documentRequests = await mockChat(documents);
  await documents.goto(url, { waitUntil: 'networkidle' });
  assert.equal(await documents.locator('#prompt').getAttribute('maxlength'), null);
  const longDocument = 'DOCUMENT-START\n' + 'a'.repeat(199972) + '\nDOCUMENT-END';
  assert.equal(longDocument.length, 200000);
  await send(documents, longDocument);
  assert.equal(documentRequests[0].messages[0].content, longDocument);
  await send(documents, 'Summarize the ending too.');
  assert.equal(documentRequests[1].messages[0].content, longDocument);
  const otherDocument = 'SECOND-START\n' + 'b'.repeat(199976) + '\nSECOND-END';
  assert.equal(otherDocument.length, 200000);
  await send(documents, otherDocument);
  assert.equal(documentRequests[2].messages.at(-1).content, otherDocument);
  assert.equal(documentRequests[2].messages.some(message => message.content === longDocument), false);
  assert.match(await documents.locator('#chat-status').textContent(), /Older turns were omitted/);
  await documents.locator('#prompt').fill('x'.repeat(200001));
  assert.equal((await documents.locator('#prompt').inputValue()).length, 200001);
  assert.equal(await documents.locator('#prompt-warning').isVisible(), true);
  assert.match(await documents.locator('#prompt-count').textContent(), /200,001/);
  await documents.locator('#send').click();
  assert.equal(documentRequests.length, 3);
  await documents.locator('#prompt').fill(String.fromCharCode(1).repeat(180000));
  assert.match(await documents.locator('#prompt-warning').textContent(), /1 MB/);
  await documents.locator('#send').click();
  assert.equal(documentRequests.length, 3);
  await documents.getByRole('button', { name: 'Explain a CDN', exact: true }).click();
  assert.equal(await documents.locator('#prompt-warning').isVisible(), false);
  await documents.getByRole('button', { name: 'New chat', exact: true }).click();
  assert.match(await documents.locator('#prompt-count').textContent(), /^0 \/ 200,000/);
  await documents.setViewportSize({ width: 390, height: 844 });
  assert.equal(await documents.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  const recovery = await browser.newPage();
  const attempts = [];
  await recovery.route('**/api/ai-chat', async route => {
    const headers = route.request().headers();
    const body = route.request().postDataJSON();
    const requestId = headers['x-request-id'];
    attempts.push({ body, requestId, retryOf: headers['x-retry-of'] });
    if (attempts.length === 1) await route.fulfill({ status: 504, json: { error: 'Temporary timeout.', errorCode: 'inference_timeout', retryable: true, requestId } });
    else await route.fulfill({ json: { reply: '**Recovered**', requestId, sessionId: body.sessionId, model: '@cf/qwen/qwen3.8-27b' } });
  });
  await recovery.goto(url, { waitUntil: 'networkidle' });
  await send(recovery, 'A harmless retry test');
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].requestId, attempts[1].requestId);
  assert.equal(attempts[0].retryOf, undefined);
  assert.equal(attempts[1].retryOf, attempts[0].requestId);
  assert.deepEqual(attempts[0].body, attempts[1].body);
  assert.equal(await recovery.locator('.chat-user').count(), 1);
  assert.equal(await recovery.locator('#chat-error').isVisible(), false);
  assert.match(await recovery.locator('#chat-status').textContent(), /Recovered after one automatic retry/);
  await send(recovery, 'Follow up');
  assert.equal(attempts[2].retryOf, undefined);
  assert.equal(attempts[2].body.messages.length, 3);
  assert.equal(attempts[2].body.messages[1].content, '**Recovered**');

  for (const example of [
    { status: 400, retryable: false, errorCode: 'invalid_request', attempts: 1 },
    { status: 429, retryable: true, errorCode: 'client_rate_limited', attempts: 1 },
    { status: 502, retryable: false, errorCode: 'output_limit', attempts: 1 },
    { status: 504, retryable: true, errorCode: 'inference_timeout', attempts: 2 },
  ]) {
    const failure = await browser.newPage();
    const ids = [];
    await failure.route('**/api/ai-chat', async route => {
      const requestId = route.request().headers()['x-request-id'];
      ids.push(requestId);
      await route.fulfill({ status: example.status, json: { error: 'Test failure.', errorCode: example.errorCode, retryable: example.retryable, requestId } });
    });
    await failure.goto(url, { waitUntil: 'networkidle' });
    await failure.locator('#prompt').fill('Retain this draft');
    await failure.locator('#send').click();
    await failure.locator('#chat-error').waitFor({ state: 'visible' });
    assert.equal(ids.length, example.attempts);
    assert.equal(await failure.locator('.chat-user').count(), 1);
    assert.equal(await failure.locator('#prompt').inputValue(), 'Retain this draft');
    assert.ok((await failure.locator('#chat-error').textContent()).includes(ids.at(-1)));
    if (example.attempts === 2) assert.match(await failure.locator('#chat-error').textContent(), new RegExp(`Previous attempt ID: ${ids[0]}`));
  }

  for (const networkFailure of [false, true]) {
    const failure = await browser.newPage();
    let referenceId;
    await failure.route('**/api/ai-chat', async route => {
      referenceId = route.request().headers()['x-request-id'];
      if (networkFailure) await route.abort('failed');
      else await route.fulfill({ status: 504, headers: { 'x-request-id': referenceId }, json: { error: 'The model timed out.', errorCode: 'inference_timeout', requestId: referenceId } });
    });
    await failure.goto(url, { waitUntil: 'networkidle' });
    await failure.locator('#prompt').fill('Keep this prompt for retry');
    await failure.locator('#send').click();
    await failure.locator('#chat-error').waitFor({ state: 'visible' });
    const message = await failure.locator('#chat-error').textContent();
    assert.ok(message.includes(`Reference ID: ${referenceId}`));
    if (!networkFailure) assert.match(message, /inference_timeout/);
    assert.equal(await failure.locator('#prompt').inputValue(), 'Keep this prompt for retry');
    assert.equal(await failure.locator('#send').isEnabled(), true);
  }

  for (const library of ['marked', 'dompurify']) {
    const fallback = await browser.newPage();
    await fallback.route(new RegExp(`cdn\\.jsdelivr\\.net/npm/${library}@`), route => route.abort());
    await mockChat(fallback);
    await fallback.goto(url, { waitUntil: 'networkidle' });
    await send(fallback, 'Check fallback');
    assert.equal(await fallback.locator('.chat-assistant .chat-content').last().textContent(), markdown);
    assert.equal(await fallback.locator('#transcript img, #transcript script').count(), 0);
  }
  console.log('PASS: Markdown/XSS safety, long documents, one bounded retry with linked IDs and unchanged context, no retry for permanent/ambiguous failures, draft preservation, mobile layout, and offline-library fallback.');
} finally {
  await browser.close();
}
