import { checkBackGesture } from './pwa-back-gesture-checks.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { swipe } from './browser-touch-swipe.mjs';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';

async function captureReaderMotion(page, action) {
  const hitTestStyle = await page.addStyleTag({ content: '.reader-motion-hit-test { pointer-events: auto !important; }' });
  try { return await page.evaluate(async action => {
    const workspace = document.querySelector('.crate-reading-workspace');
    const pane = workspace.querySelector('.crate-reading__reader-pane');
    const list = workspace.querySelector('.crate-reading__library');
    const bar = workspace.querySelector('.crate-reading__sidebar');
    const x = element => { const transform = getComputedStyle(element).transform; return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41; };
    const state = () => {
      const paneRect = pane.getBoundingClientRect(), barRect = bar.getBoundingClientRect();
      // Temporarily enable hit testing, without changing paint order, to check that the
      // article actually covers the bar while sliding. Both surfaces may be inert.
      const saved = [bar, pane].map(element => ({ element, inert: element.inert }));
      for (const { element } of saved) { element.inert = false; element.classList.add('reader-motion-hit-test'); }
      const coversBar = pane.contains(document.elementFromPoint(barRect.right - 8, barRect.y + barRect.height / 2));
      for (const { element, inert } of saved) { element.inert = inert; element.classList.remove('reader-motion-hit-test'); }
      return { reader: x(pane), list: x(list), bar: x(bar), coversBar, bottomGap: barRect.bottom - paneRect.bottom,
        visible: getComputedStyle(pane).visibility === 'visible', article: !!pane.querySelector('.crate-reading-reader__header h1') };
    };
    const before = state(), width = pane.getBoundingClientRect().width;
    let slides = 0, pops = 0;
    const transition = event => { if (event.target === pane && event.propertyName === 'transform') slides++; };
    const pop = () => { pops++; };
    pane.addEventListener('transitionrun', transition); window.addEventListener('popstate', pop);
    const committed = new Promise(resolve => {
      const observer = new MutationObserver(() => {
        if (workspace.dataset.readerOpen !== String(action === 'open')) return;
        observer.disconnect(); resolve();
      });
      observer.observe(workspace, { attributes: true, attributeFilter: ['data-reader-open'] });
    });
    if (action === 'open') document.querySelector('.crate-reading__open').click();
    else if (action === 'close') {
      const back = pane.querySelector('[aria-label="Back to reading"]');
      back.click(); back.click(); // Repeated taps must still request one history traversal.
    } else history.back();
    await committed;
    const samples = [], started = performance.now();
    do { await new Promise(resolve => requestAnimationFrame(resolve)); samples.push(state()); } while (performance.now() - started < 450);
    pane.removeEventListener('transitionrun', transition); window.removeEventListener('popstate', pop);
    return { before, width, samples, slides, pops, motion: workspace.dataset.readerMotion };
  }, action); } finally { await hitTestStyle.evaluate(element => element.remove()); }
}

function assertReaderSlide(result, action) {
  const { before, width, samples, slides, pops } = result, opening = action === 'open';
  assert.equal(slides, 1, JSON.stringify(result));
  assert.equal(pops, opening ? 0 : 1, 'Repeated toolbar taps must only go back once');
  assert.ok(Math.abs(before.reader - (opening ? width : 0)) < 1, JSON.stringify(result));
  assert.ok(samples.some(sample => sample.reader > 1 && sample.reader < width - 1), 'Expected intermediate slide frames');
  let previous = before.reader;
  for (const sample of samples) {
    assert.equal(sample.list, 0); assert.equal(sample.bar, 0);
    assert.ok(Math.abs(sample.bottomGap) < 1, 'Article must extend over the bottom bar');
    assert.ok(opening ? sample.reader <= previous + 1 : sample.reader >= previous - 1, 'Slide must not restart or reverse');
    if (sample.visible && sample.reader < width - 10) {
      assert.ok(sample.coversBar, 'Bottom bar must remain behind the sliding article');
      if (!opening) assert.ok(sample.article, 'Article content must remain during exit');
    }
    previous = sample.reader;
  }
  assert.ok(Math.abs(samples.at(-1).reader - (opening ? 0 : width)) < 1);
  assert.equal(samples.at(-1).visible, opening);
  if (!opening) assert.equal(samples.at(-1).article, false);
}

async function assertArticleStaysDismissed(page, historyLength) {
  await page.waitForFunction(() => history.state?.readingLibrary === true);
  assert.deepEqual(await page.evaluate(() => window.__readingHistorySnapshots.filter(snapshot => snapshot.articleCount || snapshot.open === 'true')), [], 'Closed history entries must only capture the library');
  const result = await page.evaluate(async () => {
    let pops = 0;
    const popped = () => { pops++; };
    window.addEventListener('popstate', popped);
    history.forward();
    await new Promise(resolve => setTimeout(resolve, 200));
    window.removeEventListener('popstate', popped);
    return { pops, length: history.length, item: new URL(location.href).searchParams.get('item'),
      open: document.querySelector('.crate-reading-workspace').dataset.readerOpen };
  });
  assert.deepEqual(result, { pops: 0, length: historyLength, item: null, open: 'false' });
}

async function assertNoPendingBanner(page) {
  await expect(page.locator('.crate-reading__notice').filter({hasText: /pending changes?|Waiting for server confirmation|Retry saved changes|Offline · showing saved Reading data/i})).toHaveCount(0);
}

async function refreshReadingFromSettings(page, expectedError) {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Reading settings',exact:true}).click();
  if (expectedError) await expect(page.getByRole('dialog').getByText(expectedError,{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Refresh library',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function sheetAppearance(page) {
  return page.getByRole('dialog').evaluate(sheet => {
    const header = sheet.querySelector('.reminder-modal-header');
    const close = header.querySelector('.crate-icon-button');
    const icon = close.querySelector('svg');
    const action = sheet.querySelector('.settings-action-button');
    return { radius: getComputedStyle(sheet).borderTopLeftRadius, surface: getComputedStyle(sheet).backgroundColor,
      headerHeight: header.getBoundingClientRect().height, titleSize: getComputedStyle(header.querySelector('h2')).fontSize,
      closeSize: close.getBoundingClientRect().width, icon: icon.outerHTML,
      actionSize: getComputedStyle(action).fontSize, actionColor: getComputedStyle(action).color, actionBackground: getComputedStyle(action).backgroundColor };
  });
}

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) test(`Reading ${name}: enroll, save, cached reader, offline change, phone confirmation and logout`, { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-reading-browser-')); let runtime, browser, server, loseCaptureReply = false, holdArticle, holdUpdate, holdList; const sent = [], heldResponses = [];
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Browser test');
    server = createServer(async (req, res) => {
      try {
        if (req.url === '/notifications/test-share') { res.writeHead(200, {'Content-Type':'text/html'}); res.end('<!doctype html><title>Share fixture</title><body>Share fixture</body>'); return; }
        const chunks=[]; for await (const chunk of req) chunks.push(chunk);
        const response = await runtime.mf.dispatchFetch(`${origin}${req.url}`, { method:req.method, headers:req.headers, ...(['GET','HEAD'].includes(req.method) ? {} : { body:Buffer.concat(chunks) }) });
        if (req.url.startsWith('/reading/item?') && holdArticle) { const held = holdArticle; holdArticle = null; held.started(); await held.release; }
        if (req.url === '/reading/update' && !response.ok) console.log('Reading update failed:', response.status, await response.clone().text());
        if (req.url === '/reading/update' && holdUpdate) { const held = holdUpdate; holdUpdate = null; held.started(); await held.release; }
        if (req.url === '/reading/list' && holdList) { const held = holdList; holdList = null; held.started(); await held.release; }
        if (req.url === '/reading/capture') { sent.push(Buffer.concat(chunks).toString()); if (loseCaptureReply) { loseCaptureReply = false; res.writeHead(503, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:"Save acknowledgement interrupted"})); return; } }
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) { if (res.headersSent) res.destroy(error); else { res.writeHead(500); res.end('Test server failed'); } }
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); const origin=`http://localhost:${server.address().port}`;
    const api = async (path, body) => {
      const response=await runtime.mf.dispatchFetch(`${origin}${path}`, {method:'POST',headers:{Authorization:`Bearer ${vault.token}`,'X-Crate-Protocol':'11','Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.status,200,await response.clone().text());return response.json();
    };
    await api('/reading/policy',{enabled:true,folderPath:'Reading',revision:null});
    const enrollment=await api('/reading/access',{kind:'reading'});
    browser=await engine.launch({headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const page=await context.newPage(); const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(() => {
      window.__readingDocument = crypto.randomUUID();
      window.__readingHistorySnapshots = [];
      const push = history.pushState.bind(history);
      history.pushState = (state, unused, url) => {
        if (state?.readingLibrary) window.__readingHistorySnapshots.push({
          open: document.querySelector('.crate-reading-workspace')?.dataset.readerOpen,
          articleCount: document.querySelectorAll('.crate-reading__reader-pane article').length,
        });
        return push(state, unused, url);
      };
    });
    const listStarted = Promise.withResolvers(), listReleased = Promise.withResolvers();
    heldResponses.push(listReleased.resolve);
    holdList = { started: listStarted.resolve, release: listReleased.promise };
    const exchangeReleased = Promise.withResolvers();
    heldResponses.push(exchangeReleased.resolve);
    await page.route('**/reading/exchange', async route => { await exchangeReleased.promise; await route.continue(); });
    await page.goto(enrollment.url);
    await expect(page.locator('.pwa-reading-opening__header')).toBeVisible();
    const headerGeometry = () => page.locator('.crate-reading__header').evaluate(header => {
      const box = selector => { const r = header.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      return { height: header.getBoundingClientRect().height, title: box('.view-header-title'), meta: box('.view-header-meta'), switcher: box('.pwa-feature-switch-button') };
    });
    const openingHeader = await headerGeometry();
    exchangeReleased.resolve();
    await page.getByRole('searchbox',{name:'Search reading'}).waitFor();
    assert.deepEqual(await headerGeometry(), openingHeader, 'Reading header stays fixed when the session loads');
    const readingSync = page.locator('.pwa-reading-root .pwa-sync-indicator');
    await listStarted.promise;
    await expect(page.getByRole('status',{name:'Loading Reading'})).toBeVisible();
    await expect(page.locator('.crate-reading__loading-row')).toHaveCount(4);
    await expect(readingSync).toHaveAttribute('data-sync-state','syncing');
    await expect(readingSync.getByRole('button')).toHaveAccessibleName('Sync status: Loading Reading');
    const header = page.locator('.crate-reading__header');
    const loadingHeader = await header.boundingBox();
    listReleased.resolve();
    await expect(readingSync).toHaveAttribute('data-sync-state','synced');
    await expect(page.locator('.crate-reading__loading-row')).toHaveCount(0);
    assert.equal((await header.boundingBox()).height, loadingHeader.height);
    assert.deepEqual(await headerGeometry(), openingHeader, 'Reading header stays fixed when the count arrives');
    const target = await readingSync.getByRole('button').boundingBox();
    assert.equal(target.width,44); assert.equal(target.height,44);
    await readingSync.getByRole('button').click();
    await expect(page.locator('.pwa-reading-root .toast')).toHaveText('Reading: All changes synced');
    assert.equal(await page.locator('.crate-feature-nav').count(), 0);
    await page.getByRole('searchbox',{name:'Search reading'}).fill('kept while switching');
    await page.getByRole('button',{name:'Switch to Reminders',exact:true}).click();
    await page.getByRole('heading',{name:'Connect to Crate',exact:true}).waitFor();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Switch to Reading',exact:true})).toBeFocused();
    await page.getByRole('button',{name:'Switch to Reading',exact:true}).click();
    await expect(page.getByRole('searchbox',{name:'Search reading'})).toHaveValue('kept while switching');
    await expect(page.getByRole('button',{name:'Switch to Reminders',exact:true})).toBeFocused();
    assert.equal(new URL(page.url()).searchParams.get('section'),'reading');
    await page.getByRole('searchbox',{name:'Search reading'}).fill('');
    await mkdir('test-results/reading',{recursive:true});
    // Reading uses the same PWA sheet surface, icon buttons, focus and gestures.
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.getByRole('button',{name:'Reading settings',exact:true}).click();
      const sheet = page.getByRole('dialog',{name:'Reading settings',exact:true});
      await expect(sheet).toHaveClass(/pwa-modal-sheet__container--settings/);
      await expect.poll(() => sheet.evaluate(el => el.getAnimations().length)).toBe(0);
      await expect(sheet.locator('.settings-group')).toHaveCount(3);
      await expect(sheet.getByRole('button',{name:'Close reading settings'}).locator('svg[data-icon="x"]')).toHaveCount(1);
      await page.screenshot({path:`test-results/reading/${name}-settings-${theme}.png`});
      await swipe(page, sheet.getByRole('heading',{name:'Reading settings',exact:true}));
      await expect(sheet).toHaveCount(0);
      await expect(page.getByRole('button',{name:'Reading settings',exact:true})).toBeFocused();
      await expect(page.locator('body')).not.toHaveClass(/pwa-sheet-scroll-locked/);
    }

    await page.getByRole('button',{name:'Save a link',exact:true}).click();
    await page.getByLabel('Link',{exact:true}).fill('https://example.invalid/browser');
    await page.getByLabel('Title (optional)').fill('A browser article');
    await page.getByRole('button',{name:'Save link',exact:true}).click();
    await page.getByRole('button',{name:/example.invalid A browser article/}).waitFor();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Exercise the real populated library and authenticated Reminders together,
    // in a separate device session so this test's logout/recovery flow is unchanged.
    const modeContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'no-preference' });
    try {
      const modePage = await modeContext.newPage();
      const modeEnrollment = await api('/notifications/reminders-enrollment-token', { folderPath: 'Reminders' });
      await modePage.goto(`${origin}/notifications?browserToken=${modeEnrollment.browserToken}`);
      await expect(modePage.getByRole('button', { name: 'Open settings', exact: true })).toBeVisible();
      await modePage.getByRole('button', { name: 'Switch to Reading', exact: true }).tap();
      await expect(modePage.getByRole('button', { name: /example.invalid A browser article/ })).toBeVisible();
      for (const destination of ['Reminders', 'Reading']) {
        await modePage.waitForFunction(() => !document.querySelector('[data-leaving="true"]'));
        await modePage.evaluate(() => {
          window.__modeFrames = [];
          const root = document.querySelector('.crate-feature-shell');
          const observer = new MutationObserver(() => {
            if (!root.querySelector('[data-entering="true"]')) return;
            observer.disconnect();
            const started = performance.now();
            const frame = () => {
              const panels = [...root.querySelectorAll('.crate-feature-panel')];
              window.__modeFrames.push(panels.map(el => Number(getComputedStyle(el).opacity)));
              if (performance.now() - started < 260) requestAnimationFrame(frame);
              else window.__modeDone = true;
            };
            window.__modeDone = false;
            requestAnimationFrame(frame);
          });
          observer.observe(root, { attributes: true, subtree: true, attributeFilter: ['data-entering'] });
        });
        await modePage.getByRole('button', { name: `Switch to ${destination}`, exact: true }).tap();
        await modePage.waitForFunction(() => window.__modeDone === true);
        const frames = await modePage.evaluate(() => window.__modeFrames);
        assert.ok(frames.filter(values => values.every(value => value > .05 && value < .95)).length >= 2, `${name}: populated mode fade to ${destination}: ${JSON.stringify(frames)}`);
      }
      await expect(modePage.getByRole('button', { name: /example.invalid A browser article/ })).toBeVisible();
      console.log(`${name}: connected Reminders and populated Reading fade in both directions with touch taps`);
    } finally { await modeContext.close(); }
    const firstArticleStarted = Promise.withResolvers(), firstArticleReleased = Promise.withResolvers();
    heldResponses.push(firstArticleReleased.resolve);
    holdArticle = { started: firstArticleStarted.resolve, release: firstArticleReleased.promise };
    await mkdir('test-results/reading',{recursive:true});
    const opening = captureReaderMotion(page, 'open');
    await firstArticleStarted.promise;
    await checkBackGesture(page, '.crate-reading__reader-pane', true);
    await page.screenshot({path:`test-results/reading/${name}-opening.png`,fullPage:true});
    assertReaderSlide(await opening, 'open');
    const articleHistoryLength = await page.evaluate(() => history.length);
    const articleUrl = page.url();
    await expect(page.getByText('Opening article…',{exact:true})).toBeVisible();
    const originalArticle = await page.locator('.crate-reading__reader-pane article').elementHandle();
    firstArticleReleased.resolve();
    await page.getByText('Available offline',{exact:true}).waitFor();
    assert.equal(await originalArticle.evaluate(el => el === document.querySelector('.crate-reading__reader-pane article')), true, 'Loading must resolve in the same article screen');
    await originalArticle.dispose();
    await page.getByRole('button',{name:'Reading appearance',exact:true}).click();
    const appearance = page.getByRole('dialog',{name:'Reading appearance',exact:true});
    await expect(appearance).toHaveClass(/pwa-modal-sheet__container--settings/);
    await page.getByRole('button',{name:'Increase text size'}).click();
    await page.keyboard.press('Escape');
    await expect(appearance).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Reading appearance',exact:true})).toBeFocused();
    await page.getByRole('button',{name:'Edit article tags'}).click();
    const tags = page.getByRole('dialog',{name:'Article tags'});
    await expect(tags).toHaveClass(/pwa-modal-sheet__container--settings/);
    await tags.getByRole('textbox').fill('essays');
    await tags.getByRole('button',{name:'Save tags',exact:true}).click();
    await expect(tags).toHaveCount(0);
    const closing = captureReaderMotion(page, 'close');
    await page.waitForTimeout(80);
    await page.screenshot({path:`test-results/reading/${name}-closing.png`,fullPage:true});
    assertReaderSlide(await closing, 'close');
    await expect(page.locator('.crate-reading-workspace')).toHaveAttribute('data-reader-open','false');
    await expect(page.locator('.crate-reading__reader-pane .crate-reading-reader')).toHaveCount(0);
    await assertArticleStaysDismissed(page, articleHistoryLength);
    await checkBackGesture(page, '.crate-reading__library');
    await page.emulateMedia({reducedMotion:'reduce'});
    await expect.poll(() => page.locator('.crate-reading__reader-pane').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
    await page.emulateMedia({reducedMotion:'no-preference'});
    const cachedArticleStarted = Promise.withResolvers(), cachedArticleReleased = Promise.withResolvers();
    heldResponses.push(cachedArticleReleased.resolve);
    holdArticle = { started: cachedArticleStarted.resolve, release: cachedArticleReleased.promise };
    await page.getByRole('button',{name:/example.invalid A browser article/}).click();
    await cachedArticleStarted.promise;
    await expect(page.getByRole('heading',{name:'A browser article',exact:true})).toBeVisible();
    await expect(page.getByText('Available offline',{exact:true})).toBeVisible();
    cachedArticleReleased.resolve();
    await expect.poll(() => page.locator('.crate-reading__reader-pane').evaluate(element => element.getAnimations().length)).toBe(0);
    // Browser Back (including native history gestures) must not start an app exit.
    const nativeBack = await captureReaderMotion(page, 'history-back');
    assert.equal(nativeBack.slides, 0, JSON.stringify(nativeBack));
    assert.equal(nativeBack.pops, 1); assert.equal(nativeBack.motion, 'none');
    for (const sample of nativeBack.samples) {
      assert.equal(sample.visible, false); assert.equal(sample.article, false);
      assert.equal(sample.list, 0); assert.equal(sample.bar, 0);
    }
    await assertArticleStaysDismissed(page, articleHistoryLength);
    // Reopening is an explicit action and reuses the closed detail slot.
    await page.getByRole('button',{name:/example.invalid A browser article/}).click();
    await page.getByText('Available offline',{exact:true}).waitFor();
    await expect.poll(() => page.locator('.crate-reading__reader-pane').evaluate(element => element.getAnimations().length)).toBe(0);
    await expect(page.locator('.crate-reading__library')).toHaveAttribute('inert', '');
    await page.setViewportSize({width:1280,height:844});
    await expect(page.locator('.crate-reading__library')).not.toHaveAttribute('inert');
    await expect(page.getByRole('searchbox',{name:'Search reading'})).toBeVisible();
    await page.setViewportSize({width:390,height:844});
    await expect(page.locator('.crate-reading__library')).toHaveAttribute('inert', '');
    // A reopened article still supports one toolbar exit with retained content.
    assertReaderSlide(await captureReaderMotion(page, 'close'), 'close');
    await assertArticleStaysDismissed(page, articleHistoryLength);
    // Repeated open/back cycles must not grow the history stack.
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.getByRole('button',{name:/example.invalid A browser article/}).click();
      await expect(page.locator('.crate-reading-workspace')).toHaveAttribute('data-reader-open','true');
      await page.goBack();
      await assertArticleStaysDismissed(page, articleHistoryLength);
    }
    // A slow article response must not reopen a reader dismissed during loading.
    const started = Promise.withResolvers(), released = Promise.withResolvers();
    heldResponses.push(released.resolve);
    holdArticle = { started: started.resolve, release: released.promise };
    await page.getByRole('button',{name:/example.invalid A browser article/}).click();
    await started.promise; await page.goBack();
    const responseReceived = page.waitForResponse(response => response.url().includes('/reading/item?'));
    released.resolve(); await responseReceived;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole('searchbox',{name:'Search reading'})).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.has('item'), false);
    await assertArticleStaysDismissed(page, articleHistoryLength);
    // Direct links and reloads still open an article; closing them removes Forward too.
    await page.goto(articleUrl);
    await page.getByText('Available offline',{exact:true}).waitFor();
    await expect(page.locator('.crate-reading-workspace')).toHaveAttribute('data-reader-motion','none');
    await page.reload();
    await page.getByText('Available offline',{exact:true}).waitFor();
    const deepLinkHistoryLength = await page.evaluate(() => history.length);
    const reloadedDocument = await page.evaluate(() => window.__readingDocument);
    assertReaderSlide(await captureReaderMotion(page, 'close'), 'close');
    await assertArticleStaysDismissed(page, deepLinkHistoryLength);
    assert.equal(await page.evaluate(() => window.__readingDocument), reloadedDocument, 'Closing a reloaded article must stay in the same document');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    // Playwright WebKit cannot navigate while setOffline(true) on this macOS build.
    // Chromium exercises cold offline launch; WebKit verifies the cached shell and in-place offline reading.
    assert.equal(await page.evaluate(async () => !!await caches.match('/notifications')), true);
    await context.setOffline(true); if (name === 'chromium') await page.reload();
    const offlineDocument = await page.evaluate(() => window.__readingDocument);
    await expect(readingSync).toHaveAttribute('data-sync-state','offline');
    await page.getByRole('button',{name:/example.invalid A browser article/}).waitFor();
    await page.getByRole('button',{name:/example.invalid A browser article/}).click();
    await page.getByText('Available offline',{exact:true}).waitFor();
    const offlineHistoryLength = await page.evaluate(() => history.length);
    await page.getByRole('button',{name:'Back to reading',exact:true}).click();
    await assertArticleStaysDismissed(page, offlineHistoryLength);
    assert.equal(await page.evaluate(() => window.__readingDocument), offlineDocument, 'Back after a library reload must not restore an older page');
    await page.getByRole('button',{name:'Favorite',exact:true}).click();
    await assertNoPendingBanner(page);
    await expect(readingSync.getByRole('button')).toHaveAccessibleName('Sync status: Offline: 1 change waiting to sync');
    await context.setOffline(false);
    await refreshReadingFromSettings(page);
    await page.getByRole('button',{name:'Remove favorite',exact:true}).waitFor();
    await assertNoPendingBanner(page);
    await expect(readingSync).toHaveAttribute('data-sync-state','synced');
    // Archiving is visible immediately in the reader and filters, without a banner.
    const archiveStarted = Promise.withResolvers(), archiveReleased = Promise.withResolvers();
    heldResponses.push(archiveReleased.resolve);
    holdUpdate = { started: archiveStarted.resolve, release: archiveReleased.promise };
    await page.getByRole('button',{name:/example.invalid A browser article/}).click();
    await page.getByText('Available offline',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Archive article',exact:true}).click();
    await archiveStarted.promise;
    await expect(page.getByRole('button',{name:'Move to inbox',exact:true})).toBeVisible();
    await assertNoPendingBanner(page);
    await page.getByRole('button',{name:'Back to reading',exact:true}).click();
    await expect(page.locator('.crate-reading__reader-pane article')).toHaveCount(0);
    await expect(page.getByRole('button',{name:/example.invalid A browser article/})).toHaveCount(0);
    await assertNoPendingBanner(page);
    await page.getByRole('button',{name:'Archive',exact:true}).click();
    await page.getByRole('button',{name:/example.invalid A browser article/}).waitFor();
    archiveReleased.resolve();
    await expect(readingSync).toHaveAttribute('data-sync-state','synced');
    await page.getByRole('button',{name:/example.invalid A browser article/}).click();
    await page.getByRole('button',{name:'Move to inbox',exact:true}).click();
    await page.getByRole('button',{name:'Back to reading',exact:true}).click();
    await expect(page.locator('.crate-reading__reader-pane article')).toHaveCount(0);
    await page.getByRole('button',{name:'Inbox',exact:true}).click();
    await expect(readingSync).toHaveAttribute('data-sync-state','synced');
    // A slow update response must not hold the favorite or the cached reader.
    const updateStarted = Promise.withResolvers(), updateReleased = Promise.withResolvers();
    heldResponses.push(updateReleased.resolve);
    holdUpdate = { started: updateStarted.resolve, release: updateReleased.promise };
    await page.getByRole('button',{name:'Remove favorite',exact:true}).click();
    await updateStarted.promise;
    await expect(readingSync.getByRole('button')).toHaveAccessibleName('Sync status: Syncing 1 change');
    await expect(page.getByRole('button',{name:'Favorite',exact:true})).toHaveAttribute('aria-pressed','false');
    await assertNoPendingBanner(page);
    await page.getByRole('button',{name:/example.invalid A browser article/}).click();
    await expect(page.getByRole('heading',{name:'A browser article',exact:true})).toBeVisible();
    await expect(page.getByText('Available offline',{exact:true})).toBeVisible();
    await assertNoPendingBanner(page);
    await page.getByRole('button',{name:'Back to reading',exact:true}).click();
    await page.getByRole('button',{name:'Save a link',exact:true}).click();
    await page.getByLabel('Link',{exact:true}).fill('https://example.invalid/while-pending');
    await page.getByLabel('Title (optional)').fill('Saved during update');
    await page.getByRole('button',{name:'Save link',exact:true}).click();
    await expect(readingSync.getByRole('button')).toHaveAccessibleName('Sync status: Syncing 2 changes');
    await assertNoPendingBanner(page);
    updateReleased.resolve();
    await assertNoPendingBanner(page);
    await expect(readingSync).toHaveAttribute('data-sync-state','synced');
    await page.getByRole('button',{name:/example.invalid Saved during update/}).waitFor();
    // A committed save with a lost response must resend exactly the persisted operation.
    sent.length = 0; loseCaptureReply = true;
    await page.getByRole('button',{name:'Save a link',exact:true}).click();
    await page.getByLabel('Link',{exact:true}).fill('https://example.invalid/lost-reply');
    await page.getByRole('button',{name:'Save link',exact:true}).click();
    await expect.poll(() => page.evaluate(async () => { const db = await new Promise((resolve,reject) => { const r=indexedDB.open('crate-reading-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=reject; }); const id=JSON.parse(localStorage.getItem('crate-reading-session-v1')).id;return new Promise(resolve=>{const r=db.transaction('values').objectStore('values').get(`pending:${id}`);r.onsuccess=()=>{db.close();resolve(r.result?.some(op=>op.action==='capture' && op.error));};}); })).toBeTruthy();
    await expect(readingSync).toHaveAttribute('data-sync-state','error');
    await assertNoPendingBanner(page);
    await refreshReadingFromSettings(page, 'Save acknowledgement interrupted');
    await expect.poll(() => page.evaluate(async () => { const db = await new Promise((resolve,reject) => { const r=indexedDB.open('crate-reading-v1',1); r.onsuccess=()=>resolve(r.result);r.onerror=reject; }); const id=JSON.parse(localStorage.getItem('crate-reading-session-v1')).id; return new Promise(resolve=>{ const r=db.transaction('values').objectStore('values').get(`pending:${id}`);r.onsuccess=()=>{db.close();resolve(r.result.length===0);}; }); })).toBe(true);
    assert.ok(sent.length >= 2, JSON.stringify({ sent, text: await page.locator('body').innerText() })); assert.equal(sent[0],sent[1]);
    if (name === 'chromium') {
      await page.goto(`${origin}/notifications/test-share`); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      await context.setOffline(true);
      await page.evaluate(() => { const form=document.createElement('form');form.method='POST';form.action='/notifications/share/reading';for (const [name,value] of Object.entries({url:'https://example.invalid/android',title:'Android share'})){const input=document.createElement('input');input.name=name;input.value=value;form.append(input);}document.body.append(form);form.submit(); });
      await page.waitForURL(/share=/);
      await page.getByLabel('Link',{exact:true}).waitFor(); assert.equal(await page.getByLabel('Link',{exact:true}).inputValue(),'https://example.invalid/android');
      await page.getByRole('button',{name:'Save link',exact:true}).click();
      await expect(readingSync.getByRole('button')).toHaveAccessibleName('Sync status: Offline: 1 change waiting to sync');
      await assertNoPendingBanner(page);
      await context.setOffline(false);
      await refreshReadingFromSettings(page);
      await page.getByRole('button',{name:/example.invalid Android share/}).waitFor();
    }
    const fresh = await browser.newContext({serviceWorkers:'block'}), shared = await fresh.newPage();
    await shared.goto(`${origin}/notifications/test-share`);
    await shared.evaluate(() => { const form=document.createElement('form');form.method='POST';form.action='/notifications/share/reading';const input=document.createElement('input');input.name='url';input.value='https://example.invalid/first-share';form.append(input);document.body.append(form);form.submit(); });
    await shared.getByText('Your shared link is kept on this device.',{exact:false}).waitFor(); await fresh.close();
    await mkdir('test-results/reading',{recursive:true}); await page.screenshot({path:`test-results/reading/${name}-library.png`,fullPage:true});
    const prepared=await api('/reading/prepare',{url:'https://example.invalid/phone',title:'Phone article'});
    const phone=await context.newPage(); await phone.goto(prepared.launchUrl);
    await phone.getByRole('heading',{name:'Saved to Crate ✓'}).waitFor(); assert.equal(new URL(phone.url()).hash,'');
    await phone.screenshot({path:`test-results/reading/${name}-saved.png`,fullPage:true});
    await phone.reload(); await phone.getByRole('heading',{name:'Saved to Crate ✓'}).waitFor();
    await page.getByRole('button',{name:'Reading settings'}).click();
    await page.getByRole('button',{name:'Log out and clear device data'}).click();
    await page.getByRole('heading',{name:'Your reading, everywhere'}).waitFor();
    assert.equal(await page.evaluate(()=>localStorage.getItem('crate-reading-session-v1')),null);
    // An already enrolled Reminders PWA opens Reading with the same browser credential.
    await runtime.db.prepare('UPDATE reading_policy SET enabled=0').run();
    const remindersEnrollment = await api('/notifications/reminders-enrollment-token', { folderPath: 'Reminders' });
    await page.goto(`${origin}/notifications?browserToken=${remindersEnrollment.browserToken}`);
    await page.waitForFunction(() => !!localStorage.getItem('crate-reminders-auth-token'));
    await page.goto(`${origin}/notifications?section=reading`);
    await page.getByText('Reading is disabled. Enable it in Crate settings.', { exact: false }).waitFor();
    await runtime.db.prepare('UPDATE reading_policy SET enabled=1').run();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByRole('searchbox',{name:'Search reading'}).waitFor();
    const linked = await page.evaluate(() => ({ reading: JSON.parse(localStorage.getItem('crate-reading-session-v1')), reminders: localStorage.getItem('crate-reminders-auth-token') }));
    assert.equal(linked.reading.source, 'reminders'); assert.equal(linked.reading.token, linked.reminders);
    await page.getByRole('button',{name:'Switch to Reminders',exact:true}).click();
    await page.getByRole('button',{name:'Open settings',exact:true}).click();
    const reminderSheetAppearance = await sheetAppearance(page);
    await page.getByRole('button',{name:'Close settings',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button',{name:'Switch to Reading',exact:true}).click();
    await page.getByRole('searchbox',{name:'Search reading'}).waitFor();
    await page.getByRole('button',{name:'Reading settings'}).click();
    assert.deepEqual(await sheetAppearance(page), reminderSheetAppearance, 'Both modes must share sheet and control styling');
    await page.getByRole('button',{name:'Log out and clear device data'}).click();
    await page.getByRole('heading',{name:'Your reading, everywhere'}).waitFor();
    assert.equal(await page.evaluate(()=>localStorage.getItem('crate-reminders-auth-token')), null);
    assert.equal(await page.evaluate(()=>localStorage.getItem('crate-reading-session-v1')), null);
    assert.equal((await runtime.mf.dispatchFetch(`${origin}/reading/session`, { headers: { Authorization: `Bearer ${linked.reminders}` } })).status, 401);
    assert.deepEqual(errors,[]);
  } catch (error) { await mkdir('test-results/reading',{recursive:true}); for (const context of browser?.contexts() ?? []) for (const page of context.pages()) { console.log('Reading failure page:',page.url(),(await page.locator('body').innerText().catch(()=>''))); await page.screenshot({path:`test-results/reading/${name}-failure.png`}).catch(()=>{}); } throw error; } finally { heldResponses.forEach(release => release()); await browser?.close(); if(server) await new Promise(resolve=>server.close(resolve)); await runtime?.close(); await rm(dir,{recursive:true,force:true}); }
});
