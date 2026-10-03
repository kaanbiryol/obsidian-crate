import { expect, test } from '@playwright/test';

export function registerReminderSourceIssueTests() {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    test(`plugin source warning recovery in Shadow DOM: ${theme} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/?host=plugin&scene=source&theme=${theme}&many`);
      const notice = page.getByRole('region', { name: 'Notes needing attention' });
      await expect(notice).toBeVisible();
      await expect(notice.getByRole('status')).toHaveText('Couldn’t read some reminders');
      await expect(notice.getByRole('button', { name: /Details|Show more/ })).toHaveCount(0);
      await expect(notice.getByRole('list', { name: 'Affected notes' })).toBeVisible();
      await expect(notice.getByText('<img src=x onerror=alert(1)>.md', { exact: true })).toBeVisible();
      await expect(notice.locator('img')).toHaveCount(0);
      await expect(notice.getByRole('listitem')).toHaveCount(21);
      expect(await notice.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const files = notice.getByRole('list', { name: 'Affected notes' });
      expect(await files.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      expect(await files.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const screenshot = testInfo.outputPath(`source-warning-${theme}-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach('source warning', { path: screenshot, contentType: 'image/png' });

      const retry = notice.getByRole('button', { name: 'Retry', exact: true });
      await retry.focus();
      await page.keyboard.press('Enter');
      await expect(notice.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
      await page.evaluate(() => window.dispatchEvent(new Event('crate-test-refresh')));
      await expect(notice.getByRole('alert')).toHaveText('Storage is temporarily unavailable. Try again.');
      await expect(retry).toBeEnabled();
      await retry.click();
      await page.evaluate(() => window.dispatchEvent(new Event('crate-test-refresh')));
      await expect(notice).toHaveCount(0);
      await expect(page.getByText('Find a new hiking route', { exact: true })).toBeVisible();
    });
  }

  for (const theme of ['light', 'dark']) test(`inline notice and open note: ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(`/?host=plugin&scene=source&theme=${theme}`);
    const notice = page.getByRole('region', { name: 'Notes needing attention' });
    await expect(notice.getByRole('status')).toHaveText('Couldn’t read one reminder');
    expect((await notice.boundingBox())!.height).toBeLessThan(140);
    await expect(page.getByText('Find a new hiking route', { exact: true })).toBeVisible();
    await expect(notice.getByText('Inbox.md · line 8', { exact: true })).toBeVisible();
    await expect(notice.getByText('This reminder has an invalid description. Editing is paused.', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`source-inline-${theme}.png`) });
    await notice.getByRole('button', { name: 'Open note: Reminders/Inbox.md', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('opened-note')).toHaveText('Reminders/Inbox.md');
  });

  test('same-named affected notes retain their full paths', async ({ page }) => {
    await page.goto('/?host=plugin&scene=source&duplicates');
    const notice = page.getByRole('region', { name: 'Notes needing attention' });
    await expect(notice.getByText('Reminders/Work/Inbox.md · line 8', { exact: true })).toBeVisible();
    await expect(notice.getByText('Reminders/Personal/Inbox.md · line 8', { exact: true })).toBeVisible();
    await notice.getByRole('button', { name: 'Open note: Reminders/Personal/Inbox.md', exact: true }).click();
    await expect(page.getByTestId('opened-note')).toHaveText('Reminders/Personal/Inbox.md');
  });

  test('automatic index recovery clears a previous retry error', async ({ page }) => {
    await page.goto('/?host=plugin&scene=source');
    const notice = page.getByRole('region', { name: 'Notes needing attention' });
    await notice.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('crate-test-refresh')));
    await expect(notice.getByRole('alert')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('crate-test-source-recovered')));
    await expect(notice).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('crate-test-source-failed')));
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('alert')).toHaveCount(0);
    await expect(notice.getByText('Inbox.md · line 8', { exact: true })).toBeVisible();
    await expect(notice.getByText('This reminder has an invalid description. Editing is paused.', { exact: true })).toBeVisible();
  });

  test('opening an unavailable note shows a recoverable error', async ({ page }) => {
    await page.goto('/?host=plugin&scene=source&openError');
    const notice = page.getByRole('region', { name: 'Notes needing attention' });
    await notice.getByRole('button', { name: 'Open note: Reminders/Inbox.md', exact: true }).click();
    await expect(notice.getByRole('alert')).toHaveText('This note is no longer available. Retry the scan to update the list.');
    await expect(notice.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  });
}
