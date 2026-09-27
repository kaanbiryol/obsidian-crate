import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) test(`Reading highlights ${name}: select, remove, persist offline and sync`, { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-highlights-'));
  let runtime, server, browser;
  let articleMarkdown = 'A useful **article excerpt**.\n\nAnother paragraph to read.';
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Highlight test');
    server = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        let response = await runtime.mf.dispatchFetch(`${origin}${req.url}`, { method: req.method, headers: req.headers,
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
        // Deterministic extracted text; the outbox, mutation receipts and storage are real.
        if (req.url.startsWith('/reading/item?') && response.ok) {
          const article = await response.json();
          response = new Response(JSON.stringify({ ...article, markdown: articleMarkdown }), { headers: response.headers });
        }
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://localhost:${server.address().port}`;
    const api = async (path, body) => {
      const response = await runtime.mf.dispatchFetch(`${origin}${path}`, { method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${vault.token}`, 'X-Crate-Protocol': '11', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    await api('/reading/policy', { enabled: true, folderPath: 'Reading', revision: null });
    const operationId = `e1_${String(Math.floor(Date.now() / 86400000)).padStart(8, '0')}_${randomUUID()}`;
    const saved = await api('/reading/capture', { url: 'https://example.invalid/article', title: 'Highlight article', operationId });
    const enrollment = await api('/reading/access', { kind: 'reading' });
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(enrollment.url);
    const open = async () => {
      await page.getByRole('button', { name: /example.invalid Highlight article/ }).click();
      await expect(page.locator('.crate-reading-reader__body')).toContainText('A useful article excerpt.');
      await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
    };
    await open();
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
    const select = async (offset = 0) => {
      const start = await textPoint(offset), end = await textPoint(offset + 25);
      await page.mouse.move(start.x + .2, start.y); await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      assert.equal(await page.locator('.crate-reading-reader__highlight').count(), 0, 'Selection is not saved while the pointer is held');
      await page.mouse.up();
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
    const marks = page.locator('.crate-reading-reader__highlight');
    await expect.poll(() => marks.allTextContents()).toEqual(['A useful ', 'article excerpt', '.']);
    assert.deepEqual(await page.locator('.crate-reading-reader__body').boundingBox(), initialBody, 'Selection actions must not move the passage');
    await expect(page.getByRole('button', { name: 'Highlight', exact: true })).toHaveCount(0);
    await page.locator('.crate-reading-reader__header h1').tap();
    await marks.nth(1).tap();
    await expect(page.getByRole('button', { name: 'Adjust highlight start' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Adjust highlight end' })).toBeVisible();
    await dragHandle('start', 2);
    await expect.poll(async () => (await marks.allTextContents()).join('')).toBe('useful article excerpt.');
    await dragHandle('start', 0);
    await expect.poll(async () => (await marks.allTextContents()).join('')).toBe('A useful article excerpt.');
    const fullText = await page.locator('.crate-reading-reader__body').textContent();
    const extendedEnd = fullText.indexOf('paragraph') + 'paragraph'.length;
    await dragHandle('end', extendedEnd);
    await expect.poll(async () => (await marks.allTextContents()).join('')).toBe(fullText.slice(0, extendedEnd));
    await dragHandle('end', 25);
    await expect.poll(() => marks.allTextContents()).toEqual(['A useful ', 'article excerpt', '.']);
    // A canceled handle drag must not persist its preview.
    const handle = page.getByRole('button', { name: 'Adjust highlight start' }), box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    const shorter = await textPoint(9); await page.mouse.move(shorter.x, shorter.y, { steps: 5 });
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
    await page.getByRole('button', { name: 'Back to reading', exact: true }).click();
    await open();
    await expect(marks).toHaveCount(3);
    if (name === 'chromium') { await page.reload(); await expect(marks).toHaveCount(3); }
    const excerpt = 'A useful article excerpt.';
    await context.setOffline(false);
    await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights?.[0]?.text).toBe(excerpt);
    await page.reload();
    await expect(page.locator('.crate-reading-reader__highlight')).toHaveCount(3);
    await marks.nth(1).tap();
    await page.getByRole('button', { name: 'Delete highlight', exact: true }).tap();
    await expect.poll(async () => (await api(`/reading/item?id=${saved.id}`)).item.highlights).toEqual([]);
    // Keep the article deeply scrolled through creation, resize, confirmation and deletion.
    const filler = Array.from({ length: 35 }, (_, i) => `Paragraph ${i}. A longer article gives this regression a real scroll position.\n\n`).join('');
    articleMarkdown = `${filler}A useful **article excerpt**.\n\n${filler}`;
    await page.reload();
    const passage = page.locator('.crate-reading-reader__body p').filter({ hasText: 'A useful article excerpt.' });
    await expect(page.locator('.crate-reading-reader__body p')).toHaveCount(71);
    await expect(passage).toBeVisible();
    await passage.evaluate(element => element.scrollIntoView({ block: 'center' }));
    const reader = page.locator('.crate-reading-reader');
    const position = await reader.evaluate(element => element.scrollTop);
    assert.ok(position > 1000, 'Regression must start well down the article');
    const passageTop = (await passage.boundingBox()).y;
    const paragraphNode = await passage.elementHandle();
    const stable = async () => {
      assert.equal(await paragraphNode.evaluate(node => node.isConnected), true, 'Highlight updates must retain the existing article paragraphs');
      assert.ok(Math.abs(await reader.evaluate(element => element.scrollTop) - position) < 2, 'Highlight edits must preserve article scroll');
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

  } finally {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
    await runtime?.close(); await rm(dir, { recursive: true, force: true });
  }
});
