import { test, expect, chromium, webkit } from '@playwright/test';

for (const browserName of ['chromium', 'webkit'] as const) for (const host of ['plugin', 'pwa']) for (const width of [390, 1280]) {
	test(`YouTube videos in ${browserName} ${host} at ${width}px`, async ({ baseURL }, testInfo) => {
		const browser = await ({ chromium, webkit })[browserName].launch();
		try {
			const page = await browser.newPage({ baseURL, reducedMotion: 'reduce', viewport: { width, height: 900 } });
			await page.route(/^https:\/\/[^/]+\/favicon\.ico(?:\?.*)?$/, route => route.abort());
			await page.route('https://i.ytimg.com/**', route => route.request().url().includes('jNQXAC9IVRw')
				? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#6b8075"/><path d="M0 220L150 100L310 220L400 80L480 130V270H0" fill="#a5b9a6"/></svg>' }) : route.abort());
			await page.route('https://www.youtube-nocookie.com/**', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
			await page.goto(`/?host=${host}&scene=reading&reading-video=1&theme=${width === 390 ? 'light' : 'dark'}`);
			const ready = page.getByRole('button', { name: /youtube.com A day at the museum/ });
			await expect(ready).toContainText('Video · The curious channel');
			await expect(ready.locator('img[data-loaded="true"]')).toHaveCount(1);
			await expect(page.getByText('Link only', { exact: true })).toHaveCount(0);
			await expect(page.getByText('Text pending', { exact: true })).toHaveCount(0);
			await page.screenshot({ path: testInfo.outputPath('video-library.png') });
			await ready.click();
			const article = page.locator('.crate-reading-reader');
			const watch = article.getByRole('button', { name: 'Play video', exact: true });
			await expect(watch).toBeVisible();
			await expect(watch.locator('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
			await expect(article.getByText('The curious channel', { exact: true })).toBeVisible();
			await expect(article.getByText('My notes: revisit the sculpture gallery.')).toBeVisible();
			await expect(article.getByText(/min read|You’ve reached the end|Article text couldn’t/)).toHaveCount(0);
			await expect(article.locator('iframe, video')).toHaveCount(0);
			expect(await article.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
			await watch.focus();
			await expect(watch).toBeFocused();
			await page.screenshot({ path: testInfo.outputPath('video-reader.png') });
			await watch.click();
			await expect(article.locator('iframe')).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/jNQXAC9IVRw\?.*start=42/);
			await article.getByRole('button', { name: 'Favorite video', exact: true }).click();
			await expect(article.getByRole('button', { name: 'Remove favorite' })).toHaveAttribute('aria-pressed', 'true');
			await article.getByRole('button', { name: 'Edit video tags' }).click();
			await page.getByRole('textbox', { name: 'Tags' }).fill('watch-later');
			await page.getByRole('button', { name: 'Save tags', exact: true }).click();
			await expect(article.getByText('#watch-later', { exact: true })).toBeVisible();
			await article.getByRole('button', { name: 'Mark as watched', exact: true }).click();
			await expect(article.getByRole('button', { name: 'Move to inbox', exact: true })).toBeVisible();
			await article.getByRole('button', { name: 'Back to reading' }).click();
			await expect(ready).toHaveCount(0);
			await page.getByRole('button', { name: 'youtu.be YouTube video', exact: true }).click();
			await expect(article.getByRole('heading', { name: 'YouTube video' })).toBeVisible();
			await expect(watch).toBeVisible();
			await expect(watch.locator('img')).toHaveCount(0);
			await expect(article.getByText('Your video is saved. You can watch it on YouTube.')).toBeVisible();
			await expect(article.getByText(/Article text couldn’t|You’ve reached the end/)).toHaveCount(0);
			await expect(article.getByRole('button', { name: 'Mark as watched', exact: true })).toBeVisible();
			await expect(article.getByRole('button', { name: 'Reading appearance' })).toHaveCount(0);
			await expect(article.getByRole('button', { name: 'Highlights (0)', exact: true })).toHaveCount(0);
			await page.screenshot({ path: testInfo.outputPath('video-unavailable.png') });
			await article.getByRole('button', { name: 'Back to reading' }).click();
			await page.getByRole('button', { name: 'youtube.com YouTube video', exact: true }).click();
			await expect(article.getByText('Your video is saved. Fetching details and transcript…')).toBeVisible();
			await watch.click();
			await expect(article.locator('iframe')).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/ScMzIvxBSi4/);
		} finally { await browser.close(); }
	});
}
