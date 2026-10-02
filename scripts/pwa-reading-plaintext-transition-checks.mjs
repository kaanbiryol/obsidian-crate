import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function verifyReadingPlaintextTransition({ t, browser, origin, owner, bundle, recovery }) {
  const context = await browser.newContext(), page = await context.newPage();
  const privateUrl = 'https://example.invalid/private-after-encryption', sent = [];
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).origin === origin) sent.push(request.postData() ?? ''); });
  const previousWindow = globalThis.window; globalThis.window = { setTimeout, clearTimeout };
  try {
    const http = new t.WorkerApiHttpClient(origin, owner.token, async request => {
      const response = await fetch(request.url, { method: request.method, body: request.body, headers: { ...request.headers, 'Content-Type': request.contentType ?? 'application/json' } });
      const bytes = await response.arrayBuffer(); return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: bytes, text: new TextDecoder().decode(bytes) };
    });
    const { token } = await http.requestJson('/reading/access', { method: 'POST', body: JSON.stringify({ kind: 'reading' }) });
    await page.goto(`${origin}/notifications?section=reading#reading=${token}`);
    await page.getByRole('button', { name: 'Save a link', exact: true }).click();
    await page.getByLabel('Link', { exact: true }).fill(privateUrl);
    // Keep this plaintext tab and its draft open while an Obsidian client
    // enables encryption and changes the enrollment's key requirements.
    await t.convertEncryptedVault(http, bundle, recovery, () => {});
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
    await expect(page.getByText(/Could not verify Reading encryption|Reconnect Reading|Reading sign-in|Unlock Reading with the web app key/).first()).toBeVisible({ timeout: 15000 });
    assert.ok(!sent.some(body => body.includes(privateUrl)), 'A stale plaintext Reading tab sent a private URL after encryption was enabled');
  } finally {
    await context.close();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
}
