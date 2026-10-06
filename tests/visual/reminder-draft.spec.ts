import { chromium, webkit, expect, test, type Browser, type Page } from '@playwright/test';
import type { RecurrenceRule } from '@/reminders/types';

interface DraftState { content: string; dueDate: string | null; hasTime: boolean; recurrence: RecurrenceRule | null }
async function readDraft(page: Page): Promise<DraftState> {
  return JSON.parse((await page.getByTestId('draft-state').textContent())!) as DraftState;
}

async function openDraft(page: Page, mode = 'empty') {
  await page.goto(`/?host=plugin&scene=draft&shadow&draft=${mode}`);
  await expect(page.getByTestId('draft-state')).toBeVisible();
  expect(await page.getByTestId('draft-state').evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true);
  return page.getByRole('textbox', { name: 'Draft content' });
}

for (const browserName of ['chromium', 'webkit'] as const) {
  test.describe(`${browserName} plugin draft effects`, () => {
    let browser: Browser;
    let page: Page;
    test.beforeEach(async ({ baseURL }) => {
      browser = await ({ chromium, webkit })[browserName].launch();
      page = await browser.newPage({ baseURL, timezoneId: 'UTC', locale: 'en-US' });
      await page.clock.setFixedTime(new Date('2026-10-05T12:00:00Z'));
    });
    test.afterEach(async () => { await browser?.close(); });

    test('preserves the exact occurrence and recurrence metadata through a title edit', async () => {
      const input = await openDraft(page, 'recurring');
      const expected = { dueDate: '2026-10-05T13:00:37.123Z', hasTime: true,
        recurrence: { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0,
          timezone: 'America/New_York', count: 8, completedCount: 3, endDate: '2027-12-31' } };
      await expect.poll(() => readDraft(page)).toMatchObject(expected);
      await input.fill((await input.inputValue()).replace('Call Alex', 'Call Sam'));
      await expect.poll(() => readDraft(page)).toMatchObject(expected);
      expect((await readDraft(page)).content).toContain('Call Sam');
    });

    test('clears the old occurrence when text or a picker replaces and removes recurrence', async () => {
      const input = await openDraft(page, 'recurring');
      await input.fill('Call Alex every Tuesday 11:00 Europe/Berlin');
      await expect.poll(() => readDraft(page)).toMatchObject({ dueDate: null, hasTime: false,
        recurrence: { frequency: 'weekly', daysOfWeek: [2], hour: 11, minute: 0, timezone: 'Europe/Berlin' } });
      await input.fill('Call Alex');
      await expect.poll(() => readDraft(page)).toMatchObject({ dueDate: null, recurrence: null });
      await page.getByRole('button', { name: 'Choose recurrence' }).click();
      await expect.poll(() => readDraft(page)).toMatchObject({ dueDate: null, recurrence: { frequency: 'daily', interval: 2, hour: 8, minute: 15 } });
      await page.getByRole('button', { name: 'Remove recurrence' }).click();
      await expect.poll(() => readDraft(page)).toMatchObject({ dueDate: null, hasTime: false, recurrence: null });
    });

    test('retains an implicit date until a typed schedule or picker removal replaces it', async () => {
      let input = await openDraft(page, 'implicit');
      await input.fill('Call Alex');
      await expect.poll(() => readDraft(page)).toMatchObject({ dueDate: '2026-10-08', hasTime: false });
      await input.fill('Call Alex tomorrow at 10:00');
      await expect.poll(() => readDraft(page)).toMatchObject({ dueDate: '2026-10-06T10:00:00.000Z', hasTime: true });
      await input.fill('Call Alex');
      await expect.poll(() => readDraft(page)).toMatchObject({ dueDate: null, hasTime: false });
      input = await openDraft(page, 'implicit');
      await input.fill('Call Alex');
      await page.getByRole('button', { name: 'Choose date' }).click();
      await expect.poll(() => readDraft(page)).toMatchObject({ dueDate: '2026-10-12', hasTime: false });
      await page.getByRole('button', { name: 'Remove date' }).click();
      await expect.poll(() => readDraft(page)).toMatchObject({ dueDate: null, hasTime: false });
    });

    test('settles a relative date once across later renders and clock changes', async () => {
      const input = await openDraft(page);
      await input.fill('Call Alex in 5 minutes');
      await expect.poll(() => readDraft(page)).toMatchObject({ dueDate: '2026-10-05T12:05:00.000Z', hasTime: true });
      await page.clock.setFixedTime(new Date('2026-10-05T12:02:00Z'));
      await page.getByRole('button', { name: 'Rerender draft' }).click();
      await expect(page.getByTestId('draft-renders')).toHaveText('1');
      await expect.poll(() => readDraft(page)).toMatchObject({ dueDate: '2026-10-05T12:05:00.000Z', hasTime: true });
    });
  });
}
