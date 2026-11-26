import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from '../support/preview/pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from '../support/preview/pwa-preview-server.mjs';
import { previewAuthToken } from '../support/preview/pwa-preview-fixtures.mjs';

// The schedule half of the PWA editor contract, split from pwa-editor-contract-test.mjs so
// each script stays well inside the browser runner's per-script timeout.
const assets = await buildPwaPreviewAssets();
for (const browserType of [chromium, webkit]) {
  const { server, origin } = await listenPwaPreviewServer({ port: 0, assets });
  const browser = await browserType.launch();
  try {
    await verifyRepeatPicker(browser, origin);
    await verifyChronoSchedules(browser, origin);
    await verifyRecurrenceTimezones(browser, origin);
    console.log(`${browserType.name()}: Natural-language schedules and recurrence timezones passed`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function verifyChronoSchedules(browser, origin) {
  for (const [schedule, instant, content = 'Call Alex', datePart = schedule] of [
    ['in 5 minutes', '2026-09-21T13:05:37.123Z'],
    ['in 2 hours', '2026-09-21T15:00:37.123Z'],
    ['tomorrow 09:00 UTC', '2026-09-22T09:00:00.000Z'],
    ['Friday 09:00:30 in the morning UTC', '2026-09-25T09:00:30.000Z'],
    ['2026-09-25T09:00:30.123+02:00', '2026-09-25T07:00:30.123Z'],
    ['tomorrow 09:00 +0200', '2026-09-22T07:00:00.000Z'],
    ['tomorrow 09:00 America/New_York', '2026-09-22T13:00:00.000Z'],
    ['tomorrow 09:00 -03:30', '2026-09-22T12:30:00.000Z'],
    ['Monday to Friday 09:00 UTC', '2026-09-25T09:00:00.000Z', 'Call Alex Monday to', 'Friday 09:00 UTC'],
    ['Monday to 2026-09-25T09:00:30.123-03:30', '2026-09-25T12:30:30.123Z', 'Call Alex Monday to', '2026-09-25T09:00:30.123-03:30'],
    ['Monday Friday 09:00 UTC', '2026-09-25T09:00:00.000Z', 'Call Alex Monday', 'Friday 09:00 UTC'],
    ['Friday Friday 09:00:30.123 UTC', '2026-09-25T09:00:30.123Z', 'Call Alex Friday', 'Friday 09:00:30.123 UTC'],
    ['Monday Friday', '2026-09-25', 'Call Alex Monday', 'Friday'],
  ]) {
    await fetch(`${origin}/preview/reset`, { method: 'POST' });
    const page = await browser.newPage({ timezoneId: 'Europe/Berlin', viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.setFixedTime(new Date('2026-09-21T13:00:37.123Z'));
      await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
      await page.locator('[data-action="open-create-modal"]').tap();
      const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
      await title.tap();
      await page.keyboard.insertText(`Call Alex ${schedule}`);
      await expect(title.locator('.rich-text-chip-date')).toHaveText(datePart);
      await expect(page.getByRole('alert')).toHaveCount(0);
      const createRequest = page.waitForRequest(request => request.url().endsWith('/reminders/create') && request.method() === 'POST');
      await page.getByRole('button', { name: 'Add reminder', exact: true }).tap();
      const created = (await createRequest).postDataJSON();
      assert.equal(created.content, content);
      const timed = instant.includes('T');
      assert.equal(timed ? created.dueDatetime : created.dueDate, instant);
      if (!timed) assert.equal(created.dueDatetime, null);
      await expect(title).toBeHidden();
      await page.getByRole('group', { name: `${content}. Press Enter to edit reminder.`, exact: true }).tap();
      if (!timed) await page.getByRole('button', { name: 'Set priority', exact: true }).tap();
      const updateRequest = page.waitForRequest(request => request.url().endsWith('/reminders/update') && request.method() === 'POST');
      await page.getByRole('button', { name: 'Save reminder', exact: true }).tap();
      const updated = (await updateRequest).postDataJSON();
      assert.equal(updated.content, content);
      assert.equal(timed ? updated.dueDatetime : updated.dueDate, instant);
      if (!timed) { assert.equal(updated.dueDatetime, null); assert.equal(updated.priority, 1); }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
}

async function verifyRecurrenceTimezones(browser, origin) {
  for (const [timezone, dueDatetime, precision = {}] of [
    ['UTC', '2026-09-28T09:00:30.123Z', { second: 30, millisecond: 123 }],
    ['America/New_York', '2026-09-28T13:00:37.123Z'],
    ['+05:30', '2026-09-28T03:30:37.123Z'],
    ['-03:30', '2026-09-28T12:30:37.123Z'],
  ]) {
    await fetch(`${origin}/preview/reset`, { method: 'POST' });
    const page = await browser.newPage({ timezoneId: 'Europe/Berlin', viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const rule = { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, timezone, ...precision,
        count: 8, completedCount: 3, endDate: '2027-12-31' };
      const seed = await fetch(`${origin}/reminders/update`, { method: 'POST',
        headers: { Authorization: `Bearer ${previewAuthToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'preview-inbox-1', dueDatetime, recurrence: rule }),
      });
      assert.equal(seed.status, 200);
      await page.clock.setFixedTime(new Date('2026-09-21T13:00:37.123Z'));
      await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
      await page.locator('[data-action="open-create-modal"]').tap();
      const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
      const schedule = `every week Monday 09:00${precision.second ? ':30.123' : ''} ${timezone}`;
      await title.tap();
      await page.keyboard.insertText(`Compare Monday with ${schedule}`);
      await expect(title.locator('.rich-text-chip-date')).toHaveText(schedule);
      const createRequest = page.waitForRequest(request => request.url().endsWith('/reminders/create') && request.method() === 'POST');
      await page.getByRole('button', { name: 'Add reminder', exact: true }).tap();
      const created = (await createRequest).postDataJSON();
      assert.equal(created.content, 'Compare Monday with');
      assert.deepEqual(created.recurrence, { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, timezone, ...precision });
      await expect(title).toBeHidden();
      await page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true }).tap();
      await expect(title.locator('.rich-text-chip-date')).toContainText(timezone);
      await page.getByRole('button', { name: 'Set priority', exact: true }).tap();
      await page.locator('.reminder-action-chips [data-picker="project"]').tap();
      await page.getByRole('option', { name: 'Work', exact: true }).tap();
      const updateRequest = page.waitForRequest(request => request.url().endsWith('/reminders/update') && request.method() === 'POST');
      await page.getByRole('button', { name: 'Save reminder', exact: true }).tap();
      const updated = (await updateRequest).postDataJSON();
      assert.deepEqual(updated.recurrence, rule);
      assert.equal(updated.dueDatetime, dueDatetime);
      assert.equal(updated.project, 'Work');
      assert.equal(updated.priority, 1);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
}


async function verifyRepeatPicker(browser, origin) {
  for (const scenario of ['unchanged', 'reverted', 'all-day', 'implicit monthly', 'change', 'add', 'remove']) {
    await fetch(`${origin}/preview/reset`, { method: 'POST' });
    const page = await browser.newPage({ timezoneId: 'Europe/Berlin', viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      // A new monthly rule starts on today's day of month, which cannot increase on the 31st.
      await page.clock.setFixedTime(new Date('2026-10-29T12:00:00.000Z'));
      const rule = {
        frequency: scenario === 'implicit monthly' ? 'monthly' : 'weekly',
        ...(scenario === 'implicit monthly' ? {} : { daysOfWeek: [1, 3] }),
        ...(['all-day', 'implicit monthly'].includes(scenario) ? {} : { hour: 9, minute: 0 }),
        timezone: 'America/New_York', count: 8, completedCount: 3, endDate: '2027-12-31',
      };
      const dates = ['all-day', 'implicit monthly'].includes(scenario)
        ? { dueDate: '2026-10-28', dueDatetime: null }
        : { dueDate: null, dueDatetime: '2026-10-28T13:00:37.123Z' };
      await page.route('**/reminders/list**', async route => {
        const response = await route.fetch();
        const data = await response.json();
        data.reminders = data.reminders.map(reminder => reminder.id === 'preview-inbox-1'
          ? { ...reminder, dueDate: dates.dueDate ?? undefined, dueDatetime: dates.dueDatetime ?? undefined,
            recurrence: scenario === 'add' ? undefined : rule } : reminder);
        await route.fulfill({ response, json: data });
      });
      await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
      await page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true }).tap();
      const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
      await expect(title).toBeEditable();
      const initialTitle = await title.textContent();
      const waitForSheet = async name => {
        await expect(page.getByRole('dialog', { name, exact: true })).toBeVisible();
        await expect(page.locator('.pwa-reminder-sheet-stage')).toHaveCSS('transform', 'none');
        // A visible picker can still be entering and reject Done until the
        // spring completion callback enables navigation.
        await expect(page.locator('.pwa-modal-sheet__container')).not.toHaveAttribute('data-base-ui-swipe-ignore');
      };
      await page.locator('.reminder-action-chips [data-picker="recurrence"]').tap();
      await waitForSheet('Repeat reminder');
      if (scenario === 'reverted') {
        await page.getByRole('button', { name: 'Monday', exact: true }).tap();
        await page.getByRole('button', { name: 'Monday', exact: true }).tap();
        await page.getByRole('tab', { name: 'Monthly', exact: true }).tap();
        await page.getByRole('button', { name: 'Increase day of month', exact: true }).tap();
        await page.getByRole('tab', { name: 'Weekly', exact: true }).tap();
      }
      if (scenario === 'change') await page.getByLabel('Reminder time', { exact: true }).fill('10:30');
      await page.getByRole('button', { name: scenario === 'remove' ? 'Remove repeat' : 'Done', exact: true }).tap();
      await expect(title).toBeEditable();
      await waitForSheet('Edit reminder');
      if (!['change', 'add', 'remove'].includes(scenario)) {
        await expect(title).toHaveText(initialTitle);
        // Reopening must not leave stale picker state that changes a later Done.
        await page.locator('.reminder-action-chips [data-picker="recurrence"]').tap();
        await waitForSheet('Repeat reminder');
        await page.getByRole('button', { name: 'Done', exact: true }).tap();
        await waitForSheet('Edit reminder');
      }
      const [request] = await Promise.all([
        page.waitForRequest(request => request.url().endsWith('/reminders/update') && request.method() === 'POST'),
        page.getByRole('button', { name: 'Save reminder', exact: true }).tap(),
      ]);
      const body = request.postDataJSON();
      if (scenario === 'remove') assert.equal(body.recurrence, null);
      else if (scenario === 'change' || scenario === 'add') {
        assert.equal(body.recurrence.frequency, scenario === 'add' ? 'daily' : 'weekly');
        assert.equal(body.recurrence.hour, scenario === 'add' ? 9 : 10);
        assert.equal(body.recurrence.minute, scenario === 'add' ? 0 : 30);
        if (scenario === 'change') assert.equal(body.recurrence.timezone, rule.timezone);
        assert.equal(body.dueDate, null);
        assert.equal(body.dueDatetime, null);
      } else {
        assert.deepEqual(body.recurrence, rule);
        assert.equal(body.dueDate, dates.dueDate);
        assert.equal(body.dueDatetime, dates.dueDatetime);
      }
    } catch (error) {
      throw new Error(`Repeat picker scenario failed: ${scenario}`, { cause: error });
    } finally { await page.close(); }
  }
  console.log(`${browser.browserType().name()}: Repeat Done preserves unchanged schedules and metadata; edits, adding and removing still apply`);
}
