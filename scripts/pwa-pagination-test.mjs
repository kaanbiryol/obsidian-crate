import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

// Exercise production rendering and mutations with deterministic reminder API
// responses. Browser timings are not pass/fail performance thresholds.
const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const cardSelector = '.sidebar-reminder-card-wrapper';
const pageSize = 200;

function fixture(count, patch = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({
    id: `pagination-${index}`, content: `Pagination reminder ${String(index + 1).padStart(3, '0')}`,
    project: 'Inbox', priority: 4, completed: false, filePath: 'Reminders/Inbox.md',
    revision: 'pagination-revision-1', lineNumber: index + 1, ...patch(index),
  }));
}

async function withReminders(browser, reminders, run) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true,
    serviceWorkers: 'block', reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [];
    const serverReminders = structuredClone(reminders);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/reminders/list?*', route => route.fulfill({
      json: { reminders: serverReminders, projects: [...new Set(serverReminders.map(item => item.project))] },
    }));
    const result = await run(page, serverReminders);
    assert.deepEqual(errors, [], 'pagination interactions must not throw browser errors');
    return result;
  } finally { await context.close(); }
}

async function mountedIds(page) {
  return page.locator(cardSelector).evaluateAll(cards => cards.map(card => (
    card.closest('[data-reminder-id]')?.getAttribute('data-reminder-id')
  )));
}

async function checkAllPages(page, reminders, label) {
  const cards = page.locator(cardSelector);
  const select = page.getByRole('combobox', { name: `${label} page`, exact: true });
  const pageCount = Math.ceil(reminders.length / pageSize);
  await expect(select.locator('option')).toHaveCount(pageCount);
  const visited = [];
  for (let index = 0; index < pageCount; index++) {
    await select.focus();
    await select.selectOption(String(index));
    await expect(select).toHaveValue(String(index));
    await expect(select).toBeFocused();
    await expect(cards).toHaveCount(Math.min(pageSize, reminders.length - index * pageSize));
    const ids = await mountedIds(page);
    assert.ok(ids.every(Boolean), 'every rendered card must retain its reminder ID');
    assert.equal(new Set(ids).size, ids.length, 'one page must not duplicate reminder rows');
    visited.push(...ids);
  }
  assert.equal(visited.length, reminders.length, 'pages must render each reminder exactly once');
  assert.deepEqual([...visited].sort(), reminders.map(item => item.id).sort(), 'all reminders must remain reachable');
  // Boundary buttons stay focusable after the page change that disables them.
  const previous = page.getByRole('button', { name: `Previous ${label.toLowerCase()} page`, exact: true });
  const next = page.getByRole('button', { name: `Next ${label.toLowerCase()} page`, exact: true });
  await previous.focus();
  await previous.press('Enter');
  await expect(select).toHaveValue(String(pageCount - 2));
  await expect(previous).toBeFocused();
  await next.focus();
  await next.press('Enter');
  await expect(select).toHaveValue(String(pageCount - 1));
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await next.press('Enter');
  await expect(select).toHaveValue(String(pageCount - 1));
}

async function checkViews(browser) {
  const today = fixture(401, () => ({ dueDate: '2000-01-01' }));
  await withReminders(browser, today, async page => {
    await page.goto(`${origin}/notifications?folder=Reminders&tab=today`);
    await expect(page.locator(cardSelector)).toHaveCount(pageSize);
    await checkAllPages(page, today, 'Active reminders');
  });

  const upcoming = fixture(401, index => ({ dueDate: new Date(Date.now() + (2 + index % 3) * 86_400_000).toISOString().slice(0, 10) }));
  await withReminders(browser, upcoming, async page => {
    await page.goto(`${origin}/notifications?folder=Reminders&tab=upcoming&upcomingDays=7`);
    await expect(page.locator(cardSelector)).toHaveCount(pageSize);
    // The first page spans dates: pagination applies across the whole list,
    // rather than allowing 200 rows for each individual date group.
    await expect(page.locator('.upcoming-date-header')).toHaveCount(2);
    await checkAllPages(page, upcoming, 'Upcoming reminders');
  });

  const completed = fixture(401, () => ({ completed: true }));
  await withReminders(browser, completed, async page => {
    await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    const toggle = page.getByRole('button', { name: 'Completed (401)', exact: true });
    await expect(toggle).toBeVisible();
    await expect(page.locator(cardSelector)).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Completed reminders page', exact: true })).toHaveCount(0);
    await toggle.click();
    await checkAllPages(page, completed, 'Completed reminders');
    await toggle.click();
    await expect(page.locator(cardSelector)).toHaveCount(0);
  });

  const project = fixture(401, () => ({ project: 'Work', filePath: 'Reminders/Work.md' }));
  await withReminders(browser, project, async page => {
    await page.goto(`${origin}/notifications?folder=Reminders&tab=browse`);
    await page.locator('[data-action="open-project"][data-project="Work"]').click();
    await expect(page.locator('.reminders-view.is-project-detail')).toBeVisible();
    await checkAllPages(page, project, 'Active reminders');
  });
}

async function checkLastPageDeletion(browser) {
  const reminders = fixture(201);
  return withReminders(browser, reminders, async (page, serverReminders) => {
    const deleted = [];
    await page.route('**/reminders/delete', route => {
      assert.equal(route.request().method(), 'DELETE');
      const body = route.request().postDataJSON();
      deleted.push(body);
      assert.equal(body.id, reminders.at(-1).id);
      assert.equal(body.expectedRevision, reminders.at(-1).revision);
      assert.equal(body.filePath, reminders.at(-1).filePath);
      const index = serverReminders.findIndex(item => item.id === body.id);
      assert.ok(index >= 0, 'the deleted reminder must still exist on the fixture server');
      serverReminders.splice(index, 1);
      return route.fulfill({ json: { success: true } });
    });
    await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    const select = page.getByRole('combobox', { name: 'Active reminders page', exact: true });
    await select.selectOption('1');
    const cards = page.locator(cardSelector);
    await expect(cards).toHaveCount(1);
    await expect(page.locator('[data-action="open-create-modal"]')).toBeVisible();
    await cards.first().click();
    const editor = page.locator('.pwa-reminder-editor[role="dialog"]');
    await expect(editor.locator('[contenteditable="true"][aria-label="Reminder title"]')).toHaveText(reminders.at(-1).content);
    await editor.getByRole('button', { name: 'Delete reminder', exact: true }).click();
    const confirmation = page.getByRole('alertdialog', { name: 'Delete reminder?', exact: true });
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/reminders/list');
    await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    await expect.poll(() => deleted.length).toBe(1);
    // The optimistic outbox refreshes after acknowledgement. Its next server
    // snapshot must retain the deletion rather than resurrect the last page.
    await (await refreshed).finished();
    await expect(cards).toHaveCount(pageSize);
    await expect(select).toHaveCount(0);
    assert.deepEqual(await mountedIds(page), reminders.slice(0, pageSize).map(item => item.id));
    await expect(cards.first()).toBeInViewport();
    await expect(cards.first()).toBeFocused();
    const focus = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute('aria-label'),
      onBody: document.activeElement === document.body,
      inDialog: Boolean(document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')),
    }));
    assert.equal(focus.inDialog, false, 'focus must not remain inside a removed editor');
    assert.equal(focus.onBody, false, 'deleting the focused row must restore focus to the remaining list');
    return focus;
  });
}

async function checkSecondPageReorder(browser) {
  const reminders = fixture(401);
  await withReminders(browser, reminders, async (page, serverReminders) => {
    const reordered = [];
    await page.route('**/reminders/reorder', route => {
      const body = route.request().postDataJSON();
      reordered.push(body);
      const byId = new Map(serverReminders.map(item => [item.id, item]));
      assert.equal(body.orderedIds.length, serverReminders.length);
      assert.equal(new Set(body.orderedIds).size, serverReminders.length);
      assert.ok(body.orderedIds.every(id => byId.has(id)));
      serverReminders.splice(0, serverReminders.length,
        ...body.orderedIds.map((id, index) => ({ ...byId.get(id), lineNumber: index + 1 })));
      return route.fulfill({ json: { success: true } });
    });
    await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    const select = page.getByRole('combobox', { name: 'Active reminders page', exact: true });
    await select.selectOption('1');
    await expect(page.locator(cardSelector)).toHaveCount(pageSize);
    await expect(page.locator('[data-action="open-create-modal"]')).toBeVisible();
    const first = page.locator('[data-reminder-id="pagination-200"]');
    const second = page.locator('[data-reminder-id="pagination-201"]');
    await first.scrollIntoViewIfNeeded();
    const from = await first.boundingBox();
    const to = await second.boundingBox();
    assert.ok(from && to, 'the first two rows on page two must be rendered');
    const x = from.x + from.width * 0.7;
    await page.mouse.move(x, from.y + from.height / 2);
    await page.mouse.down();
    // This is the actual user long-press threshold, not a performance budget.
    await expect(first).toHaveClass(/is-long-press-armed/);
    await page.mouse.move(x, to.y + to.height / 2 + 5, { steps: 10 });
    await expect(select).toBeDisabled();
    // Pointer moves are coalesced into animation frames. In WebKit the drag
    // can start before the final crossing is applied, so keep holding until
    // the real list has reordered instead of releasing an unfinished gesture.
    await expect.poll(async () => (await mountedIds(page)).slice(0, 2))
      .toEqual(['pagination-201', 'pagination-200']);
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/reminders/list');
    await page.mouse.up();
    await expect.poll(() => reordered.length).toBe(1);
    await (await refreshed).finished();
    const expected = reminders.map(item => item.id);
    [expected[200], expected[201]] = [expected[201], expected[200]];
    assert.deepEqual(reordered[0].orderedIds, expected, 'a page-two drag must preserve every other reminder and send the complete order');
    assert.deepEqual(reordered[0].expectedOrder, reminders.map(item => item.id));
    assert.equal(reordered[0].project, 'Inbox');
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue('1');
    assert.deepEqual(await mountedIds(page), expected.slice(200, 400));
    await expect(page.locator('.pwa-reminder-editor[role="dialog"]')).toHaveCount(0);
  });
}

try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      await checkViews(browser);
      const deletionFocus = await checkLastPageDeletion(browser);
      for (let attempt = 0; attempt < 3; attempt++) await checkSecondPageReorder(browser);
      console.log(JSON.stringify({ browser: browserType.name(), views: ['today', 'upcoming', 'completed', 'project'], reminders: 401,
        pageSize, allRemindersReachable: true, selectFocusPreserved: true, lastPageDeletionClamped: true,
        completeOrderPreserved: true, reorderRuns: 3, deletionFocus }));
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
