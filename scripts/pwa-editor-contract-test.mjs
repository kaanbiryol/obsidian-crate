import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { previewAuthToken } from './pwa-preview-fixtures.mjs';

const assets = await buildPwaPreviewAssets();
for (const browserType of [chromium, webkit]) {
  const { server } = await listenPwaPreviewServer({ port: 0, assets });
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/notifications?folder=Reminders&tab=inbox`);
    await page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true }).tap();
    const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
    const replaceTitle = async text => {
      // Focus places the caret at the end. Select after focus, as a user would,
      // so Playwright's fill selection cannot be collapsed by the focus handler.
      await expect(title).toBeEditable();
      await title.tap();
      await title.press('ControlOrMeta+a');
      await title.press('Backspace');
      if (text) await title.pressSequentially(text);
      await expect(title).toHaveText(text);
    };
    await expect(page.locator('.reminder-action-chips')).not.toHaveAttribute('inert');
    // Contenteditable can leave a non-breaking space after a decorated date.
    for (const separator of [' ', '\u00a0']) {
      await title.fill(`dsakldsaj tomorrow${separator}`);
      await expect(title.locator('.rich-text-chip-date')).toHaveText('tomorrow');
      await title.press('ControlOrMeta+ArrowRight');
      await page.keyboard.type('#');
      await expect(page.getByRole('option', { name: 'Work', exact: true })).toBeVisible();
      await page.keyboard.type('Wo');
      await expect(page.getByRole('option', { name: 'Work', exact: true })).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(title.locator('.rich-text-chip-project')).toHaveText('#Work');
      await expect(title.locator('.rich-text-chip-date')).toHaveText('tomorrow');
      await page.keyboard.type('then');
      await expect(title).toContainText('#Work then');
    }
    await title.fill('Read [docs](https://example.com) #Personal ');
    await expect(title.locator('a')).toHaveText('docs');
    // Start autocomplete with keyboard input after the initial link is rendered.
    await title.press('ControlOrMeta+ArrowRight');
    await page.keyboard.type('#Wo');
    const suggestion = page.getByRole('option', { name: 'Work', exact: true });
    await expect(suggestion).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(suggestion).toBeHidden();
    await expect(title.locator('.rich-text-chip-project')).toHaveText('#Work');
    // Wait for the actual caret, including the original editor's deferred restore.
    await expect.poll(() => title.evaluate(element => {
      const selection = document.getSelection();
      if (!selection?.focusNode || !element.contains(selection.focusNode)) return -1;
      const prefix = document.createRange();
      prefix.setStart(element, 0); prefix.setEnd(selection.focusNode, selection.focusOffset);
      return prefix.toString().length;
    })).toBe('Read docs #Personal #Work '.length);
    await page.keyboard.type('then');
    await expect(title).toHaveText('Read docs #Personal #Work then');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(title).not.toHaveText('Read docs #Personal #Work then');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(title).toHaveText('Read docs #Personal #Work then');

    // Paste keeps every marker; saving consumes only the final project/priority.
    await title.press('ControlOrMeta+a');
    await title.evaluate(element => {
      const data = new DataTransfer();
      data.setData('text/plain', 'Read [docs](https://example.com) #Personal #Work ! !');
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await expect(title).toHaveText('Read docs #Personal #Work ! !');
    await expect(title.locator('a')).toHaveAttribute('href', 'https://example.com');
    const requestPromise = page.waitForRequest(request => request.url().endsWith('/reminders/update') && request.method() === 'POST');
    await page.getByRole('button', { name: 'Save reminder', exact: true }).tap();
    const payload = (await requestPromise).postDataJSON();
    assert.equal(payload.content, 'Read [docs](https://example.com) #Personal !');
    assert.equal(payload.project, 'Work');
    assert.equal(payload.priority, 1);
    await expect(page.getByRole('dialog', { name: 'Edit reminder', exact: true })).toBeHidden();
    // A reload must hydrate exact Markdown from the durable draft, not DOM text.
    await page.locator('[data-action="open-create-modal"]').tap();
    const invalidCreateRequests = [];
    const trackInvalidCreate = request => {
      if (request.url().endsWith('/reminders/create') && request.method() === 'POST') invalidCreateRequests.push(request);
    };
    page.on('request', trackInvalidCreate);
    for (const schedule of ['every 0 days', 'every Monday 09:00 Europe/Invalid', 'tomorrow 09:00 UTC+', 'every Monday 09:00 UTC PST',
      'every two weeks Monday morning', 'every two months on the 15th at noon']) {
      await replaceTitle(`Task ${schedule}`);
      await expect(page.getByRole('alert').first()).toBeVisible();
      await expect(title.locator('.rich-text-chip-date')).toHaveCount(0);
      await page.getByRole('button', { name: 'Add reminder', exact: true }).tap();
      await title.press('Enter');
      await expect(title).toBeVisible();
    }
    assert.equal(invalidCreateRequests.length, 0);
    page.off('request', trackInvalidCreate);
    await replaceTitle('');
    await expect(page.getByRole('button', { name: 'Add reminder', exact: true })).toBeDisabled();
    const draftTitle = 'Draft 👩🏽‍💻 [reference](https://example.com/draft)';
    const draftDescription = 'First line\n日本語 & <script>literal text</script>';
    await title.fill(draftTitle);
    const description = page.getByRole('textbox', { name: 'Reminder description', exact: true });
    await description.fill(draftDescription);
    await expect.poll(() => page.evaluate(() => {
      const saved = sessionStorage.getItem('crate-reminder-draft:Reminders:new');
      return saved ? JSON.parse(saved).draft : null;
    })).toMatchObject({ content: draftTitle, description: draftDescription });
    await page.reload();
    await page.locator('[data-action="open-create-modal"]').tap();
    await expect(title).toHaveText(draftTitle);
    await description.focus();
    await expect(title).toHaveText('Draft 👩🏽‍💻 reference');
    await expect(title.locator('a')).toHaveAttribute('href', 'https://example.com/draft');
    await expect(description).toHaveText(draftDescription, { useInnerText: true });
    // Mounting a recovered draft must not import the previous reminder's history.
    await title.focus();
    await title.press('ControlOrMeta+z');
    await description.focus();
    await expect(title).toHaveText('Draft 👩🏽‍💻 reference');
    const createPromise = page.waitForRequest(request => request.url().endsWith('/reminders/create') && request.method() === 'POST');
    await page.getByRole('button', { name: 'Add reminder', exact: true }).tap();
    const created = (await createPromise).postDataJSON();
    assert.equal(created.content, draftTitle);
    assert.equal(created.description, draftDescription);
    await expect(title).toBeHidden();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('crate-reminder-draft:Reminders:new'))).toBeNull();
    for (const [schedule, daysOfWeek, interval, hour = 9] of [
      ['every Monday to Friday 09:00', [1, 2, 3, 4, 5], undefined],
      ['every weekend 09:00', [0, 6], undefined],
      ['every weekday 09:00', [1, 2, 3, 4, 5], undefined],
      ['every other Monday 09:00', [1], 2],
      ['every Tuesdays 09:00', [2], undefined],
      ['every morning', undefined, undefined, 6],
      ['every Monday morning', [1], undefined, 6],
      ['every Thurs 09:00', [4], undefined],
      ['every Monday at 9 in the morning', [1], undefined],
      ['daily at 3 in the afternoon', undefined, undefined, 15],
      ["every 2 weeks on Mon, Wed at 9 o'clock", [1, 3], 2],
    ]) {
      await page.locator('[data-action="open-create-modal"]').tap();
      await replaceTitle(`Task ${schedule}`);
      await expect(title.locator('.rich-text-chip-date')).toHaveText(schedule);
      const recurrenceRequest = page.waitForRequest(request => request.url().endsWith('/reminders/create') && request.method() === 'POST');
      await page.getByRole('button', { name: 'Add reminder', exact: true }).tap();
      const body = (await recurrenceRequest).postDataJSON();
      assert.equal(body.content, 'Task');
      assert.equal(body.recurrence.frequency, daysOfWeek ? 'weekly' : 'daily');
      assert.deepEqual(body.recurrence.daysOfWeek, daysOfWeek);
      assert.equal(body.recurrence.interval, interval);
      assert.equal(body.recurrence.hour, hour);
      assert.equal(body.recurrence.minute, 0);
      await expect(title).toBeHidden();
    }
    await page.locator('[data-action="open-create-modal"]').tap();
    await replaceTitle('Task #Personal then #Work tail');
    await title.locator('.rich-text-chip-project').evaluate(element => {
      const text = element.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error('Missing project text');
      document.getSelection().setBaseAndExtent(text, 3, text, 3);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await title.press('Backspace');
    await expect(title).toHaveText('Task #Personal then #Wrk tail');
    await expect(page.getByRole('option', { name: 'Work', exact: true })).toBeVisible();
    await title.press('Enter');
    await expect(title).toHaveText('Task #Personal then #Work tail');
    await title.pressSequentially('new ');
    await expect(title).toHaveText('Task #Personal then #Work new tail');
    const projectRequest = page.waitForRequest(request => request.url().endsWith('/reminders/create') && request.method() === 'POST');
    await page.getByRole('button', { name: 'Add reminder', exact: true }).tap();
    const projectBody = (await projectRequest).postDataJSON();
    assert.equal(projectBody.content, 'Task #Personal then new tail');
    assert.equal(projectBody.project, 'Work');
    await expect(title).toBeHidden();
    for (const content of ['Email monday@example.com', 'Review Monday.md', 'Open /notes/Friday.md',
      'Task February 30 at 9 in the morning', 'Task 2027-02-29 at noon', 'Task 02/30/2027 09:00']) {
      await page.locator('[data-action="open-create-modal"]').tap();
      await replaceTitle(content);
      await expect(title.locator('.rich-text-chip-date')).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      const request = page.waitForRequest(request => request.url().endsWith('/reminders/create') && request.method() === 'POST');
      await page.getByRole('button', { name: 'Add reminder', exact: true }).tap();
      const body = (await request).postDataJSON();
      assert.equal(body.content, content);
      assert.equal(body.dueDate, null);
      assert.equal(body.dueDatetime, null);
      await expect(title).toBeHidden();
    }
    await page.locator('[data-action="switch-tab"][data-tab="projects"]').tap();
    await page.locator('[data-action="open-project"][data-project="Work"]').tap();
    await page.locator('[data-action="open-create-modal"]').tap();
    await replaceTitle('Inbox selection regression');
    const projectChip = page.locator('.reminder-action-chips [data-picker="project"]');
    await expect(projectChip).toHaveText('Work');
    await projectChip.tap();
    await page.getByRole('option', { name: 'Inbox', exact: true }).tap();
    await expect(projectChip).toHaveText('Inbox');
    await page.getByRole('button', { name: 'Set priority', exact: true }).tap();
    await expect(projectChip).toHaveText('Inbox');
    const inboxRequest = page.waitForRequest(request => request.url().endsWith('/reminders/create') && request.method() === 'POST');
    await page.getByRole('button', { name: 'Add reminder', exact: true }).tap();
    const inboxBody = (await inboxRequest).postDataJSON();
    assert.equal(inboxBody.content, 'Inbox selection regression');
    assert.equal(inboxBody.project, 'Inbox');
    assert.equal(inboxBody.priority, 1);
    await expect(title).toBeHidden();
    await verifyRepeatPicker(browser, server);
    await verifyChronoSchedules(browser, server);
    await verifyRecurrenceTimezones(browser, server);
    assert.deepEqual(errors, []);
    console.log(`${browserType.name()}: Editor autocomplete after links, caret, undo/redo, marker preservation, schedule validation, saved Markdown, draft reload, validation and history isolation passed`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function verifyChronoSchedules(browser, server) {
  const origin = `http://127.0.0.1:${server.address().port}`;
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

async function verifyRecurrenceTimezones(browser, server) {
  const origin = `http://127.0.0.1:${server.address().port}`;
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


async function verifyRepeatPicker(browser, server) {
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const scenario of ['unchanged', 'reverted', 'all-day', 'implicit monthly', 'change', 'add', 'remove']) {
    await fetch(`${origin}/preview/reset`, { method: 'POST' });
    const page = await browser.newPage({ timezoneId: 'Europe/Berlin', viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
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
      await page.locator('.reminder-action-chips [data-picker="recurrence"]').tap();
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
      if (!['change', 'add', 'remove'].includes(scenario)) {
        await expect(title).toHaveText(initialTitle);
        // Reopening must not leave stale picker state that changes a later Done.
        await page.locator('.reminder-action-chips [data-picker="recurrence"]').tap();
        await page.getByRole('button', { name: 'Done', exact: true }).tap();
      }
      const request = page.waitForRequest(request => request.url().endsWith('/reminders/update') && request.method() === 'POST');
      await page.getByRole('button', { name: 'Save reminder', exact: true }).tap();
      const body = (await request).postDataJSON();
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
