(() => {
  const content = document.getElementById('usage-content');
  const status = document.getElementById('usage-status');
  if (!content || !status) return;
  const names = {
    '@cf/openai/gpt-oss-20b': 'OpenAI GPT OSS 20B',
    '@cf/google/gemma-4-26b-a4b-it': 'Google Gemma 4 26B A4B',
    '@cf/deepseek-ai/deepseek-v4-flash-0731': 'DeepSeek V4 Flash',
    '@cf/deepseek-ai/deepseek-v4-pro-0813': 'DeepSeek V4 Pro',
    '@cf/moonshotai/kimi-k2.7-code': 'Moonshot Kimi K2.7 Code',
    '@cf/qwen/qwen3.8-27b': 'Qwen 3.8 27B',
    '@cf/zai-org/glm-5.2': 'Z.ai GLM 5.2',
    unreported: 'Unreported / upstream error',
  };
  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  const timeLabel = value => new Date(value).toLocaleString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });

  async function refresh() {
    try {
      const response = await fetch('/api/ai-stats');
      if (!response.ok) throw new Error('Statistics unavailable');
      const data = await response.json();
      if (!validCount(data.totalRequests) || !Array.isArray(data.hours) || data.hours.length !== 24 ||
        !data.hours.every(row => validCount(row.requests) && Number.isFinite(Date.parse(row.hour))) ||
        !Array.isArray(data.models) || !data.models.every(row => validCount(row.requests)) ||
        data.hours.reduce((sum, row) => sum + row.requests, 0) !== data.totalRequests ||
        data.models.reduce((sum, row) => sum + row.requests, 0) !== data.totalRequests) throw new Error('Invalid statistics');
      document.getElementById('usage-total').textContent = data.totalRequests.toLocaleString('en-US');
      document.getElementById('usage-empty').hidden = data.totalRequests !== 0;
      const peak = Math.max(...data.hours.map(row => row.requests));
      document.getElementById('usage-peak').textContent = `Peak: ${peak.toLocaleString('en-US')} requests/hour`;
      const bars = data.hours.map(row => {
        const column = document.createElement('li');
        column.className = 'usage-column';
        const description = `${timeLabel(row.hour)} UTC: ${row.requests.toLocaleString('en-US')} requests`;
        column.setAttribute('aria-label', description);
        column.title = description;
        const bar = document.createElement('span');
        bar.className = 'usage-bar';
        bar.setAttribute('aria-hidden', 'true');
        bar.style.height = `${row.requests ? Math.max(2, row.requests / peak * 100) : 0}%`;
        column.append(bar);
        return column;
      });
      document.getElementById('usage-bars').replaceChildren(...bars);
      document.getElementById('usage-first-hour').textContent = `${timeLabel(data.hours[0].hour)} UTC`;
      document.getElementById('usage-last-hour').textContent = `${timeLabel(data.hours.at(-1).hour)} UTC`;
      const rows = data.models.map(row => {
        const tr = document.createElement('tr');
        const name = document.createElement('th');
        name.scope = 'row';
        name.textContent = names[row.model] || 'Unreported';
        const count = document.createElement('td');
        count.textContent = row.requests.toLocaleString('en-US');
        const share = document.createElement('td');
        const percentage = data.totalRequests ? row.requests / data.totalRequests * 100 : 0;
        const label = document.createElement('span');
        label.textContent = `${percentage.toFixed(1)}%`;
        const track = document.createElement('div');
        track.className = 'progress mt-1';
        const bar = document.createElement('div');
        bar.className = 'progress-bar';
        bar.style.width = `${percentage}%`;
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-label', `${name.textContent} request share`);
        bar.setAttribute('aria-valuenow', percentage.toFixed(1));
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        track.append(bar);
        share.append(label, track);
        tr.append(name, count, share);
        return tr;
      });
      document.getElementById('usage-models').replaceChildren(...rows);
      content.hidden = false;
      status.textContent = `Updated ${timeLabel(data.updatedAt)} UTC. Refreshes every 60 seconds; recent requests may take a minute to appear.`;
    } catch {
      status.textContent = content.hidden
        ? 'Usage statistics are temporarily unavailable. The chat is still available.'
        : 'Unable to refresh statistics. Showing the last successful snapshot; the chat is still available.';
    }
  }

  refresh();
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
})();
