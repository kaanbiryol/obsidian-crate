import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { swipe } from './browser-touch-swipe.mjs';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) test(`Reading highlights ${name}: select, remove, persist offline and sync`, { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-highlights-'));
  let runtime, server, browser, page;
  const codeExample = 'let greeting = "hello <world> & friends"\nText(greeting)\n';
  let articleMarkdown = 'A useful **article excerpt**.\n\nAnother paragraph to read.\n\n```swift\n' + codeExample + '```\n\n```unknown-language\nunchanged <example>\n```';
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Highlight test');
    server = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await runtime.mf.dispatchFetch(`${origin}${req.url}`, { method: req.method, headers: req.headers,
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://localhost:${server.address().port}`;
    const api = async (path, body) => {
      const response = await runtime.mf.dispatchFetch(`${origin}${path}`, { method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${vault.token}`, 'X-Crate-Protocol': '1', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    await api('/reading/policy', { enabled: true, folderPath: 'Reading', revision: null });
    const operationId = `e1_${String(Math.floor(Date.now() / 86400000)).padStart(8, '0')}_${randomUUID()}`;
    const saved = await api('/reading/capture', { url: 'https://example.invalid/article', title: 'Highlight article', fetchArticle: false, operationId });
    // Seed actual vault Markdown so the browser and mutation writer use the same bytes.
    const download = () => runtime.mf.dispatchFetch(`${origin}/sync/download?path=${encodeURIComponent(`Reading/Highlight article - ${saved.id.slice(0, 8)}.md`)}`, { headers: { Authorization: `Bearer ${vault.token}` } });
    const replaceArticle = async markdown => {
      const current = await download(), source = await current.text();
      const content = source.slice(0, source.indexOf('\n---\n') + 5).replace(/extraction_status: .*/, 'extraction_status: "ready"')
        + `\n<!-- crate:article:start -->\n${markdown}\n<!-- crate:article:end -->\n`;
      const response = await runtime.mf.dispatchFetch(`${origin}/sync/upload?path=${encodeURIComponent(`Reading/Highlight article - ${saved.id.slice(0, 8)}.md`)}`, { method: 'PUT', headers: {
        Authorization: `Bearer ${vault.token}`, 'X-Crate-Protocol': '1', 'Content-Type': 'text/markdown',
        'X-File-Hash': createHash('sha256').update(content).digest('hex'), 'X-File-Size': String(Buffer.byteLength(content)),
        'X-Crate-Expected-Hash': current.headers.get('X-File-Hash'),
        'X-Crate-Upload-Operation': `e1_${String(Math.floor(Date.now() / 86400000)).padStart(8, '0')}_${randomUUID()}`,
      }, body: content });
      assert.equal(response.status, 200, await response.text());
    };
    await replaceArticle(articleMarkdown);
    const enrollment = await api('/reading/access', { kind: 'reading' });
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page = await context.newPage();
    await page.goto(enrollment.url);
    const open = async () => {
      await page.getByRole('button', { name: /example.invalid Highlight article/ }).click();
      await expect(page.locator('.crate-reading-workspace')).toHaveAttribute('data-reader-open', 'true');
      await expect(page).toHaveURL(new RegExp(`item=${saved.id}`));
      await expect(page.locator('.crate-reading-reader__body')).toContainText('A useful article excerpt.');
      await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
    };
    await open();
    const code = page.locator('.crate-reading-reader__body pre code').first();
    await expect(code.locator('.hljs-keyword')).toHaveText('let');
    assert.equal(await code.textContent(), codeExample);
    await expect(page.locator('.crate-reading-reader__body pre code').nth(1)).toHaveText('unchanged <example>');
    await expect(page.locator('.crate-reading-reader__body pre code').nth(1).locator('span')).toHaveCount(0);
    const colors = [];
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator('html')).toHaveAttribute('data-pwa-color-scheme', colorScheme);
      const keyword = code.locator('.hljs-keyword');
      colors.push(await keyword.evaluate(node => getComputedStyle(node).color));
      assert.notEqual(colors.at(-1), await code.evaluate(node => getComputedStyle(node).color));
      await mkdir('test-results/reading', { recursive: true });
      await code.screenshot({ path: `test-results/reading/${name}-code-${colorScheme}.png` });
    }
    assert.notEqual(colors[0], colors[1]);
    assert.equal(await code.evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      return range.toString();
    }), codeExample, 'Selection across syntax tokens preserves the original code');
    await page.evaluate(() => window.scrollTo(0, 0));
    const textPoint = async offset => page.locator('.crate-reading-reader__body').evaluate((body, offset) => {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let node, count = 0;
      while ((node = walker.nextNode())) {
        if (count + node.length >= offset && node.length && (count + node.length > offset || node.textContent.trim())) {
          const local = offset - count, range = document.createRange();
          range.setStart(node, Math.min(local, node.length - 1)); range.setEnd(node, Math.min(local + 1, node.length));
          const rect = range.getBoundingClientRect();
          return { x: local === node.length ? rect.right : rect.left, y: (rect.top + rect.bottom) / 2 };
        }
        count += node.length;
      }
      throw new Error('Missing text offset');
    }, offset);
    const firstPassageOffset = (await page.locator('.crate-reading-reader__body').textContent()).indexOf('A useful article excerpt.');
    const select = async (offset = firstPassageOffset, length = 25) => {
      const existing = await page.locator('.crate-reading-reader__highlight').count();
      const start = await textPoint(offset), end = await textPoint(offset + length);
      await page.mouse.move(start.x + .2, start.y); await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      assert.equal(await page.locator('.crate-reading-reader__highlight').count(), existing, 'Selection is not saved while the pointer is held');
      await page.mouse.up();
      await expect(page.getByRole('button', { name: 'Copy text', exact: true })).toBeVisible();
    };
    const dragHandle = async (edge, offset) => {
      const handle = page.getByRole('button', { name: `Adjust highlight ${edge}`, exact: true });
      const box = await handle.boundingBox(), target = await textPoint(offset);
      if (name === 'chromium') {
        const input = await context.newCDPSession(page);
        const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        try {
          await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
          for (let step = 1; step <= 8; step++) await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (target.x - start.x) * step / 8, y: start.y + (target.y - start.y) * step / 8 }] });
          await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } finally { await input.detach(); }
      } else {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
        await page.mouse.move(target.x, target.y, { steps: 8 }); await page.mouse.up();
      }
      await expect(handle).toBeEnabled();
    };
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await expect(page.locator('.crate-reading__reader-pane')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    const initialBody = await page.locator('.crate-reading-reader__body').boundingBox();
    await select();
    await expect.poll(() => page.evaluate(() => getSelection().toString())).toBe('');
    const marks = page.locator('.crate-reading-reader__highlight');
    await expect.poll(() => marks.allTextContents()).toEqual(['A useful ', 'article excerpt', '.']);
    const checkActionPlacement = async () => {
      const action = await page.getByRole('group', { name: 'Highlight actions' }).boundingBox();
      assert.ok(action.x >= 12 && action.x + action.width <= 378, 'Action menu stays inside the phone viewport');
      assert.ok(action.y >= 0 && action.y + action.height <= 844, 'Action menu stays visible');
      for (const target of await page.locator('.crate-reading-reader__header, .crate-reading-reader__highlight-preview, .crate-reading-reader__highlight-handle').all()) {
        const box = await target.boundingBox();
        assert.ok(action.x + action.width <= box.x || action.x >= box.x + box.width
          || action.y + action.height <= box.y || action.y >= box.y + box.height,
        'Action menu must clear the article header, highlighted text and resize handles');
      }
    };
    await checkActionPlacement();
    assert.deepEqual(await page.locator('.crate-reading-reader__body').boundingBox(), initialBody, 'Selection actions must not move the passage');
    await expect(page.getByRole('button', { name: 'Highlight', exact: true })).toHaveCount(0);
    const copy = page.getByRole('button', { name: 'Copy text', exact: true });
    const share = page.getByRole('button', { name: 'Share text', exact: true });
    const actions = page.getByRole('group', { name: 'Highlight actions' });
    if (name === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await copy.click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'A useful article excerpt.');
      await expect(page.locator('.toast[role="status"]')).toHaveText('Copied');
      await expect(actions).toHaveCount(0);
      await marks.nth(1).tap();
    }
    // Browser stubs cover platform failures without opening external share targets.
    await page.evaluate(() => {
      window.clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      window.shareDescriptor = Object.getOwnPropertyDescriptor(navigator, 'share');
      window.copiedExcerpt = null;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async text => { window.copiedExcerpt = text; if (window.rejectCopy) throw new Error('Permission denied'); },
      } });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async data => {
        window.sharedExcerpt = data;
        window.shareActivated = navigator.userActivation.isActive;
        if (window.rejectShare) throw new DOMException('Share failed', window.rejectShare);
        if (window.delayShare) await new Promise(resolve => { window.finishShare = resolve; });
      } });
    });
    await page.evaluate(() => { window.rejectCopy = true; });
    await copy.click();
    await expect(page.getByRole('alert')).toHaveText('Could not copy text. Try again.');
    await page.evaluate(() => { window.rejectCopy = false; });
    await copy.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.toast[role="status"]')).toHaveText('Copied');
    await expect(actions).toHaveCount(0);
    await marks.nth(1).tap();
    assert.equal(await page.evaluate(() => window.copiedExcerpt), 'A useful article excerpt.');
    await share.click();
    assert.deepEqual(await page.evaluate(() => window.sharedExcerpt), { text: 'A useful article excerpt.' });
    assert.equal(await page.evaluate(() => window.shareActivated), true, 'Native share is invoked inside the user gesture');
    await page.evaluate(() => { window.rejectShare = 'AbortError'; });
    await share.click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(share).toBeEnabled();
    await page.evaluate(() => { window.rejectShare = 'NotAllowedError'; });
    await share.click();
    await expect(page.getByRole('alert')).toHaveText('Could not share text. Try Copy instead.');
    await page.evaluate(() => { window.rejectShare = null; window.delayShare = true; });
    await share.click();
    await expect(share).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Delete highlight', exact: true })).toBeEnabled();
    const scrollSpace = await page.addStyleTag({ content: '.crate-reading-reader__body { padding-bottom: 1000px; }' });
    await page.evaluate(() => window.scrollTo(0, 60));
    await expect(actions).toHaveCount(0);
    await expect(marks).toHaveCount(3);
    await page.evaluate(() => { window.finishShare(); });
    await expect(actions).toHaveCount(0);
    await scrollSpace.evaluate(element => element.remove());
    await page.evaluate(() => window.scrollTo(0, 0));
    await marks.nth(1).tap();
    await expect(copy).toBeEnabled();
    await page.evaluate(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); });
    await share.click();
    await expect(page.getByRole('status').filter({ hasText: 'Sharing unavailable. Text copied.' })).toBeVisible();
    await page.evaluate(() => {
      if (window.clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', window.clipboardDescriptor); else delete navigator.clipboard;
      if (window.shareDescriptor) Object.defineProperty(navigator, 'share', window.shareDescriptor); else delete navigator.share;
    });
    await page.locator('.crate-reading-reader__header h1').tap();
    await expect(actions).toHaveCount(0);
    await marks.nth(1).tap();
    await expect(page.getByRole('button', { name: 'Adjust highlight start' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Adjust highlight end' })).toBeVisible();
    await dragHandle('start', firstPassageOffset + 2);
    await expect.poll(async () => (await marks.allTextContents()).join('')).toBe('useful article excerpt.');
    await dragHandle('start', firstPassageOffset);
    await expect.poll(async () => (await marks.allTextContents()).join('')).toBe('A useful article excerpt.');
    const fullText = await page.locator('.crate-reading-reader__body').textContent();
    const extendedEnd = fullText.indexOf('paragraph') + 'paragraph'.length;
    await dragHandle('end', extendedEnd);
    await expect.poll(async () => (await marks.allTextContents()).join('')).toBe(fullText.slice(firstPassageOffset, extendedEnd));
    await checkActionPlacement();
    await dragHandle('end', firstPassageOffset + 25);
    await expect.poll(() => marks.allTextContents()).toEqual(['A useful ', 'article excerpt', '.']);
    // A canceled handle drag must not persist its preview.
    const handle = page.getByRole('button', { name: 'Adjust highlight start' }), box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    const shorter = await textPoint(firstPassageOffset + 9); await page.mouse.move(shorter.x, shorter.y, { steps: 5 });
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect.poll(() => marks.allTextContents()).toEqual(['A useful ', 'article excerpt', '.']);
    await expect(page.getByRole('group', { name: 'Highlight actions' })).toHaveCount(0);
    await marks.first().focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Delete highlight', exact: true })).toBeVisible();
    await page.locator('.crate-reading-reader__header h1').tap();
    await expect(page.getByRole('group', { name: 'Highlight actions' })).toHaveCount(0);
    await marks.nth(1).tap();
    await mkdir('test-results/reading', { recursive: true });
    await page.screenshot({ path: `test-results/reading/${name}-highlights.png` });
    await page.getByRole('button', { name: 'Delete highlight', exact: true }).tap();
    await expect(marks).toHaveCount(0);
    await select();
    await expect(marks).toHaveCount(3);
    // Hold the history traversal after the close animation. The revealed library
    // must not accept an article tap that the delayed popstate would then close.
    await page.evaluate(() => {
      const back = history.back.bind(history);
      history.back = () => { window.__finishReadingBack = () => { history.back = back; back(); }; };
    });
    await page.getByRole('button', { name: 'Back to reading', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__finishReadingBack));
    await expect(page.locator('.crate-reading__library')).toHaveAttribute('inert');
    await page.evaluate(() => window.__finishReadingBack());
    await expect(page.locator('.crate-reading__library')).not.toHaveAttribute('inert');
    await open();
    await expect(marks).toHaveCount(3);
    if (name === 'chromium') { await page.reload(); await expect(marks).toHaveCount(3); }
    await expect(code.locator('.hljs-keyword')).toHaveText('let');
    assert.equal(await code.textContent(), codeExample, 'Code survives offline reopening and highlight repainting');
    const excerpt = 'A useful article excerpt.';
    await context.setOffline(false);
    await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights?.[0]?.text).toBe(excerpt);
    const committed = await (await download()).text();
    assert.ok(committed.includes('==A useful== **==article excerpt==**==.=='), committed);
    assert.equal(committed.slice(committed.indexOf('\n---\n') + 5).replaceAll('==', ''),
      `\n<!-- crate:article:start -->\n${articleMarkdown}\n<!-- crate:article:end -->\n`, 'Highlighting preserves the saved article wrapper and source');
    await page.reload();
    await expect(page.locator('.crate-reading-reader__highlight')).toHaveCount(3);
    const longArticle = await page.addStyleTag({ content: '.crate-reading-reader__body { padding-top: 1400px; min-height: 12000px; }' });
    await page.evaluate(() => window.scrollTo({ top: 6300, behavior: 'instant' }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(6300);
    await expect(page.locator('.crate-reading-reader__floating')).toHaveCSS('opacity', '0');
    await page.evaluate(() => window.scrollTo({ top: 6000, behavior: 'instant' }));
    await expect(page.locator('.crate-reading-reader__floating')).toHaveCSS('opacity', '1');
    const backgroundBeforeSheet = await page.locator('.crate-reading-reader__body').boundingBox();
    const deepButton = await page.getByRole('button', { name: 'Highlights (1)', exact: true }).boundingBox();
    await page.touchscreen.tap(deepButton.x + deepButton.width / 2, deepButton.y + deepButton.height / 2);

    await expect(page.locator('.crate-reading-highlights__card blockquote')).toHaveText(excerpt);
    const highlightsPage = page.getByRole('dialog', { name: 'Highlights', exact: true });
    await expect.poll(async () => Math.round((await highlightsPage.boundingBox()).height)).toBe(834);
    await expect.poll(async () => Math.round((await highlightsPage.boundingBox()).y)).toBe(10);
    await expect(highlightsPage).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('top', '0px');
    await expect(page.locator('#app')).toHaveCSS('top', '-6000px');
    assert.deepEqual(await page.locator('.crate-reading-reader__body').boundingBox(), backgroundBeforeSheet, 'The article remains behind Highlights without moving');
    assert.equal(await highlightsPage.evaluate(element => element.closest('.pwa-sheet-portal')?.parentElement === document.body), true);
    const articleUrl = page.url();
    await page.getByRole('button', { name: 'Close highlights', exact: true }).click();
    await expect(highlightsPage).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(6000);
    assert.equal(page.url(), articleUrl, 'Dismissing Highlights stays in the article');
    await expect(page.locator('.pwa-sheet-portal')).toHaveCount(0);
    assert.equal(await page.locator('#app').evaluate(element => element.style.top), '', 'Dismissal restores the app layout');
    await page.getByRole('button', { name: 'Highlights (1)', exact: true }).evaluate(element => element.click());
    await expect.poll(async () => Math.round((await highlightsPage.boundingBox()).y)).toBe(10);
    await swipe(page, highlightsPage.getByRole('heading', { name: 'Highlights', exact: true }));
    await expect(highlightsPage).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(6000);
    assert.equal(page.url(), articleUrl, 'Swiping Highlights down stays in the article');
    await page.getByRole('button', { name: 'Highlights (1)', exact: true }).evaluate(element => element.click());
    await expect.poll(async () => Math.round((await highlightsPage.boundingBox()).y)).toBe(10);


    await page.evaluate(() => {
      window.highlightScrollSamples = [];
      window.sampleHighlightScroll = () => window.highlightScrollSamples.push(window.scrollY);
      window.addEventListener('scroll', window.sampleHighlightScroll);
    });
    await page.screenshot({ path: `test-results/reading/${name}-article-highlights.png` });
    await page.getByRole('button', { name: 'View in article', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Highlights', exact: true })).toHaveCount(0);
    await expect(marks.first()).toBeFocused();
    await expect.poll(() => marks.first().evaluate(element => {
      const rect = element.getBoundingClientRect();
      return Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2);
    })).toBeLessThan(3);
    const samples = await page.evaluate(() => {
      window.removeEventListener('scroll', window.sampleHighlightScroll);
      return window.highlightScrollSamples;
    });
    assert.ok(new Set(samples.filter(value => value > 0)).size > 3, `Passage scrolling animates through intermediate positions: ${samples}`);
    await longArticle.evaluate(element => element.remove());
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.getByRole('button', { name: 'Highlights (1)', exact: true }).click();
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    await page.getByLabel('Your note', { exact: true }).fill('A thought worth keeping');
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights?.[0]?.note).toBe('A thought worth keeping');
    await page.getByRole('button', { name: 'Back to reading', exact: true }).click();
    // Wait for the reader exit and native history traversal before opening another entry.
    await expect.poll(() => new URL(page.url()).searchParams.get('item')).toBeNull();
    await expect(page.locator('.crate-reading-reader')).toHaveCount(0);
    const dock = page.locator('.crate-feature-panel[data-active="true"] [data-dock-group]');
    await dock.click({ button: 'right' });
    await page.getByRole('button', { name: 'Highlights', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Highlights', exact: true })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search reading' }).fill('worth keeping');
    await expect(page.locator('.crate-reading-highlights__card')).toHaveCount(1);
    await page.screenshot({ path: `test-results/reading/${name}-highlights-library.png` });
    await page.getByRole('button', { name: 'View in article', exact: true }).click();
    await expect(marks.first()).toBeFocused();

    await marks.nth(1).tap();
    await page.getByRole('button', { name: 'Delete highlight', exact: true }).tap();
    await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights).toEqual([]);
    // Keep the article deeply scrolled through creation, resize, confirmation and deletion.
    const filler = Array.from({ length: 35 }, (_, i) => `Paragraph ${i}. A longer article gives this regression a real scroll position.\n\n`).join('');
    articleMarkdown = `${filler}A useful **article excerpt**.\n\n${filler}`;
    await replaceArticle(articleMarkdown);
    await page.reload();
    const passage = page.locator('.crate-reading-reader__body p').filter({ hasText: 'A useful article excerpt.' });
    await expect(page.locator('.crate-reading-reader__body p')).toHaveCount(71);
    await expect(passage).toBeVisible();
    await passage.evaluate(element => element.scrollIntoView({ block: 'center' }));
    const reader = page.locator('.crate-reading-reader');
    await expect(reader).toHaveAttribute('data-document-scroll', 'true');
    const position = await page.evaluate(() => window.scrollY);
    assert.ok(position > 1000, 'Regression must start well down the article');
    const passageTop = (await passage.boundingBox()).y;
    const paragraphNode = await passage.elementHandle();
    const stable = async () => {
      assert.equal(await paragraphNode.evaluate(node => node.isConnected), true, 'Highlight updates must retain the existing article paragraphs');
      assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - position) < 2, 'Highlight edits must preserve article scroll');
      assert.ok(Math.abs((await passage.boundingBox()).y - passageTop) < 2, 'The same passage must stay in place');
    };
    const offset = (await page.locator('.crate-reading-reader__body').textContent()).indexOf(excerpt);
    await select(offset);
    await expect(marks).toHaveCount(3);
    await stable();
    await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights?.[0]?.text).toBe(excerpt);
    await expect(page.getByRole('button', { name: 'Adjust highlight start' })).toBeEnabled();
    await stable();
    await dragHandle('start', offset + 2);
    await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights?.[0]?.text).toBe('useful article excerpt.');
    await stable();
    await page.getByRole('button', { name: 'Delete highlight', exact: true }).tap();
    await expect(marks).toHaveCount(0);
    await stable();
    await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights).toEqual([]);
    await stable();
    // A normal vault edit adds native markers and changes the article body.
    // Refresh the open PWA reader without closing/reopening it.
    await replaceArticle('A native ==Obsidian highlight== in an edited article.');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('.crate-reading-reader__body')).toHaveText('A native Obsidian highlight in an edited article.');
    await expect(marks).toHaveText('Obsidian highlight');

    // Inline code uses native markers; exact partial/code-block selections use
    // synced annotations so copying code always returns its original bytes.
    const literalCode = 'let kind = "primary"\nprint(kind)\n';
    const codeMarkdown = 'Use `DSButton` to build a component.\n\n```swift\n' + literalCode + '```\n';
    await replaceArticle(codeMarkdown);
    await page.reload();
    const inlineParagraph = page.locator('.crate-reading-reader__body p').first();
    await expect(inlineParagraph).toHaveText('Use DSButton to build a component.');
    await expect(code).toHaveText(literalCode);
    await inlineParagraph.evaluate(element => element.scrollIntoView({ block: 'center' }));
    const inlineText = await inlineParagraph.textContent();
    const inlineStart = (await page.locator('.crate-reading-reader__body').textContent()).indexOf(inlineText);
    await select(inlineStart, inlineText.length);
    await expect.poll(async () => (await marks.allTextContents()).join('')).toBe(inlineText);
    await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights?.[0]?.text).toBe(inlineText);
    assert.ok((await (await download()).text()).includes('==Use `DSButton` to build a component.=='));
    await page.getByRole('button', { name: 'Delete highlight', exact: true }).tap();
    await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights).toEqual([]);

    await context.setOffline(true);
    await select(inlineStart + 6, 6);
    await expect(marks).toHaveText('Button');
    await dragHandle('start', inlineStart + 4);
    await expect(marks).toHaveText('DSButton');
    await dragHandle('start', inlineStart + 6);
    await expect(marks).toHaveText('Button');
    if (name === 'chromium') { await page.reload(); await expect(marks).toHaveText('Button'); }
    await context.setOffline(false);
    await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights?.[0]?.codeAnchor).toBe(true);
    const unchangedBody = async () => { const note = await (await download()).text(); return note.slice(note.indexOf('\n---\n') + 5); };
    assert.equal(await unchangedBody(), `\n<!-- crate:article:start -->\n${codeMarkdown}\n<!-- crate:article:end -->\n`);
    await inlineParagraph.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await marks.tap();
    await page.getByRole('button', { name: 'Delete highlight', exact: true }).tap();
    await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights).toEqual([]);

    await code.evaluate(element => element.scrollIntoView({ block: 'center' }));
    const codeExcerpt = 'kind = "primary"\nprint(kind)';
    const codeStart = (await page.locator('.crate-reading-reader__body').textContent()).indexOf(codeExcerpt);
    await select(codeStart, codeExcerpt.length);
    await expect.poll(async () => (await marks.allTextContents()).join('')).toBe(codeExcerpt);
    await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights?.[0]?.codeAnchor).toBe(true);
    assert.equal(await unchangedBody(), `\n<!-- crate:article:start -->\n${codeMarkdown}\n<!-- crate:article:end -->\n`);
    await page.reload();
    await expect.poll(async () => (await marks.allTextContents()).join('')).toBe(codeExcerpt);
    assert.equal(await code.textContent(), literalCode);
    await expect(code.locator('.hljs-keyword')).toHaveText('let');
    await page.getByRole('button', { name: 'Highlights (1)', exact: true }).click();
    assert.equal(await page.locator('.crate-reading-highlights__card blockquote').textContent(), codeExcerpt);
    await page.screenshot({ path: `test-results/reading/${name}-code-highlights.png` });

    // Exercise the actual sanitized reader, offline queue, and source writer
    // together: parser-only tests cannot catch textContent offset differences.
    let sourceRevision = 0;
    for (const [sourceMarkdown, excerpt, native = false] of [
      ['Visit <https://example.com> today.', 'https://example.com', true],
      ['Visit https://example.org today.', 'example.org'],
      ['| Name | Value |\n| --- | --- |\n| a\\|b | `x` |\n', 'a|b'],
      ['Compare a == b in ordinary text.', 'a == b'],
      ['<div>Embedded <strong>HTML</strong> content.</div>\n', 'Embedded HTML content.'],
      ['A [[Note|label]] and ![[diagram.svg]] here.', 'Note|label'],
      ['A [[Note|label]] and ![[diagram.svg]] here.', 'diagram.svg'],
      ['Use $E = mc^2$ here.', 'E = mc^2'],
      ['A footnote[^important] here.', 'important'],
      ['> [!note]+ A callout\n> Callout text.\n', 'note'],
      ['A paragraph. ^block-id\n', 'block-id'],
      ['<audio>Hidden audio</audio><video>Hidden video</video><object>Hidden object</object>\n\nVisible text.', 'Visible text.', true],
    ]) {
      // A cached article may briefly contain the next excerpt too (for example
      // note inside footnote). Wait for this revision before measuring offsets.
      const marker = `Selection fixture revision ${++sourceRevision}`;
      const markdown = `${sourceMarkdown}\n\n${marker}\n`;
      await replaceArticle(markdown);
      await page.reload();
      const body = page.locator('.crate-reading-reader__body');
      await expect(body).toContainText(marker);
      await expect(body).toContainText(excerpt);
      await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
      const beforeText = await body.textContent();
      await body.evaluate(element => element.scrollIntoView({ block: 'center' }));
      const start = beforeText.indexOf(excerpt);
      await context.setOffline(true);
      // Use a native range here: desktop dragging an anchor starts link drag,
      // while these cases verify Markdown handling rather than pointer gestures.
      await body.evaluate((element, { start, excerpt }) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let node, offset = 0, began = false;
        while ((node = walker.nextNode())) {
          if (!began && offset + node.length > start) { range.setStart(node, start - offset); began = true; }
          if (began && offset + node.length >= start + excerpt.length) { range.setEnd(node, start + excerpt.length - offset); break; }
          offset += node.length;
        }
        if (range.toString() !== excerpt) throw new Error(`Incorrect browser selection: ${JSON.stringify({ expected: excerpt, actual: range.toString(), start, text: element.textContent })}`);
        const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      }, { start, excerpt });
      await expect.poll(async () => (await marks.allTextContents()).join('')).toBe(excerpt);
      assert.equal(await body.textContent(), beforeText);
      if (name === 'chromium') { await page.reload(); await expect.poll(async () => (await marks.allTextContents()).join('')).toBe(excerpt); }
      await context.setOffline(false);
      await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights?.[0]?.text).toBe(excerpt);
      const [stored] = (await api(`/reading/item?id=${saved.id}`)).item.highlights;
      assert.equal(!!stored.textAnchor, !native, `Correct source representation for ${markdown}`);
      if (!native) assert.equal(await unchangedBody(), `\n<!-- crate:article:start -->\n${markdown}\n<!-- crate:article:end -->\n`);
      await page.reload();
      await expect.poll(async () => (await marks.allTextContents()).join('')).toBe(excerpt);
      await page.getByRole('button', { name: 'Highlights (1)', exact: true }).click();
      assert.equal(await page.locator('.crate-reading-highlights__card blockquote:visible').textContent(), excerpt);
      await page.getByRole('button', { name: 'View in article', exact: true }).click();
      await expect(marks.first()).toBeFocused();
      await marks.first().tap();
      await page.getByRole('button', { name: 'Delete highlight', exact: true }).tap();
      await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights).toEqual([]);
      assert.equal(await unchangedBody(), `\n<!-- crate:article:start -->\n${markdown}\n<!-- crate:article:end -->\n`);
    }

  } catch (error) {
    if (page) {
      console.error('Highlight UI alerts:', await page.getByRole('alert').allTextContents());
      await mkdir('test-results/reading', { recursive: true });
      await page.screenshot({ path: `test-results/reading/${name}-highlight-failure.png` });
    }
    throw error;
  } finally {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
    await runtime?.close(); await rm(dir, { recursive: true, force: true });
  }
});
