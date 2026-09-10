import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;

async function scenario(browser, reducedMotion, count) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block', reducedMotion,
  });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const reminders = Array.from({ length: count }, (_, index) => ({
      id: `scroll-${index}`, content: `Scroll reminder ${String(index).padStart(3, '0')}`,
      project: 'Inbox', priority: 4, completed: index >= count / 2,
      filePath: 'Reminders/Inbox.md', revision: 'scroll-1', lineNumber: index + 1,
      description: index % 3 === 0 ? 'A longer reminder with extra details to exercise variable row heights.' : '',
    }));
    await page.route('**/reminders/list?*', route => route.fulfill({ json: { reminders, projects: ['Inbox'] } }));
    await page.route('**/reminders/set-completed', async route => {
      const body = route.request().postDataJSON();
      const reminder = reminders.find(item => item.id === body.id);
      assert.ok(reminder);
      reminder.completed = body.completed;
      reminder.revision += 'a';
      // Keep acknowledgement asynchronous so consecutive toggles overlap.
      await new Promise(resolve => setTimeout(resolve, 120));
      await route.fulfill({ json: { success: true, reminder } });
    });
    await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    const scroller = page.locator('.reminders-view-scroll');
    await expect(page.locator('[data-action="open-create-modal"]')).toBeVisible();
    await page.getByRole('button', { name: `Completed (${count / 2})`, exact: true }).click();
    await expect(page.locator('[data-reminder-section="completed"]')).toHaveCount(count / 2);
    // Allow section opening to settle before positioning a deliberately clipped row.
    await page.waitForTimeout(600);
    for (const completed of [true, true, false, false]) {
      const section = completed ? 'completed' : 'active';
      const rows = page.locator(`[data-reminder-section="${section}"][data-reminder-scroll-anchor]`);
      const anchor = rows.nth(4);
      const id = await anchor.getAttribute('data-reminder-id');
      await anchor.evaluate(element => {
        const container = element.closest('.reminders-view-scroll');
        container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top + 17;
      });
      await page.waitForTimeout(100);
      const targetIds = await Promise.all([7, 8].map(index => rows.nth(index).getAttribute('data-reminder-id')));
      // Sample every frame, including the frames after React has committed.
      await scroller.evaluate((container, anchorId) => {
        const element = container.querySelector(`[data-reminder-id="${anchorId}"]`);
        window.scrollSamples = [];
        window.scrollSampleUntil = performance.now() + 1100;
        const sample = () => {
          // ResizeObserver runs after rAF but before paint; read after that
          // layout phase, rather than sampling an intermediate animation write.
          setTimeout(() => window.scrollSamples.push(
            element.getBoundingClientRect().top - container.getBoundingClientRect().top,
          ), 0);
          if (performance.now() < window.scrollSampleUntil) requestAnimationFrame(sample);
        };
        sample();
      }, id);
      const acknowledgements = [];
      for (const targetId of targetIds) {
        acknowledgements.push(page.waitForResponse(response => (
          new URL(response.url()).pathname === '/reminders/set-completed'
          && response.request().postDataJSON().id === targetId
        )));
        const checkbox = page.locator(`[data-reminder-id="${targetId}"][data-reminder-section="${section}"]`)
          .getByRole('checkbox', { name: /Mark .* (incomplete|complete)$/ });
        // Dispatch at the checkbox without Playwright scrolling or waiting
        // for animations; this deliberately overlaps two completion handlers.
        await checkbox.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
        await checkbox.dispatchEvent('click');
      }
      for (const acknowledged of acknowledgements) await (await acknowledged).finished();
      for (const targetId of targetIds) {
        await expect(page.locator(`[data-reminder-id="${targetId}"][data-reminder-section="${section}"]`)).toHaveCount(0);
      }
      await page.waitForTimeout(1200);
      const samples = await page.evaluate(() => window.scrollSamples);
      const drift = Math.abs(samples.at(-1) - samples[0]);
      assert.ok(drift <= 2, `${reducedMotion}, ${count} rows, ${section}: settled anchor drifted ${drift}px`);
      // JS can sample between Motion's write and the pre-paint resize callback.
      // Reject sustained drift while allowing those intermediate frame samples.
      const stableSamples = samples.filter(value => Math.abs(value - samples[0]) <= 3).length;
      assert.ok(stableSamples / samples.length >= 0.95, `${section}: viewport drift persisted through animation`);
      // A subsequent deliberate scroll must still work.
      const before = await scroller.evaluate(element => element.scrollTop);
      await scroller.evaluate(element => { element.scrollTop -= 100; });
      await page.waitForTimeout(100);
      assert.ok(Math.abs(await scroller.evaluate(element => element.scrollTop) - (before - 100)) < 2);
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      for (const reducedMotion of ['no-preference', 'reduce']) {
        for (const count of [60, 240]) await scenario(browser, reducedMotion, count);
      }
      console.log(`${browserType.name()}: long-list completion and reopening preserve the viewport with and without motion`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
