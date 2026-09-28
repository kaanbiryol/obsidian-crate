// Reproduce the article-fetching limitation against two controlled HTTP origins.
// No public websites, vault data, or credentials are involved.
import { createServer } from 'node:http';
import { chromium, webkit } from '@playwright/test';
import assert from 'node:assert/strict';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const article = '<article>A readable article</article>';
const remote = createServer((req, res) => {
  if (req.url === '/allowed') res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/html'); res.end(article);
});
const sw = `self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('message', e => e.waitUntil((async () => {
  try { const response = await fetch(e.data.url, { mode: e.data.mode });
    e.ports[0].postMessage({ type: response.type, status: response.status, text: await response.text() });
  } catch { e.ports[0].postMessage({ rejected: true }); }
})()));`;
const app = createServer((req, res) => {
  if (req.url === '/sw.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(sw); }
  else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>CORS experiment</title>'); }
});
try {
  const remoteOrigin = await listen(remote), appOrigin = await listen(app);
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage(); await page.goto(appOrigin);
      const result = await page.evaluate(async origin => {
        const read = async (path, mode) => {
          try { const response = await fetch(origin + path, { mode }); return { type: response.type, status: response.status, text: await response.text() }; }
          catch { return { rejected: true }; }
        };
        await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
        const fromWorker = (path, mode) => new Promise(resolve => {
          const channel = new MessageChannel(); channel.port1.onmessage = event => resolve(event.data);
          navigator.serviceWorker.controller.postMessage({ url: origin + path, mode }, [channel.port2]);
        });
        return { page: { denied: await read('/denied', 'cors'), allowed: await read('/allowed', 'cors'), opaque: await read('/denied', 'no-cors') },
          worker: { denied: await fromWorker('/denied', 'cors'), allowed: await fromWorker('/allowed', 'cors'), opaque: await fromWorker('/denied', 'no-cors') } };
      }, remoteOrigin);
      for (const surface of Object.values(result)) {
        assert.deepEqual(surface.denied, { rejected: true });
        assert.deepEqual(surface.allowed, { type: 'cors', status: 200, text: article });
        assert.deepEqual(surface.opaque, { type: 'opaque', status: 0, text: '' });
      }
      console.log(`${name}: page and service worker both require CORS permission to read cross-origin HTML; no-cors is opaque`);
    } finally { await browser.close(); }
  }
} finally { await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => remote.close(resolve))]); }
