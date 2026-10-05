import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import { openLocalRuntime, issueLocalDevice } from '../packages/server/src/local-server-runtime.mjs';
import { listenLocalServer } from '../packages/server/src/local-server-http.mjs';
import { verifyReadingFolderMove } from './pwa-reading-folder-move-checks.mjs';
import { verifyReadingPlaintextTransition } from './pwa-reading-plaintext-transition-checks.mjs';

const dataDir = await mkdtemp(join(tmpdir(), 'crate-reading-e2ee-'));
let runtime, server, browser, loseReply = false, injectShell = false;
const commits = [];
try {
  const modulePath = join(dataDir, 'crypto.mjs');
  const compiled = await build({ stdin: { contents: `export * from './src/encryption/key-bundle'; export * from './src/encryption/server-state'; export * from './src/encryption/file-authority'; export * from './src/encryption/file-codec';  export * from './src/reading/core/notes'; export * from './src/sync/encryption-conversion'; export * from './src/sync/worker-api/http'; export * from './src/sync/api';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', alias: { obsidian: join(process.cwd(), 'src/test/mocks/obsidian.ts') } });
  await writeFile(modulePath, compiled.outputFiles[0].contents);
  const t = await import(pathToFileURL(modulePath).href);
  runtime = await openLocalRuntime({ dataDir: join(dataDir, 'server') });
  const owner = await issueLocalDevice(runtime.db, 'Reading encryption test');
  const bundle = t.addReminderScope(t.addReminderScope(t.createVaultKeyBundle(), 'Reminders'), 'Reading', 'reading');
  const keys = await t.FileKeyAuthority.fromVault(bundle);
  const recovery = await t.generateRecoveryCode();
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
  const headers = { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json', 'X-Crate-Protocol': '2', 'X-Crate-Encryption-Vault': bundle.vaultId, 'X-Crate-Encryption-Generation': String(bundle.generation) };
  const path = 'Reading/Article.md';
  const note = t.createReadingNote({ id: '3eecb772-ac6a-4890-9dea-1e989849c920', url: 'https://example.invalid/private-reading', title: 'Encrypted Reading article', savedAt: new Date().toISOString() })
    .replace('extraction_status: "pending"', 'extraction_status: "ready"')
    .replace('<!-- crate:article:end -->', 'Safe encrypted article.\n\n<img src=x onerror="window.articleAttack=true"><svg onload="window.articleAttack=true"></svg><script>window.articleAttack=true</script><a href="javascript:window.articleAttack=true">Unsafe link</a>\n<!-- crate:article:end -->');
  const sealed = await t.sealFile({ path, content: new TextEncoder().encode(note), contentType: 'text/markdown', publicData: null }, keys.forPath(path));
  const upload = await fetch(`${origin}/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', body: sealed.bytes, headers: { ...headers, 'Content-Type': 'application/vnd.crate.encrypted-file', 'X-File-Hash': sealed.hash, 'X-File-Size': String(sealed.bytes.length), 'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': `e1_${String(Math.floor(Date.now() / 86400000)).padStart(8, '0')}_${crypto.randomUUID()}` } });
  assert.equal(upload.status, 200, await upload.text());
  const enrollment = await fetch(origin + '/reading/access', { method: 'POST', headers, body: JSON.stringify({ kind: 'reading' }) });
  assert.equal(enrollment.status, 200, await enrollment.clone().text());
  const { token } = await enrollment.json();
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
  const page = await context.newPage(), errors = [], requests = [];
  let recoverySent = false;
  // Inject via the local server so WebKit keeps its real service-worker path.
  // Avoid Playwright interception of service-worker-owned requests.
  injectShell = true;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if ((request.url() + (request.postData() ?? '')).includes(recovery)) recoverySent = true; if (request.method() !== 'GET') requests.push({ path: new URL(request.url()).pathname, body: request.postData() ?? '' }); });
  await page.goto(`${origin}/notifications?section=reading#reading=${token}&crateReadingKey=${encodeURIComponent(recovery)}`);
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
    const file = await runtime.db.prepare('SELECT storage_key FROM files WHERE path=?').bind(path).first();
    const bytes = new Uint8Array(await (await (await runtime.mf.getR2Bucket('BUCKET')).get(file.storage_key)).arrayBuffer());
    assert.ok(new TextDecoder().decode((await t.openFile(bytes, path, keys.forPath(path))).content).includes('private-offline-tag'));
    await page.reload();
    await expect(page.getByText('Encrypted Reading article', { exact: true }).first()).toBeVisible();
  }
  if (await page.getByRole('button', { name: 'Back to reading' }).count()) {
    await page.getByRole('button', { name: 'Back to reading' }).click();
    await expect(page.locator('.crate-reading__reader-pane article')).toHaveCount(0);
  }
  const external = []; page.on('request', request => { if ((request.url() + (request.postData() ?? '')).includes(recovery)) recoverySent = true; if (new URL(request.url()).origin !== origin) external.push(request.url()); });
  const articleHtml = '<!doctype html><html><head><title>Private browser extraction</title></head><body><article><h1>Private browser extraction</h1><p>A private article with enough original prose to verify trusted browser extraction without sending its source URL to the Crate server.</p><p>The complete article is converted to Markdown and encrypted before its note is committed.</p><img src="https://tracker.example.invalid/private-image"><iframe src="https://tracker.example.invalid/frame"></iframe></article></body></html>';
  if (type === chromium) await page.route('https://capture.example.com/article-private', route => route.fulfill({ status: 200, contentType: 'text/html', headers: { 'Access-Control-Allow-Origin': '*' }, body: articleHtml }));
  else {
    // Playwright WebKit cannot reliably route requests from a controlled page.
    // Supply only this external fixture at fetch; keep the real extractor,
    // encrypted commits, service worker and all other requests unchanged.
    await page.evaluate(html => {
      const fetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (input === 'https://capture.example.com/article-private') {
          if (init?.credentials !== 'omit' || init?.referrerPolicy !== 'no-referrer' || init?.mode !== 'cors') throw new Error('Unsafe article request');
          return Promise.resolve(new Response(html, { headers: { 'Content-Type': 'text/html' } }));
        }
        return fetch(input, init);
      };
    }, articleHtml);
  }
  await page.getByRole('button', { name: 'Save a link', exact: true }).click();
  await page.getByLabel('Link', { exact: true }).fill('https://capture.example.com/article-private');
  await page.getByRole('button', { name: 'Save link', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Private browser extraction', { exact: true })).toBeVisible({ timeout: 20000 });
  assert.ok(!external.some(url => url.includes('tracker.example')));
  assert.ok(!commits.some(body => body.includes('article-private') || body.includes('Private browser extraction')));
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Encryption', exact: true }).locator('.settings-row').filter({ has: page.getByText('Reading', { exact: true }) }).getByText('Unlocked', { exact: true })).toBeVisible();
  await expect(page.getByText('Connect Reminders to check this device.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.getByRole('button', { name: 'Log out and clear device data', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('crate-reading-session-v1'))).toBeNull();
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('crate-encryption-keys'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const count = await new Promise((resolve, reject) => { const r = db.transaction('keys').objectStore('keys').count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close(); return count;
  })).toBe(0);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('crate-encryption-session:'))), false);
  // A fresh Safari/PWA partition must keep an incoming Shortcut URL through
  // folder-key recovery, without placing that URL in any server request.
  const fresh = await fetch(origin + '/reading/access', { method: 'POST', headers, body: JSON.stringify({ kind: 'reading' }) });
  assert.equal(fresh.status, 200); const freshGrant = await fresh.json();
  const lockedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const locked = await lockedContext.newPage(), privateUrl = 'https://example.invalid/private-shortcut-draft';
  const wire = []; locked.on('request', request => wire.push(request.url() + (request.postData() ?? '')));
  await locked.goto(`${origin}/notifications?section=reading#reading=${freshGrant.token}&readingCapture=${encodeURIComponent(privateUrl)}`);
  await expect(locked.getByRole('heading', { name: 'Unlock Crate', exact: true })).toBeVisible();
  assert.ok(!locked.url().includes('readingCapture'));
  await locked.getByRole('button', { name: 'Use recovery key instead', exact: true }).click();
  await locked.getByLabel('Recovery key', { exact: true }).fill(recovery);
  await locked.getByRole('button', { name: 'Unlock Crate', exact: true }).click();
  await expect(locked.getByLabel('Link', { exact: true })).toHaveValue(privateUrl, { timeout: 20000 });
  const remembered = await locked.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('crate-encryption-keys'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const ids = await new Promise((resolve, reject) => { const r = db.transaction('keys').objectStore('keys').getAllKeys(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close(); return ids;
  });
  assert.deepEqual(remembered.sort(), bundle.scopes.map(scope => `${bundle.vaultId}:${scope.id}`).sort());
  assert.ok(!wire.some(request => request.includes(privateUrl) || request.includes(encodeURIComponent(privateUrl))));
  await lockedContext.close();
  await verifyReadingFolderMove({ t, page, origin, owner, bundle, recovery });
  assert.equal(recoverySent, false, 'Recovery key must never be sent to the server');
  assert.deepEqual(errors, []);
  assert.ok(!requests.some(request => request.body.includes('private-reading')));
  console.log(`Reading plaintext-to-encrypted transition, encrypted enrollment, private cache, article access, browser extraction, locked Shortcut recovery, folder move with retained credentials,${type === chromium ? ' offline edits, exact replay after a lost reply,' : ''} and logout cleanup passed (${type.name()})`);
} finally {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await runtime?.mf.dispose();
  await rm(dataDir, { recursive: true, force: true });
}
