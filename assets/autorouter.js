(() => {
  const form = document.getElementById('chat-form');
  const prompt = document.getElementById('prompt');
  const transcript = document.getElementById('transcript');
  const status = document.getElementById('chat-status');
  const error = document.getElementById('chat-error');
  const newChat = document.getElementById('new-chat');
  const controls = [prompt, document.getElementById('send'), newChat, ...document.querySelectorAll('.example-prompt')];
  const welcome = transcript.firstElementChild.cloneNode(true);
  const sessionLabel = document.getElementById('chat-session');
  let sessionId = crypto.randomUUID();
  let history = [];
  let busy = false;
  sessionLabel.textContent = `Anonymous session: ${sessionId}`;

  function addMessage(role, content, details) {
    const message = document.createElement('div');
    message.className = `chat-message chat-${role} p-3 rounded-3 mb-3`;
    const label = document.createElement('div');
    label.className = 'small fw-bold mb-1';
    label.textContent = role === 'user' ? 'You' : 'Assistant';
    const text = document.createElement('div');
    text.className = 'chat-content';
    if (role === 'assistant' && window.marked?.parse && window.DOMPurify?.isSupported) {
      text.classList.add('chat-markdown');
      text.innerHTML = window.DOMPurify.sanitize(window.marked.parse(content, { async: false, gfm: true, breaks: true }), {
        ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
        ALLOWED_ATTR: ['href', 'title', 'start'],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
      });
      text.querySelectorAll('a[href]').forEach(link => {
        try {
          if (!['http:', 'https:', 'mailto:'].includes(new URL(link.getAttribute('href'), window.location.href).protocol)) {
            link.removeAttribute('href');
          } else {
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
          }
        } catch {
          link.removeAttribute('href');
        }
      });
    } else {
      text.textContent = content;
    }
    message.append(label, text);
    if (details) {
      const info = document.createElement('div');
      info.className = 'chat-details text-muted border-top mt-2 pt-2';
      const reasons = {
        cost_optimal_within_pool: 'Best expected balance of quality and cost',
        forced_by_candidate_pool: 'Only one eligible model',
        pinned_by_turn: 'Reused the model for this turn',
        fallback_candidate_unavailable: 'Fallback: selected model unavailable',
        fallback_key_not_in_candidates: 'Fallback: routing decision not in pool',
        fallback_router_error: 'Fallback: router unavailable',
        fallback_router_timeout: 'Fallback: router timed out',
        fallback_unsupported_input: 'Fallback: input could not be classified',
      };
      info.textContent = `Model: ${details.model || 'Not reported'}\nRouting: ${reasons[details.routingReason] || details.routingReason || 'Not reported'}`;
      if (details.sessionId) info.textContent += `\nSession ID: ${details.sessionId}`;
      if (details.logId) info.textContent += `\nRequest ID: ${details.logId}`;
      if (details.decisionId) info.textContent += `\nRouting decision ID: ${details.decisionId}`;
      info.style.whiteSpace = 'pre-wrap';
      message.append(info);
    }
    transcript.append(message);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function setBusy(value) {
    busy = value;
    controls.forEach(control => { control.disabled = value; });
    form.setAttribute('aria-busy', String(value));
  }

  document.querySelectorAll('.example-prompt').forEach(button => {
    button.addEventListener('click', () => {
      prompt.value = button.dataset.prompt;
      prompt.focus();
    });
  });

  newChat.addEventListener('click', () => {
    sessionId = crypto.randomUUID();
    sessionLabel.textContent = `Anonymous session: ${sessionId}`;
    history = [];
    transcript.replaceChildren(welcome.cloneNode(true));
    prompt.value = '';
    error.hidden = true;
    status.textContent = 'New chat. Every request goes through Auto Router.';
    prompt.focus();
  });

  prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!busy) form.requestSubmit();
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const content = prompt.value.trim();
    if (busy || !content) return;
    error.hidden = true;
    const messages = [...history, { role: 'user', content }];
    while (messages.length > 20 || messages.reduce((total, message) => total + message.content.length, 0) > 12000 ||
      new TextEncoder().encode(JSON.stringify({ messages, sessionId })).byteLength > 16000) {
      messages.splice(0, 2);
    }
    addMessage('user', content);
    setBusy(true);
    status.textContent = 'Auto Router is choosing a model and generating a reply...';
    try {
      const response = await fetch('/api/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, sessionId }),
        signal: AbortSignal.timeout(70000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The demo is temporarily unavailable. Please try again.');
      if (typeof result.reply !== 'string' || !result.reply.trim()) throw new Error('The model returned no answer. Please try again.');
      addMessage('assistant', result.reply, result);
      history = [...messages, { role: 'assistant', content: result.reply.slice(0, 2000) }];
      prompt.value = '';
      status.textContent = 'Reply received through AI Gateway Auto Router. Try another question.';
    } catch (cause) {
      error.textContent = cause.name === 'TimeoutError'
        ? 'The request took too long. Please try again.'
        : cause instanceof SyntaxError || cause instanceof TypeError
          ? 'Could not reach the chat service. Please try again on demo.clarkmerrick.com.'
          : cause.message;
      error.hidden = false;
      status.textContent = 'No reply received. Your message is still in the box so you can retry.';
    } finally {
      setBusy(false);
      prompt.focus();
    }
  });
})();
