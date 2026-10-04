import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function verifyReminderFolderMove({ admin, page, origin, owner, setOffline, setFault, getFault, replays, notification }) {
  const token = await page.evaluate(() => localStorage.getItem('crate-reminders-auth-token'));
  const start = replays.length;
  setFault('after');
  await page.locator('[data-action="open-create-modal"]').click();
  await page.getByRole('textbox', { name: 'Reminder title', exact: true }).fill('Accepted before the folder moved');
  await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
  await expect.poll(() => replays.length).toBeGreaterThan(start);
  await expect.poll(getFault).toBe('retry');
  await setOffline(true);
  setFault('none');
  // The originating plugin moves the scope and then its files through normal sync.
  await admin.evaluate(async ({ origin, token }) => {
    const t = window.crateEncryptionTest;
    const transport = async request => {
      const response = await fetch(request.url, { method: request.method, body: request.body,
        headers: { ...request.headers, 'Content-Type': request.contentType ?? 'application/json' } });
      const bytes = await response.arrayBuffer();
      return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: bytes, text: new TextDecoder().decode(bytes) };
    };
    const http = new t.WorkerApiHttpClient(origin, token, transport);
    let bundle = window.encryptedTestKeys;
    // Two offline moves also exercise a parent-folder rename.
    for (const [from, to] of [['Reminders', 'Personal/Tasks'], ['Personal', 'Work']]) {
      const next = t.moveEncryptionScopes(bundle, from, to);
      await t.convertEncryptedVault(http, next, window.encryptedTestRecovery, () => {});
      const api = new t.SyncApiClient(origin, token, transport); await api.configureEncryption(next);
      const inventory = await api.getManifest(), keys = await t.FileKeyAuthority.fromVault(next), info = await http.getServerInfo();
      for (const path of Object.keys(inventory.files).filter(path => path.startsWith(from + '/'))) {
        const nextPath = to + path.slice(from.length), file = await api.downloadFile(path);
        const content = new Uint8Array(file.content);
        const sealed = await t.sealFile({ path: nextPath, content, contentType: 'text/markdown', publicData: await t.createReminderProjection(next, nextPath, content.buffer) }, keys.forPath(nextPath));
        await api.uploadFile(nextPath, sealed.bytes.buffer, sealed.hash, sealed.bytes.length, 'application/vnd.crate.encrypted-file', null,
          `e1_${String(info.reminderOperationDay).padStart(8, '0')}_${crypto.randomUUID()}`);
        const old = (await api.getFileMetadata([path])).files[path]; await api.deleteFile(path, old.hash, old.revision);
      }
      bundle = next;
    }
    window.encryptedTestKeys = bundle;
  }, { origin, token: owner.token });
  // Restore the durable offline state before reconnecting. Reconnecting
  // first starts refresh requests that an immediate reload would cancel.
  await page.reload();
  await expect(page.getByText('Accepted before the folder moved', { exact: true })).toBeVisible();
  await setOffline(false);
  await expect(page.getByText('Accepted before the folder moved', { exact: true })).toBeVisible({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('crate-reminder-outbox:')).length), { timeout: 30000 }).toBe(0);
  assert.equal(await page.evaluate(() => localStorage.getItem('crate-reminders-auth-token')), token);
  await page.locator('[data-action="toggle-settings"]').click();
  await page.getByText('Encryption details', { exact: true }).click();
  await expect(page.getByText('Work/Tasks', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.locator('[data-action="open-create-modal"]').click();
  await page.getByRole('textbox', { name: 'Reminder title', exact: true }).fill('Saved after the folder moved');
  await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
  // Creation encrypts asynchronously before it enters the outbox. Do not treat
  // its initially empty queue as a completed write and reload mid-submit.
  await expect(page.getByRole('textbox', { name: 'Reminder title', exact: true })).toHaveCount(0);
  await expect(page.getByText('Saved after the folder moved', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('crate-reminder-outbox:')).length), { timeout: 30000 }).toBe(0);
  await page.reload();
  await expect(page.getByText('Saved after the folder moved', { exact: true })).toBeVisible();
  await page.addScriptTag({ url: `${origin}/test-encryption-harness.js` });
  assert.equal((await page.evaluate(value => window.crateEncryptionTest.decryptPushDisplay(value), notification))?.title, 'Private push title');
}
