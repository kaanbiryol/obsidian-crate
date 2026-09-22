import { test, expect, type Locator } from '@playwright/test';
import type { Reminder } from '../../src/reminders/types';

// Only the public editor API, browser editing operations and Markdown output
// are part of this contract. No implementation names, node classes or model APIs.
async function range(editor: Locator, anchor: number, focus = anchor) {
  await editor.evaluate((element, offsets) => {
    (element as HTMLElement).focus();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const point = (offset: number): [Node, number] => {
      for (const node of nodes) {
        if (offset <= node.length) return [node, offset];
        offset -= node.length;
      }
      throw new Error('Requested selection outside editor');
    };
    const [a, ao] = point(offsets.anchor);
    const [f, fo] = point(offsets.focus);
    document.getSelection()!.setBaseAndExtent(a, ao, f, fo);
    document.dispatchEvent(new Event('selectionchange'));
  }, { anchor, focus });
}
async function expectCaret(editor: Locator, offset: number) {
  await expect.poll(() => editor.evaluate(element => {
    const selection = element.ownerDocument.getSelection() as (Selection & {
      getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[];
    }) | null;
    if (!selection?.rangeCount) return -1;
    let selected: AbstractRange | undefined = selection.getRangeAt(0);
    const root = element.getRootNode();
    // WebKit retargets ordinary selection access to the shadow host.
    if (root instanceof ShadowRoot && selection.getComposedRanges) {
      selected = selection.getComposedRanges({ shadowRoots: [root] })[0] ?? selected;
    }
    if (!selected || !element.contains(selected.endContainer)) return -1;
    const prefix = element.ownerDocument.createRange();
    prefix.setStart(element, 0);
    prefix.setEnd(selected.endContainer, selected.endOffset);
    return prefix.toString().length;
  })).toBe(offset);
}
async function paste(editor: Locator, text: string) {
  await editor.evaluate((element, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    data.setData('text/html', '<b>Unexpected HTML</b><img src=x onerror="window.injected=true">');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, text);
}
const errors = new WeakMap<object, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });
async function open(page: import('@playwright/test').Page, host: unknown, value: string, autoFocus = false) {
  if (host !== 'pwa' && host !== 'plugin') throw new Error('Unknown test host');
  await page.goto(`/?host=${host}&value=${encodeURIComponent(value)}&autofocus=${autoFocus}`);
  const editor = page.getByRole('textbox', { name: 'Reminder', exact: true });
  await expect(editor).toBeVisible();
  await expect(page.getByTestId('value')).toHaveJSProperty('textContent', value);
  return { editor, output: page.getByTestId('value') };
}

const recurringReminder: Reminder = {
  id: 'edit-recurrence', content: 'Task', project: 'Inbox', priority: 4, completed: false,
  dueDatetime: '2026-09-28T09:00:37.123Z',
  recurrence: { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, timezone: 'UTC', count: 5, completedCount: 2 },
};

async function openDraft(page: import('@playwright/test').Page, host: unknown, reminder = recurringReminder) {
  if (host !== 'pwa' && host !== 'plugin') throw new Error('Unknown test host');
  await page.clock.install({ time: new Date('2026-09-21T13:00:00Z') });
  await page.goto(`/?fixture=draft&host=${host}&reminder=${encodeURIComponent(JSON.stringify(reminder))}`);
  const editor = page.getByRole('textbox', { name: 'Reminder title', exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

test('relative schedules settle without repeatedly updating their own draft', async ({ page }, info) => {
  // Advance by 1 ms on each clock read so a fast render cannot conceal a
  // date-parsing effect that continually schedules itself again.
  await page.addInitScript(() => {
    const OriginalDate = Date;
    let elapsed = 0;
    const reference = OriginalDate.parse('2026-09-21T13:00:00Z');
    globalThis.Date = new Proxy(OriginalDate, {
      construct(target, args: unknown[]) { return Reflect.construct(target, args.length ? args : [reference + elapsed++]) as Date; },
    });
  });
  const renderErrors: string[] = [];
  page.on('console', message => { if (message.text().includes('Maximum update depth')) renderErrors.push(message.text()); });
  await page.goto(`/?fixture=draft&host=${String(info.project.metadata.host)}`);
  const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
  await title.click();
  await page.keyboard.insertText('Call Alex in 5 minutes');
  const readDraft = async () => JSON.parse((await page.getByTestId('draft').textContent())!) as { dueDate: string; hasTime: boolean };
  await expect.poll(async () => (await readDraft()).hasTime).toBe(true);
  const dueDate = (await readDraft()).dueDate;
  await page.getByRole('textbox', { name: 'Reminder description', exact: true }).fill('Follow up');
  expect((await readDraft()).dueDate).toBe(dueDate);
  expect(renderErrors).toEqual([]);
});

for (const [schedule, dueDatetime, content = 'Call Alex', datePart = schedule] of [
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
] as const) {
  test(`Chrono schedules save and reopen with the same instant: ${schedule}`, async ({ page }, info) => {
    await page.clock.setFixedTime(new Date('2026-09-21T13:00:37.123Z'));
    const params = new URLSearchParams({ fixture: 'modal', host: String(info.project.metadata.host) });
    await page.goto(`/?${params}`);
    const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
    await title.click();
    await page.keyboard.insertText(`Call Alex ${schedule}`);
    await expect(title.locator('.rich-text-chip-date')).toHaveText(datePart);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
    await expect.poll(async () => JSON.parse((await page.getByTestId('saved').textContent()) || 'null') as unknown)
      .toMatchObject({ content, dueDate: dueDatetime });
    params.set('reminder', JSON.stringify({ id: 'chrono-reopen', content, project: 'Inbox',
      priority: 4, completed: false, dueDatetime }));
    await page.goto(`/?${params}`);
    await expect(title).toContainText(content);
    await page.getByRole('button', { name: 'Save reminder', exact: true }).click();
    await expect.poll(async () => JSON.parse((await page.getByTestId('saved').textContent()) || 'null') as unknown)
      .toMatchObject({ content, dueDatetime });
  });
}

test('weekday title text survives reopening an all-day reminder and changing its priority', async ({ page }, info) => {
  await page.clock.setFixedTime(new Date('2026-09-21T13:00:37.123Z'));
  const reminder = { id: 'weekday-title', content: 'Notes from Monday', project: 'Inbox',
    priority: 4, completed: false, dueDate: '2026-09-25' };
  const params = new URLSearchParams({ fixture: 'modal', host: String(info.project.metadata.host), reminder: JSON.stringify(reminder) });
  await page.goto(`/?${params}`);
  const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
  await expect(title).toContainText(reminder.content);
  await expect(title.locator('.rich-text-chip-date')).toHaveText('Sep 25, 2026');
  await page.getByRole('button', { name: 'Set priority', exact: true }).click();
  await expect(title).toContainText(reminder.content);
  await page.getByRole('button', { name: 'Save reminder', exact: true }).click();
  await expect.poll(async () => JSON.parse((await page.getByTestId('saved').textContent()) || 'null') as unknown)
    .toMatchObject({ content: reminder.content, dueDate: reminder.dueDate, priority: 1 });
});

for (const [timezone, dueDatetime] of [
  ['America/New_York', '2026-09-28T13:00:37.123Z'],
  ['+05:30', '2026-09-28T03:30:37.123Z'],
  ['-03:30', '2026-09-28T12:30:37.123Z'],
] as const) {
  test(`recurrence timezone survives creation, reopening and picker edits: ${timezone}`, async ({ page }, info) => {
    await page.clock.setFixedTime(new Date('2026-09-21T13:00:37.123Z'));
    const params = new URLSearchParams({ fixture: 'modal', host: String(info.project.metadata.host) });
    await page.goto(`/?${params}`);
    const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
    const schedule = `every week Monday 09:00 ${timezone}`;
    await title.click();
    await page.keyboard.insertText(`Compare Monday with ${schedule}`);
    await expect(title.locator('.rich-text-chip-date')).toHaveText(schedule);
    await expect(title).toHaveText(`Compare Monday with ${schedule}`);
    await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
    const readSaved = async () => JSON.parse((await page.getByTestId('saved').textContent()) || 'null') as Reminder;
    await expect.poll(readSaved).toMatchObject({ content: 'Compare Monday with',
      recurrence: { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, timezone } });
    const reminder = { ...recurringReminder, content: 'Call Alex', dueDatetime,
      recurrence: { ...recurringReminder.recurrence!, timezone, endDate: '2027-12-31' } };
    params.set('reminder', JSON.stringify(reminder));
    await page.goto(`/?${params}`);
    await expect(title.locator('.rich-text-chip-date')).toContainText(timezone);
    await page.getByRole('button', { name: 'Set priority', exact: true }).click();
    await page.locator('.reminder-action-chips [data-picker="project"]').click();
    await page.getByRole('option', { name: 'Work', exact: true }).click();
    await page.getByRole('button', { name: 'Save reminder', exact: true }).click();
    await expect.poll(readSaved).toMatchObject({ content: 'Call Alex', project: 'Work', priority: 1,
      dueDatetime, recurrence: reminder.recurrence });
    params.set('reminder', JSON.stringify(await readSaved()));
    await page.goto(`/?${params}`);
    await page.locator('.reminder-action-chips [data-picker="recurrence"]').click();
    await page.getByLabel('Reminder time', { exact: true }).fill('10:30');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(title.locator('.rich-text-chip-date')).toHaveText(`every Mon 10:30 ${timezone}`);
    await page.getByRole('button', { name: 'Save reminder', exact: true }).click();
    await expect.poll(readSaved).toMatchObject({ recurrence: { timezone, hour: 10, minute: 30 } });
    expect((await readSaved()).dueDatetime).toBeUndefined();
  });
}

test('invalid timezone input blocks button and Enter submission and remains correctable', async ({ page }, info) => {
  await page.goto(`/?fixture=modal&host=${String(info.project.metadata.host)}`);
  const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
  for (const schedule of ['every Monday 09:00 Europe/Invalid', 'tomorrow 09:00 UTC+', 'every Monday 09:00 UTC PST']) {
    const length = (await title.textContent())!.length;
    if (length) await range(title, 0, length);
    else await title.click();
    await page.keyboard.insertText(`Call Alex ${schedule}`);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(title.locator('.rich-text-chip-date')).toHaveCount(0);
    await title.press('Enter');
    await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
    await expect(title).toHaveText(`Call Alex ${schedule}`);
    await expect(page.getByTestId('saved')).toBeEmpty();
  }
  await range(title, 0, (await title.textContent())!.length);
  await page.keyboard.insertText('Call Alex every Monday 09:00 UTC');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await title.press('Enter');
  await expect.poll(async () => JSON.parse((await page.getByTestId('saved').textContent()) || 'null') as unknown)
    .toMatchObject({ content: 'Call Alex', recurrence: { timezone: 'UTC', hour: 9 } });
});

test('unsupported repeat wording blocks saving and can be corrected', async ({ page }, info) => {
  await page.goto(`/?fixture=modal&host=${String(info.project.metadata.host)}`);
  const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
  await title.click();
  await page.keyboard.insertText('Call Alex every two weeks Monday morning');
  await expect(page.getByRole('alert')).toContainText('Use digits for repeat intervals');
  await title.press('Enter');
  await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
  await expect(page.getByTestId('saved')).toBeEmpty();
  await expect(title).toHaveText('Call Alex every two weeks Monday morning');
  await range(title, 0, (await title.textContent())!.length);
  await page.keyboard.insertText('Call Alex every 2 weeks Monday morning');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await title.press('Enter');
  await expect.poll(async () => JSON.parse((await page.getByTestId('saved').textContent()) || 'null') as unknown)
    .toMatchObject({ content: 'Call Alex', recurrence: { frequency: 'weekly', interval: 2, daysOfWeek: [1], hour: 6, minute: 0 } });
});

for (const editing of [false, true]) {
  for (const submitWith of ['button', 'Enter'] as const) {
    test(`blocks metadata-only ${editing ? 'edits' : 'creation'} and allows a title via ${submitWith}`, async ({ page }, info) => {
      const params = new URLSearchParams({ fixture: 'modal', host: String(info.project.metadata.host) });
      if (editing) params.set('reminder', JSON.stringify(recurringReminder));
      await page.goto(`/?${params}`);
      const dialog = page.getByRole('dialog', { name: editing ? 'Edit reminder' : 'New reminder', exact: true });
      const editor = page.getByRole('textbox', { name: 'Reminder title', exact: true });
      const save = page.getByRole('button', { name: editing ? 'Save reminder' : 'Add reminder', exact: true });
      await expect(editor).toBeEditable();
      await page.getByRole('textbox', { name: 'Reminder description', exact: true }).fill('Description alone is insufficient');
      for (const content of ['', 'every Monday', 'tomorrow', '09:00', '#Work ', '!', 'every Monday 09:00 #Work !']) {
        const length = (await editor.textContent())!.length;
        if (length) await range(editor, 0, length);
        else await editor.click();
        if (content) await page.keyboard.insertText(content);
        else if (length) await editor.press('Backspace');
        await expect(editor).toHaveText(content.trim());
        await expect(save).toBeDisabled();
        // The editor handles Enter separately from the disabled header action.
        await editor.press('Enter');
        await expect(dialog).toBeVisible();
        await expect(page.getByTestId('saved')).toBeEmpty();
      }
      await range(editor, 0);
      await page.keyboard.insertText('Finish report ');
      await expect(save).toBeEnabled();
      if (submitWith === 'Enter') await editor.press('Enter');
      else await save.click();
      await expect(dialog).toBeHidden();
      await expect.poll(async () => JSON.parse((await page.getByTestId('saved').textContent()) || 'null') as unknown)
        .toMatchObject({ content: 'Finish report', project: 'Work', priority: 1,
          recurrence: { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0 } });
    });
  }
}

for (const schedule of ['every Tuesday 10:00', 'every Monday']) {
  test(`clears the old occurrence when editing a saved recurrence: ${schedule}`, async ({ page }, info) => {
    const editor = await openDraft(page, info.project.metadata.host);
    await range(editor, 5, (await editor.textContent())!.length);
    await page.keyboard.insertText(schedule);
    await expect.poll(async () => JSON.parse((await page.getByTestId('draft').textContent())!) as unknown).toMatchObject({ dueDate: null });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const { updatedReminder } = JSON.parse((await page.getByTestId('saved').textContent())!) as { updatedReminder: Reminder };
    expect(updatedReminder.content).toBe('Task');
    expect(updatedReminder.dueDate).toBeUndefined();
    expect(updatedReminder.dueDatetime).toBeUndefined();
    expect(updatedReminder.recurrence).toMatchObject({ frequency: 'weekly', daysOfWeek: [schedule.includes('Tuesday') ? 2 : 1] });
    expect(updatedReminder.recurrence?.hour).toBe(schedule.includes('Tuesday') ? 10 : undefined);
  });
}

for (const timed of [true, false]) {
  test(`deleting saved recurrence text clears its hidden date (${timed ? 'timed' : 'all-day'})`, async ({ page }, info) => {
    const reminder = timed ? recurringReminder : { ...recurringReminder, dueDatetime: undefined, dueDate: '2026-09-28',
      recurrence: { frequency: 'weekly' as const, daysOfWeek: [1], timezone: 'UTC' } };
    const editor = await openDraft(page, info.project.metadata.host, reminder);
    await range(editor, 4, (await editor.textContent())!.length);
    await editor.press('Backspace');
    await expect.poll(async () => JSON.parse((await page.getByTestId('draft').textContent())!) as unknown).toEqual({ content: 'Task', dueDate: null, hasTime: false });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const { updatedReminder } = JSON.parse((await page.getByTestId('saved').textContent())!) as { updatedReminder: Reminder };
    expect(updatedReminder.content).toBe('Task');
    expect(updatedReminder.recurrence).toBeUndefined();
    expect(updatedReminder.dueDate).toBeUndefined();
    expect(updatedReminder.dueDatetime).toBeUndefined();
  });
}

test('adding recurrence to a saved one-off reminder clears its old occurrence', async ({ page }, info) => {
  const editor = await openDraft(page, info.project.metadata.host, { ...recurringReminder, recurrence: undefined });
  await range(editor, 5, (await editor.textContent())!.length);
  await page.keyboard.insertText('every Tuesday 10:00');
  await expect.poll(async () => JSON.parse((await page.getByTestId('draft').textContent())!) as unknown).toMatchObject({ dueDate: null });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const { updatedReminder } = JSON.parse((await page.getByTestId('saved').textContent())!) as { updatedReminder: Reminder };
  expect(updatedReminder.dueDate).toBeUndefined();
  expect(updatedReminder.dueDatetime).toBeUndefined();
  expect(updatedReminder.recurrence).toMatchObject({ frequency: 'weekly', daysOfWeek: [2], hour: 10, minute: 0 });
});

test('editing only the title keeps the saved recurrence occurrence and metadata', async ({ page }, info) => {
  const editor = await openDraft(page, info.project.metadata.host);
  await range(editor, 0, 4);
  await page.keyboard.insertText('Renamed task');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const { updatedReminder } = JSON.parse((await page.getByTestId('saved').textContent())!) as { updatedReminder: Reminder };
  expect(updatedReminder).toMatchObject({ content: 'Renamed task', dueDatetime: recurringReminder.dueDatetime, recurrence: recurringReminder.recurrence });
});

for (const kind of ['timed', 'all-day', 'implicit monthly'] as const) {
  for (const revert of [false, true]) {
    test(`unchanged repeat picker preserves the saved schedule (${kind}, revert=${revert})`, async ({ page }, info) => {
      const recurrence = { ...recurringReminder.recurrence!, timezone: 'America/New_York', endDate: '2027-12-31' };
      const reminder: Reminder = kind === 'timed'
        ? { ...recurringReminder, recurrence }
        : { ...recurringReminder, dueDatetime: undefined, dueDate: '2026-10-28',
          recurrence: kind === 'all-day'
            ? { ...recurrence, hour: undefined, minute: undefined }
            : { ...recurrence, frequency: 'monthly', daysOfWeek: undefined, hour: undefined, minute: undefined } };
      await openDraft(page, info.project.metadata.host, reminder);
      const original = await page.getByTestId('draft').textContent();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const originalSave = await page.getByTestId('saved').textContent();
      for (let visit = 0; visit < 2; visit++) {
        await page.getByRole('button', { name: 'Choose repeat', exact: true }).click();
        if (revert) {
          await page.getByRole('button', { name: 'Increase every', exact: true }).click();
          await page.getByRole('button', { name: 'Decrease every', exact: true }).click();
        }
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Repeat reminder', exact: true })).toBeHidden();
        await expect(page.getByTestId('draft')).toHaveText(original!);
      }
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByTestId('saved')).toHaveText(originalSave!);
      const { updatedReminder } = JSON.parse((await page.getByTestId('saved').textContent())!) as { updatedReminder: Reminder };
      expect(updatedReminder.recurrence).toEqual(JSON.parse(JSON.stringify(reminder.recurrence)));
      if (kind !== 'timed') expect(updatedReminder.dueDate).toBe(reminder.dueDate);
      expect(updatedReminder.dueDatetime).toBe(reminder.dueDatetime);
    });
  }
}

for (const action of ['change', 'add', 'remove'] as const) {
  test(`repeat picker still applies an actual ${action}`, async ({ page }, info) => {
    await openDraft(page, info.project.metadata.host, action === 'add'
      ? { ...recurringReminder, recurrence: undefined } : recurringReminder);
    await page.getByRole('button', { name: 'Choose repeat', exact: true }).click();
    if (action === 'change') await page.getByLabel('Reminder time', { exact: true }).fill('10:30');
    await page.getByRole('button', { name: action === 'remove' ? 'Remove repeat' : 'Done', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Repeat reminder', exact: true })).toBeHidden();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const { updatedReminder } = JSON.parse((await page.getByTestId('saved').textContent())!) as { updatedReminder: Reminder };
    if (action === 'remove') expect(updatedReminder.recurrence).toBeUndefined();
    else {
      expect(updatedReminder.recurrence).toMatchObject(action === 'add'
        ? { frequency: 'daily', hour: 9, minute: 0 } : { frequency: 'weekly', hour: 10, minute: 30 });
    }
    expect(updatedReminder.dueDate).toBeUndefined();
    expect(updatedReminder.dueDatetime).toBeUndefined();
  });
}

for (const timed of [true, false]) {
  test(`Remove repeat clears the entire schedule through save and reopen (${timed ? 'timed' : 'all-day'})`, async ({ page }, info) => {
    const reminder: Reminder = { ...recurringReminder, project: 'Work', priority: 1, description: 'Keep these notes',
      ...(timed ? {} : { dueDatetime: undefined, dueDate: '2026-09-28',
        recurrence: { frequency: 'weekly', daysOfWeek: [1], timezone: 'UTC' } }) };
    const params = new URLSearchParams({ fixture: 'modal', host: String(info.project.metadata.host), reminder: JSON.stringify(reminder) });
    await page.goto(`/?${params}`);
    const editor = page.getByRole('textbox', { name: 'Reminder title', exact: true });
    await expect(editor).toBeEditable();
    await page.locator('.reminder-action-chips [data-picker="recurrence"]').click();
    await page.getByRole('button', { name: 'Remove repeat', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Repeat reminder', exact: true })).toBeHidden();
    await expect(page.locator('.reminder-action-chips [data-picker="date"]')).toHaveText('Date');
    await expect(editor).toHaveText('Task #Work !');
    await page.getByRole('button', { name: 'Save reminder', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Edit reminder', exact: true })).toBeHidden();
    const saved = JSON.parse((await page.getByTestId('saved').textContent())!) as Reminder;
    expect(saved).toMatchObject({ content: 'Task', description: reminder.description, project: 'Work', priority: 1 });
    expect(saved.recurrence).toBeUndefined();
    expect(saved.dueDate).toBeUndefined();
    expect(saved.dueDatetime).toBeUndefined();
    params.set('reminder', JSON.stringify(saved));
    await page.goto(`/?${params}`);
    await expect(editor).toHaveText('Task #Work !');
    await expect(page.locator('.reminder-action-chips [data-picker="date"]')).toHaveText('Date');
  });
}

for (const date of ['02/30/2027 09:00', '31.04.2027 09:00', '04-31-2027 09:00', '2027-2-30 09:00',
  'February 30 at 9 in the morning', '2027-02-29 at noon']) {
  test(`unmatched calendar text clears the old schedule and saves unchanged: ${date}`, async ({ page }, info) => {
    const editor = await openDraft(page, info.project.metadata.host);
    await range(editor, 0, (await editor.textContent())!.length);
    await page.keyboard.insertText(`Task ${date}`);
    await expect(page.getByTestId('draft')).toContainText(`Task ${date}`);
    await expect(editor.locator('.rich-text-chip-date')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const { updatedReminder } = JSON.parse((await page.getByTestId('saved').textContent())!) as { updatedReminder: Reminder };
    expect(updatedReminder.content).toBe(`Task ${date}`);
    expect(updatedReminder.dueDate).toBeUndefined();
    expect(updatedReminder.dueDatetime).toBeUndefined();
    expect(updatedReminder.recurrence).toBeUndefined();
  });
}

test('keeps Inbox selected when creating in Work and changing priority', async ({ page }, info) => {
  const host = info.project.metadata.host as string;
  await page.goto(`/?fixture=draft&host=${host}&defaultProject=Work`);
  const editor = page.getByRole('textbox', { name: 'Reminder title', exact: true });
  await editor.click();
  await editor.pressSequentially('Task');
  await page.getByRole('button', { name: 'Choose project', exact: true }).click();
  await page.getByRole('option', { name: 'Inbox', exact: true }).click();
  await expect(page.getByTestId('project')).toHaveText('Inbox');
  await page.getByRole('button', { name: 'Toggle priority', exact: true }).click();
  await expect(page.getByTestId('project')).toHaveText('Inbox');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(JSON.parse((await page.getByTestId('saved').textContent())!)).toMatchObject({ content: 'Task', project: 'Inbox', priority: 1 });
});

for (const literal of ['monday@example.com', 'sales@friday.com', 'monday.com', 'Monday.md', 'weekly.csv', '/notes/Friday.md']) {
  test(`preserves addresses and filenames while recognizing a separate date: ${literal}`, async ({ page }, info) => {
    const { editor, output } = await open(page, info.project.metadata.host, '');
    await editor.click();
    await editor.pressSequentially(`Review ${literal}`);
    await expect(output).toHaveText(`Review ${literal}`);
    await expect(editor.locator('.rich-text-chip-date')).toHaveCount(0);
    await editor.pressSequentially(' tomorrow 09:00');
    await expect(editor.locator('.rich-text-chip-date')).toHaveText('tomorrow 09:00');
    await expect.poll(async () => JSON.parse((await page.getByTestId('parsed').textContent())!) as unknown).toMatchObject({ cleanContent: `Review ${literal}` });
  });
}

for (const value of ['', 'Plain reminder', '  padded text  ', 'first\nsecond\n第三行 👩🏽‍💻', 'Review [docs](https://example.com) #Work ! tomorrow']) {
  test(`loads and remounts exact Markdown ${JSON.stringify(value)}`, async ({ page }, info) => {
    const { editor, output } = await open(page, info.project.metadata.host, value);
    await page.getByRole('button', { name: 'Remount', exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(output).toHaveJSProperty('textContent', value);
    if (value.includes('[docs]')) await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com');
    await page.getByRole('button', { name: 'Focus end', exact: true }).click();
    await page.keyboard.insertText('X');
    await expect(output).toHaveJSProperty('textContent', value + 'X');
  });
}
test('inserts at the start, middle and end without losing caret position', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'abcdef');
  await range(editor, 3); await page.keyboard.type('XY');
  await expect(output).toHaveText('abcXYdef');
  await range(editor, 0); await page.keyboard.type('start ');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click();
  await page.keyboard.type(' end');
  await expect(output).toHaveText('start abcXYdef end');
});
for (const backward of [false, true]) {
  test(`replaces ${backward ? 'backward' : 'forward'} selection across link and project`, async ({ page }, info) => {
    const value = 'Start [docs](https://example.com) #Work end';
    const { editor, output } = await open(page, info.project.metadata.host, value);
    await range(editor, backward ? 16 : 6, backward ? 6 : 16);
    await page.keyboard.insertText('replacement');
    await expect(output).toHaveText('Start replacement end');
    await editor.press('ControlOrMeta+z'); await expect(output).toHaveText(value);
    await editor.press('ControlOrMeta+Shift+z'); await expect(output).toHaveText('Start replacement end');
  });
}
test('edits a link label without changing its URL', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Read [docs](https://example.com) now');
  await range(editor, 7); await page.keyboard.type('NEW');
  await expect(output).toHaveText('Read [doNEWcs](https://example.com) now');
  // The active link exposes Markdown; blur restores its rendered anchor.
  await page.getByRole('button', { name: 'Blur editor', exact: true }).click();
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com');
});
test('deletes an entire link and restores it with undo', async ({ page }, info) => {
  const value = 'A [docs](https://example.com) B';
  const { editor, output } = await open(page, info.project.metadata.host, value);
  await range(editor, 2, 6); await page.keyboard.press('Backspace');
  await expect(output).toHaveText('A  B'); await expect(editor.locator('a')).toHaveCount(0);
  await editor.press('ControlOrMeta+z'); await expect(output).toHaveText(value);
});
test('edits inside a project marker as ordinary text', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Plan #Work');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click();
  await page.keyboard.press('Backspace'); await expect(output).toHaveText('Plan #Wor');
  await page.keyboard.type('k !'); await expect(output).toHaveText('Plan #Work !');
  await range(editor, 5, 10); await page.keyboard.insertText('today');
  await expect(output).toHaveText('Plan today !');
});
test('pastes multiline Unicode as text and round-trips paste history', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Replace me');
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  const text = '👩🏽‍💻 café e\u0301\n第二行 #Work !\n<script>literal</script>';
  await paste(editor, text); await expect(output).toHaveJSProperty('textContent', text);
  await expect(editor.locator('b, img, script')).toHaveCount(0);
  await editor.press('ControlOrMeta+z'); await expect(output).toHaveText('Replace me');
  await editor.press('ControlOrMeta+Shift+z'); await expect(output).toHaveJSProperty('textContent', text);
});
test('preserves duplicate markers on paste', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Old');
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await paste(editor, 'Read [docs](https://example.com) #Crate Demo #Work ! !');
  await expect(output).toHaveText('Read [docs](https://example.com) #Crate Demo #Work ! !');
});

for (const [schedule, recurrence] of [
  ['every Monday at 9 in the morning', { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0 }],
  ['daily at 3 in the afternoon', { frequency: 'daily', hour: 15, minute: 0 }],
  ["every 2 weeks on Mon, Wed at 9 o'clock", { frequency: 'weekly', interval: 2, daysOfWeek: [1, 3], hour: 9, minute: 0 }],
  ['monthly on the 15th at 9.30', { frequency: 'monthly', dayOfMonth: 15, hour: 9, minute: 30 }],
  ['every Mon. at 9 in the morning UTC', { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, timezone: 'UTC' }],
  ['every morning', { frequency: 'daily', hour: 6, minute: 0 }],
  ['every Monday morning', { frequency: 'weekly', daysOfWeek: [1], hour: 6, minute: 0 }],
  ['every Thurs 09:00', { frequency: 'weekly', daysOfWeek: [4], hour: 9, minute: 0 }],
  ['every Monday morning at 09:30 UTC', { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 30, timezone: 'UTC' }],
  ['every Monday to Friday 09:00', { frequency: 'weekly', daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0 }],
  ['every weekend 09:00', { frequency: 'weekly', daysOfWeek: [0, 6], hour: 9, minute: 0 }],
  ['every weekday and Saturday 09:00', { frequency: 'weekly', daysOfWeek: [1, 2, 3, 4, 5, 6], hour: 9, minute: 0 }],
  ['every weekday 09:00', { frequency: 'weekly', daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0 }],
  ['every other Monday 09:00', { frequency: 'weekly', interval: 2, daysOfWeek: [1], hour: 9, minute: 0 }],
  ['every Tuesdays 09:00', { frequency: 'weekly', daysOfWeek: [2], hour: 9, minute: 0 }],
  ['every Monday at noon', { frequency: 'weekly', daysOfWeek: [1], hour: 12, minute: 0 }],
  ['monthly on the last day 09:00', { frequency: 'monthly', dayOfMonth: 31, hour: 9, minute: 0 }],
  ['daily at midnight', { frequency: 'daily', hour: 0, minute: 0 }],
  ['every week Monday 09:00', { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0 }],
  ['weekly on Monday at 09:00', { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0 }],
  ['every 2 weeks Mon, Wed, and Fri 09:00', { frequency: 'weekly', interval: 2, daysOfWeek: [1, 3, 5], hour: 9, minute: 0 }],
  ['daily at 9 pm', { frequency: 'daily', hour: 21, minute: 0 }],
  ['monthly on the 15th at 09:00', { frequency: 'monthly', dayOfMonth: 15, hour: 9, minute: 0 }],
] as const) {
  test(`keeps recurrence through typing, paste and remount: ${schedule}`, async ({ page }, info) => {
    const { editor, output } = await open(page, info.project.metadata.host, 'Task ');
    await page.getByRole('button', { name: 'Focus end', exact: true }).click();
    // Type each word through native key events: a space commits schedule changes.
    let expected = 'Task ';
    for (const word of schedule.split(' ')) {
      expected += `${word} `;
      await page.keyboard.type(`${word} `);
      await expect(output).toHaveJSProperty('textContent', expected);
      await expectCaret(editor, expected.length);
    }
    const expectSchedule = async () => {
      await expect.poll(async () => JSON.parse((await page.getByTestId('parsed').textContent())!) as unknown).toMatchObject({
        cleanContent: 'Task', recurrencePart: schedule, recurrence,
      });
      await expect(editor.locator('.rich-text-chip-date')).toHaveText(schedule);
    };
    await expectSchedule();
    await page.getByRole('button', { name: 'Select all', exact: true }).click();
    await paste(editor, expected);
    await expect(output).toHaveJSProperty('textContent', expected);
    await expectSchedule();
    await page.getByRole('button', { name: 'Remount', exact: true }).click();
    await expectSchedule();
  });
}

test('edits a recurring weekday and time in place without resetting the schedule', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Task every week Monday 09:00 #Work !');
  await range(editor, 16, 22);
  await page.keyboard.type('Wednesday');
  await expect(output).toHaveText('Task every week Wednesday 09:00 #Work !');
  await range(editor, 26, 31);
  await page.keyboard.type('10:30');
  await expect(output).toHaveText('Task every week Wednesday 10:30 #Work !');
  await expect.poll(async () => JSON.parse((await page.getByTestId('parsed').textContent())!) as unknown).toMatchObject({
    cleanContent: 'Task', project: 'Work', priority: 1,
    recurrence: { frequency: 'weekly', daysOfWeek: [3], hour: 10, minute: 30 },
  });
  await expect(editor.locator('.rich-text-chip-date')).toHaveText('every week Wednesday 10:30');
});

for (const [text, active] of [
  ['Compare Monday with Friday ', 'Friday'],
  ['Compare Monday to Friday ', 'Friday'],
  ['Review weekly report tomorrow ', 'tomorrow'],
  ['Task every Monday Friday ', 'Friday'],
  ['Task Tuesday Tuesday ', 'Tuesday'],
  ['Task #Crate Demo #Work ! ! Monday Friday ', 'Friday'],
]) {
  test(`preserves all text while the last schedule becomes active: ${text}`, async ({ page }, info) => {
    const { editor, output } = await open(page, info.project.metadata.host, '');
    await page.getByRole('button', { name: 'Focus end', exact: true }).click();
    let expected = '';
    for (const word of text!.trimEnd().split(' ')) {
      expected += `${word} `;
      await page.keyboard.type(`${word} `);
      await expect(output).toHaveJSProperty('textContent', expected);
      await expectCaret(editor, expected.length);
    }
    await expect(editor.locator('.rich-text-chip-date')).toHaveText(active!);
    await editor.press('ControlOrMeta+a');
    await expect.poll(() => editor.evaluate(element =>
      element.ownerDocument.getSelection()?.toString().replace(/\u00a0/g, ' ').trimEnd(),
    )).toBe(text!.trimEnd());
    await paste(editor, text!);
    await expect(output).toHaveJSProperty('textContent', text);
    await expect(editor.locator('.rich-text-chip-date')).toHaveText(active!);
  });
}

test('keeps earlier text when deleting, undoing and redoing the active date', async ({ page }, info) => {
  const value = 'Compare Monday with Friday';
  const { editor, output } = await open(page, info.project.metadata.host, value);
  await range(editor, 20, 26);
  await page.keyboard.press('Backspace');
  await expect(output).toHaveText('Compare Monday with');
  await expect(editor.locator('.rich-text-chip-date')).toHaveText('Monday');
  await editor.press('ControlOrMeta+z');
  await expect(output).toHaveText(value);
  await expect(editor.locator('.rich-text-chip-date')).toHaveText('Friday');
  await editor.press('ControlOrMeta+Shift+z');
  await expect(output).toHaveText('Compare Monday with');
});

for (const date of ['2026-02-30', '2026-02-30 09:00', 'February 30 at 9 in the morning']) {
  test(`keeps the last Chrono match until unmatched text is corrected: ${date}`, async ({ page }, info) => {
    const { editor, output } = await open(page, info.project.metadata.host, 'Task tomorrow ');
    await page.getByRole('button', { name: 'Focus end', exact: true }).click();
    await page.keyboard.type(`${date} `);
    await expect(output).toHaveText(`Task tomorrow ${date}`);
    await expect(editor.locator('.rich-text-chip-date')).toHaveText('tomorrow');
    await expect.poll(async () => JSON.parse((await page.getByTestId('parsed').textContent())!) as unknown).toMatchObject({
      cleanContent: `Task ${date}`, datePart: 'tomorrow',
    });
    await expect(page.getByTestId('parsed')).not.toContainText('dateError');
    await page.getByRole('button', { name: 'Select all', exact: true }).click();
    await paste(editor, 'Task 2028-02-29');
    await expect(editor.locator('.rich-text-chip-date')).toHaveText('2028-02-29');
    await expect(page.getByTestId('parsed')).not.toContainText('dateError');
  });
}

for (const project of ['Café', 'Cafe\u0301', '日本語']) {
  test(`keeps an unknown Unicode project intact: ${project}`, async ({ page }, info) => {
    const { editor, output } = await open(page, info.project.metadata.host, 'Task ');
    await page.getByRole('button', { name: 'Focus end', exact: true }).click();
    await page.keyboard.type(`#${project} `);
    await expect(output).toHaveText(`Task #${project}`);
    await expect(editor.locator('.rich-text-chip-project')).toHaveText(`#${project}`);
    await expect.poll(async () => JSON.parse((await page.getByTestId('parsed').textContent())!) as unknown).toMatchObject({
      cleanContent: 'Task', project,
    });
  });
}

test('inserts and rejoins a newline', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'alphaomega');
  await range(editor, 5); await page.keyboard.press('Enter');
  await expect(output).toHaveJSProperty('textContent', 'alpha\nomega');
  await page.keyboard.press('Backspace'); await expect(output).toHaveText('alphaomega');
});
test('keeps project suggestions closed on focus and opens them when editing the project', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Buy coffee #Work', true);
  await expect(editor).toBeFocused();
  await expect(page.getByTestId('query')).toHaveText('(none)');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click();
  await expectCaret(editor, 'Buy coffee #Work'.length);
  await expect(page.getByTestId('query')).toHaveText('(none)');
  await expect(output).toHaveText('Buy coffee #Work');
  await page.keyboard.press('Backspace');
  await expect(page.getByTestId('query')).toHaveText('Wor');
  await page.keyboard.type('k ');
  await expect(page.getByTestId('query')).toHaveText('(none)');
});
test('reports autocomplete after a Markdown link and accepts a host keyboard action', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Read [docs](https://example.com) ');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click();
  await page.keyboard.type('#Wo'); await expect(page.getByTestId('query')).toHaveText('Wo');
  await page.keyboard.press('Tab');
  await expect(output).toHaveJSProperty('textContent', 'Read [docs](https://example.com) #Work ');
  // The original API restores selection asynchronously; wait for the actual caret.
  await expectCaret(editor, 'Read docs #Work '.length);
  await page.keyboard.type('next');
  await expect(output).toHaveText('Read [docs](https://example.com) #Work next');
});
test('external value preserves an active caret', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'abcdef');
  await page.getByRole('textbox', { name: 'External value' }).fill('uvwxyz');
  await range(editor, 3); await page.getByRole('button', { name: 'Apply external value', exact: true }).click();
  await expect(output).toHaveText('uvwxyz');
  await expectCaret(editor, 3);
  await page.keyboard.type('X'); await expect(output).toHaveText('uvwXxyz');
});
test('honors an explicit pending caret on external replacement', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Original');
  await page.getByRole('textbox', { name: 'External value' }).fill('Replacement');
  await editor.focus(); await page.getByRole('button', { name: 'Apply at offset two', exact: true }).click();
  await expect(output).toHaveText('Replacement');
  await expectCaret(editor, 2);
  await page.keyboard.type('X'); await expect(output).toHaveText('ReXplacement');
});
test('read-only toggling prevents edits and re-enables input', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Original');
  await page.getByRole('checkbox', { name: 'Read only' }).check();
  await expect(editor).toHaveAttribute('contenteditable', 'false'); await editor.click(); await page.keyboard.type('ignored');
  await expect(output).toHaveText('Original');
  await page.getByRole('checkbox', { name: 'Read only' }).uncheck();
  await page.getByRole('button', { name: 'Focus end', exact: true }).click(); await page.keyboard.type(' edited');
  await expect(output).toHaveText('Original edited');
});
test('focus request and host Escape handling work without editing content', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Original');
  await page.getByRole('button', { name: 'Request focus', exact: true }).click(); await expect(editor).toBeFocused();
  await page.keyboard.type('X'); await expect(output).toHaveText('OriginalX');
  await page.keyboard.press('Escape'); await expect(editor).not.toBeFocused();
});
test('two editor instances keep values and undo histories isolated', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'First');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click(); await page.keyboard.insertText(' one');
  const other = page.getByRole('textbox', { name: 'Other reminder', exact: true });
  await range(other, 14); await page.keyboard.insertText(' two');
  await other.press('ControlOrMeta+z'); await expect(page.getByTestId('other-value')).toHaveText('Other reminder');
  await expect(output).toHaveText('First one');
  await editor.focus(); await editor.press('ControlOrMeta+z'); await expect(output).toHaveText('First');
});
test('repeated remounts retain value but start a fresh history', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Original');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click(); await page.keyboard.insertText(' edit');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Remount', exact: true }).click();
  await editor.focus(); await editor.press('ControlOrMeta+z'); await expect(output).toHaveText('Original edit');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click(); await page.keyboard.type('X');
  await expect(output).toHaveText('Original editX');
});
test('select-all deletion can be undone back to the complete Markdown document', async ({ page }, info) => {
  const value = 'Read [docs](https://example.com) #Crate Demo !\nSecond line';
  const { editor, output } = await open(page, info.project.metadata.host, value);
  await editor.focus(); await editor.press('ControlOrMeta+a'); await page.keyboard.press('Backspace');
  await expect(output).toHaveText('');
  await editor.press('ControlOrMeta+z'); await expect(output).toHaveJSProperty('textContent', value);
});
test('typing Markdown creates an editable link and preserves trailing text', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Read ');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click();
  await page.keyboard.type('[docs](https://example.com) next');
  await expect(output).toHaveText('Read [docs](https://example.com) next');
  await expect(editor.locator('a')).toHaveText('docs');
});
test('updating known projects preserves text and the active caret', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Plan #New Project');
  await range(editor, 2); await page.getByRole('button', { name: 'Add known project', exact: true }).click();
  await expectCaret(editor, 2);
  await page.keyboard.type('X'); await expect(output).toHaveText('PlXan #New Project');
});
test('backspace removes one combined emoji without corrupting nearby text', async ({ page }, info) => {
  const { output } = await open(page, info.project.metadata.host, 'Plan 👩🏽‍💻');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click(); await page.keyboard.press('Backspace');
  await expect(output).toHaveJSProperty('textContent', 'Plan ');
});
test('a long multiline paste preserves all text through undo and redo', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Original');
  const long = Array.from({ length: 60 }, (_, index) => `Line ${index}: café 日本語 👩🏽‍💻 and ordinary reminder text`).join('\n');
  await page.getByRole('button', { name: 'Select all', exact: true }).click(); await paste(editor, long);
  await expect(output).toHaveJSProperty('textContent', long);
  await editor.press('ControlOrMeta+z'); await expect(output).toHaveText('Original');
  await editor.press('ControlOrMeta+Shift+z'); await expect(output).toHaveJSProperty('textContent', long);
});

test('keeps a local calendar date and time together through typing and remount', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Task ');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click();
  await editor.pressSequentially('2026-09-28 09:00');
  await expect(output).toHaveText('Task 2026-09-28 09:00');
  const verify = async () => {
    await expect(editor.locator('.rich-text-chip-date')).toHaveText('2026-09-28 09:00');
    await expect.poll(async () => JSON.parse((await page.getByTestId('parsed').textContent())!) as unknown).toMatchObject({
      cleanContent: 'Task', dueDate: '2026-09-28T09:00:00.000Z', hasTime: true,
    });
  };
  await verify();
  await page.getByRole('button', { name: 'Remount', exact: true }).click();
  await verify();
});

for (const schedule of ['every 0 days', 'monthly on the 32nd', 'every Monday 09:00 Europe/Invalid',
  'every Monday from 9 to 10',
  'every two weeks Monday morning', 'every two months on the 15th at noon',
  'every other weekday 09:00']) {
  test(`keeps unsupported schedule text without activating a partial date: ${schedule}`, async ({ page }, info) => {
    const { editor, output } = await open(page, info.project.metadata.host, 'Task Monday ');
    await page.getByRole('button', { name: 'Focus end', exact: true }).click();
    await editor.pressSequentially(schedule);
    await expect(output).toHaveText(`Task Monday ${schedule}`);
    await expect(editor.locator('.rich-text-chip-date')).toHaveCount(0);
    await expect.poll(async () => JSON.parse((await page.getByTestId('parsed').textContent())!) as unknown).toMatchObject({
      cleanContent: `Task Monday ${schedule}`, dateError: expect.any(String),
    });
    await editor.press('ControlOrMeta+a');
    await paste(editor, 'Task daily 09:00');
    await expect(output).toHaveText('Task daily 09:00');
    await expect(editor.locator('.rich-text-chip-date')).toHaveText('daily 09:00');
    await expect(page.getByTestId('parsed')).not.toContainText('dateError');
  });
}

test('autocomplete and saving preserve earlier project and priority mentions', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Compare #Crate Demo with ');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click();
  await editor.pressSequentially('#Wo');
  await expect(page.getByTestId('query')).toHaveText('Wo');
  await editor.press('Tab');
  await expect(output).toHaveText('Compare #Crate Demo with #Work');
  await expect(editor.locator('.rich-text-chip-project')).toHaveText('#Work');
  await editor.pressSequentially('! !');
  await expect.poll(async () => JSON.parse((await page.getByTestId('parsed').textContent())!) as unknown).toMatchObject({
    cleanContent: 'Compare #Crate Demo with !', project: 'Work', priority: 1,
  });
});

test('autocomplete replaces the project suffix beyond the caret', async ({ page }, info) => {
  const text = 'Compare #Crate Demo with #Work tail';
  const { editor, output } = await open(page, info.project.metadata.host, text);
  await range(editor, text.lastIndexOf('#Work') + 3);
  await editor.press('Delete');
  await expect(output).toHaveText('Compare #Crate Demo with #Wok tail');
  await expect(page.getByTestId('query')).toHaveText('Wo');
  await editor.press('Tab');
  await expect(output).toHaveText(text);
  await expectCaret(editor, text.lastIndexOf('#Work') + 6);
  await editor.pressSequentially('new ');
  await expect(output).toHaveText('Compare #Crate Demo with #Work new tail');
  await expect.poll(async () => JSON.parse((await page.getByTestId('parsed').textContent())!) as unknown).toMatchObject({
    cleanContent: 'Compare #Crate Demo with new tail', project: 'Work',
  });
});

for (const fractional of [false, true]) {
  test(`Chrono recurrence seconds survive reopening and picker edits: ${fractional}`, async ({ page }, info) => {
    await page.clock.setFixedTime(new Date('2026-09-21T13:00:37.123Z'));
    const precision = { second: 30, ...(fractional ? { millisecond: 123 } : {}) };
    const schedule = `every Monday 09:00:30${fractional ? '.123' : ''}`;
    const params = new URLSearchParams({ fixture: 'modal', host: String(info.project.metadata.host) });
    await page.goto(`/?${params}`);
    const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
    await title.click();
    await page.keyboard.type(`Call Alex ${schedule}`);
    await expect(title.locator('.rich-text-chip-date')).toHaveText(schedule);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await title.press('Enter');
    const saved = async () => JSON.parse((await page.getByTestId('saved').textContent()) || 'null') as Reminder;
    await expect.poll(saved).toMatchObject({ content: 'Call Alex',
      recurrence: { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, ...precision } });
    params.set('reminder', JSON.stringify({ ...recurringReminder, ...(await saved()),
      dueDatetime: `2026-09-28T09:00:30.${fractional ? '123' : '000'}Z` }));
    await page.goto(`/?${params}`);
    await page.locator('.reminder-action-chips [data-picker="recurrence"]').click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(title.locator('.rich-text-chip-date')).toContainText(`09:00:30${fractional ? '.123' : ''}`);
    await page.getByRole('button', { name: 'Save reminder', exact: true }).click();
    await expect.poll(saved).toMatchObject({ recurrence: precision });
    params.set('reminder', JSON.stringify(await saved()));
    await page.goto(`/?${params}`);
    await page.locator('.reminder-action-chips [data-picker="recurrence"]').click();
    await page.getByLabel('Reminder time', { exact: true }).fill('10:30');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(title.locator('.rich-text-chip-date')).toHaveText('every Mon 10:30');
    await page.getByRole('button', { name: 'Save reminder', exact: true }).click();
    await expect.poll(saved).toMatchObject({ recurrence: { hour: 10, minute: 30 } });
    expect((await saved()).recurrence?.second).toBeUndefined();
    expect((await saved()).recurrence?.millisecond).toBeUndefined();
  });
}
