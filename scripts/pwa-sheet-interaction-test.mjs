import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

async function tapBackdropAbove(page, dialog) {
	// The library container is taller than the visible reminder sheet. Tap the
	// apparent backdrop immediately above the content to catch invisible blockers.
	const sheet = page.locator('.pwa-reminder-sheet-stage');
	await expect(dialog).toBeVisible();
	await expect(page.getByRole('button', { name: 'Close sheet', exact: true })).toBeVisible();
	await expect(page.locator('.pwa-modal-sheet__container')).toHaveCSS('transform', 'none');
	if (await sheet.count()) await expect(sheet).toHaveCSS('transform', 'none');
	const bounds = await dialog.boundingBox();
	assert.ok(bounds && bounds.y > 24, 'The sheet must leave a visible backdrop');
	const point = { x: bounds.x + bounds.width / 2, y: bounds.y - 24 };
	assert.ok(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('pwa-modal-sheet__backdrop'), point),
		`Visible backdrop must receive the tap: ${JSON.stringify(bounds)}`);
	await page.touchscreen.tap(point.x, point.y);
}

async function expectNoTouchRing(locator) {
	await expect(locator).toHaveCSS('outline-style', 'none');
	await expect(locator).toHaveCSS('box-shadow', 'none');
}

async function tabTo(page, locator) {
	// Safari's default Tab order includes text inputs; Option-Tab includes buttons.
	const tab = page.context().browser().browserType().name() === 'webkit' ? 'Alt+Tab' : 'Tab';
	for (let attempts = 0; attempts < 30; attempts++) {
		await page.keyboard.press(tab);
		if (await locator.evaluate(element => element === document.activeElement)) return;
	}
	assert.fail('Keyboard navigation did not reach the requested control');
}

async function expectNeutralKeyboardRing(locator) {
	await expect(locator).toHaveCSS('outline-style', 'solid');
	const style = await locator.evaluate(element => {
		const computed = getComputedStyle(element);
		return { color: computed.outlineColor, width: parseFloat(computed.outlineWidth) };
	});
	assert.ok(style.width >= 1, 'Keyboard focus must remain visible');
	const channels = style.color.match(/[\d.]+/g).slice(0, 3).map(Number);
	assert.ok(Math.max(...channels) - Math.min(...channels) < 35,
		`Keyboard focus should use a neutral color, received ${style.color}`);
}

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		try {
			const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
			await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
			const card = page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true });
			const editor = page.getByRole('dialog', { name: 'Edit reminder', exact: true });
			const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
			await card.tap();
			await expect(title).toBeFocused();
			await expectNoTouchRing(title);
			await title.fill('Keep this draft while choosing');
			const priority = editor.getByRole('button', { name: /^(Set|Remove) priority$/ });
			await priority.tap();
			await expect(editor).toBeVisible();
			await expectNoTouchRing(priority);

			const project = page.getByRole('dialog', { name: 'Select project', exact: true });
			await editor.getByRole('button', { name: 'Inbox', exact: true }).tap();
			await project.getByRole('heading', { name: 'Project', exact: true }).tap();
			await expect(project).toBeVisible();
			await tapBackdropAbove(page, project);
			await expect(project).toBeHidden();
			await expect(title).toContainText('Keep this draft while choosing');
			await editor.getByRole('button', { name: 'Inbox', exact: true }).tap();
			await expect(project).toBeVisible();
			await expect(page.getByRole('button', { name: 'Close sheet', exact: true })).toBeVisible();
			await expect(page.locator('.pwa-reminder-sheet-stage')).toHaveCSS('transform', 'none');
			await project.getByRole('option', { name: 'Work', exact: true }).tap();
			await expect(editor.getByRole('button', { name: 'Work', exact: true })).toBeVisible();

			await editor.getByRole('button', { name: 'Date', exact: true }).tap();
			const schedule = page.getByRole('dialog', { name: 'Schedule reminder', exact: true });
			const date = schedule.locator('input[type="date"]');
			await date.tap();
			await expectNoTouchRing(date);
			await date.fill('2027-06-10');
			await expect(schedule).toBeVisible();
			await tapBackdropAbove(page, schedule);
			await expect(schedule).toBeHidden();
			await expect(title).toContainText('Keep this draft while choosing');

			await editor.getByRole('button', { name: 'Recurrence', exact: true }).tap();
			const repeat = page.getByRole('dialog', { name: 'Repeat reminder', exact: true });
			const weekly = repeat.getByRole('tab', { name: 'Weekly', exact: true });
			await weekly.tap();
			await expect(weekly).toHaveAttribute('aria-selected', 'true');
			await expectNoTouchRing(weekly);
			await expect(repeat).toBeVisible();
			await tapBackdropAbove(page, repeat);
			await expect(repeat).toBeHidden();
			await expect(title).toContainText('Keep this draft while choosing');
			await tapBackdropAbove(page, editor);
			await expect(editor).toBeHidden();
			await expectNoTouchRing(card);
			await card.tap();
			await expect(title).toHaveText('Check this article');
			await tapBackdropAbove(page, editor);
			await expect(editor).toBeHidden();

			await page.getByRole('button', { name: 'Open settings', exact: true }).tap();
			const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
			await expectNoTouchRing(settings);
			const darkTheme = settings.getByRole('button', { name: 'Dark', exact: true });
			await darkTheme.tap();
			await expect(darkTheme).toHaveAttribute('aria-pressed', 'true');
			await expectNoTouchRing(darkTheme);
			await expect(settings).toBeVisible();
			const days = settings.getByRole('spinbutton', { name: 'Upcoming range (days)', exact: true });
			const inputBorder = await days.evaluate(element => getComputedStyle(element).borderColor);
			await days.tap();
			await days.fill('12');
			await expectNoTouchRing(days);
			await expect(days).toHaveCSS('border-color', inputBorder);
			const select = settings.getByRole('combobox');
			await select.tap();
			await expectNoTouchRing(select);
			await select.selectOption('inbox');
			await expect(settings).toBeVisible();

			await tabTo(page, days);
			await expectNeutralKeyboardRing(days);
			await tabTo(page, settings.getByRole('button', { name: 'Close settings', exact: true }));
			await expectNeutralKeyboardRing(settings.getByRole('button', { name: 'Close settings', exact: true }));
			await darkTheme.tap();
			await expectNoTouchRing(darkTheme);
			await tapBackdropAbove(page, settings);
			await expect(settings).toBeHidden();
			await expectNoTouchRing(page.getByRole('button', { name: 'Open settings', exact: true }));
			await tabTo(page, card);
			await expectNeutralKeyboardRing(card);
			await page.keyboard.press('Enter');
			await expect(editor).toBeVisible();
			await expect(page.locator('.pwa-modal-sheet__container')).toHaveCSS('transform', 'none');
			await page.keyboard.press('Escape');
			await expect(editor).toBeHidden();
			console.log(`${browserType.name()}: sheet backdrops, interior controls, touch focus and keyboard focus passed`);
		} finally {
			await browser.close();
		}
	}
} finally {
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
