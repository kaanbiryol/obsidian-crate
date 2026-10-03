/* global readingEncryption -- Bundled production Reading encryption and persistence. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';

const harness = (await build({ stdin: { contents: `
export * from './src/encryption/key-bundle';

export * from './src/pwa/reading/storage';
export * from './src/pwa/reading/encryption-session';
export * from './src/pwa/reading/encryption-lifecycle';
export * from './src/pwa/encryption-fragments';
export * from './src/pwa/encryption-keys';
export { loadReading } from './src/pwa/reading/api';
export { createReadingNote, parseReadingNote } from './src/reading/core/notes';
`, resolveDir: process.cwd() }, bundle: true, format: 'iife', globalName: 'readingEncryption', write: false })).outputFiles[0].text;
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reading encryption recovery</title>' }));
    await page.goto('https://reading-encryption.test');
    await page.addScriptTag({ content: harness });
    const result = await page.evaluate(async () => {
      const t = readingEncryption;
      const bundle = t.addReminderScope(t.createVaultKeyBundle(), 'Reading', 'reading'), scope = bundle.scopes[0];
      const recovery = await t.generateRecoveryCode();
      const session = { id: 'reader', token: 'token', folderPath: 'Reading', generation: 'policy', expiresAt: Date.now() + 100000 };
      localStorage.setItem(t.READING_SESSION_KEY, JSON.stringify(session));
      const state = { version: 1, vaultId: bundle.vaultId, generation: bundle.generation, mode: 'active', recovery: await t.sealRecoveryBundle(bundle, recovery), scope: { id: scope.id, folderPath: scope.folderPath, keyId: scope.data.id, notificationKeyId: scope.notifications.id, purpose: 'reading' } };
      window.fetch = async path => Response.json(String(path).startsWith('/reading/encrypted-files')
        ? { files: [], sequence: 1, generation: bundle.generation, nextCursor: null } : { encryption: state });
      location.hash = 'crateReadingKey=' + encodeURIComponent(recovery);
      t.consumeReadingKeyFragment();
      const db = await t.readingDatabase();
      const original = { url: 'https://private.example/draft' };
      await db.put('values', original, 'draft:reader');
      await db.put('values', [{ originalBody: 'private queued edit' }], 'pending:reader');
      await db.put('values', { preserve: 'another session' }, 'draft:reader-other');
      await t.prepareReadingEncryption(session);
      const migrated = await db.get('values', 'draft:reader');
      const raw = JSON.stringify(await db.getAll('values'));
      if (raw.includes('private.example') || raw.includes('private queued edit')) throw new Error('Migration left plaintext');
      const opened = await t.readReadingDraft('draft:reader');
      const unrelated = await db.get('values', 'draft:reader-other');
      const keys = await t.readReminderKeys(bundle.vaultId, scope.id);
      if (keys.data.key.extractable || keys.data.secret) throw new Error('Persisted extractable key');
      const wrappedKeys = await t.exportWrappedLocalKeys();
      if (!wrappedKeys[0].localState || JSON.stringify(wrappedKeys).includes(scope.data.secret)) throw new Error('Recovery key export is invalid');

      const item = { ...t.parseReadingNote(t.createReadingNote({ id: crypto.randomUUID(), url: 'https://private.example/article', savedAt: new Date().toISOString() })), path: 'Reading/Article.md' };
      const damaged = { encryptedReading: 1, content: 'unreadable ciphertext' };
      const future = { encryptedReading: 2, content: 'future ciphertext' };
      await db.put('values', damaged, 'article:reader:damaged');
      await db.put('values', future, 'article:reader:future');
      await t.cacheReadingArticle(session, item, 'Healthy offline article');
      const healthyArticle = await t.readReadingArticle(session, item.crate_reading_id);
      await t.loadReading(session);
      const preservedArticles = JSON.stringify(await db.get('values', 'article:reader:damaged')) === JSON.stringify(damaged)
        && JSON.stringify(await db.get('values', 'article:reader:future')) === JSON.stringify(future);
      const articleKey = `article:reader:${item.crate_reading_id}`;
      await db.put('values', future, articleKey);
      let refusedReplacement = false;
      try { await t.cacheReadingArticle(session, item, 'Replacement'); } catch { refusedReplacement = true; }
      const preservedReplacement = JSON.stringify(await db.get('values', articleKey)) === JSON.stringify(future);
      await db.put('values', damaged, 'list:reader');
      const live = await t.loadReading(session);
      const preservedList = JSON.stringify(await db.get('values', 'list:reader')) === JSON.stringify(damaged);

      // Re-enrollment with a damaged native key retains the same local data key.
      await t.rememberReminderKeys(t.createReminderKeyGrant(bundle, 'Reading'));
      t.resetReadingEncryption();
      await t.prepareReadingEncryption(session);
      const recovered = await t.readReadingDraft('draft:reader');

      // A transaction failure may not leave a half-migrated plaintext session.
      t.resetReadingEncryption();
      await db.put('values', { items: [], issues: [], savedAt: 1 }, 'list:reader');
      await db.put('values', original, 'draft:reader');
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, key) {
        if (key === 'list:reader') throw new DOMException('Quota full', 'QuotaExceededError');
        return put.call(this, value, key);
      };
      let migrationFailed = false;
      try { await t.prepareReadingEncryption(session); } catch { migrationFailed = true; }
      finally { IDBObjectStore.prototype.put = put; }
      const rolledBack = await db.get('values', 'draft:reader');
      await t.prepareReadingEncryption(session);
      const ciphertext = await db.get('values', 'draft:reader');
      const oldSession = localStorage.getItem(t.READING_SESSION_KEY);
      const clearing = t.clearReadingData(() => !localStorage.getItem(t.READING_SESSION_KEY) || localStorage.getItem(t.READING_SESSION_KEY) === oldSession);
      localStorage.setItem(t.READING_SESSION_KEY, JSON.stringify({ ...session, token: 'new-token' }));
      await clearing;
      const survived = await db.get('values', 'draft:reader');
      let staleRejected = false;
      try { await t.writeValue('draft:reader', { url: 'stale' }, session); } catch { staleRejected = true; }
      t.resetReadingEncryption();
      let locked = false;
      try { await t.readReadingDraft('draft:reader'); } catch { locked = true; }
      return { migrated: migrated.encryptedReading, opened, unrelated, recovered, migrationFailed, rolledBack,
        healthyArticle: healthyArticle.markdown, preservedArticles, refusedReplacement, preservedReplacement, preservedList, recoveryIssue: live.issues.length === 1,
        preservedNewSession: JSON.stringify(survived) === JSON.stringify(ciphertext), staleRejected, locked };
    });
    assert.equal(result.migrated, 1);
    assert.equal(result.opened.url, 'https://private.example/draft');
    assert.deepEqual(result.recovered, result.opened);
    assert.deepEqual(result.unrelated, { preserve: 'another session' });
    assert.equal(result.migrationFailed, true);
    assert.deepEqual(result.rolledBack, result.opened);
    assert.equal(result.preservedNewSession, true);
    assert.equal(result.staleRejected, true);
    assert.equal(result.locked, true);
    assert.equal(result.healthyArticle, 'Healthy offline article');
    for (const key of ['preservedArticles', 'refusedReplacement', 'preservedReplacement', 'preservedList', 'recoveryIssue']) assert.equal(result[key], true, key);
    console.log(`Reading encryption migration, damaged-cache isolation, key recovery and stale-session fencing passed (${engine.name()})`);
  } finally { await browser.close(); }
}
