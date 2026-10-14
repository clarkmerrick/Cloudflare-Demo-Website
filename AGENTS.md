# Project conventions

- This is a static Bootstrap website. Reuse the theme classes in `assets/dist/css/bootstrap.min.css` and plain browser JavaScript; no build step or npm dependencies are required.
- Run `node --test tests/*.test.mjs`, `node --check assets/autorouter.js`, `node --check workers/ai-chat.mjs`, and `git diff --check` before publishing chat changes.
- Cloudflare Pages project `demo-clarkmerrick-com` builds `main` from GitHub repository ID `630177371`. Cloudflare displays its historical name `clarkdemo.com`; the current GitHub name is `clarkmerrick/Cloudflare-Demo-Website`.
- The public site is `https://demo.clarkmerrick.com`. Its delegated zone ID is `df194a551022ee768d93a48d2aff4647`, not the parent `clarkmerrick.com` zone.
- The Auto Router page is `/autorouter`. Its same-origin POST endpoint `/api/ai-chat` is a separate Worker route, not a Pages Function. Local static servers and the Pages hostname do not have this route.
- Worker source is `workers/ai-chat.mjs`; its deploy configuration is `.devin/wrangler.jsonc`. Deploy using `wrangler deploy --config .devin/wrangler.jsonc` with an authenticated Wrangler installation, or the Cloudflare MCP. GitHub pushes automatically publish the static pages, but do not redeploy this separate Worker.
- AI Gateway `demo-auto-router` requires authentication, collects prompt/response logs, skips response caching, and bills Workers AI postpaid. Every inference must call `cloudflare/auto` through the AI binding, with the Workers AI provider and the three-model allowlist fixed server-side. Do not introduce a direct-model fallback.
- Cloudflare gateway limits are 20 requests per 60 seconds and a $5 rolling 24-hour estimated spend budget. The Worker limits each IP to approximately 6 requests per minute per Cloudflare location, bounds request bodies to 16,000 bytes, and bounds conversation context to 12,000 characters. Spend limits are eventually consistent, not a guaranteed hard billing cap.
- Do not add API tokens to browser code or committed files. Public prompt logging must remain disclosed on the page.
