import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      const safari = await browser.newContext({ serviceWorkers: 'block' });
      await safari.route('**/notifications/preview-session.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
      const page = await safari.newPage();
      // Reproduce the service worker's generic cached shell, with no token in
      // its manifest link, while retaining the scanned URL in the address bar.
      await page.route('**/notifications?*', async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace(/<link rel="manifest"[^>]+>/, '<link rel="manifest" href="/notifications/manifest.json">');
        await route.fulfill({ response, body });
      });
      const browserExchanges = [];
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/notifications/reminders-exchange') browserExchanges.push(request.postDataJSON());
      });
      await page.goto(`${origin}/notifications?token=install-fresh&browserToken=browser-fresh&folder=Reminders&tab=inbox`);
      const cardName = 'Check this article. Press Enter to edit reminder.';
      await page.getByRole('group', { name: cardName, exact: true }).waitFor();
      expect(browserExchanges.map(exchange => exchange.token)).toEqual(['browser-fresh']);
      expect(new URL(page.url()).searchParams.has('token')).toBe(false);
      expect(new URL(page.url()).searchParams.has('browserToken')).toBe(false);
      const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute('href');
      const manifestResponse = await page.request.get(new URL(manifestUrl, origin).href);
      const manifest = await manifestResponse.json();
      const startUrl = new URL(manifest.start_url, origin);
      expect(startUrl.searchParams.get('token')).toBe('install-fresh');
      expect(startUrl.searchParams.has('browserToken')).toBe(false);
      expect(startUrl.searchParams.get('folder')).toBe('Reminders');

      // The installed app starts with its own storage, not Safari's auth token.
      const installed = await browser.newContext({ serviceWorkers: 'block' });
      await installed.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true }); });
      await installed.route('**/notifications/preview-session.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
      const home = await installed.newPage();
      const installExchanges = [];
      home.on('request', request => {
        if (new URL(request.url()).pathname === '/notifications/reminders-exchange') installExchanges.push(request.postDataJSON());
      });
      await home.goto(startUrl.href);
      await home.getByRole('group', { name: cardName, exact: true }).waitFor();
      expect(installExchanges.map(exchange => exchange.token)).toEqual(['install-fresh']);
      expect(installExchanges[0].previousAuthToken).toBeUndefined();
      expect(new URL(home.url()).searchParams.has('token')).toBe(false);
      await installed.close();
      await safari.close();
      console.log(`${browserType.name()}: cached QR page preserves separate Home Screen enrollment`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
