import { chromium, webkit, expect, test } from '@playwright/test';

for (const browserName of ['chromium', 'webkit'] as const) {
  test.describe(browserName, () => {
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      test(`toast fades without moving and can be replaced (${reducedMotion})`, async ({ baseURL }) => {
        const browser = await ({ chromium, webkit })[browserName].launch();
        try {
          const page = await browser.newPage({ baseURL, reducedMotion, viewport: { width: 390, height: 844 } });
          await page.goto('/?host=pwa&scene=controls&theme=dark');
          const show = page.getByRole('button', { name: 'Show success', exact: true });
          await show.scrollIntoViewIfNeeded();
          await show.click();
          const toast = page.locator('.toast');
          await expect(toast).toHaveCSS('opacity', '1');
          const before = await toast.boundingBox();
          expect(before).not.toBeNull();
          expect(Math.abs(before!.x + before!.width / 2 - 195)).toBeLessThan(1);
          const samples = await page.evaluate(async () => {
            const element = document.querySelector('.toast')!;
            const dismiss = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Dismiss feedback')!;
            dismiss.click();
            const samples: { opacity: number; bottom: number }[] = [];
            for (let frame = 0; frame < 40 && element.isConnected; frame++) {
              await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
              if (element.isConnected) samples.push({ opacity: Number(getComputedStyle(element).opacity), bottom: element.getBoundingClientRect().bottom });
            }
            return samples;
          });
          if (reducedMotion === 'no-preference') {
            expect(samples.some(sample => sample.opacity > 0 && sample.opacity < 1)).toBe(true);
            for (const sample of samples) expect(Math.abs(sample.bottom - before!.y - before!.height)).toBeLessThan(1);
          } else expect(samples.some(sample => sample.opacity > 0 && sample.opacity < 1)).toBe(false);
          await expect(toast).toHaveCount(0);
          await show.click();
          await page.getByRole('button', { name: 'Show error', exact: true }).click();
          await expect(toast).toHaveCount(1);
          await expect(toast).toHaveAttribute('role', 'alert');
          await expect(toast).toHaveText('Could not save changes.');
          await expect(toast).toHaveCSS('opacity', '1');
        } finally { await browser.close(); }
      });
    }
  });
}
