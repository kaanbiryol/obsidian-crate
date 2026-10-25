import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from '../support/preview/pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from '../support/preview/pwa-preview-server.mjs';
import { switchFeature } from '../support/pwa-feature-navigation.mjs';

// Real PWA UI, recovery cryptography and IndexedDB; only HTTP data is a fixture.
// Separate browser contexts model iOS storage separation, not OS installation.
const compiled = await build({ stdin: { resolveDir: process.cwd(), contents: `
export * from './src/encryption/key-bundle';
export * from './src/encryption/server-state';
export { PathTags } from './src/encryption/path-tags';
export { sealFolderLabel } from './src/encryption/folder-label';
export { importEncryptionSecret } from './src/encryption/envelope';` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
const keys = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const bundle = await keys.createVaultKeyBundle();
const recovery = await keys.generateRecoveryCode(), wrong = await keys.generateRecoveryCode();
// Reminders and Reading both receive the vault's full public state.
const state = { ...keys.createEncryptionState(bundle, await keys.sealRecoveryBundle(bundle, recovery)), mode: 'active' };
// The server names feature folders by tag; each session also receives its folder's sealed name.
const sealFolder = async path => keys.sealFolderLabel(path, await keys.PathTags.fromSecret(bundle.vaultId, bundle.vault), await keys.importEncryptionSecret(bundle.vault), bundle.vaultId);
const remindersFolder = await sealFolder('Reminders'), readingFolder = await sealFolder('Reading');
const remindersEncryption = { encryption: state, folderPath: remindersFolder.wire, folderLabel: remindersFolder.label };
const readingEncryption = { encryption: state, folderLabel: readingFolder.label };
const assets = await buildPwaPreviewAssets();
const { server, origin } = await listenPwaPreviewServer({ port: 0, assets });
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1';
await mkdir('.generated/encryption-onboarding', { recursive: true });

async function contextFor(browser, { installed = false, reading = false, mobile = true, cookies = [], userAgent = iphone } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 390, height: 844 }, ...(mobile ? { userAgent, hasTouch: true } : {}) });
  if (installed) await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  if (reading) await context.addInitScript(folderPath => {
    if (!localStorage.getItem('crate-reading-session-v1')) localStorage.setItem('crate-reading-session-v1', JSON.stringify({
      token: 'preview-reading-token', id: 'reading-test', folderPath, generation: 'policy', expiresAt: Date.now() + 600000,
    }));
  }, readingFolder.wire);
  await context.addCookies(cookies);
  await context.route('**/notifications/preview-session.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await context.route('**/encryption', route => route.fulfill({ json: remindersEncryption }));
  await context.route('**/reading/encryption', route => route.fulfill({ json: readingEncryption }));
  await context.route('**/*/encrypted-files?*', route => route.fulfill({ json: { files: [], nextCursor: null, generation: bundle.generation, sequence: 1 } }));
  context.on('request', request => assert.ok(!(request.url() + (request.postData() ?? '')).includes(recovery), 'Recovery key must not reach the server'));
  return context;
}

try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const safari = await contextFor(browser);
      let installCookies;
      try {
        const page = await safari.newPage();
        await page.goto(`${origin}/notifications?token=install-onboarding&browserToken=safari-onboarding&tab=inbox#${new URLSearchParams({ crateKey: recovery, crateReadingKey: recovery, crateFolder: 'Reminders' })}`);
        await expect(page.getByRole('heading', { name: 'Welcome to Crate', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Continue to web', exact: true })).toBeVisible();
        await expect(page.locator('.crate-feature-panel')).toHaveCount(0);
        await page.screenshot({ path: `.generated/encryption-onboarding/${engine.name()}-browser-choice-light.png`, fullPage: true });
        await page.getByRole('button', { name: 'Install Crate', exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('button', { name: 'Install Crate', exact: true })).toBeFocused();
        await expect(page.getByRole('button', { name: 'Install Crate', exact: true })).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByText('Open as Web App', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Install Crate', exact: true }).click();
        await expect(page.getByText('Open as Web App', { exact: true })).toBeVisible();
        await expect(page.locator('.crate-feature-panel')).toHaveCount(0);
        await page.setViewportSize({ width: 320, height: 568 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `.generated/encryption-onboarding/${engine.name()}-browser-install.png`, fullPage: true });
        await page.getByText('Open Crate from your Home Screen.', { exact: true }).scrollIntoViewIfNeeded();
        await expect(page.getByText('Open Crate from your Home Screen.', { exact: true })).toBeInViewport();
        await expect.poll(() => page.evaluate(id => localStorage.getItem('crate-encryption-unlocked:' + id), bundle.vaultId)).toBe('1');
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Welcome to Crate', exact: true })).toBeVisible();
        await expect(page.locator('.crate-feature-panel')).toHaveCount(0);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ colorScheme: 'dark' });
        await expect(page.locator('html')).toHaveAttribute('data-pwa-color-scheme', 'dark');
        await page.screenshot({ path: `.generated/encryption-onboarding/${engine.name()}-browser-choice.png`, fullPage: true });
        await page.getByRole('button', { name: 'Continue to web', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Welcome to Crate', exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'Open settings', exact: true }).click();
        await expect(page.locator('.pwa-home-screen-prompt')).toHaveCount(0);
        await page.getByRole('button', { name: 'Add to home screen', exact: true }).click();
        await expect(page.getByText('Compare the codes and confirm on both devices.', { exact: false })).toBeVisible();
        await expect(page.getByText('Connect with Obsidian', { exact: true })).toBeVisible();
        installCookies = await safari.cookies();
        assert.ok(installCookies.some(cookie => cookie.name === 'crate-reminders-install'));
        assert.ok(installCookies.every(cookie => !cookie.value.includes(recovery)));
        await page.reload();
        await expect(page.locator('.crate-feature-panel[data-active="true"]')).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Welcome to Crate', exact: true })).toHaveCount(0);
        await expect(page.locator('.pwa-home-screen-prompt')).toHaveCount(0);
      } finally { await safari.close(); }

      for (const reading of [false, true]) {
        const context = await contextFor(browser, { installed: true, reading, cookies: reading ? [] : installCookies });
        try {
          const page = await context.newPage();
          const url = `${origin}/notifications?${reading ? 'section=reading' : 'tab=inbox'}`;
          await page.goto(url);
          const setup = page.getByRole('heading', { name: 'Finish setting up Crate', exact: true });
          await expect(setup).toBeVisible();
          await expect(page.locator('.toast.is-error')).toHaveCount(0);
          await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).not.toBeVisible();
          await page.emulateMedia({ colorScheme: 'dark' });
          await expect(page.locator('html')).toHaveAttribute('data-pwa-color-scheme', 'dark');
          await page.screenshot({ path: `.generated/encryption-onboarding/${engine.name()}-${reading ? 'reading' : 'reminders'}-setup.png`, fullPage: true });
          await page.emulateMedia({ colorScheme: 'light' });
          await page.reload();
          await expect(setup).toBeVisible();
          await page.getByRole('button', { name: 'Use recovery key instead', exact: true }).click();
          const input = page.getByLabel('Recovery key', { exact: true });
          await input.fill(wrong);
          await page.getByRole('button', { name: 'Unlock Crate', exact: true }).click();
          await expect(page.locator('.crate-field__error')).toHaveText('This key couldn’t unlock your vault. Check your saved recovery key.');
          await expect(setup).toBeVisible();
          await page.setViewportSize({ width: 320, height: 568 });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.getByRole('button', { name: 'Unlock Crate', exact: true }).scrollIntoViewIfNeeded();
          await expect(page.getByRole('button', { name: 'Unlock Crate', exact: true })).toBeInViewport();
          await page.screenshot({ path: `.generated/encryption-onboarding/${engine.name()}-${reading ? 'reading' : 'reminders'}-small.png`, fullPage: true });
          await page.setViewportSize({ width: 390, height: 844 });
          await input.fill(recovery);
          // Hold crypto to check stable pending controls and duplicate-submit guards.
          await page.evaluate(() => {
            const original = SubtleCrypto.prototype.importKey;
            SubtleCrypto.prototype.importKey = async function (...args) {
              SubtleCrypto.prototype.importKey = original;
              await new Promise(resolve => { window.releaseUnlock = resolve; });
              return original.apply(this, args);
            };
          });
          await page.getByRole('button', { name: 'Unlock Crate', exact: true }).click();
          await expect(page.getByRole('button', { name: 'Unlocking…', exact: true })).toBeDisabled();
          await expect(input).toBeDisabled();
          await page.locator('.crate-encryption-unlock__options summary').click();
          await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toBeDisabled();
          await expect.poll(() => page.evaluate(() => typeof window.releaseUnlock)).toBe('function');
          const unlockedReload = page.waitForEvent('domcontentloaded');
          await page.evaluate(() => window.releaseUnlock());
          await unlockedReload;
          await expect.poll(() => page.evaluate(id => localStorage.getItem('crate-encryption-unlocked:' + id), bundle.vaultId)).toBe('1');
          await expect(page.locator('.crate-encryption-unlock')).toHaveCount(0);
          await page.reload();
          await expect.poll(() => page.evaluate(async () => {
            const db = await new Promise((resolve, reject) => { const r = indexedDB.open('crate-encryption-keys', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
            const count = await new Promise(resolve => { const r = db.transaction('keys').objectStore('keys').count(); r.onsuccess = () => resolve(r.result); }); db.close(); return count;
          })).toBe(1);
          await expect(page.locator('.crate-encryption-unlock')).toHaveCount(0);
          // An established app that loses keys needs recovery, not first-run copy.
          await page.evaluate(async () => {
            const db = await new Promise(resolve => { const r = indexedDB.open('crate-encryption-keys', 1); r.onsuccess = () => resolve(r.result); });
            const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').clear();
            await new Promise(resolve => { tx.oncomplete = resolve; }); db.close();
          });
          await page.reload();
          await expect(page.getByRole('heading', { name: 'Unlock Crate', exact: true })).toBeVisible();
          await expect(setup).toHaveCount(0);
        } finally { await context.close(); }
      }
      const android = await contextFor(browser, { userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36' });
      try {
        await android.route('**/encryption', route => route.fulfill({ json: { encryption: null } }));
        const page = await android.newPage();
        await page.goto(`${origin}/notifications?token=android-install&browserToken=android-browser&folder=Reminders&tab=inbox`);
        await page.getByRole('button', { name: 'Install Crate', exact: true }).click();
        await expect(page.getByText('menu (⋮)', { exact: true })).toBeVisible();
        await expect(page.getByText('Open as Web App', { exact: true })).toHaveCount(0);
        await expect(page.locator('.crate-feature-panel')).toHaveCount(0);
        await page.getByRole('button', { name: 'Continue to web', exact: true }).click();
        await expect(page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true })).toBeVisible();
      } finally { await android.close(); }
      const settingUp = await contextFor(browser, { installed: true });
      try {
        await settingUp.route('**/encryption', route => route.fulfill({ json: { ...remindersEncryption, encryption: { ...state, mode: 'resetting' } } }));
        const page = await settingUp.newPage();
        await page.goto(`${origin}/notifications?token=setting-up`);
        await expect(page.getByRole('heading', { name: 'Encryption setup in progress', exact: true })).toBeVisible();
        await expect(page.getByLabel('Recovery key', { exact: true })).toHaveCount(0);
      } finally { await settingUp.close(); }
      const desktop = await contextFor(browser, { mobile: false, installed: true });
      try {
        const page = await desktop.newPage();
        await page.goto(`${origin}/notifications?token=desktop`);
        await expect(page.getByRole('heading', { name: 'Unlock Crate', exact: true })).toBeVisible();
      } finally { await desktop.close(); }
      // One ordinary app credential: either destination unlocks both sections.
      // Reading is deliberately not pre-enrolled with a separate credential.
      for (const initial of ['reading', 'reminders']) {
        const context = await contextFor(browser, { installed: true });
        try {
          await context.route('**/reading/session', route => route.fulfill({ json: {
            id: 'joined', folderPath: readingFolder.wire, generation: 'g1', expiresAt: Date.now() + 600000,
          } }));
          await context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => !localStorage.getItem('test-offline') }));
          await context.route('**/*', route => route.request().headers().authorization && offline ? route.abort() : route.fallback());
          let offline = false;
          const page = await context.newPage();
          const errors = []; page.on('pageerror', error => errors.push(error.message));
          await page.goto(`${origin}/notifications?token=shared-${initial}&section=${initial}`);
          await expect(page.getByRole('heading', { name: 'Finish setting up Crate', exact: true })).toBeVisible();
          await page.getByRole('button', { name: 'Use recovery key instead', exact: true }).click();
          await page.getByLabel('Recovery key', { exact: true }).fill(recovery);
          await page.getByRole('button', { name: 'Unlock Crate', exact: true }).click();
          const panel = destination => page.locator(`.crate-feature-panel[data-crate-section="${destination}"][data-active="true"]`);
          await expect(panel(initial)).toBeVisible();
          const other = initial === 'reading' ? 'Reminders' : 'Reading';
          await switchFeature(page, other);
          await expect(panel(other.toLowerCase())).toBeVisible();
          await expect(page.locator('.crate-encryption-unlock')).toHaveCount(0);
          if (initial === 'reading') await switchFeature(page, 'Reading');
          await page.getByRole('button', { name: 'Save a link', exact: true }).click();
          await page.getByRole('textbox', { name: 'Link', exact: true }).fill('https://example.com/private-draft');
          const savedDraft = () => page.evaluate(async () => {
            const db = await new Promise(resolve => { const r = indexedDB.open('crate-reading-v1', 1); r.onsuccess = () => resolve(r.result); });
            const draft = await new Promise(resolve => { const r = db.transaction('values').objectStore('values').get('draft:reminders:joined:g1'); r.onsuccess = () => resolve(r.result); });
            db.close(); return draft;
          });
          await expect.poll(async () => (await savedDraft())?.encryptedReading).toBe(1);
          const before = await savedDraft();
          assert.ok(!JSON.stringify(before).includes('private-draft'));
          await expect(page.locator('.crate-feature-panel[data-active="true"] .pwa-sync-indicator')).toHaveAttribute('data-sync-state', 'synced');
          offline = true;
          await page.evaluate(() => localStorage.setItem('test-offline', '1'));
          await page.reload();
          await expect(page.getByRole('textbox', { name: 'Link', exact: true })).toHaveValue('https://example.com/private-draft');
          await expect(page.locator('.crate-encryption-unlock')).toHaveCount(0);
          offline = false;
          await page.evaluate(() => localStorage.removeItem('test-offline'));
          // Encryption verification can succeed while the actual data API expires.
          await context.route('**/reading/encrypted-files?*', route => route.fulfill({ status: 401, json: { error: 'Session expired' } }));
          await page.reload();
          await expect(page.getByRole('heading', { name: 'Reconnect to Crate', exact: true })).toBeVisible();
          assert.equal(await page.evaluate(() => localStorage.getItem('crate-reminders-auth-token')), null);
          assert.equal(await page.evaluate(() => localStorage.getItem('crate-reading-session-v1')), null);
          assert.equal((await savedDraft())?.encryptedReading, 1, 'Session expiry must retain the encrypted draft');
          await page.reload();
          await expect(page.getByRole('heading', { name: 'Reconnect to Crate', exact: true })).toBeVisible();
          await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
          assert.equal((await savedDraft())?.encryptedReading, 1, 'Reload after expiry retains recovery controls and the encrypted draft');
          await context.route('**/reading/encrypted-files?*', route => route.fulfill({ json: { files: [], nextCursor: null, generation: bundle.generation, sequence: 1 } }));
          await page.goto(`${origin}/notifications?token=reconnected-${initial}&section=reading`);
          await expect(page.getByRole('textbox', { name: 'Link', exact: true })).toHaveValue('https://example.com/private-draft');
          await expect(page.locator('.crate-feature-panel[data-active="true"] .pwa-sync-indicator')).toHaveAttribute('data-sync-state', 'synced');
          await context.route('**/reading/encryption', route => route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }));
          await page.reload();
          // An unanswered check is a connection problem, not a locked vault.
          await expect(page.getByRole('heading', { name: 'Unable to connect', exact: true })).toBeVisible();
          await page.getByRole('button', { name: 'Open Reminders', exact: true }).click();
          await expect(panel('reminders')).toBeVisible();
          await expect(page.locator('.crate-encryption-unlock')).toHaveCount(0);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
      console.log(`${engine.name()}: install explanation, isolated first unlock, wrong key, pending state, reload, recovery and desktop presentation passed`);
      console.log(`${engine.name()}: one app credential, unlock both sections, simulated offline draft recovery, encrypted Reading expiry and failure isolation passed`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
