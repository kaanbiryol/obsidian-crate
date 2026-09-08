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
    if (body.token.startsWith('invalid-')) {
      await route.fulfill({ status: 401, body: 'Invalid or expired enrollment token' });
    } else if (failNextExchange) {
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

  // A failed replacement must preserve the existing session, folder, cache,
  // and unsaved edits. Its URL's other folder is not committed prematurely.
  await home.evaluate(() => sessionStorage.setItem('crate-reminder-draft:existing', 'keep existing edit'));
  const existingAuth = await home.evaluate(key => localStorage.getItem(key), authKey);
  const folders = [];
  home.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/reminders/list') folders.push(url.searchParams.get('folderPath'));
  });
  for (const failure of ['invalid', 'unavailable']) {
    failNextExchange = failure === 'unavailable';
    await home.goto(`${origin}/notifications?token=${failure}-${launchMode}&folder=WrongFolder&tab=inbox`);
    await home.getByRole('group', { name: cardName, exact: true }).waitFor();
    expect(await home.evaluate(key => localStorage.getItem(key), authKey)).toBe(existingAuth);
    expect(await home.evaluate(() => sessionStorage.getItem('crate-reminder-draft:existing'))).toBe('keep existing edit');
    expect(await home.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-config')).folderPath)).toBe('Tasks');
    await expect(home.getByRole('alert').filter({ hasText: 'Could not reconnect:' })).toBeVisible();
    // Successful reminder refresh leaves the preserved session editable.
    await home.getByRole('group', { name: cardName, exact: true }).click();
    await expect(home.getByRole('textbox', { name: 'Reminder title', exact: true })).toBeVisible();
    await home.getByRole('button', { name: 'Close reminder editor', exact: true }).click();
  }
  expect(folders).not.toContain('WrongFolder');

  // Replace A with B, then launch immutable A with its obsolete folder settings.
  await home.goto(`${origin}/notifications?token=renewal-${launchMode}&folder=RenewedTasks&tab=inbox`);
  await home.getByRole('group', { name: cardName, exact: true }).waitFor();
  expect(exchanges.at(-1).previousAuthToken).toBe(existingAuth);
  expect(await home.evaluate(() => sessionStorage.getItem('crate-reminder-draft:existing'))).toBe('keep existing edit');
  await home.evaluate(() => sessionStorage.setItem('crate-reminder-draft:renewed', 'keep renewed edit'));
  const afterRenewal = exchanges.length;
  folders.length = 0;
  await home.goto(launchUrl);
  await home.getByRole('button', { name: 'Open settings', exact: true }).waitFor();
  await expect.poll(() => folders.includes('RenewedTasks')).toBe(true);
  expect(exchanges).toHaveLength(afterRenewal);
  expect(await home.evaluate(key => localStorage.getItem(key), authKey)).toBeTruthy();
  expect(await home.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-config')).folderPath)).toBe('RenewedTasks');
  expect(await home.evaluate(() => sessionStorage.getItem('crate-reminder-draft:renewed'))).toBe('keep renewed edit');
  expect(folders).not.toContain('Tasks');

  // Cleaned-up Safari links and old notification URLs no longer contain a
  // grant. They must not move a renewed, folder-scoped session back either.
  await home.goto(`${origin}/notifications?folder=Tasks&tab=inbox`);
  await home.getByRole('group', { name: cardName, exact: true }).waitFor();
  expect(await home.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-config')).folderPath)).toBe('RenewedTasks');
  expect(await home.evaluate(() => sessionStorage.getItem('crate-reminder-draft:renewed'))).toBe('keep renewed edit');
  expect(exchanges).toHaveLength(afterRenewal);
  expect(folders).not.toContain('Tasks');

  await home.getByRole('button', { name: 'Open settings', exact: true }).click();
  await home.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect.poll(() => home.evaluate(key => localStorage.getItem(key), authKey)).toBeNull();
  await home.goto(launchUrl);
  await home.getByRole('button', { name: 'Open Obsidian', exact: true }).waitFor();
  expect(exchanges).toHaveLength(afterRenewal);
  expect(await home.evaluate(() => sessionStorage.getItem('crate-reminder-draft:renewed'))).toBeNull();
  await home.goto(`${origin}/notifications?token=after-logout-${launchMode}&folder=FreshTasks&tab=inbox`);
  await home.getByRole('group', { name: cardName, exact: true }).waitFor();
  expect(exchanges.at(-1).previousAuthToken).toBeUndefined();
  expect(await home.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-config')).folderPath)).toBe('FreshTasks');

  // Logging out in Safari must discard the outstanding install handoff too.
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), authKey)).toBeNull();
  expect(await safari.cookies()).toEqual([]);
  expect(new URL(page.url()).searchParams.has('token')).toBe(false);
  await installed.close();
  await safari.close();
}

async function testConcurrentEnrollment(browser) {
  const context = await createContext(browser, true);
  try {
    const one = await context.newPage();
    const two = await context.newPage();
    const exchanges = [];
    let pending;
    await context.route('**/notifications/reminders-exchange', route => {
      exchanges.push(route.request().postDataJSON());
      pending = route;
    });
    const installUrl = `${origin}/notifications?token=concurrent-install&folder=Tasks&tab=inbox`;
    await one.goto(installUrl);
    await expect.poll(() => exchanges.length).toBe(1);
    await two.goto(installUrl);
    await expect.poll(() => two.evaluate(async () => (await navigator.locks.query()).pending.length)).toBe(1);
    await pending.fulfill({ response: await pending.fetch() });
    await one.getByRole('group', { name: cardName, exact: true }).waitFor();
    await two.getByRole('button', { name: 'Open settings', exact: true }).waitFor();
    expect(await two.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-config')).folderPath)).toBe('Tasks');
    expect(exchanges).toHaveLength(1);

    // Logging out in another tab while replacement is pending must fence its
    // eventual success and keep both tabs logged out, without a stuck splash.
    await one.goto(`${origin}/notifications?token=pending-replacement&folder=OtherFolder&tab=inbox`);
    await expect.poll(() => exchanges.length).toBe(2);
    await two.getByRole('button', { name: 'Open settings', exact: true }).click();
    await two.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect.poll(() => two.evaluate(key => localStorage.getItem(key), authKey)).toBeNull();
    await pending.fulfill({ response: await pending.fetch() });
    await one.getByRole('button', { name: 'Open Obsidian', exact: true }).waitFor();
    await two.getByRole('button', { name: 'Open Obsidian', exact: true }).waitFor();
    expect(await one.evaluate(key => localStorage.getItem(key), authKey)).toBeNull();
    expect(await one.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-config')).folderPath)).toBe('Tasks');
  } finally { await context.close(); }
}

async function testLateReplacementFailure(browser) {
  const context = await createContext(browser, true);
  try {
    await context.addInitScript(() => { Object.defineProperty(navigator, 'locks', { value: undefined }); });
    let pending;
    await context.route('**/notifications/reminders-exchange', async route => {
      if (route.request().postDataJSON().token === 'late-failure') pending = route;
      else await route.fulfill({ response: await route.fetch() });
    });
    const one = await context.newPage();
    await one.goto(`${origin}/notifications?token=initial-session&folder=Tasks&tab=inbox`);
    await one.getByRole('group', { name: cardName, exact: true }).waitFor();
    await one.goto(`${origin}/notifications?token=late-failure&folder=WrongFolder&tab=inbox`);
    await expect.poll(() => Boolean(pending)).toBe(true);
    const two = await context.newPage();
    await two.goto(`${origin}/notifications?token=successful-renewal&folder=NewFolder&tab=inbox`);
    await two.getByRole('group', { name: cardName, exact: true }).waitFor();
    await two.evaluate(() => sessionStorage.setItem('crate-reminder-draft:renewed', 'new session draft'));
    await pending.fulfill({ status: 401, body: 'Invalid or expired enrollment token' });
    await one.getByRole('button', { name: 'Open settings', exact: true }).waitFor();
    expect(await one.evaluate(key => localStorage.getItem(key), authKey)).toBeTruthy();
    expect(await one.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-config')).folderPath)).toBe('NewFolder');
    expect(await two.evaluate(() => sessionStorage.getItem('crate-reminder-draft:renewed'))).toBe('new session draft');
  } finally { await context.close(); }
}

try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      for (const mode of ['manifest', 'document', 'cookie', 'retry']) {
        await testInstall(browser, mode);
        console.log(`${browserType.name()}: ${mode} enrollment survives refresh, failed renewal, A → B → A, logout and fresh enrollment`);
      }
      await testConcurrentEnrollment(browser);
      console.log(`${browserType.name()}: concurrent tabs redeem once and pending renewal cannot reverse logout`);
      await testLateReplacementFailure(browser);
      console.log(`${browserType.name()}: without Web Locks, late failed replacement preserves another tab's renewed session`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
