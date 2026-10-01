import { checkDetailHistoryFreshness } from './pwa-detail-history-checks.mjs';
import { dockAppearance } from './pwa-launch-theme-checks.mjs';
import { checkSaveLinkKeyboard } from './pwa-sheet-field-checks.mjs';
import { switchFeature, featureNavigationTarget } from './pwa-feature-navigation.mjs';
import { checkBackGesture } from './pwa-back-gesture-checks.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { swipe } from './browser-touch-swipe.mjs';
import { checkPwaScreenGestures, checkPwaTextField } from './pwa-screen-interaction-checks.mjs';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';

async function checkReaderNavigation(page) {
  const reader = page.locator('.crate-reading-reader');
  await expect(reader).toHaveAttribute('data-document-scroll', 'true');
  const nav = reader.getByRole('navigation', { name: 'Article actions' });
  const floating = reader.locator('.crate-reading-reader__floating');
  const highlights = reader.getByRole('button', { name: /^Highlights \(/ });
  const tags = reader.getByRole('button', { name: 'Edit article tags', exact: true });
  await expect(tags).toHaveText('');
  const material = button => button.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.background, border: style.borderColor, shadow: style.boxShadow,
      blur: style.backdropFilter || style.webkitBackdropFilter, color: style.color };
  });
  const appearance = reader.getByRole('button', { name: 'Reading appearance', exact: true });
  assert.deepEqual(await material(tags), await material(appearance), 'Tags matches the appearance icon');
  assert.deepEqual(await material(highlights), await material(appearance), 'Highlights uses the same frosted material and icon color');
  await expect(reader.getByRole('group', { name: 'Article view' })).toHaveCount(0);
  await expect(floating).toHaveCSS('height', '0px');
  // Give the short server fixture enough length to exercise real browser scrolling.
  const length = await page.addStyleTag({ content: '.crate-reading-reader__body { min-height: 12000px; }' });
  await expect(reader.locator('.crate-reading-reader__body')).toBeVisible();
  const scrollTo = async top => {
    await page.evaluate(value => window.scrollTo(0, value), top);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(top);
    await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBe(0);
  };
  const visibleAtTop = async () => {
    await expect(nav).toHaveAttribute('data-scroll-hidden', 'false');
    await expect(floating).toHaveAttribute('data-scroll-hidden', 'false');
    await expect(floating).toHaveCSS('opacity', '1');
    await expect(nav).toHaveCSS('opacity', '1');
    const box = await highlights.boundingBox();
    assert.ok(box && box.y > 0 && box.y + box.height <= page.viewportSize().height, JSON.stringify(box));
    await expect.poll(() => nav.evaluate(element => Math.abs(element.getBoundingClientRect().top))).toBeLessThan(1);
  };
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion });
    await scrollTo(0);
    await visibleAtTop();
    await scrollTo(450);
    await expect(nav).toHaveAttribute('data-scroll-hidden', 'true');
    await expect(floating).toHaveAttribute('data-scroll-hidden', 'true');
    await expect(floating).toHaveCSS('opacity', '0');
    await expect(highlights).toHaveCSS('pointer-events', 'none');
    await expect(nav).toHaveCSS('opacity', '0');
    if (reducedMotion === 'no-preference') await expect.poll(() => nav.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(1);
    await scrollTo(446); // Tiny reversals should not flicker the header.
    await expect(nav).toHaveAttribute('data-scroll-hidden', 'true');
    await expect(floating).toHaveAttribute('data-scroll-hidden', 'true');
    await expect(floating).toHaveCSS('opacity', '0');
    await expect(highlights).toHaveCSS('pointer-events', 'none');
    await scrollTo(420);
    if (reducedMotion === 'no-preference') {
      await expect.poll(() => floating.evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0);
      await expect.poll(() => floating.evaluate(element => Number(getComputedStyle(element).opacity))).toBeLessThan(1);
      await expect.poll(() => nav.evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0);
      await expect.poll(() => nav.evaluate(element => Number(getComputedStyle(element).opacity))).toBeLessThan(1);
    }
    await scrollTo(360);
    await visibleAtTop();
    // The overlay sheet must keep the full article and restore its scroll offset.
    await highlights.click();
    await expect(page.getByRole('dialog', { name: 'Highlights', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close highlights', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Highlights', exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(360);
    await expect(highlights).toBeFocused();
    await highlights.evaluate(element => element.blur());
    // Opening a sheet from a scrolled article must restore the document offset.
    // Give this sheet an explicit focus-return target. A programmatic click
    // alone can leave the preceding Highlights trigger as the remembered target.
    await appearance.evaluate(element => { element.focus({ preventScroll: true }); element.click(); });
    await expect(page.getByRole('dialog', { name: 'Reading appearance' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Reading appearance' })).toHaveCount(0);
    await expect(appearance).toBeFocused();
    await appearance.evaluate(element => element.blur());
    await expect(page.locator('body')).not.toHaveClass(/pwa-sheet-scroll-locked/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(360);
    await scrollTo(700);
    await expect(nav).toHaveAttribute('data-scroll-hidden', 'true');
    await expect(floating).toHaveAttribute('data-scroll-hidden', 'true');
    await expect(floating).toHaveCSS('opacity', '0');
    await expect(highlights).toHaveCSS('pointer-events', 'none');
    await nav.getByRole('button', { name: 'Back to reading' }).focus();
    await visibleAtTop();
    await nav.getByRole('button', { name: 'Back to reading' }).evaluate(element => element.blur());
    // Restored controls stay anchored even many viewports into the article.
    await scrollTo(6300);
    await expect(nav).toHaveCSS('opacity', '0');
    await scrollTo(6000);
    await visibleAtTop();
    const passageTop = await reader.locator('.crate-reading-reader__body').evaluate(element => element.getBoundingClientRect().top);
    await page.waitForTimeout(200);
    assert.equal(await reader.locator('.crate-reading-reader__body').evaluate(element => element.getBoundingClientRect().top), passageTop, 'Chrome transitions must not move the article');
    await scrollTo(0);
    await visibleAtTop();
    if (reducedMotion === 'reduce') await expect(nav).toHaveCSS('transition-duration', '0s');
  }
  // The pinned actions must remain below the installed app's status-bar inset.
  const safeArea = await page.addStyleTag({ content: ':root { --pwa-safe-area-top: 47px; }' });
  await scrollTo(6300);
  await expect(nav).toHaveCSS('opacity', '0');
  await scrollTo(6000);
  await expect(nav).toHaveCSS('opacity', '1');
  await expect.poll(() => nav.evaluate(element => element.getBoundingClientRect().top)).toBe(47);
  await safeArea.evaluate(element => element.remove());
  await scrollTo(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await length.evaluate(element => element.remove());
}

async function captureReaderMotion(page, action) {
  const hitTestStyle = await page.addStyleTag({ content: '.reader-motion-hit-test { pointer-events: auto !important; }' });
  try { return await page.evaluate(async action => {
    const workspace = document.querySelector('.crate-reading-workspace');
    const pane = workspace.querySelector('.crate-reading__reader-pane');
    const list = workspace.querySelector('.crate-reading__library');
    const bar = workspace.querySelector('.crate-reading__sidebar');
    const readingTab = bar.querySelector('[data-dock-group]');
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
        visible: getComputedStyle(pane).visibility === 'visible', article: !!pane.querySelector('.crate-reading-reader__header h1'),
        body: !!pane.querySelector('.crate-reading-reader__body'),
        tabOpacity: getComputedStyle(readingTab).opacity,
        iconOpacity: getComputedStyle(readingTab.querySelector('.pwa-dock__view-icon')).opacity,
        dockInert: !!readingTab.closest('[inert]') };
    };
    const before = state(), width = pane.getBoundingClientRect().width;
    let slides = 0, pops = 0;
    const transition = event => { if (event.target === pane && event.propertyName === 'transform') slides++; };
    let resolvePop;
    const popped = new Promise(resolve => { resolvePop = resolve; });
    const pop = () => { pops++; resolvePop(); };
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
    const samples = [];
    let slideDuration = 0;
    if (action === 'history-back') {
      const started = performance.now();
      do { await new Promise(resolve => requestAnimationFrame(resolve)); samples.push(state()); } while (performance.now() - started < 450);
    } else {
      // Inspect the actual CSS transition at known progress. A loaded runner can
      // deliver its next rAF after the whole slide and miss every interior frame.
      const animation = pane.getAnimations().find(animation => animation.transitionProperty === 'transform');
      if (!animation) throw new Error(`Missing reader ${action} transition`);
      slideDuration = Number(animation.effect.getComputedTiming().duration);
      animation.pause();
      await animation.ready;
      for (const progress of [0, .25, .5, .75, .99]) {
        animation.currentTime = slideDuration * progress;
        samples.push(state());
      }
      animation.finish();
      await animation.finished;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      samples.push(state());
    }
    // Back commits after the slide; a busy compositor may finish after the sampling window.
    if (action !== 'open') { await popped; samples.push(state()); }
    pane.removeEventListener('transitionrun', transition); window.removeEventListener('popstate', pop);
    return { before, width, samples, slides, pops, slideDuration, motion: workspace.dataset.readerMotion };
  }, action); } finally { await hitTestStyle.evaluate(element => element.remove()); }
}

function assertReaderSlide(result, action) {
  const { before, width, samples, slides, pops } = result, opening = action === 'open';
  assertSteadyReadingTab(result);
  assert.equal(samples.at(-1).dockInert, opening, 'Reader must block the dock until returning to the library');
  assert.equal(slides, 1, JSON.stringify(result));
  assert.ok(result.slideDuration > 0 && result.slideDuration <= 450, JSON.stringify(result));
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

function assertSteadyReadingTab({ before, samples }) {
  for (const sample of [before, ...samples]) {
    assert.equal(sample.tabOpacity, '1', 'Reading tab must not dim or fade when the reader opens or closes');
    assert.equal(sample.iconOpacity, '1', 'Reading icon must remain fully painted');
  }
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
  await page.getByRole('button',{name:'Open settings',exact:true}).click();
  if (expectedError) await expect(page.getByRole('dialog').getByText(expectedError,{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Refresh all',exact:true}).click();
  await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function sheetAppearance(page) {
  await expect(page.getByRole('button', { name: 'Refresh all', exact: true })).toBeVisible();
  return page.getByRole('dialog').evaluate(sheet => {
    const header = sheet.querySelector('.reminder-modal-header');
    const close = header.querySelector('.crate-icon-button');
    const icon = close.querySelector('svg');
    const action = [...sheet.querySelectorAll('button')].find(button => button.textContent.trim() === 'Refresh all');
    return { radius: getComputedStyle(sheet).borderTopLeftRadius, surface: getComputedStyle(sheet).backgroundColor,
      headerHeight: Math.round(header.getBoundingClientRect().height * 100) / 100, titleSize: getComputedStyle(header.querySelector('h2')).fontSize,
      closeSize: Math.round(close.getBoundingClientRect().width * 100) / 100, icon: icon.outerHTML,
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
        // Complete this reader fixture through the real publication endpoint;
        // invalid-domain retries otherwise delay the deferred capture for minutes.
        if (req.url === '/reading/capture' && response.ok && JSON.parse(Buffer.concat(chunks).toString()).url === 'https://browser.example.invalid/browser') {
          const queued = await runtime.db.prepare('SELECT id,generation FROM reading_captures WHERE url_identity=?').bind('https://browser.example.invalid/browser').first();
          if (queued) {
            const { REMINDER_ALARMS } = await runtime.mf.getBindings();
            const published = await REMINDER_ALARMS.get(REMINDER_ALARMS.idFromName('__crate__/projection')).fetch('https://do/reading-publish', {
              method: 'POST', body: JSON.stringify({ captureId: queued.id, generation: queued.generation, result: null }),
            });
            assert.equal(published.status, 204);
          }
        }
        if (req.url === '/reading/capture') { sent.push(Buffer.concat(chunks).toString()); if (loseCaptureReply) { loseCaptureReply = false; res.writeHead(503, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:"Save acknowledgement interrupted"})); return; } }
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) { if (res.headersSent) res.destroy(error); else { res.writeHead(500); res.end('Test server failed'); } }
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); const origin=`http://localhost:${server.address().port}`;
    const api = async (path, body) => {
      const response=await runtime.mf.dispatchFetch(`${origin}${path}`, {method:'POST',headers:{Authorization:`Bearer ${vault.token}`,'X-Crate-Protocol':'1','Content-Type':'application/json'},body:JSON.stringify(body)});
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
        // Model the predecessor snapshot: replaceState cannot repaint an older entry.
        if (state?.readingArticle) window.__readingBackTitle = document.querySelector('.pwa-tab-panel:not([data-leaving]) .crate-reading__header h1')?.textContent;
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
    await expect(page.locator('.pwa-reading-opening__header [data-icon="settings"]')).toBeVisible();
    const headerGeometry = () => page.locator('.crate-reading__header:visible').evaluate(header => {
      const box = selector => { const r = header.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const icon = header.querySelector('[data-icon="settings"]'), style = getComputedStyle(icon);
      return { height: header.getBoundingClientRect().height, title: box('.view-header-title'), meta: box('.view-header-meta'), switcher: box('.pwa-feature-switch-button'),
        settings: box('[aria-label="Open settings"]'), settingsIcon: icon.outerHTML, settingsColor: style.color, settingsOpacity: style.opacity };
    });
    let openingHeader;
    await expect.poll(async () => { openingHeader = await headerGeometry(); return openingHeader.height; }).toBeGreaterThan(0);
    await expect(page.locator('.pwa-dock .pwa-mode-opening__shape')).toHaveCount(0);
    const openingDock = await dockAppearance(page);
    exchangeReleased.resolve();
    await page.getByRole('searchbox',{name:'Search reading'}).waitFor();
    assert.deepEqual(await headerGeometry(), openingHeader, 'Reading header stays fixed when the session loads');
    assert.deepEqual(await dockAppearance(page), openingDock, 'Reading dock is already complete while the session loads');
    const readingSync = page.locator('.pwa-reading-root .pwa-tab-panel:not([data-leaving]) .pwa-sync-indicator');
    await listStarted.promise;
    await expect(page.getByRole('status',{name:'Loading Reading'})).toBeVisible();
    await expect(page.locator('.crate-content-loading')).toHaveCount(1);
    await expect(readingSync).toHaveAttribute('data-sync-state','syncing');
    await expect(readingSync.getByRole('button')).toHaveAccessibleName('Sync status: Refreshing Crate');
    const header = page.locator('.crate-reading__header');
    const loadingHeader = await header.boundingBox();
    listReleased.resolve();
    await expect(readingSync).toHaveAttribute('data-sync-state','synced');
    await expect(page.locator('.crate-content-loading')).toHaveCount(0);
    assert.equal((await header.boundingBox()).height, loadingHeader.height);
    assert.deepEqual(await headerGeometry(), openingHeader, 'Reading header stays fixed when the count arrives');
    await checkPwaScreenGestures(page, page.locator('.crate-reading__list-scroll'));
    await checkPwaTextField(page.getByRole('searchbox', { name: 'Search reading' }));
    await expect(page.locator('.crate-reading__header h1')).toHaveCSS('-webkit-user-select', 'none');
    const target = await readingSync.getByRole('button').boundingBox();
    assert.equal(target.width,44); assert.equal(target.height,44);
    await readingSync.getByRole('button').click();
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    assert.equal(await page.locator('.crate-feature-nav').count(), 0);
    await page.getByRole('searchbox',{name:'Search reading'}).fill('kept while switching');
    await switchFeature(page, 'Reminders');
    await page.getByRole('heading',{name:'Connect to Crate',exact:true}).waitFor();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(featureNavigationTarget(page)).toBeFocused();
    await switchFeature(page, 'Reading');
    await expect(page.getByRole('searchbox',{name:'Search reading'})).toHaveValue('kept while switching');
    await expect(featureNavigationTarget(page)).toBeFocused();
    assert.equal(new URL(page.url()).searchParams.get('section'),'reading');
    await page.getByRole('searchbox',{name:'Search reading'}).fill('');
    await mkdir('test-results/reading',{recursive:true});
    // Reading uses the same PWA sheet surface, icon buttons, focus and gestures.
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.getByRole('button',{name:'Open settings',exact:true}).click();
      const sheet = page.getByRole('dialog',{name:'Settings',exact:true});
      await expect(sheet).toHaveClass(/pwa-modal-sheet__container--settings/);
      // The portal exists before Base UI starts its entrance transition.
      // An empty animation list in that frame does not mean it is on screen.
      await expect(sheet).toHaveCSS('transform', 'none');
      await expect.poll(() => sheet.evaluate(el => el.getAnimations().length)).toBe(0);
      for (const title of ['General', 'Tabs', 'Reminders', 'Reading']) await expect(sheet.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(sheet.getByRole('button',{name:'Close settings'}).locator('svg[data-icon="x"]')).toHaveCount(1);
      await page.screenshot({path:`test-results/reading/${name}-settings-${theme}.png`});
      // This checks dismissal and focus, independently of native flick velocity.
      // The dedicated settings motion suite covers short, fast releases.
      await swipe(page, sheet.getByRole('heading',{name:'Settings',exact:true}), 540, 300, 36);
      await expect(sheet).toHaveCount(0);
      await expect(page.getByRole('button',{name:'Open settings',exact:true})).toBeFocused();
      await expect(page.locator('body')).not.toHaveClass(/pwa-sheet-scroll-locked/);
    }

    await page.getByRole('button',{name:'Save a link',exact:true}).click();
    await checkSaveLinkKeyboard(page);
    await checkPwaTextField(page.getByLabel('Link', { exact: true }), { sheet: true });
    await page.getByLabel('Link',{exact:true}).fill('https://browser.example.invalid/browser');
    await page.getByRole('button',{name:'Save link',exact:true}).click();
    await page.getByRole('button',{name:/browser.example.invalid browser.example.invalid/}).waitFor();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Exercise the real populated library and authenticated Reminders together,
    // in a separate device session so this test's logout/recovery flow is unchanged.
    const modeContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'no-preference', serviceWorkers: 'block' });
    try {
      const modePage = await modeContext.newPage();
      await modePage.route('**/reminders/list?*', route => route.fulfill({ json: {
        projects: ['Errands'], reminders: [{ id: 'history-reminder', content: 'History reminder', project: 'Errands',
          priority: 4, completed: false, filePath: 'Reminders/Errands.md', lineNumber: 1 }],
      } }));
      const modeEnrollment = await api('/notifications/reminders-enrollment-token', { folderPath: 'Reminders' });
      await modePage.goto(`${origin}/notifications?browserToken=${modeEnrollment.browserToken}`);
      await expect(modePage.getByRole('button', { name: 'Open settings', exact: true })).toBeVisible();
      await switchFeature(modePage, 'Reading');
      await expect(modePage.getByRole('button', { name: /browser.example.invalid browser.example.invalid/ })).toBeVisible();
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
        await switchFeature(modePage, destination);
        await modePage.waitForFunction(() => window.__modeDone === true);
        const frames = await modePage.evaluate(() => window.__modeFrames);
        // Hosted runners may skip frames. Verify a painted intermediate state
        // without imposing a frame-rate threshold on the runner.
        assert.ok(frames.some(values => values.some(value => value > 0 && value < 1)), `${name}: populated mode dissolve to ${destination}: ${JSON.stringify(frames)}`);
        assert.ok(frames.every(values => values.some(value => value === 1)), 'The incoming feature stays opaque beneath the outgoing feature');
      }
      await expect(modePage.getByRole('button', { name: /browser.example.invalid browser.example.invalid/ })).toBeVisible();
      console.log(`${name}: connected Reminders and populated Reading fade in both directions with touch taps`);
      // Each feature remembers its closed detail slot. Opening the other feature's
      // detail replaces that slot's predecessor, so it must no longer be reused.
      for (let cycle = 0; cycle < 3; cycle++) {
        await modePage.getByRole('button', { name: /browser.example.invalid browser.example.invalid/ }).click();
        await expect(modePage.locator('.crate-reading-workspace')).toHaveAttribute('data-reader-open', 'true');
        await modePage.goBack();
        await modePage.waitForFunction(() => history.state?.readingLibrary === true);
        await expect(modePage.locator('.crate-feature-panel[data-active="true"]')).toHaveAttribute('data-crate-section', 'reading');
        await expect(modePage.locator('.crate-reading-workspace')).toHaveAttribute('data-reader-open', 'false');
        await modePage.locator('.crate-feature-panel[data-active="true"] .pwa-dock [data-tab="projects"]').click();
        await modePage.getByRole('button', { name: 'Open Errands', exact: true }).click();
        await expect(modePage.locator('.pwa-project-layer')).toHaveAttribute('data-project-open', 'true');
        await modePage.goBack();
        await modePage.waitForFunction(() => history.state?.reminderProjectList === true);
        await expect(modePage.locator('.crate-feature-panel[data-active="true"]')).toHaveAttribute('data-crate-section', 'reminders');
        await expect(modePage.locator('.pwa-navigation-screen--project')).toHaveCount(0);
        await expect(modePage.locator('.crate-feature-panel[data-active="true"] [data-dock-active="true"]')).toHaveAccessibleName('Projects');
        await switchFeature(modePage, 'Reading');
      }
      console.log(`${name}: alternating article/project history Back retains the selected tab`);
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
    let articleHistoryLength = await page.evaluate(() => history.length);
    const articleUrl = page.url();
    await expect(page.getByRole('status', { name: 'Loading article', exact: true }).locator('.crate-content-loading__spinner')).toBeVisible();
    await expect(page.locator('.crate-reading-reader__header')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Back to reading' })).toBeEnabled();
    const originalArticle = await page.locator('.crate-reading__reader-pane article').elementHandle();
    firstArticleReleased.resolve();
    await page.getByText('Available offline',{exact:true}).waitFor();
    assert.equal(await originalArticle.evaluate(el => el === document.querySelector('.crate-reading__reader-pane article')), true, 'Loading must resolve in the same article screen');
    await originalArticle.dispose();
    // After visiting Inbox, another tab must not reuse its native Back snapshot.
    await page.goBack();
    await page.waitForFunction(() => history.state?.readingLibrary === true);
    await checkDetailHistoryFreshness(page, {
      open: async () => { await page.locator('.crate-reading__open').first().click(); await expect(page.locator('.crate-reading-workspace')).toHaveAttribute('data-reader-open', 'true'); },
      close: async () => { await page.goBack(); await page.waitForFunction(() => history.state?.readingLibrary === true); },
      list: page.locator('.crate-reading__library'), stateKey: 'readingStackId', detailKey: 'readingArticle',
    });
    // Cached text is available during the next slide. It must not trigger
    // parsing, syntax highlighting, or a full article layout while moving.
    const cachedOpening = await captureReaderMotion(page, 'open');
    assertReaderSlide(cachedOpening, 'open');
    assert.ok(cachedOpening.samples.filter(sample => sample.reader > 1).every(sample => !sample.body && !sample.article), 'Article heading and body wait for the opening slide');
    assert.ok(cachedOpening.samples.every(sample => sample.article === sample.body), 'Article heading and body appear in the same frame');
    await expect(page.locator('.crate-reading-reader__body')).toHaveCount(1);
    await page.goBack();
    await page.waitForFunction(() => history.state?.readingLibrary === true);
    await page.getByRole('button', { name: 'Favorite', exact: true }).click();
    for (const [section, title] of [['favorites', 'Favorites'], ['inbox', 'Reading'], ['favorites', 'Favorites'], ['inbox', 'Reading']]) {
      await page.locator('.pwa-reading-root [data-dock-group]').click({ button: 'right' });
      await page.locator(`[data-dock-destination="${section === 'inbox' ? 'reading' : section}"]`).click();
      await page.waitForFunction(() => !document.querySelector('.pwa-reading-root [data-leaving="true"]'));
      await expect(page.locator('.crate-reading__header h1')).toHaveText(title);
      for (let visit = 0; visit < 2; visit++) {
        await page.getByRole('button', { name: /browser.example.invalid browser.example.invalid/ }).click();
        await expect(page.locator('.crate-reading-workspace')).toHaveAttribute('data-reader-open', 'true');
        assert.equal(await page.evaluate(() => window.__readingBackTitle), title, 'The native Back predecessor must contain the selected tab title');
        await page.goBack();
        await page.waitForFunction(() => history.state?.readingLibrary === true);
        await expect(page.locator('.crate-reading__header h1')).toHaveText(title);
      }
    }
    await page.getByRole('button', { name: 'Remove favorite', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Favorite', exact: true })).toBeVisible();
    await expect(readingSync).toHaveAttribute('data-sync-state', 'synced');
    console.log(`${name}: native Back predecessors preserve Favorites and Reading titles across repeated visits`);
    await page.getByRole('button', { name: /browser.example.invalid browser.example.invalid/ }).click();
    await page.getByText('Available offline', { exact: true }).waitFor();
    articleHistoryLength = await page.evaluate(() => history.length);
    await checkReaderNavigation(page);
    const articleTitle = page.locator('.crate-reading-reader__header h1');
    await checkPwaScreenGestures(page, articleTitle);
    await expect(page.locator('.crate-reading-reader__body')).toHaveCSS('-webkit-user-select', 'text');
    await articleTitle.dblclick();
    assert.ok(await page.evaluate(() => document.getSelection().toString().length > 0), 'Article text remains selectable');
    await page.evaluate(() => document.getSelection().removeAllRanges());
    await expect(page.locator('.crate-reading-reader__nav')).toHaveCSS('-webkit-user-select', 'none');
    await expect(page.getByRole('button', { name: 'Reading appearance', exact: true })).toHaveCSS('-webkit-user-select', 'none');
    await page.getByRole('button',{name:'Reading appearance',exact:true}).click();
    const appearance = page.getByRole('dialog',{name:'Reading appearance',exact:true});
    await expect(appearance).toHaveClass(/pwa-modal-sheet__container--settings/);
    await page.getByRole('button',{name:'Increase text size'}).click();
    await expect(page.locator('.crate-reading-reader__body')).toHaveCSS('font-size', '20px');
    await page.keyboard.press('Escape');
    await expect(appearance).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Reading appearance',exact:true})).toBeFocused();
    await page.getByRole('button',{name:'Edit article tags'}).click();
    const tags = page.getByRole('dialog',{name:'Article tags'});
    await expect(tags).toHaveClass(/pwa-modal-sheet__container--settings/);
    await checkPwaTextField(tags.getByRole('textbox'), { sheet: true });
    await tags.getByRole('textbox').fill('essays');
    await tags.getByRole('button',{name:'Save tags',exact:true}).click();
    await expect(tags).toHaveCount(0);
    const closingLength = await page.addStyleTag({ content: '.crate-reading-reader__body { min-height: 3000px; }' });
    await page.evaluate(() => window.scrollTo(0, 700));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(700);
    const closing = captureReaderMotion(page, 'close');
    await page.waitForTimeout(80);
    await page.screenshot({path:`test-results/reading/${name}-closing.png`,fullPage:true});
    assertReaderSlide(await closing, 'close');
    await closingLength.evaluate(element => element.remove());
    await expect(page.locator('.crate-reading-workspace')).toHaveAttribute('data-reader-open','false');
    await expect(page.locator('.crate-reading__reader-pane .crate-reading-reader')).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveClass(/pwa-document-reader/);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    await assertArticleStaysDismissed(page, articleHistoryLength);
    await checkBackGesture(page, '.crate-reading__library');
    await page.emulateMedia({reducedMotion:'reduce'});
    await expect.poll(() => page.locator('.crate-reading__reader-pane').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
    await page.emulateMedia({reducedMotion:'no-preference'});
    const cachedArticleStarted = Promise.withResolvers(), cachedArticleReleased = Promise.withResolvers();
    heldResponses.push(cachedArticleReleased.resolve);
    holdArticle = { started: cachedArticleStarted.resolve, release: cachedArticleReleased.promise };
    await page.getByRole('button',{name:/browser.example.invalid browser.example.invalid/}).click();
    await cachedArticleStarted.promise;
    await expect(page.getByRole('heading',{name:'browser.example.invalid',exact:true})).toBeVisible();
    await expect(page.getByText('Available offline',{exact:true})).toBeVisible();
    cachedArticleReleased.resolve();
    await expect.poll(() => page.locator('.crate-reading__reader-pane').evaluate(element => element.getAnimations().length)).toBe(0);
    // Browser Back (including native history gestures) must not start an app exit.
    const nativeBack = await captureReaderMotion(page, 'history-back');
    assertSteadyReadingTab(nativeBack);
    assert.equal(nativeBack.before.dockInert, true);
    assert.ok(nativeBack.samples.every(sample => !sample.dockInert), 'History Back must restore dock interaction immediately');
    assert.equal(nativeBack.slides, 0, JSON.stringify(nativeBack));
    assert.equal(nativeBack.pops, 1); assert.equal(nativeBack.motion, 'none');
    for (const sample of nativeBack.samples) {
      assert.equal(sample.visible, false); assert.equal(sample.article, false);
      assert.equal(sample.list, 0); assert.equal(sample.bar, 0);
    }
    await assertArticleStaysDismissed(page, articleHistoryLength);
    // Reopening is an explicit action and reuses the closed detail slot.
    await page.getByRole('button',{name:/browser.example.invalid browser.example.invalid/}).click();
    await page.getByText('Available offline',{exact:true}).waitFor();
    await expect.poll(() => page.locator('.crate-reading__reader-pane').evaluate(element => element.getAnimations().length)).toBe(0);
    await expect(page.locator('.crate-reading__library')).toHaveAttribute('inert', '');
    await page.setViewportSize({width:1280,height:844});
    await expect(page.locator('.crate-reading__library')).toHaveAttribute('inert', '');
    await expect(page.locator('html')).toHaveClass(/pwa-document-reader/);
    await expect(page.locator('.crate-reading__brand')).toBeHidden();
    await expect.poll(() => page.locator('.crate-reading__reader-pane').evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(1280);
    assertReaderSlide(await captureReaderMotion(page, 'close'), 'close');
    await assertArticleStaysDismissed(page, articleHistoryLength);
    for (const width of [1280, 900, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.locator('.crate-reading__brand')).toBeHidden();
      await expect(page.locator('.crate-reading__reader-pane')).toBeHidden();
      await expect(page.locator('.pwa-dock.crate-reading__mobile-nav')).toBeVisible();
      await expect(page.getByRole('searchbox', { name: 'Search reading' })).toBeVisible();
      await expect.poll(() => page.locator('.crate-reading__library').evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(width);
    }
    await page.getByRole('button',{name:/browser.example.invalid browser.example.invalid/}).click();
    await page.getByText('Available offline',{exact:true}).waitFor();
    await expect.poll(() => page.locator('.crate-reading__reader-pane').evaluate(element => element.getAnimations().length)).toBe(0);
    await page.setViewportSize({width:390,height:844});
    await expect(page.locator('.crate-reading__library')).toHaveAttribute('inert', '');
    // A reopened article still supports one toolbar exit with retained content.
    assertReaderSlide(await captureReaderMotion(page, 'close'), 'close');
    await assertArticleStaysDismissed(page, articleHistoryLength);
    // Repeated open/back cycles must not grow the history stack.
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.getByRole('button',{name:/browser.example.invalid browser.example.invalid/}).click();
      await expect(page.locator('.crate-reading-workspace')).toHaveAttribute('data-reader-open','true');
      await page.goBack();
      await assertArticleStaysDismissed(page, articleHistoryLength);
    }
    // A slow article response must not reopen a reader dismissed during loading.
    const started = Promise.withResolvers(), released = Promise.withResolvers();
    heldResponses.push(released.resolve);
    holdArticle = { started: started.resolve, release: released.promise };
    await page.getByRole('button',{name:/browser.example.invalid browser.example.invalid/}).click();
    await started.promise; await page.goBack();
    const responseReceived = page.waitForResponse(response => response.url().includes('/reading/item?'));
    released.resolve(); await responseReceived;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole('searchbox',{name:'Search reading'})).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.has('item'), false);
    await assertArticleStaysDismissed(page, articleHistoryLength);
    // Direct links and reloads still open an article; closing them removes Forward too.
    await page.waitForLoadState('networkidle');
    await page.goto(articleUrl);
    await page.getByText('Available offline',{exact:true}).waitFor();
    await expect(page.locator('.crate-reading-workspace')).toHaveAttribute('data-reader-motion','none');
    await page.waitForLoadState('networkidle');
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
    await page.getByRole('button',{name:/browser.example.invalid browser.example.invalid/}).waitFor();
    await page.getByRole('button',{name:/browser.example.invalid browser.example.invalid/}).click();
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
    await page.getByRole('button',{name:/browser.example.invalid browser.example.invalid/}).click();
    await page.getByText('Available offline',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Archive article',exact:true}).click();
    await archiveStarted.promise;
    await expect(page.getByRole('button',{name:'Move to inbox',exact:true})).toBeVisible();
    await assertNoPendingBanner(page);
    await page.getByRole('button',{name:'Back to reading',exact:true}).click();
    await expect(page.locator('.crate-reading__reader-pane article')).toHaveCount(0);
    await expect(page.getByRole('button',{name:/browser.example.invalid browser.example.invalid/})).toHaveCount(0);
    await assertNoPendingBanner(page);
    await page.locator('.crate-feature-panel[data-active="true"] [data-dock-switcher]').press('ArrowDown');
    await page.getByRole('dialog', { name: 'More views' }).getByRole('button',{name:'Archive',exact:true}).click();
    await page.getByRole('button',{name:/browser.example.invalid browser.example.invalid/}).waitFor();
    archiveReleased.resolve();
    await expect(readingSync).toHaveAttribute('data-sync-state','synced');
    await page.getByRole('button',{name:/browser.example.invalid browser.example.invalid/}).click();
    await page.getByRole('button',{name:'Move to inbox',exact:true}).click();
    await page.getByRole('button',{name:'Back to reading',exact:true}).click();
    await expect(page.locator('.crate-reading__reader-pane article')).toHaveCount(0);
    await page.locator('.crate-feature-panel[data-active="true"] [data-dock-switcher]').press('ArrowDown');
    await page.getByRole('dialog', { name: 'More views' }).getByRole('button',{name:'Reading',exact:true}).click();
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
    await page.getByRole('button',{name:/browser.example.invalid browser.example.invalid/}).click();
    await expect(page.getByRole('heading',{name:'browser.example.invalid',exact:true})).toBeVisible();
    await expect(page.getByText('Available offline',{exact:true})).toBeVisible();
    await assertNoPendingBanner(page);
    await page.getByRole('button',{name:'Back to reading',exact:true}).click();
    await page.getByRole('button',{name:'Save a link',exact:true}).click();
    await page.getByLabel('Link',{exact:true}).fill('https://pending.example.invalid/while-pending');
    await page.getByRole('button',{name:'Save link',exact:true}).click();
    await expect(readingSync.getByRole('button')).toHaveAccessibleName('Sync status: Syncing 2 changes');
    await assertNoPendingBanner(page);
    updateReleased.resolve();
    await assertNoPendingBanner(page);
    await expect(readingSync).toHaveAttribute('data-sync-state','synced');
    await page.getByRole('button',{name:/pending.example.invalid pending.example.invalid/}).waitFor();
    // A committed save with a lost response must resend exactly the persisted operation.
    sent.length = 0; loseCaptureReply = true;
    await page.getByRole('button',{name:'Save a link',exact:true}).click();
    await page.getByLabel('Link',{exact:true}).fill('https://example.invalid/lost-reply');
    await page.getByRole('button',{name:'Save link',exact:true}).click();
    await expect.poll(() => page.evaluate(async () => { const db = await new Promise((resolve,reject) => { const r=indexedDB.open('crate-reading-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=reject; }); const id=JSON.parse(localStorage.getItem('crate-reading-session-v1')).id;return new Promise(resolve=>{const r=db.transaction('values').objectStore('values').get(`pending:${id}`);r.onsuccess=()=>{db.close();resolve(r.result?.some(op=>op.action==='capture' && op.error));};}); })).toBeTruthy();
    await expect(readingSync).toHaveAttribute('data-sync-state','error');
    await expect(page.locator('.pwa-reading-root .toast.is-error')).toHaveCount(0);
    await assertNoPendingBanner(page);
    await expect(readingSync).toHaveAttribute('data-sync-state','synced', { timeout: 10000 });
    await expect.poll(() => page.evaluate(async () => { const db = await new Promise((resolve,reject) => { const r=indexedDB.open('crate-reading-v1',1); r.onsuccess=()=>resolve(r.result);r.onerror=reject; }); const id=JSON.parse(localStorage.getItem('crate-reading-session-v1')).id; return new Promise(resolve=>{ const r=db.transaction('values').objectStore('values').get(`pending:${id}`);r.onsuccess=()=>{db.close();resolve(r.result.length===0);}; }); })).toBe(true);
    assert.ok(sent.length >= 2, JSON.stringify({ sent, text: await page.locator('body').innerText() })); assert.equal(sent[0],sent[1]);
    if (name === 'chromium') {
      await page.goto(`${origin}/notifications/test-share`); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      await context.setOffline(true);
      await page.evaluate(() => { const form=document.createElement('form');form.method='POST';form.action='/notifications/share/reading';for (const [name,value] of Object.entries({url:'https://android.example.invalid/android',title:'Android share'})){const input=document.createElement('input');input.name=name;input.value=value;form.append(input);}document.body.append(form);form.submit(); });
      await page.waitForURL(/share=/);
      await page.getByLabel('Link',{exact:true}).waitFor(); assert.equal(await page.getByLabel('Link',{exact:true}).inputValue(),'https://android.example.invalid/android');
      await page.getByRole('button',{name:'Save link',exact:true}).click();
      await expect(readingSync.getByRole('button')).toHaveAccessibleName('Sync status: Offline: 1 change waiting to sync');
      await assertNoPendingBanner(page);
      await context.setOffline(false);
      await refreshReadingFromSettings(page);
      await page.getByRole('button',{name:/android.example.invalid android.example.invalid/}).waitFor();
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
    await page.getByRole('button',{name:'Open settings'}).click();
    await page.getByRole('button',{name:'Log out',exact:true}).click();
    const readingToken = await page.evaluate(() => JSON.parse(localStorage.getItem('crate-reading-session-v1')).token);
    await page.getByRole('button',{name:'Log out and clear device data'}).click();
    await page.getByRole('heading',{name:'Your reading, everywhere'}).waitFor();
    assert.equal(await page.evaluate(()=>localStorage.getItem('crate-reading-session-v1')),null);
    await expect.poll(async () => (await runtime.mf.dispatchFetch(`${origin}/reading/session`, { headers: { Authorization: `Bearer ${readingToken}` } })).status).toBe(401);
    // An enrolled Reminders PWA opens Reading even when article fetching is off.
    await runtime.db.prepare('UPDATE reading_policy SET enabled=0').run();
    const remindersEnrollment = await api('/notifications/reminders-enrollment-token', { folderPath: 'Reminders' });
    const remindersLoaded = page.waitForResponse(response => new URL(response.url()).pathname === '/reminders/list');
    await page.goto(`${origin}/notifications?browserToken=${remindersEnrollment.browserToken}`);
    await page.waitForFunction(() => !!localStorage.getItem('crate-reminders-auth-token'));
    // Token persistence precedes bootstrap. This transition tests Reading access,
    // not cancellation of the new document's initial Reminders request.
    await (await remindersLoaded).finished();
    await page.waitForLoadState('networkidle');
    await page.goto(`${origin}/notifications?section=reading`);
    await page.getByRole('searchbox', { name: 'Search reading' }).waitFor();
    await runtime.db.prepare('UPDATE reading_policy SET enabled=1').run();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByRole('searchbox',{name:'Search reading'}).waitFor();
    const linked = await page.evaluate(() => ({ reading: JSON.parse(localStorage.getItem('crate-reading-session-v1')), reminders: localStorage.getItem('crate-reminders-auth-token') }));
    assert.equal(linked.reading.source, 'reminders'); assert.equal(linked.reading.token, linked.reminders);
    await switchFeature(page, 'Reminders');
    await page.getByRole('button',{name:'Open settings',exact:true}).click();
    const reminderSheetAppearance = await sheetAppearance(page);
    await page.getByRole('button',{name:'Close settings',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await switchFeature(page, 'Reading');
    await page.getByRole('searchbox',{name:'Search reading'}).waitFor();
    await page.getByRole('button',{name:'Open settings'}).click();
    assert.deepEqual(await sheetAppearance(page), reminderSheetAppearance, 'Both modes must share sheet and control styling');
    await page.getByRole('button',{name:'Log out',exact:true}).click();
    await page.getByRole('button',{name:'Log out and clear device data'}).click();
    await page.getByRole('heading',{name:'Your reading, everywhere'}).waitFor();
    assert.equal(await page.evaluate(()=>localStorage.getItem('crate-reminders-auth-token')), null);
    assert.equal(await page.evaluate(()=>localStorage.getItem('crate-reading-session-v1')), null);
    // Private views clear immediately; remote revocation completes independently.
    await expect.poll(async () => (await runtime.mf.dispatchFetch(`${origin}/reading/session`, { headers: { Authorization: `Bearer ${linked.reminders}` } })).status).toBe(401);
    assert.deepEqual(errors,[]);
  } catch (error) { console.error('Reading failure assertion:', error); await mkdir('test-results/reading',{recursive:true}); for (const context of browser?.contexts() ?? []) for (const page of context.pages()) { console.log('Reading failure page:',page.url(),(await page.locator('body').innerText().catch(()=>''))); await page.screenshot({path:`test-results/reading/${name}-failure.png`}).catch(()=>{}); } throw error; } finally { heldResponses.forEach(release => release()); await browser?.close(); if(server) await new Promise(resolve=>server.close(resolve)); await runtime?.close(); await rm(dir,{recursive:true,force:true}); }
});

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) test(`Reading ${name}: single-screen layout at every width`, { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-reading-layout-'));
  let runtime, browser, server;
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Layout test');
    server = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const response = await runtime.mf.dispatchFetch(`${origin}${req.url}`, {
          method: req.method, headers: req.headers,
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
        });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://localhost:${server.address().port}`;
    const api = async (path, body) => {
      const response = await runtime.mf.dispatchFetch(`${origin}${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${vault.token}`, 'X-Crate-Protocol': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    await api('/reading/policy', { enabled: true, folderPath: 'Reading', revision: null });
    const enrollment = await api('/reading/access', { kind: 'reading' });
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 844 } });
    await page.goto(enrollment.url);
    await expect(page.getByRole('heading', { name: 'Save something worth your time' })).toBeVisible();
    for (const width of [1280, 900, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.locator('.crate-reading__brand')).toBeHidden();
      await expect(page.locator('.crate-reading__reader-pane')).toBeHidden();
      await expect(page.locator('.pwa-dock.crate-reading__mobile-nav')).toBeVisible();
      await expect.poll(() => page.locator('.crate-reading__library').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(width);
    }
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.getByRole('button', { name: 'Save your first link' }).click();
    await page.getByRole('textbox', { name: 'Link', exact: true }).fill('https://layout.example.invalid/article');
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
    const article = page.locator('.crate-reading__open').first();
    await expect(article).toBeVisible();
    await expect(article).not.toHaveAttribute('aria-disabled', 'true');
    await article.click();
    await expect(page.locator('.crate-reading-workspace')).toHaveAttribute('data-reader-open', 'true');
    await expect(page.locator('.crate-reading__library')).toHaveAttribute('inert', '');
    await expect(page.locator('html')).toHaveClass(/pwa-document-reader/);
    await expect.poll(() => page.locator('.crate-reading__reader-pane').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(1280);
    await page.getByRole('button', { name: 'Back to reading' }).click();
    await expect(page.locator('.crate-reading__reader-pane')).toBeHidden();
    await expect(article).toBeVisible();
    await expect(page.locator('.pwa-dock.crate-reading__mobile-nav')).toBeVisible();
    await mkdir('test-results/reading', { recursive: true });
    await page.screenshot({ path: `test-results/reading/${name}-desktop-single-screen.png` });
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) test(`Reading ${name}: open reader follows extraction transitions`, { timeout: 60000 }, async () => {
  const { buildPwaPreviewAssets } = await import('./pwa-preview-assets.mjs');
  const { listenPwaPreviewServer } = await import('./pwa-preview-server.mjs');
  const { server } = await listenPwaPreviewServer({ port: 0, assets: await buildPwaPreviewAssets() });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    let status = 'pending';
    const item = () => ({ crate_reading_version: 1, crate_reading_id: '67de6c50-c70c-4c85-93f2-a048d9f33b1a', title: 'Extraction fixture',
      source_url: 'https://example.com/article', saved_at: '2026-09-21T10:00:00.000Z', reading_status: 'inbox', favorite: false,
      tags: [], extraction_status: status, capture_method: 'url', path: 'Reading/Article.md' });
    await page.route('**/reading/session', route => route.fulfill({ json: { id: 'extraction-test', folderPath: 'Reading', generation: 'generation', expiresAt: Date.now() + 86400000 } }));
    await page.route('**/reading/list*', route => route.fulfill({ json: { items: [item()], issues: [], cursor: null } }));
    await page.route('**/reading/item?*', route => route.fulfill({ json: { item: item(), markdown: status === 'ready' ? 'The extracted article is now available.' : '' } }));
    await page.goto(`${origin}/notifications?section=reading`);
    await page.getByRole('button', { name: /Extraction fixture/ }).click();
    await expect(page.getByText('Your link is saved. Article text is on its way.', { exact: true })).toBeVisible();
    status = 'ready';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('.crate-reading-reader__body')).toContainText('The extracted article is now available.');
    await expect(page.getByText('Your link is saved. Article text is on its way.', { exact: true })).toHaveCount(0);
    // A retry may go back to pending without changing the highlights array.
    status = 'pending';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByText('Your link is saved. Article text is on its way.', { exact: true })).toBeVisible();
    status = 'unavailable';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
