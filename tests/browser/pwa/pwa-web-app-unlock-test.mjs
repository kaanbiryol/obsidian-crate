/* global webKeys -- Bundled production key import and browser persistence. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';

const harness = (await build({ stdin: { contents: `
export * from './src/encryption/key-bundle';
export * from './src/encryption/server-state';
export * from './src/pwa/encryption/web-app-unlock';
export * from './src/pwa/encryption/encryption-keys';
export { AUTH_TOKEN_KEY, saveConfig } from './src/pwa/config';
export { READING_SESSION_KEY } from './src/pwa/reading/storage';
`, resolveDir: process.cwd() }, bundle: true, format: 'iife', globalName: 'webKeys', write: false })).outputFiles[0].text;

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const primary of ['Reminders', 'Reading']) {
      const page = await browser.newPage();
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Web app unlock</title>' }));
      await page.goto('https://web-keys.test');
      await page.addScriptTag({ content: harness });
      const vaultId = await page.evaluate(async primary => {
        const t = webKeys;
        const bundle = await t.createVaultKeyBundle();
        const code = await t.generateRecoveryCode();
        const expected = { ...t.createEncryptionState(bundle, await t.sealRecoveryBundle(bundle, code)), mode: 'active' };
        localStorage.setItem(t.AUTH_TOKEN_KEY, 'reminder-session');
        t.saveConfig({ folderPath: 'Old reminders', upcomingDays: 7, allDayNotificationTime: null });
        const readingSession = { token: 'reader-token', id: 'reader', folderPath: 'Old reading', generation: 'policy', expiresAt: Date.now() + 100000 };
        localStorage.setItem(t.READING_SESSION_KEY, JSON.stringify(readingSession));
        let rejected = false;
        try { await t.rememberRecoveryKey(code, { ...expected, vaultId: crypto.randomUUID() }, () => true); } catch { rejected = true; }
        if (!rejected || (await t.exportWrappedLocalKeys()).length) throw new Error('Wrong-vault code was persisted');
        // Either feature's connection changing during key import must fence the unlock.
        const originalImport = SubtleCrypto.prototype.importKey;
        let changed = false;
        SubtleCrypto.prototype.importKey = function(...args) {
          changed = true;
          if (primary === 'Reading') localStorage.setItem(t.READING_SESSION_KEY, JSON.stringify({ ...readingSession, token: 'new-reader-token' }));
          else localStorage.setItem(t.AUTH_TOKEN_KEY, 'new-session');
          return originalImport.apply(this, args);
        };
        rejected = false;
        try { await t.rememberRecoveryKey(code, expected, () => true); } catch { rejected = true; }
        finally { SubtleCrypto.prototype.importKey = originalImport; }
        if (!changed || !rejected || (await t.exportWrappedLocalKeys()).length) throw new Error('Stale unlock persisted keys');
        localStorage.setItem(t.AUTH_TOKEN_KEY, 'reminder-session');
        localStorage.setItem(t.READING_SESSION_KEY, JSON.stringify(readingSession));

        await t.rememberRecoveryKey(code, expected, () => true);
        const keys = await t.readVaultKeys(bundle.vaultId);
        if (keys.vault.key.extractable || keys.notifications.key.extractable || keys.notificationFingerprint.extractable || keys.pathTag.extractable || keys.seal.privateKey.extractable
          || keys.vault.secret || keys.notifications.secret) throw new Error('Raw key persisted');
        if ((await t.exportWrappedLocalKeys()).length !== 1) throw new Error('One vault must keep one key record');
        for (const feature of ['reminders', 'reading']) {
          const cipher = await t.unlockLocalState(keys, feature);
          localStorage.setItem('draft:' + feature, cipher.seal('Private draft for ' + feature, 'draft'));
          cipher.destroy();
        }
        // Recovering again must retain the same wrapped local draft key for both features.
        await t.rememberRecoveryKey(code, expected, () => true);
        if (Object.values(localStorage).some(value => value.includes('Private draft') || value.includes('crate-recovery-v1.'))) throw new Error('Unlock leaked code or plaintext');
        return bundle.vaultId;
      }, primary);
      await page.reload();
      await page.addScriptTag({ content: harness });
      await page.context().setOffline(true);
      const drafts = await page.evaluate(async vaultId => {
        const keys = await webKeys.readVaultKeys(vaultId);
        return Promise.all(['reminders', 'reading'].map(async feature => {
          const cipher = await webKeys.unlockLocalState(keys, feature);
          const draft = cipher.open(localStorage.getItem('draft:' + feature), 'draft');
          cipher.destroy(); return draft;
        }));
      }, vaultId);
      assert.deepEqual(drafts, ['Private draft for reminders', 'Private draft for reading']);
      await page.close();
    }
    console.log(`One-code vault unlock, wrong-vault rejection, Reminders/Reading stale-session fencing, non-extractable keys and offline draft recovery passed (${engine.name()})`);
  } finally { await browser.close(); }
}
