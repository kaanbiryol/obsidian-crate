import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function verifyReadingFolderMove({ t, page, origin, owner, bundle, recovery }) {
  // The plugin transport uses browser timers. Exercise its real conversion with
  // an explicit fetch transport against disposable local D1/R2 only.
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  try {
    const transport = async request => {
      const response = await fetch(request.url, { method: request.method, body: request.body,
        headers: { ...request.headers, 'Content-Type': request.contentType ?? 'application/json' } });
      const bytes = await response.arrayBuffer();
      return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: bytes, text: new TextDecoder().decode(bytes) };
    };
    const http = new t.WorkerApiHttpClient(origin, owner.token, transport);
    http.setEncryptionAuthority(bundle.vaultId, bundle.generation);
    const enroll = async (keys, folder) => {
      const { token } = await http.requestJson('/reading/access', { method: 'POST', body: JSON.stringify({ kind: 'reading' }) });
      // Open the setup link as a new document, as Obsidian does. Navigating an
      // already-open /notifications page to only a new hash does not reload it.
      await page.goto(origin + '/health');
      await page.goto(`${origin}/notifications?section=reading#reading=${token}&crateReadingKey=${encodeURIComponent(t.encodeWebAppKey([t.createReminderKeyGrant(keys, folder)]))}`);
      await expect(page.getByText('Encrypted Reading article', { exact: true })).toBeVisible({ timeout: 30000 });
    };
    await enroll(bundle, 'Reading');
    const oldSession = await page.evaluate(() => JSON.parse(localStorage.getItem('crate-reading-session-v1')));
    const next = t.moveEncryptionScopes(bundle, 'Reading', 'Articles');
    await t.convertEncryptedVault(http, next, recovery, () => {});
    // Apply the file move through the same conditional upload/delete API used by
    // normal sync, after updating its scope configuration.
    const api = new t.SyncApiClient(origin, owner.token, transport); await api.configureEncryption(next);
    const oldPath = 'Reading/Article.md', nextPath = 'Articles/Article.md';
    const file = await api.downloadFile(oldPath);
    const keys = await t.FileKeyAuthority.fromVault(next);
    const sealed = await t.sealFile({ path: nextPath, content: new Uint8Array(file.content), contentType: 'text/markdown', publicData: null }, keys.forPath(nextPath));
    const info = await http.getServerInfo();
    await api.uploadFile(nextPath, sealed.bytes.buffer, sealed.hash, sealed.bytes.length, 'application/vnd.crate.encrypted-file', null,
      `e1_${String(info.reminderOperationDay).padStart(8, '0')}_${crypto.randomUUID()}`);
    const old = (await api.getFileMetadata([oldPath])).files[oldPath];
    await api.deleteFile(oldPath, old.hash, old.revision);
    assert.equal((await fetch(origin + '/reading/encryption', { headers: { Authorization: `Bearer ${oldSession.token}`, 'X-Crate-Protocol': '2' } })).status, 200);
    // The same open PWA follows the rename on refresh, without another link/key.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await expect(page.getByText('Articles', { exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(page.getByText('Encrypted Reading article', { exact: true })).toBeVisible({ timeout: 30000 });
    await page.reload();
    await expect(page.getByText('Encrypted Reading article', { exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await expect(page.getByText('Active · this Reading folder is unlocked.', { exact: true })).toBeVisible();
    await expect(page.getByText('Articles', { exact: true })).toBeVisible();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('crate-reading-session-v1'))), oldSession);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}
