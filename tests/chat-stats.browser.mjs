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
const lastHour = Math.floor(Date.now() / 3600000) * 3600000;
const models = [
  ['@cf/deepseek-ai/deepseek-v4-flash-0731', 6], ['@cf/zai-org/glm-5.2', 3], ['@cf/openai/gpt-oss-20b', 1],
  ['@cf/google/gemma-4-26b-a4b-it', 0], ['@cf/deepseek-ai/deepseek-v4-pro-0813', 0],
  ['@cf/moonshotai/kimi-k2.7-code', 0], ['@cf/qwen/qwen3.8-27b', 0],
];
const fixture = {
  totalRequests: 10,
  hours: Array.from({ length: 24 }, (_, index) => ({ hour: new Date(lastHour - (23 - index) * 3600000).toISOString(), requests: index === 23 ? 6 : index === 22 ? 4 : 0 })),
  models: models.map(([model, requests]) => ({ model, requests, percentage: requests * 10 })),
  windowStart: new Date(lastHour - 23 * 3600000).toISOString(), windowEnd: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let fail = false;
  let data = structuredClone(fixture);
  await page.route('**/api/ai-stats', route => fail
    ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    : route.fulfill({ json: data }));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('usage-status').textContent.startsWith('Updated'));
  assert.equal(await page.locator('#usage-total').textContent(), '10');
  assert.equal(await page.locator('#usage-bars li').count(), 24);
  assert.equal(await page.locator('#usage-models tr').count(), 7);
  const deepseek = page.locator('#usage-models tr').filter({ hasText: 'DeepSeek V4 Flash' });
  assert.match(await deepseek.innerText(), /60\.0%/);
  assert.equal(await deepseek.getByRole('progressbar').getAttribute('aria-valuenow'), '60.0');
  fail = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => document.getElementById('usage-status').textContent.includes('snapshot'));
  assert.equal(await page.locator('#usage-total').textContent(), '10');
  assert.equal(await page.locator('#send').isEnabled(), true);
  fail = false;
  data.totalRequests = 0;
  data.hours.forEach(row => { row.requests = 0; });
  data.models.forEach(row => { row.requests = 0; row.percentage = 0; });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => document.getElementById('usage-total').textContent === '0');
  assert.equal(await page.locator('#usage-empty').isVisible(), true);
  assert.ok((await page.locator('#usage-models').innerText()).includes('0.0%'));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);

  const unavailable = await browser.newPage();
  await unavailable.route('**/api/ai-stats', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await unavailable.goto(url, { waitUntil: 'networkidle' });
  await unavailable.waitForFunction(() => document.getElementById('usage-status').textContent.includes('temporarily unavailable'));
  assert.equal(await unavailable.locator('#usage-content').isVisible(), false);
  assert.equal(await unavailable.locator('#send').isEnabled(), true);
  console.log('PASS: 24 hourly bars, request totals, model percentages, accessible labels, zero-data state, stale/unavailable recovery, independent chat controls, and mobile layout.');
} finally {
  await browser.close();
}
