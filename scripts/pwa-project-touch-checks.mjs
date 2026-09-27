import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

async function settleAppearance(card) {
  await card.evaluate(async element => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
  });
}

async function appearance(card) {
  return card.evaluate(element => {
    const surface = getComputedStyle(element.querySelector('.premium-project-content'));
    const accent = getComputedStyle(element.querySelector('.premium-project-accent'));
    const chevron = element.querySelector('.premium-project-chevron');
    return {
      background: surface.backgroundColor, border: surface.borderColor, transform: surface.transform,
      accentShadow: accent.boxShadow,
      chevronOpacity: chevron && getComputedStyle(chevron).opacity,
      chevronTransform: chevron && getComputedStyle(chevron).transform,
    };
  });
}

export async function checkProjectTouchFeedback(page) {
  const scroll = page.locator('.reminders-browse-view .ios-scroll');
  // Cover standalone cards, grouped parents, and nested cards such as Finance.
  for (const project of ['Errands', 'Personal', 'Personal/Finance']) {
    const card = page.getByRole('button', { name: `Open ${project}`, exact: true });
    await card.scrollIntoViewIfNeeded();
    await page.mouse.move(-1, -1);
    await settleAppearance(card);
    const resting = await appearance(card);
    // Force :hover to remain on a touch surface after release, including WebKit.
    await card.hover();
    assert.ok(await card.evaluate(element => element.matches(':hover')));
    await expect.poll(() => appearance(card), { message: `${project}: touch hover must not highlight cards or icons` }).toEqual(resting);
    await page.mouse.move(-1, -1);

    if (page.context().browser().browserType().name() === 'chromium') {
      const session = await page.context().newCDPSession(page);
      const send = (type, point) => session.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [point] : [] });
      try {
        for (const ending of ['cancel', 'scroll']) {
          const bounds = await card.boundingBox();
          const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
          const beforeScroll = await scroll.evaluate(element => element.scrollTop);
          await send('touchStart', point);
          await expect.poll(async () => (await appearance(card)).background).not.toBe(resting.background);
          if (ending === 'cancel') {
            await send('touchCancel');
          } else {
            for (let step = 1; step <= 6; step++) await send('touchMove', { x: point.x, y: point.y - step * 6 });
            await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(beforeScroll);
            // Scrolling cancels the press even before the finger lifts.
            await expect.poll(() => appearance(card)).toEqual(resting);
            await send('touchEnd');
          }
          await expect.poll(() => appearance(card), { message: `${project}: ${ending} must clear press feedback` }).toEqual(resting);
          await expect(page.locator('.pwa-navigation-screen--project')).toHaveCount(0);
        }
      } finally {
        await session.detach();
      }
    }
    // Native taps must clear feedback too, including when detail navigation
    // keeps the source card mounted underneath the new screen.
    await card.tap();
    await expect(page.getByRole('heading', { name: project, exact: true })).toBeVisible();
    await expect(card).not.toHaveAttribute('data-press-active', '');
    await page.goBack();
    await expect(page.locator('.pwa-navigation-screen--project')).toHaveCount(0);
    await expect.poll(() => appearance(card)).toEqual(resting);
  }
  await scroll.evaluate(element => { element.scrollTop = 0; });
}

export async function checkProjectMouseFeedback(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  try {
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme });
      await page.goto(`${origin}/notifications?folder=Reminders&tab=browse`);
      const card = page.locator('.premium-project-card').first();
      await expect(card).toBeVisible();
      await page.mouse.move(-1, -1);
      await settleAppearance(card);
      const resting = await appearance(card);
      await card.hover();
      await expect.poll(async () => (await appearance(card)).background).not.toBe(resting.background);
      await page.mouse.move(-1, -1);
      await expect.poll(() => appearance(card)).toEqual(resting);
    }
  } finally {
    await page.close();
  }
}
