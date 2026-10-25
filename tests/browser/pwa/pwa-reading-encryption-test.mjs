import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import { openLocalRuntime, issueLocalDevice } from '../../../packages/server/src/local-server-runtime.mjs';
import { listenLocalServer } from '../../../packages/server/src/local-server-http.mjs';
import { verifyReadingPlaintextTransition } from './pwa-reading-plaintext-transition-checks.mjs';
import { assertNoPlaintextNames, isWirePath, recordPlaintextNames } from './pwa-encrypted-names-checks.mjs';

// Plaintext names that may exist only inside ciphertext once the vault is encrypted.
const PLAINTEXT_NAMES = ['Reading/', '"Reading"', 'folder=Reading', 'folderPath=Reading', 'Reminders/', '"Reminders"', 'Article.md',
  'Encrypted Reading article', 'Private server extraction', 'private-offline-tag', 'private-reading'];

const dataDir = await mkdtemp(join(tmpdir(), 'crate-reading-e2ee-'));
let runtime, server, browser, loseReply = false, injectShell = false;
const commits = [], extracts = [];
try {
  const modulePath = join(dataDir, 'crypto.mjs');
  const compiled = await build({ stdin: { contents: `export * from './src/encryption/key-bundle'; export * from './src/encryption/server-state'; export * from './src/encryption/file-authority'; export * from './src/encryption/file-codec';  export * from './src/reading/core/notes'; export * from './src/sync/encryption/reset'; export * from './src/sync/worker-api/http'; export { PathTags } from './src/encryption/path-tags'; export { sealFolderLabel } from './src/encryption/folder-label'; export { importEncryptionSecret } from './src/encryption/envelope';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', alias: { obsidian: join(process.cwd(), 'src/test/mocks/obsidian.ts') } });
  await writeFile(modulePath, compiled.outputFiles[0].contents);
  const t = await import(pathToFileURL(modulePath).href);
  runtime = await openLocalRuntime({ dataDir: join(dataDir, 'server') });
  const owner = await issueLocalDevice(runtime.db, 'Reading encryption test');
  const bundle = await t.createVaultKeyBundle();
  const keys = await t.FileKeyAuthority.fromBundle(bundle);
  const recovery = await t.generateRecoveryCode();
  // Reading starts in a plaintext vault; turning encryption on replaces its policy.
  await runtime.db.batch([
    runtime.db.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,1,'Reading','reading-test','revision')"),
  ]);
  server = await listenLocalServer({ origin: runtime.origin, mf: { dispatchFetch: async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/notifications/csp-probe.js') {
      return new Response('window.cspProbe=true', { headers: { 'Content-Type': 'application/javascript' } });
    }
    if (injectShell && pathname === '/notifications') {
      const response = await runtime.mf.dispatchFetch(url, init);
      const html = (await response.text()).replace('</body>', '<script src="/notifications/csp-probe.js"></script><script>window.cspProbe=true</script><img src="/notifications/missing-probe" onerror="window.cspProbe=true"></body>');
      return new Response(html, response);
    }
    // The Worker integration test covers the real download; supply its result here.
    if (pathname === '/reading/encrypted-extract') {
      extracts.push(await new Response(init.body).text());
      return Response.json({ article: { title: 'Private server extraction', markdown: '# Private server extraction\n\nThe article is downloaded by the server and encrypted on this device before its note is committed.' } }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (pathname !== '/reading/encrypted-commit') return runtime.mf.dispatchFetch(url, init);
    const body = await new Response(init.body).text(); commits.push(body);
    const response = await runtime.mf.dispatchFetch(url, { ...init, body });
    if (loseReply && response.ok) { loseReply = false; await response.arrayBuffer(); return Response.json({ error: 'Lost acknowledgement' }, { status: 503 }); }
    return response;
  } } }, { port: 0 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const type = process.env.CRATE_TEST_BROWSER === 'webkit' ? webkit : chromium;
  browser = await type.launch();
  await verifyReadingPlaintextTransition({ t, browser, origin, owner, bundle, recovery });
  // The transition's setup issued the vault's only device credential.
  const headers = { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json', 'X-Crate-Protocol': '1', 'X-Crate-Encryption-Vault': bundle.vaultId, 'X-Crate-Encryption-Generation': String(bundle.generation) };
  assert.equal(await runtime.db.prepare('SELECT 1 FROM reading_policy').first(), null);
  // As the plugin does, name feature folders by tag with their sealed plaintext names.
  const tags = await t.PathTags.fromSecret(bundle.vaultId, bundle.vault), vaultKey = await t.importEncryptionSecret(bundle.vault);
  const readingFolder = await t.sealFolderLabel('Reading', tags, vaultKey, bundle.vaultId), remindersFolder = await t.sealFolderLabel('Reminders', tags, vaultKey, bundle.vaultId);
  const plainPolicy = await fetch(`${origin}/reading/policy`, { method: 'POST', headers, body: JSON.stringify({ enabled: true, folderPath: 'Reading', revision: null }) });
  assert.equal(plainPolicy.status, 428, 'An encrypted vault refuses a readable Reading folder');
  const policy = await fetch(`${origin}/reading/policy`, { method: 'POST', headers, body: JSON.stringify({ enabled: true, folderPath: readingFolder.wire, folderLabel: readingFolder.label, revision: null }) });
  assert.equal(policy.status, 200, await policy.clone().text());
  const path = 'Reading/Article.md', wire = await tags.wire(path);
  assert.ok(isWirePath(wire) && wire.startsWith(`${readingFolder.wire}/`));
  const note = t.createReadingNote({ id: '3eecb772-ac6a-4890-9dea-1e989849c920', url: 'https://example.invalid/private-reading', title: 'Encrypted Reading article', savedAt: new Date().toISOString() })
    .replace('extraction_status: "pending"', 'extraction_status: "ready"')
    .replace('<!-- crate:article:end -->', 'Safe encrypted article.\n\n<img src=x onerror="window.articleAttack=true"><svg onload="window.articleAttack=true"></svg><script>window.articleAttack=true</script><a href="javascript:window.articleAttack=true">Unsafe link</a>\n<!-- crate:article:end -->');
  const sealed = await t.sealFile({ path, content: new TextEncoder().encode(note), contentType: 'text/markdown', publicData: null }, keys.forPath(wire));
  const upload = await fetch(`${origin}/sync/upload?path=${encodeURIComponent(wire)}`, { method: 'PUT', body: sealed.bytes, headers: { ...headers, 'Content-Type': 'application/vnd.crate.encrypted-file', 'X-File-Hash': sealed.hash, 'X-File-Size': String(sealed.bytes.length), 'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': `e1_${String(Math.floor(Date.now() / 86400000)).padStart(8, '0')}_${crypto.randomUUID()}` } });
  assert.equal(upload.status, 200, await upload.text());
  const enroll = async () => {
    const enrollment = await fetch(origin + '/notifications/reminders-enrollment-token', { method: 'POST', headers, body: JSON.stringify({ folderPath: remindersFolder.wire, folderLabel: remindersFolder.label }) });
    assert.equal(enrollment.status, 200, await enrollment.clone().text());
    return (await enrollment.json()).browserToken;
  };
  const token = await enroll();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // Headless WebKit's native getSubscription() freezes even on an empty page
  // on this host. Keep real SW/storage, but leave native push to device checks.
  if (type === webkit) await context.addInitScript(() => {
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { get: () => undefined });
  });
  await context.addInitScript(() => {
    window.cspViolations = [];
    window.cspBlockedScripts = [];
    document.addEventListener('securitypolicyviolation', event => { window.cspViolations.push(event.effectiveDirective); if (event.effectiveDirective.startsWith('script-src')) window.cspBlockedScripts.push(event.blockedURI); });
  });
  // Every request the web app sends while the vault is encrypted, URL and body.
  const sent = recordPlaintextNames(context, origin, PLAINTEXT_NAMES);
  const page = await context.newPage(), errors = [], requests = [];
  let recoverySent = false;
  // Inject via the local server so WebKit keeps its real service-worker path.
  // Avoid Playwright interception of service-worker-owned requests.
  injectShell = true;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if ((request.url() + (request.postData() ?? '')).includes(recovery)) recoverySent = true; if (request.method() !== 'GET') requests.push({ path: new URL(request.url()).pathname, body: request.postData() ?? '' }); });
  await page.goto(`${origin}/notifications?section=reading&browserToken=${token}#crateReadingKey=${encodeURIComponent(recovery)}`);
  try { await expect(page.getByText('Encrypted Reading article', { exact: true })).toBeVisible({ timeout: 30000 }); }
  catch (error) { console.log('Reading bootstrap:', await page.locator('body').innerText({ timeout: 2000 }).catch(() => 'unavailable'), errors); throw error; }
  assert.ok(!page.url().includes('crateReadingKey'));
  await expect.poll(() => page.evaluate(() => window.cspViolations.includes('script-src-attr'))).toBe(true);
  assert.equal(await page.evaluate(() => window.cspProbe), undefined);
  await expect.poll(() => page.evaluate(() => window.cspBlockedScripts.some(uri => uri.endsWith('/notifications/csp-probe.js')))).toBe(true);
  injectShell = false;
  const snapshot = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open('crate-reading-v1', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const values = await new Promise((resolve, reject) => { const read = db.transaction('values').objectStore('values').getAll(); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
    db.close(); return JSON.stringify(values);
  });
  assert.ok(!snapshot.includes('private-reading')); assert.ok(!snapshot.includes('Encrypted Reading article')); assert.ok(snapshot.includes('encryptedReading'));
  await page.getByText('Encrypted Reading article', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to reading' })).toBeVisible();
  const checkSafeArticle = async () => {
    await expect(page.locator('.crate-reading-reader__body')).toContainText('Safe encrypted article.');
    await expect(page.locator('.crate-reading-reader__body script,.crate-reading-reader__body img,.crate-reading-reader__body svg,.crate-reading-reader__body a[href^="javascript:"]')).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.articleAttack), undefined);
  };
  await checkSafeArticle();
  if (type === chromium) {
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Edit article tags' }).click();
    const tags = page.getByRole('dialog', { name: 'Article tags' });
    await tags.getByRole('textbox').fill('private-offline-tag');
    await tags.getByRole('button', { name: 'Save tags' }).click();
    await expect(tags).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('Encrypted Reading article', { exact: true }).first()).toBeVisible();
    await checkSafeArticle();
    loseReply = true; await context.setOffline(false);
    await expect.poll(() => commits.length, { timeout: 25000 }).toBeGreaterThanOrEqual(2);
    assert.equal(commits[0], commits[1]);
    assert.ok(!commits[0].includes('private-offline-tag'));
    const file = await runtime.db.prepare('SELECT storage_key FROM files WHERE path=?').bind(wire).first();
    const bytes = new Uint8Array(await (await (await runtime.mf.getR2Bucket('BUCKET')).get(file.storage_key)).arrayBuffer());
    assert.ok(new TextDecoder().decode((await t.openFile(bytes, path, keys.forPath(wire))).content).includes('private-offline-tag'));
    await page.reload();
    await expect(page.getByText('Encrypted Reading article', { exact: true }).first()).toBeVisible();
  }
  if (await page.getByRole('button', { name: 'Back to reading' }).count()) {
    await page.getByRole('button', { name: 'Back to reading' }).click();
    await expect(page.locator('.crate-reading__reader-pane article')).toHaveCount(0);
  }
  const external = []; page.on('request', request => { if ((request.url() + (request.postData() ?? '')).includes(recovery)) recoverySent = true; if (new URL(request.url()).origin !== origin) external.push(request.url()); });
  await page.getByRole('button', { name: 'Save a link', exact: true }).click();
  await page.getByLabel('Link', { exact: true }).fill('https://capture.example.com/article-private');
  await page.getByRole('button', { name: 'Save link', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Private server extraction', { exact: true })).toBeVisible({ timeout: 20000 });
  // Only the server downloads the page; the link reaches it in a request body.
  assert.deepEqual(extracts.map(body => JSON.parse(body)), [{ url: 'https://capture.example.com/article-private' }]);
  assert.ok(!external.some(url => url.includes('capture.example.com')));
  assert.ok(!commits.some(body => body.includes('article-private') || body.includes('Private server extraction')));
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Encryption', exact: true }).locator('.settings-row').filter({ has: page.getByText('Reading', { exact: true }) }).getByText('Unlocked', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.getByRole('button', { name: 'Log out and clear device data', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('crate-reading-session-v1'))).toBeNull();
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('crate-encryption-keys'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const count = await new Promise((resolve, reject) => { const r = db.transaction('keys').objectStore('keys').count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close(); return count;
  })).toBe(0);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('crate-encryption-session:'))), false);
  // A fresh Safari/PWA partition unlocks with the recovery key and keeps one vault key record.
  const freshToken = await enroll();
  const lockedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const lockedSent = recordPlaintextNames(lockedContext, origin, PLAINTEXT_NAMES);
  // This context signs in through Reminders, which checks push subscriptions.
  if (type === webkit) await lockedContext.addInitScript(() => {
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { get: () => undefined });
  });
  const locked = await lockedContext.newPage();
  await locked.goto(`${origin}/notifications?section=reading&browserToken=${freshToken}`);
  await expect(locked.getByRole('heading', { name: 'Unlock Crate', exact: true })).toBeVisible();
  await locked.getByRole('button', { name: 'Use recovery key instead', exact: true }).click();
  await locked.getByLabel('Recovery key', { exact: true }).fill(recovery);
  await locked.getByRole('button', { name: 'Unlock Crate', exact: true }).click();
  await expect(locked.getByRole('button', { name: 'Save a link', exact: true })).toBeVisible({ timeout: 20000 });
  const remembered = await locked.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('crate-encryption-keys'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const ids = await new Promise((resolve, reject) => { const r = db.transaction('keys').objectStore('keys').getAllKeys(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close(); return ids;
  });
  assert.deepEqual(remembered, [bundle.vaultId]);
  await lockedContext.close();
  assert.equal(recoverySent, false, 'Recovery key must never be sent to the server');
  assert.deepEqual(errors, []);
  assert.ok(!requests.some(request => request.body.includes('private-reading')));
  assert.deepEqual(sent.leaks, [], 'The Reading app sent a plaintext file or folder name');
  assert.deepEqual(lockedSent.leaks, [], 'The locked Reading app sent a plaintext file or folder name');
  assert.ok(sent.count > 0 && lockedSent.count > 0);
  // Two notes, both stored under the Reading folder's tag with tagged or random names.
  const stored = (await runtime.db.prepare('SELECT path FROM files').all()).results.map(row => row.path);
  assert.equal(stored.length, 2);
  assert.ok(stored.every(file => isWirePath(file) && file.startsWith(`${readingFolder.wire}/`)), stored.join(', '));
  await assertNoPlaintextNames(runtime.db, PLAINTEXT_NAMES);
  console.log(`Reading plaintext-to-encrypted transition, encrypted enrollment, tagged paths, private cache, article access, server extraction, locked recovery,${type === chromium ? ' offline edits, exact replay after a lost reply,' : ''} no plaintext names in requests, and logout cleanup passed (${type.name()})`);
} finally {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await runtime?.mf.dispose();
  await rm(dataDir, { recursive: true, force: true });
}
