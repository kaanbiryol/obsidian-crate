import { expect, test } from '@playwright/test';

for (const host of ['plugin', 'pwa']) {
  for (const scene of ['loading', 'loading-block']) {
    test(`${host} ${scene} delays its indicator and respects reduced motion`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto(`/?host=${host}&scene=${scene}&theme=light`);
      const status = page.getByRole('status', { name: 'Loading reminders' });
      await expect(status).toBeVisible();
      const spinner = status.locator('.crate-content-loading__spinner');
      await expect(spinner).toBeVisible();
      await expect(spinner.locator('rect')).toHaveCount(12);
      await expect(spinner).toHaveCSS('animation-timing-function', 'ease, steps(12)');
      const visibilityAt = (time: number) => spinner.evaluate((element, time) => {
        for (const animation of element.getAnimations()) {
          animation.pause();
          animation.currentTime = time;
        }
        return getComputedStyle(element).visibility;
      }, time);
      expect(await visibilityAt(249)).toBe('hidden');
      expect(await visibilityAt(250)).toBe('visible');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(spinner).toHaveCSS('animation-name', 'crate-loading-appear');
      await expect(status).toHaveAttribute('aria-label', 'Loading reminders');
    });
  }
}
