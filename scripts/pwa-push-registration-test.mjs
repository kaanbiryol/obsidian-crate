import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { previewAuthToken } from './pwa-preview-fixtures.mjs';

// Browser/provider and registration responses are controlled here. Real Worker
// authentication, endpoint ownership and D1 upserts have separate runtime tests.
const assets = await buildPwaPreviewAssets({ assetVersion: 'push-registration-regression' });
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const authKey = 'crate-reminders-auth-token';
const providerKey = 'test-push-provider';
const firstEndpoint = 'https://fcm.googleapis.com/fcm/send/first';
const nextEndpoint = 'https://fcm.googleapis.com/fcm/send/rotated';
const provider = (page, patch) => page.evaluate(({ providerKey, patch }) => {
  const value = JSON.parse(localStorage.getItem(providerKey));
  localStorage.setItem(providerKey, JSON.stringify({ ...value, ...patch }));
}, { providerKey, patch });
const providerState = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), providerKey);
const resume = page => page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
const on = page => page.locator('.settings-status.is-success');
const retry = page => page.getByRole('button', { name: 'Retry', exact: true });

async function harness(browser, existing = false) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const sessions = new Set([previewAuthToken]);
  const rows = new Map();
  const attempts = [];
  const held = [];
  const control = { mode: 'ok', holdToken: null };
  await context.addInitScript(({ authKey, providerKey, token, existing, firstEndpoint }) => {
    if (!localStorage.getItem(providerKey)) {
      localStorage.setItem(authKey, token);
      localStorage.setItem(providerKey, JSON.stringify({ permission: existing ? 'granted' : 'default', endpoint: existing ? firstEndpoint : null, subscribes: 0, unsubscribes: 0 }));
    }
    const read = () => JSON.parse(localStorage.getItem(providerKey));
    const write = value => localStorage.setItem(providerKey, JSON.stringify(value));
    const subscription = endpoint => {
      const keys = { p256dh: read().p256dh || 'provider-key', auth: 'provider-auth' };
      return {
        endpoint,
        toJSON: () => ({ endpoint, keys }),
        unsubscribe: async () => { const value = read(); write({ ...value, endpoint: value.endpoint === endpoint ? null : value.endpoint, unsubscribes: value.unsubscribes + 1 }); return true; },
      };
    };
    Object.defineProperty(window, 'Notification', { configurable: true, value: class {
      static get permission() { return read().permission; }
    } });
    Object.defineProperty(window, 'pushManager', { configurable: true, value: {
      getSubscription: async () => { const value = read(); if (value.readFailure) throw new Error('Provider unavailable'); return value.endpoint ? subscription(value.endpoint) : null; },
      subscribe: async () => { const value = read(); const endpoint = value.endpoint || firstEndpoint; write({ ...value, permission: 'granted', endpoint, subscribes: value.subscribes + 1 }); return subscription(endpoint); },
      permissionState: async () => read().permission,
    } });
  }, { authKey, providerKey, token: previewAuthToken, existing, firstEndpoint });
  await context.route('**/notifications/preview-session.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await context.route('**/notifications/vapid-public-key', route => route.fulfill({ contentType: 'application/json', body: '{"publicKey":"AQID"}' }));
  await context.route('**/notifications/reminders-exchange', async route => {
    const body = route.request().postDataJSON();
    sessions.delete(body.previousAuthToken);
    for (const [endpoint, row] of rows) if (row.owner === body.previousAuthToken) rows.delete(endpoint);
    const authToken = `new-session-${body.token}`;
    sessions.add(authToken);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authToken }) });
  });
  await context.route('**/auth/session', async route => {
    const token = route.request().headers().authorization?.slice(7);
    sessions.delete(token);
    for (const [endpoint, row] of rows) if (row.owner === token) rows.delete(endpoint);
    await route.fulfill({ contentType: 'application/json', body: '{"success":true}' });
  });
  await context.route('**/reminders/**', async route => {
    const request = route.request();
    if (!sessions.has(request.headers().authorization?.slice(7))) return route.fulfill({ status: 401, body: 'Expired session' });
    return route.continue({ headers: { ...request.headers(), authorization: `Bearer ${previewAuthToken}` } });
  });
  await context.route('**/notifications/subscribe', async route => {
    const token = route.request().headers().authorization?.slice(7);
    const body = route.request().postDataJSON();
    attempts.push({ token, ...body });
    if (!sessions.has(token)) return route.fulfill({ status: 401, body: 'Expired session' });
    if (control.mode === 'before') return route.fulfill({ status: 503, body: 'Registration unavailable' });
    const existing = rows.get(body.endpoint);
    if (existing && existing.owner !== token) return route.fulfill({ status: 429, body: 'Endpoint belongs to another session' });
    const row = existing || { id: `registration-${rows.size}`, owner: token };
    rows.set(body.endpoint, row);
    if (control.holdToken === token) await new Promise(resolve => held.push(resolve));
    if (control.mode === 'after') return route.fulfill({ status: 503, body: 'Registration response lost' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(control.mode === 'malformed' ? {} : { id: row.id }) });
  });
  const page = await context.newPage();
  const open = async () => {
    await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  };
  const renew = async (target = page) => {
    await target.goto(`${origin}/notifications?browserToken=renewal-${Date.now()}&folder=Reminders&tab=inbox`);
    await target.getByRole('button', { name: 'Open settings', exact: true }).click();
  };
  return { context, page, open, renew, rows, attempts, control, release: () => held.splice(0).forEach(resolve => resolve()), close: async () => { held.splice(0).forEach(resolve => resolve()); await context.close(); } };
}

async function registrationFailure(browser, failure) {
  const state = await harness(browser);
  const { page, open, control, rows, attempts } = state;
  try {
    control.mode = failure;
    await open();
    await page.getByRole('button', { name: 'Enable', exact: true }).click();
    await retry(page).waitFor();
    await expect(on(page)).toHaveCount(0);
    expect((await providerState(page)).subscribes, await page.getByRole('dialog', { name: 'Settings', exact: true }).innerText()).toBe(1);
    await resume(page);
    await expect.poll(() => attempts.length).toBe(2);
    await retry(page).waitFor();
    await expect(on(page)).toHaveCount(0);
    control.mode = 'ok';
    await retry(page).click();
    await on(page).waitFor();
    expect(rows.size).toBe(1);
    expect((await providerState(page)).subscribes).toBe(1);
    expect(new Set(attempts.map(attempt => attempt.endpoint))).toEqual(new Set([firstEndpoint]));
    rows.clear();
    await resume(page);
    await expect.poll(() => rows.size).toBe(1);
    await on(page).waitFor();
  } finally { await state.close(); }
}

async function renewalAndProviderChanges(browser) {
  const state = await harness(browser, true);
  const { page, open, renew, rows, attempts, control, release } = state;
  try {
    await open();
    await on(page).waitFor();
    expect(rows.get(firstEndpoint).owner).toBe(previewAuthToken);
    await renew();
    await on(page).waitFor();
    const currentToken = await page.evaluate(key => localStorage.getItem(key), authKey);
    expect(rows.get(firstEndpoint).owner).toBe(currentToken);
    expect((await providerState(page)).subscribes).toBe(0);
    await provider(page, { permission: 'denied' });
    const beforeDenied = attempts.length;
    await resume(page);
    await page.getByText('Blocked', { exact: true }).waitFor();
    await expect(on(page)).toHaveCount(0);
    expect(attempts.length).toBe(beforeDenied);
    await provider(page, { permission: 'unknown' });
    await resume(page);
    await retry(page).waitFor();
    await expect(page.getByText('Not supported', { exact: true })).toHaveCount(0);
    await provider(page, { permission: 'granted', readFailure: true });
    await retry(page).click();
    await expect(page.getByText('Notifications are not confirmed. Provider unavailable', { exact: true })).toBeVisible();
    await provider(page, { readFailure: false });
    control.mode = 'malformed';
    await retry(page).click();
    await expect(page.getByText('Notifications are not confirmed. The server did not confirm notification registration.', { exact: true })).toBeVisible();
    control.mode = 'ok';
    control.holdToken = currentToken;
    const previousAttempts = attempts.length;
    await retry(page).click();
    await expect.poll(() => attempts.length).toBe(previousAttempts + 1);
    await page.getByText('Checking…', { exact: true }).waitFor();
    await provider(page, { endpoint: nextEndpoint });
    release();
    await retry(page).waitFor();
    await expect(on(page)).toHaveCount(0);
    control.holdToken = null;
    await retry(page).click();
    await on(page).waitFor();
    expect(rows.get(nextEndpoint).owner).toBe(currentToken);
    expect((await providerState(page)).subscribes).toBe(0);
    control.holdToken = currentToken;
    const beforeKeyChange = attempts.length;
    await resume(page);
    await expect.poll(() => attempts.length).toBe(beforeKeyChange + 1);
    await provider(page, { p256dh: 'rotated-provider-key' });
    release();
    await retry(page).waitFor();
    await expect(on(page)).toHaveCount(0);
    control.holdToken = null;
    await retry(page).click();
    await on(page).waitFor();
    expect(attempts.at(-1).keys.p256dh).toBe('rotated-provider-key');
  } finally { await state.close(); }
}

async function logoutDuringConfirmation(browser) {
  const state = await harness(browser, true);
  const { context, page, open, renew, attempts, control, release } = state;
  try {
    control.holdToken = previewAuthToken;
    await open();
    await expect.poll(() => attempts.length).toBe(1);
    await page.getByText('Checking…', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), authKey)).toBe(null);
    const peer = await context.newPage();
    await renew(peer);
    await on(peer).waitFor();
    // The original tab adopts this session while its earlier cleanup is pending.
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await on(page).waitFor();
    release();
    await expect.poll(() => page.getByRole('button', { name: 'Log out', exact: true }).isEnabled()).toBe(true);
    await expect(on(page)).toBeVisible();
    expect((await providerState(page)).endpoint).toBe(firstEndpoint);
    expect((await providerState(page)).unsubscribes).toBe(0);
  } finally { await state.close(); }
}

try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      for (const failure of ['before', 'after']) await registrationFailure(browser, failure);
      await renewalAndProviderChanges(browser);
      await logoutDuringConfirmation(browser);
      console.log(`${browserType.name()}: server confirmation gates On; failed/lost registrations retry, renewal/restored rows repair, provider changes and unknown states stay truthful, and late logout cleanup preserves a fresh session`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
