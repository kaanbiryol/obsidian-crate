import { expect, test } from '@playwright/test';

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
  test(`plugin source warnings in Shadow DOM: ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?host=plugin&scene=source&theme=${theme}`);
    const notice = page.getByRole('region', { name: 'Incomplete reminder list' });
    await expect(notice).toBeVisible();
    await page.getByText('Review affected files (21)', { exact: true }).click();
    await expect(notice.getByText('Reminders/<img src=x onerror=alert(1)>.md', { exact: true })).toBeVisible();
    await expect(notice.locator('img')).toHaveCount(0);
    await expect(notice.locator('.crate-reminder-source-notice__files p')).toHaveCount(20);
    await page.getByRole('button', { name: 'Show more files' }).click();
    await expect(notice.locator('.crate-reminder-source-notice__files p')).toHaveCount(21);
    expect(await notice.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const screenshot = testInfo.outputPath(`source-warning-${theme}-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach('source warning', { path: screenshot, contentType: 'image/png' });

    const refresh = page.getByRole('button', { name: 'Refresh reminders', exact: true });
    await refresh.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Refreshing reminders…' })).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event('crate-test-refresh')));
    await expect(notice.getByRole('alert')).toHaveText('Storage is temporarily unavailable. Try again.');
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await page.evaluate(() => window.dispatchEvent(new Event('crate-test-refresh')));
    await expect(notice).toHaveCount(0);
    await expect(page.getByText('Healthy reminders remain available', { exact: true })).toBeVisible();
  });
}
