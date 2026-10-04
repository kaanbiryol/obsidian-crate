import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';
import { shortcutTemplate, shortcutIdentifier, shortcutRequest } from './reading-shortcut-fixture.mjs';
import contract from '../src/reading/shortcut-contract.json' with { type: 'json' };

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) test(`iPhone shortcut setup in ${name}`, { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-shortcut-browser-')); let runtime, server, browser, origin;
  const errors = []; let creates = 0, unavailable = false;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    runtime = await openLocalRuntime({ dataDir: join(dir, 'data') });
    const vault = await issueLocalDevice(runtime.db, 'Shortcut browser test');
    server = createServer({ key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) }, async (req, res) => {
      try {
        if (req.url === '/reading/shortcut-pairing') { creates++; if (unavailable) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"Not found"}'); return; } }
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await runtime.mf.dispatchFetch(`${origin}${req.url}`, { method: req.method, headers: req.headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end('Test server failed'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `https://localhost:${server.address().port}`;
    const api = async (path, body, token = vault.token) => {
      const response = await runtime.mf.dispatchFetch(`${origin}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Crate-Protocol': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    await api('/reading/policy', { enabled: true, folderPath: 'Reading', revision: null });
    const enrollment = await api('/reading/access', { kind: 'reading' });
    const setup = new URL(enrollment.url); setup.searchParams.set('setup', 'shortcut');
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(setup.href);
    const dialog = page.getByRole('dialog', { name: 'Set up iPhone shortcut' });
    await expect(dialog).toBeVisible().catch(async error => { console.error('Setup page:', await page.locator('body').innerText(), errors); throw error; });
    const download = dialog.getByRole('link', { name: 'Download Save to Crate' });
    await expect(download).toHaveAttribute('href', 'https://crate.kaanbiryol.com/shortcuts/v2/');
    await expect(download).toHaveAttribute('rel', 'noopener noreferrer');
    await mkdir('test-results/reading', { recursive: true });
    await page.screenshot({ path: `test-results/reading/${name}-shortcut-start.png`, fullPage: true, animations: 'disabled' });
    await expect(dialog.getByRole('list', { name: 'Shortcut setup steps' })).toBeVisible();
    await context.setOffline(true);
    await expect(dialog.getByRole('button', { name: 'Create pairing code', exact: true })).toBeDisabled();
    await expect(dialog.getByText('Connect to the internet to pair your shortcut.')).toBeVisible();
    await context.setOffline(false);
    await dialog.getByRole('button', { name: 'Create pairing code', exact: true }).click();
    const input = dialog.getByLabel('Pairing code', { exact: true });
    await expect(input).toHaveValue(/\/reading\/shortcut-exchange#[a-f0-9]{64}$/).catch(async error => { console.error('Pairing UI error:', await dialog.getByRole('alert').allTextContents()); console.error('Fields:', await dialog.locator('textarea').count()); throw error; });
    assert.equal(creates, 1);
    const code = await input.inputValue(); assert.ok(!code.includes('Bearer'));
    // Clipboard denial leaves a selectable fallback; no second credential is minted.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } }));
    await dialog.getByRole('button', { name: 'Copy pairing code' }).click();
    await expect(dialog.getByRole('alert')).toContainText('copy it manually'); assert.equal(creates, 1);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedPairing = value; } } }));
    await dialog.getByRole('button', { name: 'Copy pairing code' }).click();
    assert.equal(await page.evaluate(() => window.copiedPairing), code);
    await expect(dialog.getByText('Copied. Open the shortcut', { exact: false })).toBeVisible();
    const connected = await api(contract.exchangePath, { token: new URL(code).hash.slice(1) }, '');
    const sharedUrl = 'https://example.invalid/paired-phone';
    const { url: captureUrl, ...captureRequest } = shortcutRequest(shortcutTemplate.WFWorkflowActions.find(action => shortcutIdentifier(action) === 'downloadurl'), {
      [shortcutTemplate.WFWorkflowActions[0].WFWorkflowActionParameters.UUID]: connected.endpoint,
      [shortcutTemplate.WFWorkflowActions[1].WFWorkflowActionParameters.UUID]: connected.authorization,
      [shortcutTemplate.WFWorkflowActions[3].WFWorkflowActionParameters.UUID]: sharedUrl,
    });
    const preparedResponse = await runtime.mf.dispatchFetch(captureUrl, captureRequest);
    assert.equal(preparedResponse.status, 200, await preparedResponse.clone().text());
    const saved = await preparedResponse.json();
    assert.equal(new URL(saved.launchUrl).pathname, '/notifications/save-reading');
    // A web sheet has no enrolled Reading session. The prepared capability must
    // still commit, confirm, survive reload, and appear in the enrolled library.
    const sheetContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const sheet = await sheetContext.newPage(); sheet.on('pageerror', error => errors.push(error.message));
    await sheet.goto(saved.launchUrl);
    await expect(sheet.getByRole('heading', { name: 'Saved', exact: true })).toBeVisible();
    assert.equal(new URL(sheet.url()).hash, '');
    const openReading = sheet.getByRole('link', { name: 'Open Reading', exact: true });
    const itemId = new URL(await openReading.getAttribute('href'), origin).searchParams.get('item');
    assert.ok(itemId);
    await sheet.reload();
    await expect(sheet.getByRole('heading', { name: 'Saved', exact: true })).toBeVisible();
    const library = await runtime.mf.dispatchFetch(`${origin}/reading/list`, { headers: { Authorization: captureRequest.headers.Authorization } });
    assert.equal(library.status, 403, 'The shortcut credential cannot read the library');
    const enrolledLibrary = await page.evaluate(async () => {
      const session = JSON.parse(localStorage.getItem('crate-reading-session-v1'));
      const response = await fetch('/reading/list', { headers: { Authorization: `Bearer ${session.token}` } });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(enrolledLibrary.status, 200);
    assert.ok(enrolledLibrary.body.items.some(item => item.crate_reading_id === itemId && item.source_url === sharedUrl));
    await sheetContext.close();
    await mkdir('test-results/reading', { recursive: true });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      // Wait for the theme transition and verify readable secondary actions.
      await expect.poll(() => download.evaluate(el => {
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
        ctx.fillStyle = getComputedStyle(el).color; ctx.fillRect(0, 0, 1, 1);
        return ctx.getImageData(0, 0, 1, 1).data[0];
      })).toBeGreaterThan(colorScheme === 'dark' ? 150 : 0);
      await page.screenshot({ path: `test-results/reading/${name}-shortcut-${colorScheme}.png`, fullPage: true, animations: 'disabled' });
      assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    }
    await page.setViewportSize({ width: 320, height: 568 });
    await dialog.getByRole('heading', { name: '3. Save your first article', exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('heading', { name: '3. Save your first article', exact: true })).toBeVisible();
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    const closeBox = await dialog.getByRole('button', { name: 'Close shortcut setup' }).boundingBox();
    assert.ok(closeBox && closeBox.y >= 0 && closeBox.y + closeBox.height <= 568, 'The close control must stay visible while scrolling');
    await page.screenshot({ path: `test-results/reading/${name}-shortcut-small.png`, fullPage: true, animations: 'disabled' });
    await page.clock.setFixedTime(new Date(Date.now() + 11 * 60_000));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(dialog.getByText('This pairing code expired.', { exact: false })).toBeVisible();
    await expect(input).toHaveCount(0);
    await page.clock.setFixedTime(new Date());
    await dialog.getByRole('button', { name: 'Close shortcut setup' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Set up iPhone shortcut', exact: true }).click();
    await expect(input).toHaveCount(0);
    unavailable = true;
    await dialog.getByRole('button', { name: 'Create pairing code', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Update your Crate server');
    unavailable = false;
    await dialog.getByRole('button', { name: 'Create pairing code', exact: true }).click();
    await expect(input).toHaveValue(/shortcut-exchange#/);
    await page.evaluate(() => { localStorage.removeItem('crate-reading-session-v1'); window.dispatchEvent(new Event('storage')); });
    await expect(page.getByRole('heading', { name: 'Connect to Crate', exact: true })).toBeVisible();
    await expect(input).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await runtime?.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) test(`shortcut diagnostics and recovery in ${name}`, { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-shortcut-errors-')); let runtime, server, browser, origin;
  const errors = []; let handoffs = 0;
  try {
    execFileSync(process.execPath, ['scripts/build-shortcut-support.mjs'], { stdio: 'ignore' });
    const supportHtml = await readFile('site/shortcuts/help/index.html');
    const supportScript = await readFile('site/shortcuts/help/support.js');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    runtime = await openLocalRuntime({ dataDir: join(dir, 'data') });
    const vault = await issueLocalDevice(runtime.db, 'Shortcut diagnostics test');
    server = createServer({ key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) }, async (req, res) => {
      try {
        const path = new URL(req.url, origin).pathname;
        if (path.startsWith('/shortcuts/help/')) {
          res.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'application/javascript' : 'text/html' });
          res.end(path.endsWith('.js') ? supportScript : supportHtml); return;
        }
        if (path === '/reading/handoff') handoffs++;
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await runtime.mf.dispatchFetch(`${origin}${req.url}`, { method: req.method, headers: req.headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end('Test server failed'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `https://localhost:${server.address().port}`;
    const post = async (path, body, authorization = `Bearer ${vault.token}`) => runtime.mf.dispatchFetch(`${origin}${path}`, { method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-Crate-Protocol': '1', [contract.revisionHeader]: String(contract.revision) }, body: JSON.stringify(body) });
    assert.equal((await post('/reading/policy', { enabled: false, folderPath: 'Reading', revision: null })).status, 200);
    const access = await (await post('/reading/access', { kind: 'capture' })).json();
    const authorization = `Bearer ${access.token}`;
    const articleUrl = 'https://example.invalid/private-article-name';
    const prepare = async () => {
      const response = await post(contract.preparePath, { url: articleUrl }, authorization);
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const expandDiagnostics = async () => {
      // A fragment-only navigation triggers a reload in the save page. Wait
      // until that new document consumes the fragment before opening details.
      await expect(page).toHaveURL(url => url.hash === '');
      if (!await page.locator('#support').evaluate(el => el.open)) await page.locator('#support > summary').click();
    };
    const diagnostic = async () => {
      await expandDiagnostics();
      return JSON.parse(await page.getByLabel('Diagnostics', { exact: true }).inputValue());
    };
    const noSuccess = async () => {
      await expect(page.getByRole('link', { name: 'Open Reading', exact: true })).toBeHidden();
      assert.ok(!await page.getByRole('heading', { name: /^(?:Saved|Already saved)/ }).count());
      assert.equal(new URL(page.url()).hash, '');
    };

    const expired = await post(contract.preparePath, { url: articleUrl }, 'Bearer private-expired-credential');
    const expiredReply = await expired.json(); assert.equal(expired.status, 401);
    await page.goto(expiredReply.launchUrl);
    await expect(page.getByRole('heading', { name: 'Reconnect your shortcut', exact: true })).toBeVisible();
    await noSuccess(); assert.equal(handoffs, 0);
    await expect(page.getByRole('button', { name: 'Copy diagnostics', exact: true })).toBeHidden();
    const report = await diagnostic();
    assert.equal(report.status, 401); assert.equal(report.stage, 'prepare');
    assert.equal(report.requestId, expired.headers.get('X-Crate-Request-Id'));
    assert.equal(report.shortcutRevision, contract.revision);
    assert.match(report.pwaVersion, /^[a-f0-9]{16}$/);
    assert.ok(report.serverFingerprint === null || /^[a-f0-9]{64}$/.test(report.serverFingerprint));
    const issue = new URL(await page.getByRole('link', { name: 'Report on GitHub', exact: true }).getAttribute('href'));
    assert.equal(issue.origin + issue.pathname, contract.issuesUrl);
    assert.ok(issue.searchParams.get('body').includes(JSON.stringify(report, null, 2)));
    for (const secret of [articleUrl, authorization, access.token, 'private-expired-credential']) {
      assert.ok(!JSON.stringify(report).includes(secret)); assert.ok(!issue.searchParams.get('body').includes(secret));
    }
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } }));
    await page.getByRole('button', { name: 'Copy diagnostics', exact: true }).click();
    await expect(page.getByText('Select and copy the diagnostics below.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Diagnostics', { exact: true })).toBeVisible();
    assert.equal(await page.getByLabel('Diagnostics', { exact: true }).evaluate(el => el.selectionEnd - el.selectionStart), JSON.stringify(report, null, 2).length);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedDiagnostics = value; } } }));
    await page.getByRole('button', { name: 'Copy diagnostics', exact: true }).click();
    await expect(page.getByText('Diagnostics copied.', { exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => window.copiedDiagnostics), JSON.stringify(report, null, 2));
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const box = await page.getByRole('button', { name: 'Copy diagnostics', exact: true }).boundingBox(); assert.ok(box.height >= 48);
      await mkdir('test-results/reading', { recursive: true });
      await page.screenshot({ path: `test-results/reading/${name}-shortcut-error-${colorScheme}.png`, fullPage: true, animations: 'disabled' });
    }

    const newer = await (await post('/reading/shortcut/v2/prepare', { url: articleUrl }, authorization)).json();
    await page.goto(newer.launchUrl);
    await expect(page.getByRole('heading', { name: 'Update your Crate server', exact: true })).toBeVisible(); await noSuccess();
    const badPair = await (await post(contract.exchangePath, { token: 'expired-pairing-secret' }, '')).json();
    await page.goto(badPair.launchUrl);
    await expect(page.getByRole('heading', { name: 'Pairing did not finish', exact: true })).toBeVisible(); await noSuccess();
    assert.equal((await diagnostic()).stage, 'pair');

    // Untrusted or malformed error fragments cannot leak fields or replay a
    // previously stored save capability, including after a page reload.
    for (const fragment of ['error=%', 'error=' + 'x'.repeat(5000), 'not-a-capability', 'error=' + encodeURIComponent(JSON.stringify({
      code: 'invalid_response', stage: { toString: null }, requestId: authorization, serverFingerprint: articleUrl, pwaVersion: authorization,
      url: articleUrl, token: 'private-pairing-secret', headers: { Authorization: authorization },
    }))]) {
      await page.evaluate(() => sessionStorage.setItem('crate-reading-handoff-v1', JSON.stringify({ token: 'e'.repeat(64), until: Date.now() + 300000 })));
      await page.goto(`${origin}/notifications/save-reading#${fragment}`);
      await expandDiagnostics(); await expect(page.getByRole('button', { name: 'Copy diagnostics', exact: true })).toBeVisible(); await noSuccess();
      assert.ok(!JSON.stringify(await diagnostic()).includes('private'));
      await page.reload(); await expandDiagnostics(); await expect(page.getByRole('button', { name: 'Copy diagnostics', exact: true })).toBeVisible(); await noSuccess();
      assert.equal(handoffs, 0);
    }
    const staticError = { stage: 'prepare', code: 'invalid_response', shortcutRevision: contract.revision, shortcutContract: contract.version };
    await page.goto(`${origin}/shortcuts/help/#error=${encodeURIComponent(JSON.stringify(staticError))}`);
    await expect(page.getByRole('heading', { name: 'Save not confirmed', exact: true })).toBeVisible(); await noSuccess();
    assert.equal((await diagnostic()).serverRevision, null);
    await expect(page.getByRole('status').first()).toContainText('Update Crate in Obsidian and its server');
    await expect(page.getByRole('link', { name: 'Download shortcut', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open shortcut setup', exact: true })).toBeHidden(); assert.equal(handoffs, 0);

    const stale = await prepare(); const staleToken = new URL(stale.launchUrl).hash.slice(1);
    await runtime.db.prepare('UPDATE reading_handoffs SET expires_at=1 WHERE token_hash=?').bind(createHash('sha256').update(staleToken).digest('hex')).run();
    await page.goto(stale.launchUrl);
    await expect(page.getByRole('heading', { name: 'Share this link again', exact: true })).toBeVisible(); await noSuccess();
    await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeHidden(); assert.equal((await diagnostic()).status, 410);

    let mode = 'lost', attempts = [], firstReceipt;
    await page.route('**/reading/handoff', async route => {
      attempts.push({ token: route.request().headers()['x-crate-capture'], protocol: route.request().headers()['x-crate-protocol'], body: route.request().postData() });
      if (attempts.length === 1 && mode === 'lost') {
        const response = await route.fetch(); assert.equal(response.status(), 200); firstReceipt = await response.json(); await route.abort('failed');
      } else if (attempts.length === 1 && mode === 'malformed') await route.fulfill({ status: 200, contentType: 'text/html', body: '<html>private upstream error</html>' });
      else if (attempts.length === 1 && mode === 'protocol') await route.fulfill({ status: 428, contentType: 'application/json', body: JSON.stringify({ code: 'protocol_incompatible' }) });
      else await route.continue();
    });
    const pending = await prepare();
    await page.goto(pending.launchUrl);
    await expect(page.getByRole('heading', { name: 'Save not confirmed', exact: true })).toBeVisible(); await noSuccess();
    await page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Saved', exact: true })).toBeVisible();
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]); assert.equal(attempts[0].body, '{}');
    const savedId = new URL(await page.getByRole('link', { name: 'Open Reading', exact: true }).getAttribute('href'), origin).searchParams.get('item');
    assert.equal(savedId, firstReceipt.id); assert.equal((await runtime.db.prepare('SELECT count(*) AS count FROM files').first()).count, 1);
    await expect(page.getByRole('heading', { name: 'A newer shortcut is available', exact: true })).toBeHidden();

    await expect(page.locator('#message')).toHaveText('You can close this window.');
    await expect(page.locator('#status-label')).toHaveCount(0);
    await expect(page.locator('#support')).toBeHidden();

    mode = 'malformed'; attempts = [];
    const malformed = await prepare(); await page.goto(malformed.launchUrl);
    await expect(page.getByRole('heading', { name: 'Save not confirmed', exact: true })).toBeVisible(); await noSuccess();
    assert.equal((await diagnostic()).code, 'invalid_response'); assert.ok(!JSON.stringify(await diagnostic()).includes('private upstream'));
    await page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Already saved', exact: true })).toBeVisible(); assert.deepEqual(attempts[0], attempts[1]);

    mode = 'protocol'; attempts = [];
    const changed = await prepare(); await page.goto(changed.launchUrl);
    await expect(page.getByRole('heading', { name: 'Reload this save page', exact: true })).toBeVisible(); await noSuccess();
    await page.getByRole('button', { name: 'Reload save page', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Already saved', exact: true })).toBeVisible();
    assert.deepEqual(attempts[0], attempts[1]);

    await page.unroute('**/reading/handoff');
    const legacyResponse = await post('/reading/prepare', { url: articleUrl }, authorization);
    const legacy = await legacyResponse.json(); await page.goto(legacy.launchUrl);
    await expect(page.getByRole('heading', { name: 'Already saved', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A newer shortcut is available', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download shortcut', exact: true })).toHaveAttribute('href', contract.downloadUrl);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await runtime?.close(); await rm(dir, { recursive: true, force: true }); }
});
