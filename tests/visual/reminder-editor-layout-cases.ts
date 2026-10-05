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
          const add = page.getByRole('button', { name: 'Add reminder', exact: true });
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

          await clearEditor(title);
          await expect(add).toBeDisabled();
          await expect(add).toHaveCSS('border-top-width', '0px');
          await expect(add).toHaveCSS('box-shadow', 'none');
          await expect(add).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          await expect.poll(() => title.evaluate(el => getComputedStyle(el, '::before').content)).toBe('"Reminder title"');
          expect(await title.evaluate(el => getComputedStyle(el, '::before').pointerEvents)).toBe('none');

          await replaceText(page, title, 'A short reminder');
          await expect(add).toBeEnabled();
          await replaceText(page, description, 'A supporting description');
          const titleStyle = await title.evaluate(el => ({ size: parseFloat(getComputedStyle(el).fontSize), color: getComputedStyle(el).color }));
          const descriptionStyle = await description.evaluate(el => ({ size: parseFloat(getComputedStyle(el).fontSize), color: getComputedStyle(el).color }));
          expect(descriptionStyle.size).toBeLessThan(titleStyle.size);
          expect(descriptionStyle.color).not.toBe(titleStyle.color);
          const headingSize = await page.getByRole('heading', { name: 'New reminder' }).evaluate(el => parseFloat(getComputedStyle(el).fontSize));
          expect(headingSize).toBeLessThan(titleStyle.size);
          const titleBox = await bounds(title), descriptionBox = await bounds(description);
          expect(Math.abs(titleBox.x - descriptionBox.x)).toBeLessThan(1);
          expect(descriptionBox.y - titleBox.y - titleBox.height).toBeGreaterThanOrEqual(0);
          expect(descriptionBox.y - titleBox.y - titleBox.height).toBeLessThanOrEqual(16);
          const firstChip = page.locator('.reminder-action-chip').first();
          const chipBox = await bounds(firstChip);
          expect(Math.abs(chipBox.x - titleBox.x)).toBeLessThan(1);
          expect(chipBox.y - descriptionBox.y - descriptionBox.height).toBeGreaterThanOrEqual(0);
          expect(chipBox.y - descriptionBox.y - descriptionBox.height).toBeLessThanOrEqual(32);
          const chips = page.locator('.reminder-action-chip');
          const chipHeights = await chips.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
          expect(Math.max(...chipHeights) - Math.min(...chipHeights)).toBeLessThan(1);
          const neutralColor = await firstChip.evaluate(el => getComputedStyle(el).color);
          const priority = page.getByRole('button', { name: 'Remove priority' });
          expect(await priority.evaluate(el => getComputedStyle(el).color)).not.toBe(neutralColor);
          await priority.click();
          await page.mouse.move(0, 0);
          await expect(page.getByRole('button', { name: 'Set priority' })).toHaveCSS('color', neutralColor);
          const shortHeight = (await bounds(surface)).height;

          await replaceText(page, title, 'Plan tomorrow #Work !');
          const markers = title.locator('.rich-text-chip');
          await expect(markers).toHaveCount(3);
          const markerBounds = await markers.evaluateAll(elements => elements.map(el => {
            const box = el.getBoundingClientRect();
            return { height: box.height, left: box.left, right: box.right };
          }));
          expect(Math.max(...markerBounds.map(box => box.height)) - Math.min(...markerBounds.map(box => box.height))).toBeLessThan(3);
          for (const box of markerBounds) {
            expect(box.left).toBeGreaterThanOrEqual(titleBox.x);
            expect(box.right).toBeLessThanOrEqual(titleBox.x + titleBox.width);
          }

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
      test(`${host} ${theme}: delete stays quiet until hover and remains keyboard accessible`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`/?host=${host}&theme=${theme}&scene=editor&shadow=1&edit=1`);
        const remove = page.getByRole('button', { name: 'Delete reminder', exact: true });
        await expect(remove).toBeVisible();
        const quietColor = await remove.evaluate(el => getComputedStyle(el).color);
        await expect(remove).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await remove.hover();
        await expect(remove).not.toHaveCSS('color', quietColor);
        // The PWA keeps sheet-header icons transparent; Obsidian adds a hover fill.
        if (host === 'plugin') await expect(remove).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        else await expect(remove).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await page.keyboard.press('Tab');
        await remove.focus();
        await expect(remove).toBeFocused();
        await expect(remove).toHaveCSS('outline-style', 'solid');
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('result')).toHaveText('Deleted');
      });
      for (const width of [320, 960]) {
        test(`${host} ${theme} ${width}: pickers fit native fields and expose selection and focus`, async ({ page }) => {
          await page.setViewportSize({ width, height: 844 });
          for (const scene of ['date', 'project', 'weekly', 'monthly']) {
            await page.goto(`/?host=${host}&theme=${theme}&scene=${scene}&shadow=1`);
            const picker = page.locator('.reminder-picker');
            await expect(picker).toBeVisible();
            expect(await picker.evaluate(el => el.getRootNode() instanceof ShadowRoot)).toBe(host === 'plugin');
            const box = await bounds(picker);
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width);
            expect(box.y + box.height).toBeLessThanOrEqual(844);
            expect(await picker.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
            for (const field of await picker.locator('input[type="date"], input[type="time"]').all()) {
              const fieldBox = await bounds(field);
              expect(fieldBox.x).toBeGreaterThanOrEqual(box.x);
              expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(box.x + box.width);
              await field.focus();
              await expect(field).toBeFocused();
            }
            if (scene === 'date') {
              await picker.locator('input[type="date"]').fill('2026-10-06');
              await picker.locator('input[type="date"]').press('Enter');
              await expect(page.getByTestId('result')).toHaveText('2026-10-06');
              await picker.locator('input[type="time"]').fill('14:45');
              await expect(page.getByTestId('result')).toHaveText('14:45');
            }
            if (scene === 'project' || scene === 'weekly') {
              const selected = scene === 'project'
                ? picker.getByRole('option', { name: 'Work', exact: true })
                : picker.locator('.recurrence-day-button[aria-pressed="true"]').first();
              const unselected = scene === 'project'
                ? picker.getByRole('option', { name: 'Personal', exact: true })
                : picker.locator('.recurrence-day-button[aria-pressed="false"]').first();
              expect(await selected.evaluate(el => getComputedStyle(el).backgroundColor))
                .not.toBe(await unselected.evaluate(el => getComputedStyle(el).backgroundColor));
              await expect(selected).toHaveCSS('box-shadow', 'none');
              await page.keyboard.press('Tab');
              await selected.focus();
              await expect(selected).toHaveCSS('outline-style', 'solid');
            }
          }
        });
      }
    }
  }
}
