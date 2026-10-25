import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function verifyReadingPlaintextTransition({ t, browser, origin, owner, bundle, recovery }) {
  const context = await browser.newContext(), page = await context.newPage();
  const privateUrl = 'https://example.invalid/private-after-encryption', sent = [];
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).origin === origin) sent.push(request.postData() ?? ''); });
  const previousWindow = globalThis.window; globalThis.window = { setTimeout, clearTimeout };
  try {
    const transport = async request => {
      const response = await fetch(request.url, { method: request.method, body: request.body, headers: { ...request.headers, 'Content-Type': request.contentType ?? 'application/json' } });
      const bytes = await response.arrayBuffer(); return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: bytes, text: new TextDecoder().decode(bytes) };
    };
    const http = new t.WorkerApiHttpClient(origin, owner.token, transport);
    const { browserToken } = await http.requestJson('/notifications/reminders-enrollment-token', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders' }) });
    await page.goto(`${origin}/notifications?section=reading&browserToken=${browserToken}`);
    await page.getByRole('button', { name: 'Save a link', exact: true }).click();
    await page.getByLabel('Link', { exact: true }).fill(privateUrl);
    // Keep this plaintext tab and its draft open while an Obsidian client turns
    // encryption on, replacing the server copy and revoking every web enrollment.
    const setup = t.createEncryptionSetup(origin, owner.token, bundle, true);
    await t.resetRemoteEncryption(setup, () => {}, () => {}, token => new t.WorkerApiHttpClient(origin, token, transport), () => {},
      async () => t.createEncryptionState(bundle, await t.sealRecoveryBundle(bundle, recovery)));
    owner.token = setup.replacementToken;
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
    // Setup revoked this tab's sign-in; it must ask to reconnect instead of saving.
    try { await expect(page.getByRole('heading', { name: 'Reconnect to Crate', exact: true })).toBeVisible({ timeout: 15000 }); }
    catch (error) { console.log('Stale Reading tab:', await page.locator('body').innerText({ timeout: 2000 }).catch(() => 'unavailable')); throw error; }
    assert.ok(!sent.some(body => body.includes(privateUrl)), 'A stale plaintext Reading tab sent a private URL after encryption was enabled');
  } finally {
    await context.close();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
}
