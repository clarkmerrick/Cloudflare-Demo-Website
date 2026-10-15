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
    await route.fulfill({ json: {
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

  for (const library of ['marked', 'dompurify']) {
    const fallback = await browser.newPage();
    await fallback.route(new RegExp(`cdn\\.jsdelivr\\.net/npm/${library}@`), route => route.abort());
    await mockChat(fallback);
    await fallback.goto(url, { waitUntil: 'networkidle' });
    await send(fallback, 'Check fallback');
    assert.equal(await fallback.locator('.chat-assistant .chat-content').last().textContent(), markdown);
    assert.equal(await fallback.locator('#transcript img, #transcript script').count(), 0);
  }
  console.log('PASS: Markdown formatting, sanitized HTML and links, no tracking images, literal user/metadata text, original conversation context, session continuity, mobile code overflow, and offline-library fallback.');
} finally {
  await browser.close();
}
