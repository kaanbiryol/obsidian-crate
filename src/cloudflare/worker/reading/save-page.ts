import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol';

export function readingSavePage(): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>Save to Crate</title><style>
  :root{font-family:system-ui,sans-serif;color:#18181b;background:#f7f7f8;color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px}main{max-width:380px;text-align:center;padding:40px 16px}img{width:72px;height:72px;margin-bottom:32px}h1{font-size:28px;letter-spacing:-.03em;margin:0 0 12px}p{line-height:1.6;color:#71717a}button,a{display:inline-block;border:0;border-radius:12px;background:#6d28d9;color:white;padding:14px 22px;font:inherit;text-decoration:none;min-height:48px;margin:8px}#retry[hidden],#open[hidden]{display:none}.spinner{height:24px;width:24px;border:2px solid #ccc;border-top-color:#6d28d9;border-radius:50%;margin:20px auto;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}@media(prefers-color-scheme:dark){:root{color:#f4f4f5;background:#18181b}p{color:#a1a1aa}}:focus-visible{outline:3px solid #a78bfa;outline-offset:4px}
  </style></head><body><main><img src="/notifications/crate-mark-256.png" alt="Crate"><div class="spinner" id="progress" aria-hidden="true"></div><h1 id="title">Saving to Crate…</h1><p id="message" role="status" aria-live="polite">Keeping this link for later.</p><button id="retry" hidden>Retry save</button><a id="open" href="/notifications?section=reading" hidden>Open Reading</a><p id="close-hint">Wait for confirmation before closing this page.</p></main><script src="/notifications/save-reading.js" defer></script></body></html>`, { headers: pageHeaders('text/html; charset=utf-8') });
}
const pageHeaders = (type: string) => ({ 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
export function readingSaveScript(): Response {
  return new Response(`(() => {
  const key = 'crate-reading-handoff-v1';
  let token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  try { if (token) sessionStorage.setItem(key, JSON.stringify({ token, until: Date.now() + 300000 }));
    else { const saved = JSON.parse(sessionStorage.getItem(key) || 'null'); if (saved && saved.until > Date.now()) token = saved.token; }
  } catch {}
  const title = document.getElementById('title'), message = document.getElementById('message'), retry = document.getElementById('retry'), progress = document.getElementById('progress');
  let busy = false;
  async function save() {
    if (busy) return; busy = true; retry.hidden = true; progress.hidden = false;
    try {
      if (!/^[a-f0-9]{64}$/.test(token)) throw { terminal: true, message: 'This save link is missing or expired. Share the article to Crate again.' };
      title.textContent = 'Saving to Crate…';
      const response = await fetch('/reading/handoff', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(20000), headers: { 'X-Crate-Capture': token, '${CRATE_PROTOCOL_HEADER}': '${CRATE_PLUGIN_PROTOCOL.current}', 'Content-Type': 'application/json' }, body: '{}' });
      const data = await response.json();
      if (!response.ok) throw { terminal: [400,401,403,409,410,413].includes(response.status), message: data.error || 'Your save has not been confirmed.' };
      if (!data.saved) throw new Error('Your save has not been confirmed.');
      title.textContent = data.alreadySaved ? 'Already saved ✓' : 'Saved to Crate ✓';
      message.textContent = 'Your link is safely saved in Reading.';
      document.getElementById('open').href = '/notifications?section=reading&item=' + encodeURIComponent(data.id);
      document.getElementById('open').hidden = false;
      document.getElementById('close-hint').textContent = 'You can close this page now.';
    } catch (error) {
      title.textContent = error.terminal ? 'Share this link again' : 'Save not confirmed';
      message.textContent = error.message || 'The connection was interrupted. Retry to check and finish this same save.';
      retry.hidden = Boolean(error.terminal);
    } finally { busy = false; progress.hidden = true; }
  }
  retry.addEventListener('click', save); save();
})();`, { headers: pageHeaders('application/javascript') });
}
