import { expect, test, type Locator, type Page } from '@playwright/test';
import { clearEditor, settleEditor } from './editor-helpers';

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function replaceText(page: Page, field: Locator, text: string) {
  await clearEditor(field);
  await settleEditor(page);
  await page.keyboard.insertText(text);
  await expect(field).toHaveText(text.trim());
}

export function registerReminderEditorLayoutTests() {
  for (const host of ['plugin', 'pwa']) {
    for (const theme of ['light', 'dark']) {
      for (const width of [320, 390, 960]) {
        test(`${host} ${theme} ${width}: editor stays aligned and contains long fields`, async ({ page }) => {
          await page.setViewportSize({ width, height: 844 });
          await page.goto(`/?host=${host}&theme=${theme}&scene=editor&shadow=1`);
          const surface = page.getByTestId('visual-surface');
          const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
          const description = page.getByRole('textbox', { name: 'Reminder description', exact: true });
          const add = page.getByRole('button', { name: 'Add', exact: true });
          await expect(title).toBeVisible();
          expect(await title.evaluate(el => el.getRootNode() instanceof ShadowRoot)).toBe(host === 'plugin');

          // Assert the rendered relationships, independent of grid/flex and SCSS formatting.
          const closeBox = await bounds(page.getByRole('button', { name: 'Close reminder editor' }));
          const headingBox = await bounds(page.getByRole('heading', { name: 'New reminder' }));
          const addBox = await bounds(add);
          expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(headingBox.x);
          expect(headingBox.x + headingBox.width).toBeLessThanOrEqual(addBox.x);
          expect(Math.abs(closeBox.y + closeBox.height / 2 - addBox.y - addBox.height / 2)).toBeLessThan(1);
          expect((await bounds(page.locator('.reminder-modal-header'))).height).toBeGreaterThanOrEqual(44);

          await replaceText(page, title, 'A short reminder');
          await replaceText(page, description, 'A supporting description');
          const titleStyle = await title.evaluate(el => ({ size: parseFloat(getComputedStyle(el).fontSize), color: getComputedStyle(el).color }));
          const descriptionStyle = await description.evaluate(el => ({ size: parseFloat(getComputedStyle(el).fontSize), color: getComputedStyle(el).color }));
          expect(descriptionStyle.size).toBeLessThan(titleStyle.size);
          expect(descriptionStyle.color).not.toBe(titleStyle.color);
          const titleBox = await bounds(title), descriptionBox = await bounds(description);
          expect(Math.abs(titleBox.x - descriptionBox.x)).toBeLessThan(1);
          expect(descriptionBox.y - titleBox.y - titleBox.height).toBeGreaterThanOrEqual(0);
          expect(descriptionBox.y - titleBox.y - titleBox.height).toBeLessThanOrEqual(16);
          const firstChip = page.locator('.reminder-action-chip').first();
          const chipBox = await bounds(firstChip);
          expect(Math.abs(chipBox.x - titleBox.x)).toBeLessThan(1);
          expect(chipBox.y - descriptionBox.y - descriptionBox.height).toBeGreaterThanOrEqual(0);
          expect(chipBox.y - descriptionBox.y - descriptionBox.height).toBeLessThanOrEqual(32);
          const shortHeight = (await bounds(surface)).height;

          await replaceText(page, title, 'A long reminder title that wraps across several lines. '.repeat(20));
          await replaceText(page, description, 'Supporting details that must scroll within the editor. '.repeat(60));
          for (const field of [title, description]) {
            await expect.poll(() => field.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
            expect(await field.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
            await field.evaluate(el => { el.scrollTop = el.scrollHeight; });
            expect(await field.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
          }
          const longDescription = await bounds(description), longChip = await bounds(firstChip);
          expect(longChip.y).toBeGreaterThanOrEqual(longDescription.y + longDescription.height);
          const surfaceBox = await bounds(surface);
          expect(surfaceBox.height - shortHeight).toBeLessThan(200);
          expect(surfaceBox.x).toBeGreaterThanOrEqual(0);
          expect(surfaceBox.x + surfaceBox.width).toBeLessThanOrEqual(width);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await add.click();
          await expect(page.getByTestId('result')).toHaveText('Saved');
        });
      }
    }
  }
}
