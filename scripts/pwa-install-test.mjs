import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const cardName = 'Check this article. Press Enter to edit reminder.';
const authKey = 'crate-reminders-auth-token';

async function createContext(browser, standalone = false, cookies = []) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  if (standalone) {
    await context.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true }); });
  }
  await context.addCookies(cookies);
  // No preview authentication: exercise the production bootstrap from empty storage.
  await context.route('**/notifications/preview-session.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  return context;
}

async function testInstall(browser, launchMode) {
  const safari = await createContext(browser);
  const page = await safari.newPage();
  // Reproduce a generic cached shell whose original manifest has no grant.
  await page.route('**/notifications?*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/<link rel="manifest"[^>]+>/, '<link rel="manifest" href="/notifications/manifest.json">');
    await route.fulfill({ response, body });
  });
  const exchanges = [];
  const spent = new Set();
  let failNextExchange = false;
  const exchange = async route => {
    const body = route.request().postDataJSON();
    exchanges.push(body);
    if (failNextExchange) {
      failNextExchange = false;
      await route.fulfill({ status: 503, body: 'Temporarily unavailable' });
    } else if (spent.has(body.token)) {
      await route.fulfill({ status: 401, body: 'Invalid or expired enrollment token' });
    } else {
      spent.add(body.token);
      await route.fulfill({ response: await route.fetch() });
    }
  };
  await safari.route('**/notifications/reminders-exchange', exchange);
  const installToken = `install-${launchMode}`;
  await page.goto(`${origin}/notifications?token=${installToken}&browserToken=browser-${launchMode}&folder=Tasks&upcomingDays=14&allDayTime=09%3A30&tab=inbox`);
  await page.getByRole('group', { name: cardName, exact: true }).waitFor();
  expect(exchanges.map(exchange => exchange.token)).toEqual([`browser-${launchMode}`]);
  expect(new URL(page.url()).searchParams.get('token')).toBe(installToken);
  expect(new URL(page.url()).searchParams.has('browserToken')).toBe(false);
  const browserAuth = await page.evaluate(key => localStorage.getItem(key), authKey);

  // Refreshing Safari before installation must not lose the reserved grant or
  // re-exchange the already spent browser grant.
  await page.reload();
  await page.getByRole('group', { name: cardName, exact: true }).waitFor();
  expect(exchanges).toHaveLength(1);
  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await page.request.get(new URL(manifestUrl, origin).href)).json();
  const startUrl = new URL(manifest.start_url, origin);
  expect(startUrl.searchParams.get('token')).toBe(installToken);
  expect(startUrl.searchParams.has('browserToken')).toBe(false);
  expect(startUrl.searchParams.get('folder')).toBe('Tasks');

  // iOS 17.2+ copies cookies, not localStorage. Also test platforms that only
  // carry the manifest/document URL and have no cookie transfer.
  const cookies = await safari.cookies();
  expect(cookies).toHaveLength(1);
  expect(cookies[0].name).toBe('crate-reminders-install');
  expect(cookies[0].sameSite).toBe('Strict');
  expect(cookies[0].value).not.toContain(`browser-${launchMode}`);
  expect(cookies[0].value).not.toContain(browserAuth);
  const installed = await createContext(browser, true, launchMode === 'cookie' ? cookies : []);
  await installed.route('**/notifications/reminders-exchange', exchange);
  const home = await installed.newPage();
  const launchUrl = launchMode === 'cookie' ? `${origin}/notifications`
    : launchMode === 'document' ? page.url() : startUrl.href;
  failNextExchange = launchMode === 'retry';
  await home.goto(launchUrl);
  if (launchMode === 'retry') {
    await home.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    expect(new URL(home.url()).searchParams.get('token')).toBe(installToken);
    await home.getByRole('button', { name: 'Retry', exact: true }).click();
  }
  await home.getByRole('group', { name: cardName, exact: true }).waitFor();
  const installExchanges = exchanges.slice(1);
  expect(installExchanges.map(exchange => exchange.token)).toEqual(launchMode === 'retry' ? [installToken, installToken] : [installToken]);
  expect(installExchanges[0].previousAuthToken).toBeUndefined();
  expect(new URL(home.url()).searchParams.has('token')).toBe(false);
  expect(await installed.cookies()).toEqual([]);
  const storedConfig = await home.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-config')));
  expect(storedConfig).toEqual({ folderPath: 'Tasks', upcomingDays: 14, allDayNotificationTime: '09:30' });

  // Cold launch the immutable icon URL twice with the app's own storage.
  const exchangeCount = exchanges.length;
  for (let launch = 0; launch < 2; launch++) {
    const next = await installed.newPage();
    await next.goto(launchUrl);
    await next.getByRole('button', { name: 'Open settings', exact: true }).waitFor();
    expect(await next.evaluate(key => localStorage.getItem(key), authKey)).toBeTruthy();
    expect(await next.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-config')).folderPath)).toBe('Tasks');
    await next.close();
  }
  expect(exchanges).toHaveLength(exchangeCount);

  await home.getByRole('button', { name: 'Open settings', exact: true }).click();
  await home.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect.poll(() => home.evaluate(key => localStorage.getItem(key), authKey)).toBeNull();
  await home.goto(launchUrl);
  await home.getByRole('button', { name: 'Open Obsidian', exact: true }).waitFor();
  expect(exchanges).toHaveLength(exchangeCount);

  // Logging out in Safari must discard the outstanding install handoff too.
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), authKey)).toBeNull();
  expect(await safari.cookies()).toEqual([]);
  expect(new URL(page.url()).searchParams.has('token')).toBe(false);
  await installed.close();
  await safari.close();
}

try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      for (const mode of ['manifest', 'document', 'cookie', 'retry']) {
        await testInstall(browser, mode);
        console.log(`${browserType.name()}: ${mode} enrollment survives Safari refresh and repeated Home Screen launches`);
      }
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
