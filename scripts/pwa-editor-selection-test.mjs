import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { createInitialState } from './pwa-preview-fixtures.mjs';

const content = 'A long reminder with enough text to scroll inside the title. '.repeat(16).trim();
const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;

async function selectionState(title) {
	return title.evaluate(element => {
		const selection = document.getSelection();
		const range = selection.getRangeAt(0);
		const prefix = range.cloneRange();
		prefix.selectNodeContents(element);
		prefix.setEnd(range.startContainer, range.startOffset);
		const caret = range.getBoundingClientRect();
		const bounds = element.getBoundingClientRect();
		return {
			start: prefix.toString().length, selected: range.toString(),
			scrollTop: element.scrollTop,
			visible: caret.height > 0 && caret.top >= bounds.top && caret.bottom <= bounds.bottom,
			backward: selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset,
		};
	});
}

async function settled(page) {
	await expect(page.locator('.pwa-reminder-sheet-stage')).toHaveCSS('transform', 'none');
	await expect(page.locator('.reminder-action-chips')).not.toHaveAttribute('inert');
}

try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		try {
			const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
			const data = { ...createInitialState(), projects: ['Inbox', 'Work', 'Personal'] };
			const reminder = data.reminders.find(reminder => reminder.id === 'preview-inbox-1');
			reminder.content = content;
			reminder.dueDatetime = '2027-04-13T10:30:00.000Z';
			await page.route('**/reminders/list*', async route => {
				await route.fulfill({ json: data });
			});
			await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
			await page.evaluate(() => {
				window.keyboardViewportHeight = 844;
				const viewport = new EventTarget();
				Object.defineProperties(viewport, {
					height: { get: () => window.keyboardViewportHeight }, width: { value: 390 },
					offsetTop: { value: 0 }, offsetLeft: { value: 0 }, scale: { value: 1 },
					pageTop: { value: 0 }, pageLeft: { value: 0 },
				});
				Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
			});
			await page.getByRole('group', { name: new RegExp('^A long reminder') }).tap();
			const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
			const editor = page.getByRole('dialog', { name: 'Edit reminder', exact: true });
			await settled(page);
			await expect(title).toBeFocused();
			await expect.poll(async () => (await selectionState(title)).visible).toBe(true);
			assert.equal((await selectionState(title)).start, (await title.textContent()).length, 'Opening keeps the caret at the end, including inline date chips');
			await expect(title).toHaveCSS('mask-image', 'none');
			await page.evaluate(() => {
				window.keyboardViewportHeight = 510;
				window.visualViewport.dispatchEvent(new Event('resize'));
			});
			await expect(page.locator('.pwa-modal-sheet__container--reminder')).toHaveCSS('--pwa-keyboard-inset', '334px');
			await expect.poll(async () => (await selectionState(title)).visible).toBe(true);
			await title.evaluate(async element => {
				element.scrollTop = 0;
				await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			});
			assert.equal(await title.evaluate(element => element.scrollTop), 0, 'Reading earlier text must not snap back to the caret');
			await editor.getByRole('button', { name: 'Inbox', exact: true }).tap();
			const project = page.getByRole('dialog', { name: 'Select project', exact: true });
			await expect(project).toBeVisible();
			await settled(page);
			await project.getByRole('button', { name: 'Close project selection', exact: true }).tap();
			await expect(project).toBeHidden();
			await settled(page);
			assert.equal(await title.evaluate(element => element.scrollTop), 0, 'Picker return preserves a manually scrolled reading position');

			// Selection moves reveal the caret; ordinary scrolling must remain under user control.
			await title.evaluate(element => document.getSelection().setBaseAndExtent(element.firstChild, 220, element.firstChild, 220));
			await expect.poll(async () => (await selectionState(title)).visible).toBe(true);
			const middle = await selectionState(title);
			await editor.getByRole('button', { name: 'Inbox', exact: true }).tap();
			await expect(project).toBeVisible();
			await settled(page);
			await project.getByRole('button', { name: 'Close project selection', exact: true }).tap();
			await expect(project).toBeHidden();
			await settled(page);
			await expect(title).toBeFocused();
			assert.equal((await selectionState(title)).start, middle.start);
			assert.ok(Math.abs((await selectionState(title)).scrollTop - middle.scrollTop) <= 1, 'Cancel preserves inner scroll');

			await editor.getByRole('button', { name: 'Inbox', exact: true }).tap();
			await expect(project).toBeVisible();
			await settled(page);
			await project.getByRole('option', { name: 'Work', exact: true }).tap();
			await expect(project).toBeHidden();
			await settled(page);
			assert.equal((await selectionState(title)).start, middle.start, 'A changed project preserves the text caret');
			await page.keyboard.insertText('INSERTED ');
			await expect(title).toContainText(content.slice(0, 220) + 'INSERTED ' + content.slice(220));

			await title.evaluate(element => document.getSelection().setBaseAndExtent(element.firstChild, 230, element.firstChild, 220));
			const selected = await selectionState(title);
			await editor.getByRole('button', { name: 'Work', exact: true }).tap();
			await expect(project).toBeVisible();
			await settled(page);
			await project.getByRole('button', { name: 'Close project selection', exact: true }).tap();
			await expect(project).toBeHidden();
			await settled(page);
			const restored = await selectionState(title);
			assert.equal(restored.selected, selected.selected);
			assert.equal(restored.backward, selected.backward, 'Keep selection direction');

			const description = page.getByRole('textbox', { name: 'Reminder description', exact: true });
			await description.fill('A description with many lines.\n'.repeat(20));
			await description.evaluate(element => { element.setSelectionRange(90, 95, 'backward'); element.scrollTop = 36; });
			const descriptionBefore = await description.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection, scroll: element.scrollTop }));
			await expect(description).toHaveCSS('mask-image', 'none');
			await editor.getByRole('button', { name: 'Work', exact: true }).tap();
			await expect(project).toBeVisible();
			await settled(page);
			await project.getByRole('button', { name: 'Close project selection', exact: true }).tap();
			await expect(project).toBeHidden();
			await settled(page);
			await expect(description).toBeFocused();
			assert.deepEqual(await description.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection, scroll: element.scrollTop })), descriptionBefore);
			assert.equal(await page.evaluate(() => window.scrollY), 0, 'The document stays anchored');
			console.log(`${browserType.name()}: long reminder caret visibility, picker selection/scroll restoration and focused-field fades passed`);
		} finally { await browser.close(); }
	}
} finally { await new Promise(resolve => server.close(resolve)); }
