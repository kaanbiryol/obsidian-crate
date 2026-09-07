import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

// Use the built production app. Only the reminder API is replaced with local,
// deterministic data; all list, navigation, editor and cache code is real.
const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const cardSelector = '.sidebar-reminder-card-wrapper';
const pageSize = 200;
const round = value => Math.round(value);

async function measureCapacity(browser, count) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block',
  });
  try {
    const page = await context.newPage();
    // Operational timeout only: timing figures are diagnostic, not machine-
    // dependent pass/fail budgets. Each scenario has a finite set of actions.
    page.setDefaultTimeout(60_000);
    const reminders = Array.from({ length: count }, (_, index) => ({
      id: `capacity-${index}`, content: `Capacity reminder ${String(index + 1).padStart(5, '0')}`,
      description: `Synthetic reminder ${index + 1}`, project: 'Inbox', priority: 4,
      completed: false, filePath: 'Reminders/Inbox.md', revision: 'capacity-revision-1',
      lineNumber: index + 1,
    }));
    const payloadBytes = Buffer.byteLength(JSON.stringify({ reminders, projects: ['Inbox'] }));
    const mutations = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/reminders/list?*', route => route.fulfill({
      json: { reminders, projects: ['Inbox'] },
    }));
    await page.route('**/reminders/update', route => {
      const body = route.request().postDataJSON();
      mutations.push(body);
      const reminder = reminders.find(item => item.id === body.id);
      assert.ok(reminder, 'mutation must target one of the loaded reminders');
      assert.equal(body.expectedRevision, reminder.revision);
      assert.equal(body.filePath, reminder.filePath);
      Object.assign(reminder, { content: body.content, description: body.description, revision: 'capacity-revision-2' });
      return route.fulfill({ json: { success: true, reminder } });
    });

    await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    const cards = page.locator(cardSelector);
    await expect(cards).toHaveCount(Math.min(count, pageSize), { timeout: 60_000 });
    await expect(cards.first()).toBeInViewport();
    const initial = await page.evaluate(selector => {
      const cards = [...document.querySelectorAll(selector)];
      const row = cards[0].closest('[data-reminder-id]');
      return {
        firstListMs: performance.now(),
        renderedCards: cards.length,
        uniqueReminders: new Set(cards.map(card => card.closest('[data-reminder-id]').getAttribute('data-reminder-id'))).size,
        domElements: document.querySelectorAll('*').length,
        rowContentVisibility: getComputedStyle(row).contentVisibility,
      };
    }, cardSelector);
    assert.equal(initial.uniqueReminders, Math.min(count, pageSize), 'the current page must have unique reminder rows');
    const pageSelect = page.getByRole('combobox', { name: 'Active reminders page', exact: true });
    await expect(pageSelect.locator('option')).toHaveCount(Math.ceil(count / pageSize));
    await expect(page.locator('[data-action="open-create-modal"]')).toBeVisible();

    const startedEditing = await page.evaluate(() => performance.now());
    await cards.first().click();
    // Scope editor selectors so benchmark timings do not include accessibility
    // tree scans of every reminder by the browser automation harness.
    const editor = page.locator('.pwa-reminder-editor[role="dialog"]');
    const title = editor.locator('[contenteditable="true"][aria-label="Reminder title"]');
    await expect(title).toBeFocused();
    await expect(title).toHaveText('Capacity reminder 00001');
    const openEditorMs = await page.evaluate(started => performance.now() - started, startedEditing);
    await title.fill('Capacity edit confirmed');
    const startedSaving = await page.evaluate(() => performance.now());
    const refreshedAfterFirstSave = page.waitForResponse(response => new URL(response.url()).pathname === '/reminders/list');
    await editor.locator('button[data-action="save-reminder"]').click();
    await editor.waitFor({ state: 'detached' });
    await expect(cards.first()).toHaveAttribute('aria-label', 'Capacity edit confirmed. Press Enter to edit reminder.');
    // Measure the visible optimistic save separately from server acknowledgement.
    const saveMs = await page.evaluate(started => performance.now() - started, startedSaving);
    await expect.poll(() => mutations.length).toBe(1);
    await (await refreshedAfterFirstSave).finished();
    await expect(cards.first()).toHaveAttribute('aria-label', 'Capacity edit confirmed. Press Enter to edit reminder.');

    // Exercise a view switch away from the full list and back, then reach both
    // the middle and end of the scroll range instead of only checking row count.
    const startedNavigation = await page.evaluate(() => performance.now());
    await page.locator('[data-action="switch-tab"][data-tab="today"]').click();
    await expect(page.locator('.reminders-view.is-today')).toBeVisible();
    await expect(cards).toHaveCount(0);
    const awayMs = await page.evaluate(started => performance.now() - started, startedNavigation);
    const startedReturn = await page.evaluate(() => performance.now());
    await page.locator('[data-action="switch-tab"][data-tab="inbox"]').click();
    await expect(cards).toHaveCount(Math.min(count, pageSize), { timeout: 60_000 });
    const returnMs = await page.evaluate(started => performance.now() - started, startedReturn);
    for (const index of [Math.floor(count / 2), count - 1]) {
      await pageSelect.focus();
      await pageSelect.selectOption(String(Math.floor(index / pageSize)));
      await expect(pageSelect).toBeFocused();
      await expect(page.locator(`[data-reminder-id="${reminders[index].id}"]`)).toBeAttached();
      const card = cards.nth(index % pageSize);
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeInViewport();
      await expect(card).toHaveAttribute('aria-label', `${reminders[index].content}. Press Enter to edit reminder.`);
    }
    await cards.last().click();
    await expect(title).toHaveText(reminders.at(-1).content);
    await title.fill('Last page edit confirmed');
    const refreshedAfterLastSave = page.waitForResponse(response => new URL(response.url()).pathname === '/reminders/list');
    await editor.locator('button[data-action="save-reminder"]').click();
    await editor.waitFor({ state: 'detached' });
    await expect.poll(() => mutations.length).toBe(2);
    await (await refreshedAfterLastSave).finished();
    await expect(cards.last()).toHaveAttribute('aria-label', 'Last page edit confirmed. Press Enter to edit reminder.');
    assert.equal(mutations[1].id, `capacity-${count - 1}`, 'last-page edit must retain its original reminder identity');
    assert.deepEqual(errors, [], 'large-list interactions must not throw browser errors');

    return {
      reminders: count, payloadBytes, firstListMs: round(initial.firstListMs),
      openEditorMs: round(openEditorMs), saveMs: round(saveMs),
      navigateAwayMs: round(awayMs), navigateBackMs: round(returnMs),
      renderedCards: initial.renderedCards, domElements: initial.domElements,
      rowContentVisibility: initial.rowContentVisibility,
      rendering: 'paginated', pageSize,
      viewportVirtualized: false,
    };
  } finally { await context.close(); }
}

try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      for (const count of [1_000, 10_000]) {
        const result = await measureCapacity(browser, count);
        console.log(JSON.stringify({ browser: browserType.name(), ...result }));
      }
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
