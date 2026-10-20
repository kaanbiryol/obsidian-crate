/* global webKeys -- Bundled production key import and browser persistence. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';

const harness = (await build({ stdin: { contents: `
export * from './src/encryption/key-bundle';

export * from './src/pwa/web-app-unlock';
export * from './src/pwa/encryption-keys';
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
      const identities = await page.evaluate(async primary => {
        const t = webKeys;
        const bundle = t.addReminderScope(t.addReminderScope(t.createVaultKeyBundle(), 'Reminders'), 'Reading', 'reading');
        const grants = ['Reminders', 'Reading'].map(folder => t.createReminderKeyGrant(bundle, folder));
        const scope = grants.find(grant => grant.scope.folderPath === primary).scope;
        const code = await t.generateRecoveryCode();
        const expected = { version: 1, vaultId: bundle.vaultId, generation: bundle.generation, mode: 'active', recovery: await t.sealRecoveryBundle(bundle, code),
          scope: { id: scope.id, folderPath: scope.folderPath, purpose: scope.purpose, keyId: scope.data.id, notificationKeyId: scope.notifications.id } };
        localStorage.setItem(t.AUTH_TOKEN_KEY, 'reminder-session');
        t.saveConfig({ folderPath: 'Old reminders', upcomingDays: 7, allDayNotificationTime: null });
        localStorage.setItem(t.READING_SESSION_KEY, JSON.stringify({ token: 'reader-token', id: 'reader', folderPath: 'Old reading', generation: 'policy', expiresAt: Date.now() + 100000 }));
        let rejected = false;
        try { await t.rememberRecoveryKey(code, { ...expected, vaultId: crypto.randomUUID() }, primary, () => true); } catch { rejected = true; }
        if (!rejected || (await t.exportWrappedLocalKeys()).length) throw new Error('Wrong-vault code was persisted');
        const originalImport = SubtleCrypto.prototype.importKey;
        let changed = false;
        SubtleCrypto.prototype.importKey = function(...args) {
          changed = true; localStorage.setItem(t.AUTH_TOKEN_KEY, 'new-session');
          return originalImport.apply(this, args);
        };
        rejected = false;
        try { await t.rememberRecoveryKey(code, expected, primary, () => true); } catch { rejected = true; }
        finally { SubtleCrypto.prototype.importKey = originalImport; }
        if (!changed || !rejected || (await t.exportWrappedLocalKeys()).length) throw new Error('Stale unlock persisted keys');

        await t.rememberRecoveryKey(code, expected, primary === 'Reading' ? 'Old reading' : 'Old reminders', () => true);
        for (const grant of grants) {
          const keys = await t.readReminderKeys(bundle.vaultId, grant.scope.id);
          if (keys.data.key.extractable || keys.notifications.key.extractable || keys.notificationFingerprint.extractable || keys.data.secret) throw new Error('Raw key persisted');
          if (keys.localFolderPath !== (grant.scope.purpose ? 'Old reading' : 'Old reminders')) throw new Error('Local namespace changed');
          const cipher = await t.unlockLocalState(keys);
          localStorage.setItem('draft:' + keys.scopeId, cipher.seal('Private draft for ' + keys.scopeId, 'draft'));
          cipher.destroy();
        }
        // Recovering either feature must retain the same wrapped local draft keys.
        await t.rememberRecoveryKey(code, expected, primary === 'Reading' ? 'Old reading' : 'Old reminders', () => true);
        if (Object.values(localStorage).some(value => value.includes('Private draft') || value.includes('crate-recovery-v1.'))) throw new Error('Unlock leaked code or plaintext');
        return grants.map(grant => ({ vaultId: grant.vaultId, scopeId: grant.scope.id }));
      }, primary);
      await page.reload();
      await page.addScriptTag({ content: harness });
      await page.context().setOffline(true);
      const drafts = await page.evaluate(async identities => {
        return Promise.all(identities.map(async identity => {
          const keys = await webKeys.readReminderKeys(identity.vaultId, identity.scopeId);
          const cipher = await webKeys.unlockLocalState(keys);
          const draft = cipher.open(localStorage.getItem('draft:' + keys.scopeId), 'draft');
          cipher.destroy(); return draft;
        }));
      }, identities);
      assert.deepEqual(drafts, identities.map(identity => 'Private draft for ' + identity.scopeId));
      await page.close();
    }
    console.log(`One-code unlock from either feature, wrong-vault rejection, stale-session fencing, non-extractable keys and offline draft recovery passed (${engine.name()})`);
  } finally { await browser.close(); }
}
